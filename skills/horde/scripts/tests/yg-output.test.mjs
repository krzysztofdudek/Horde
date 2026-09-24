// Horde reads Yggdrasil through its machine documents, never through the report it writes for a
// person — that report's grammar is Yggdrasil's to change, and 6.1.0 changes it. Every fixture under
// fixtures/yg-output/ is real CLI output, captured from one scratch project (one component, one
// enforced script rule with a two-case drill corpus, one advisory prose rule, no reviewer):
//   *-6.1.0.*  Yggdrasil release/6.1.0 at 865c140b, built in the dev container; the documents that
//              arrived with issue 212 (drill-6.1.0.json, drill-empty-6.1.0.json, health-6.1.0.json,
//              and context-missing-6.1.0.* now carrying node-not-found) from the issue-212 build,
//              Yggdrasil jarl/191-grammar, commit "feat(json): yg drill --json …" (212), over the same project rebuilt from scratch
//   *-6.0.0.*  the released 6.0.0 from npm, over a copy of the same project
// A variant with a changed text grammar is written here by hand, beside the real line it rewords,
// so the test says exactly what moved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aspectStanding, drillFromDoc, parseDrillSummary, pendingProsePairs, runDrill, runYgCheck, ygJson,
} from '../node.mjs';
import { healthFromDoc, parseHealth, readHealth } from '../audit.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'yg-output');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

// ---- yg check ---------------------------------------------------------------------------------

test('yg check: which pairs still wait for a verdict is read off yg-check/1, not off --details text', () => {
  // The line the old reader matched. 6.0.0 printed it once per pending pair; 6.1.0 reports the same
  // two pairs with its own wording per cause, and the line is gone.
  const OLD_PENDING_RE = /No valid verdict for aspect '([^']+)' on (file|node):(.+?)\.\s*$/;
  const pendingIn = (text) => text.split('\n').filter((l) => OLD_PENDING_RE.test(l.trim())).length;
  assert.equal(pendingIn(fixture('check-6.0.0-fresh.details.txt')), 2);
  assert.equal(pendingIn(fixture('check-6.1.0-filled.details.txt')), 0, 'the 6.1.0 report no longer says it');

  // The document names the same facts on both releases, in the same fields.
  const v61 = JSON.parse(fixture('check-6.1.0-filled.json'));
  assert.equal(v61.schema, 'yg-check/1');
  assert.deepEqual(aspectStanding(v61, 'plain-names'), {
    pairs: 1, refused: 0, unverified: 1, nodes: ['feature'], reports: [],
  });
  assert.deepEqual(aspectStanding(v61, 'no-marker'), {
    pairs: 1,
    refused: 1,
    unverified: 0,
    nodes: ['feature'],
    reports: [{ unit: 'node:feature', report: 'other.mjs:1: unfinished-work marker left behind.' }],
  });
  const llm = v61.pairs.filter((p) => p.kind === 'llm' && (p.verdict === 'unverified' || p.verdict === 'stale'));
  assert.deepEqual(llm.map((p) => `${p.aspect} ${p.unit.kind}:${p.unit.path}`), ['plain-names node:feature']);

  const v60 = JSON.parse(fixture('check-6.0.0-fresh.json'));
  assert.equal(v60.schema, 'yg-check/1');
  assert.equal(aspectStanding(v60, 'no-marker').unverified, 1, 'the 6.0.0 floor carries verdict and unit too');
  assert.equal(aspectStanding(v60, 'plain-names').unverified, 1);
});

// A CLI that answers each read with the real output captured for it: the document for `--json`, the
// report for anything else. The landing asks it which prose pairs still wait for a judgement.
function checkCli(t, release) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'yg-stub.mjs');
  const json = join(FIXTURES, release === '6.1.0' ? 'check-6.1.0-filled.json' : 'check-6.0.0-fresh.json');
  const text = join(FIXTURES, release === '6.1.0' ? 'check-6.1.0-filled.details.txt' : 'check-6.0.0-fresh.details.txt');
  writeFileSync(stub, [
    "import { readFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "if (argv[0] === '--version') { console.log('6.0.0'); process.exit(0); }",
    `process.stdout.write(readFileSync(argv.includes('--json') ? ${JSON.stringify(json)} : ${JSON.stringify(text)}, 'utf8'));`,
    'process.exit(1);',
    '',
  ].join('\n'));
  return { dir, cfg: { ygCommand: `${process.execPath} ${stub}` } };
}

test('yg check: the landing names the prose pair still waiting, on 6.1.0 and on the 6.0.0 floor', (t) => {
  const v61 = checkCli(t, '6.1.0');
  const checked = runYgCheck(v61.cfg, v61.dir);
  assert.equal(checked.ok, false);
  assert.equal(checked.exit, 1);
  assert.equal(
    checked.summary,
    "yg check: FAIL — 1 blocking finding and 4 warnings.; first: Aspect 'no-marker' is refused on node:feature by a deterministic check.",
  );
  const pending = pendingProsePairs(v61.cfg, v61.dir, checked);
  assert.deepEqual(pending.pairs, [{ aspect: 'plain-names', unitKind: 'node', unit: 'feature' }]);
  assert.deepEqual(pending.scriptPending, [], 'the script rule has its verdict: refused, not pending');

  const v60 = checkCli(t, '6.0.0');
  const floor = pendingProsePairs(v60.cfg, v60.dir);
  assert.deepEqual(floor.pairs, [{ aspect: 'plain-names', unitKind: 'node', unit: 'feature' }]);
  assert.deepEqual(floor.scriptPending, [{ aspect: 'no-marker', unitKind: 'node', unit: 'feature' }]);
});

test('yg check: nothing in Horde reads the report — the text readers are gone from node.mjs', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node.mjs'), 'utf8');
  for (const anchor of ['No valid verdict', '/^yg check:/', '(enforced|Errors)', "'--details'"]) {
    assert.ok(!src.includes(anchor), `node.mjs still reads the text report (${anchor})`);
  }
});

// ---- yg-error/1: a failing --json command answers with a document ----------------------------

function stubCli(t, stdoutFile, stderrFile, exit = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-error-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'yg-stub.mjs');
  writeFileSync(stub, [
    "import { readFileSync } from 'node:fs';",
    `process.stdout.write(readFileSync(${JSON.stringify(join(FIXTURES, stdoutFile))}, 'utf8'));`,
    stderrFile ? `process.stderr.write(readFileSync(${JSON.stringify(join(FIXTURES, stderrFile))}, 'utf8'));` : '',
    `process.exit(${exit});`,
    '',
  ].join('\n'));
  return { dir, cfg: { ygCommand: `${process.execPath} ${stub}` } };
}

test('yg-error/1: a node the graph does not have is absent, not an old CLI', (t) => {
  // `yg node nope --json` on 6.1.0: code node-not-found. The old reader saw a document that was not
  // yg-node/1 and called the CLI too old to use.
  const node = stubCli(t, 'node-missing-6.1.0.json', 'node-missing-6.1.0.stderr.txt');
  assert.equal(ygJson(node.dir, node.cfg, ['node', 'nope', '--json'], 'yg-node/1').state, 'absent');
  // `yg context --node nope --json` answers the same code since 212.
  const ctx = stubCli(t, 'context-missing-6.1.0.json', 'context-missing-6.1.0.stderr.txt');
  assert.equal(JSON.parse(fixture('context-missing-6.1.0.json')).code, 'node-not-found');
  assert.equal(ygJson(ctx.dir, ctx.cfg, ['context', '--node', 'nope', '--json'], 'yg-context/1').state, 'absent');
});

test('yg-error/1: absence is read off the code, never off the sentence', (t) => {
  // What `yg context` answered before 212: the missing node under the generic code. The sentence is
  // Yggdrasil's to reword, so a document that does not say node-not-found is an error, not absence.
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-code-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = { ...JSON.parse(fixture('context-missing-6.1.0.json')), code: 'command-error' };
  const body = join(dir, 'doc.json');
  writeFileSync(body, JSON.stringify(doc));
  const stub = join(dir, 'yg-stub.mjs');
  writeFileSync(stub, `import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(${JSON.stringify(body)}, 'utf8'));\nprocess.exit(1);\n`);
  const res = ygJson(dir, { ygCommand: `${process.execPath} ${stub}` }, ['context', '--node', 'nope', '--json'], 'yg-context/1');
  assert.equal(res.state, 'error');
  assert.equal(res.errorCode, 'command-error');
});

test('yg-error/1: any other refusal is an error with its own words, never "upgrade the CLI"', (t) => {
  const { dir, cfg } = stubCli(t, 'health-json-refused-6.1.0.json', null);
  const res = ygJson(dir, cfg, ['aspects', '--health', '--json'], 'yg-aspects/1');
  assert.equal(res.state, 'error');
  assert.equal(res.errorCode, 'command-error');
  assert.match(res.detail, /^--health cannot be combined with --json\./);
});

// ---- yg drill: the yg-drill/1 document, and the summary line only for 6.0.x --------------------

// A CLI that answers `yg drill` like one real release: 6.1.0 prints its document for `--json`,
// 6.0.x refuses `--json` by name and prints its case lines and summary otherwise.
function drillCli(t, { json, jsonExit = 0, refuseJson = false, text = 'drill-6.1.0.txt', textExit = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-drill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'yg-stub.mjs');
  const calls = join(dir, 'calls.log');
  writeFileSync(stub, [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(calls)}, argv.join(' ') + '\\n');`,
    "if (argv.includes('--json')) {",
    refuseJson
      ? "  process.stderr.write(\"error: unknown option '--json'\\n\"); process.exit(1);"
      : `  process.stdout.write(readFileSync(${JSON.stringify(join(FIXTURES, json || 'drill-6.1.0.json'))}, 'utf8')); process.exit(${jsonExit});`,
    '}',
    `process.stdout.write(readFileSync(${JSON.stringify(join(FIXTURES, text))}, 'utf8'));`,
    `process.exit(${textExit});`,
    '',
  ].join('\n'));
  return { dir, cfg: { ygCommand: `${process.execPath} ${stub}` }, calls: () => readFileSync(calls, 'utf8').trim().split('\n') };
}

test('yg drill: the counts are read off yg-drill/1', (t) => {
  const doc = JSON.parse(fixture('drill-6.1.0.json'));
  assert.equal(doc.schema, 'yg-drill/1');
  assert.deepEqual(
    { ...drillFromDoc(doc, 0), line: undefined },
    { pass: 2, miss: 0, falseAlarm: 0, unrun: 0, unsupported: 0, line: undefined },
  );
  const cli = drillCli(t, {});
  const res = runDrill(cli.dir, cli.cfg, 'no-marker');
  assert.equal(res.read, true);
  assert.equal(res.cases, 2);
  assert.equal(res.green, true);
  assert.equal(res.command.endsWith('drill --aspect no-marker --json'), true);
  assert.deepEqual(cli.calls(), ['drill --aspect no-marker --json'], 'one run, the document — never the text as well');
});

test('yg drill: an empty corpus reads as no cases, never as green', (t) => {
  const cli = drillCli(t, { json: 'drill-empty-6.1.0.json' });
  const res = runDrill(cli.dir, cli.cfg, 'plain-names');
  assert.equal(res.read, true);
  assert.equal(res.cases, 0);
  assert.equal(res.green, false);
});

test('yg drill: a document the exit code contradicts is unread — never green', (t) => {
  // Counts say clean; the drill exited 1, which Yggdrasil uses for a MISS or a FALSE-ALARM.
  const cli = drillCli(t, { jsonExit: 1 });
  const res = runDrill(cli.dir, cli.cfg, 'no-marker');
  assert.equal(res.read, false);
  assert.equal(res.green, false);
  assert.equal(drillFromDoc({ schema: 'yg-drill/1', aspect: 'x', counts: { pass: 2 } }, 0), null, 'a count missing from the document is not zero');
  assert.equal(drillFromDoc({ schema: 'yg-drill/2', aspect: 'x', counts: { pass: 2, miss: 0, falseAlarm: 0, unrun: 0, unsupported: 0 } }, 0), null, 'another version is not this one');
});

test('yg drill: a 6.0.x CLI that refuses --json is asked again and its summary line read', (t) => {
  const cli = drillCli(t, { refuseJson: true });
  const res = runDrill(cli.dir, cli.cfg, 'no-marker');
  assert.equal(res.read, true);
  assert.equal(res.cases, 2);
  assert.equal(res.green, true);
  assert.equal(res.command.endsWith('drill --aspect no-marker'), true);
  assert.deepEqual(cli.calls(), ['drill --aspect no-marker --json', 'drill --aspect no-marker']);
});

test('yg drill: the real summary line reads', () => {
  const real = fixture('drill-6.1.0.txt');
  assert.deepEqual(
    { ...parseDrillSummary(real, 0), line: undefined },
    {
      pass: 2, miss: 0, falseAlarm: 0, unrun: 0, unsupported: 0, line: undefined,
    },
  );
});

test('yg drill: a reworded summary still reads, where the old pattern read nothing', () => {
  const OLD_DRILL_RE = /(\d+) pass · (\d+) MISS · (\d+) FALSE-ALARM · (\d+) unrun · (\d+) unsupported/;
  const variants = {
    // lower case, commas, past tense
    "drill  no-marker — 2 passed, 1 missed, 0 false alarms, 0 unrun, 0 unsupported  (corpus dev)": [2, 1, 0, 0, 0, 1],
    // zero segments dropped (8.6 of the output spec bans them)
    "drill  no-marker: 2 pass  (corpus dev)": [2, 0, 0, 0, 0, 0],
    // another order, and a false alarm
    "yg drill 'no-marker': 1 FALSE-ALARM · 3 pass · 0 MISS · 0 unrun · 0 unsupported.": [3, 0, 1, 0, 0, 1],
  };
  for (const [line, [pass, miss, falseAlarm, unrun, unsupported, exit]] of Object.entries(variants)) {
    assert.equal(OLD_DRILL_RE.test(line), false, `the old pattern read "${line}"`);
    const got = parseDrillSummary(`pass  satisfies-clean/case  [expected satisfied, got satisfied]\n${line}\n`, exit);
    assert.ok(got, `unread: "${line}"`);
    assert.deepEqual([got.pass, got.miss, got.falseAlarm, got.unrun, got.unsupported], [pass, miss, falseAlarm, unrun, unsupported], line);
  }
});

test('yg drill: a count Horde does not recognise, or a line the exit code contradicts, is unread — never green', () => {
  // A renamed outcome: reading its absence as zero would call a missed case clean.
  assert.equal(parseDrillSummary("drill  no-marker: 2 pass · 1 wrong · 0 unrun", 1), null);
  // The line says clean, the drill exited 1 (a MISS or FALSE-ALARM, by Yggdrasil's own exit code).
  assert.equal(parseDrillSummary("drill  no-marker: 2 pass", 1), null);
  // An empty corpus prints no counts at all.
  assert.equal(parseDrillSummary("yg drill 'no-marker': no case corpus found under x — nothing to run.", 0), null);
});

// ---- yg aspects --health: yg-aspects-health/1, and the table only for 6.0.x ------------------

// A CLI that answers `yg aspects --health` like one real release: the document for `--json`, or a
// refusal of `--json` (6.0.x on stderr, a 6.1.0 build from before the document as yg-error/1), and
// the table otherwise.
function healthCli(t, { json = null, refusal = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'yg-stub.mjs');
  const lines = [
    "import { readFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "if (argv[0] === '--version') { console.log('6.1.0'); process.exit(0); }",
    "if (argv.includes('--json')) {",
  ];
  if (json) lines.push(`  process.stdout.write(readFileSync(${JSON.stringify(join(FIXTURES, json))}, 'utf8')); process.exit(0);`);
  else if (refusal === 'stderr') lines.push("  process.stderr.write('Error: --health cannot be combined with --json.\\n'); process.exit(1);");
  else lines.push(`  process.stdout.write(readFileSync(${JSON.stringify(join(FIXTURES, 'health-json-refused-6.1.0.json'))}, 'utf8')); process.exit(1);`);
  lines.push('}', `process.stdout.write(readFileSync(${JSON.stringify(join(FIXTURES, 'health-6.1.0.txt'))}, 'utf8'));`, '');
  writeFileSync(stub, lines.join('\n'));
  return { dir, cfg: { ygCommand: `${process.execPath} ${stub}` } };
}

test('yg aspects --health: the signal and the reading are read off yg-aspects-health/1', (t) => {
  const doc = JSON.parse(fixture('health-6.1.0.json'));
  assert.equal(doc.schema, 'yg-aspects-health/1');
  const got = healthFromDoc(doc);
  assert.deepEqual(got.get('no-marker'), {
    signal: 'active',
    reading: 'estimated catch rate ~100% — uncertainty range is wide (few observations).',
  });
  // A rule the tool never judged: its null signal reads as the table's own em-dash, not a word Horde coins.
  assert.deepEqual(got.get('plain-names'), { signal: '—', reading: null });
  // The same reading the table gives, rule for rule.
  assert.deepEqual([...got], [...parseHealth(fixture('health-6.1.0.txt'))]);
  assert.equal(healthFromDoc(JSON.parse(fixture('check-6.1.0-filled.json'))), null, 'another document is not this one');

  const cli = healthCli(t, { json: 'health-6.1.0.json' });
  const read = readHealth(cli.dir, cli.cfg);
  assert.equal(read.read, true);
  assert.equal(read.health.get('no-marker').signal, 'active');
});

test('yg aspects --health: a CLI with no document is read by its table — 6.0.x and a pre-212 6.1.0 alike', (t) => {
  for (const refusal of ['stderr', 'yg-error']) {
    const cli = healthCli(t, { refusal });
    const read = readHealth(cli.dir, cli.cfg);
    assert.equal(read.read, true, refusal);
    assert.equal(read.health.get('no-marker').signal, 'active', refusal);
  }
});

test('yg aspects --health: the real tables read, on 6.1.0 and on the 6.0.0 floor', () => {
  const v61 = parseHealth(fixture('health-6.1.0.txt'));
  assert.deepEqual(v61.get('no-marker'), {
    signal: 'active',
    reading: 'estimated catch rate ~100% — uncertainty range is wide (few observations).',
  });
  assert.deepEqual(v61.get('plain-names'), { signal: '—', reading: null });
  const v60 = parseHealth(fixture('health-6.0.0.txt'));
  assert.deepEqual([...v60.keys()], ['no-marker', 'plain-names']);
});

test('yg aspects --health: a re-laid table still reads by its column names', () => {
  // The 6.1.0 table re-laid the way a grammar change may: columns reordered with `aspect` no longer
  // first, headings capitalised, every row indented, colour on, the detail heading reworded in case.
  const relaid = [
    '\x1b[1m  Signal  Aspect     Kind           Status\x1b[0m',
    '  active  no-marker  deterministic  enforced',
    '  —       plain-names  llm          advisory',
    '',
    'note: signal detail (catch = violations caught; exposure = times the reviewer judged):',
    '    no-marker: estimated catch rate ~100% — uncertainty range is wide (few observations).',
    '',
  ].join('\n');
  const OLD_HEADER = (l) => /^aspect\s{2,}/.test(l) && /\bsignal\b/.test(l);
  assert.equal(relaid.split('\n').some(OLD_HEADER), false, 'the old header test finds no table');
  const got = parseHealth(relaid);
  assert.ok(got, 'unread');
  assert.deepEqual(got.get('no-marker'), {
    signal: 'active',
    reading: 'estimated catch rate ~100% — uncertainty range is wide (few observations).',
  });
  assert.equal(got.get('plain-names').signal, '—');
});

test('yg aspects --health: text without both column names is unread, not a guess', () => {
  assert.equal(parseHealth('aspect  kind  status\nno-marker  deterministic  enforced\n'), null);
  assert.equal(parseHealth(fixture('health-json-refused-6.1.0.json')), null);
});
