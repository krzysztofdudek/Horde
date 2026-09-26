// Horde reads Yggdrasil through its machine documents, never through the report it writes for a
// person — that report's grammar is Yggdrasil's to change, and 6.1.0 changes it. Every fixture under
// fixtures/yg-output/ is real CLI output, captured from one scratch project (one component, one
// enforced script rule with a two-case drill corpus, one advisory prose rule, no reviewer):
//   *-6.1.0.*  Yggdrasil release/6.1.0 at 865c140b, built in the dev container; the documents that
//              arrived with issue 212 (drill-6.1.0.json, drill-empty-6.1.0.json, health-6.1.0.json,
//              and context-missing-6.1.0.* now carrying node-not-found) from the issue-212 build,
//              Yggdrasil jarl/191-grammar, commit "feat(json): yg drill --json …" (212), over the same project rebuilt from scratch
// Yggdrasil 6.1.0 is Horde's floor, so no 6.0.x output is read, or kept, here: every answer is a
// document, and a CLI that has none is refused by its version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aspectStanding, drillFromDoc, pendingProsePairs, runDrill, runYgCheck, ygJson,
  fillDeterministic, splitFindings,
} from '../node.mjs';
import { healthFromDoc, readHealth } from '../audit.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'yg-output');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

// ---- yg check ---------------------------------------------------------------------------------

test('yg check: which pairs still wait for a verdict is read off yg-check/1, not off --details text', () => {
  // The line the old reader matched. 6.1.0 reports the pending pairs with its own wording per cause,
  // and the line is gone.
  const OLD_PENDING_RE = /No valid verdict for aspect '([^']+)' on (file|node):(.+?)\.\s*$/;
  const pendingIn = (text) => text.split('\n').filter((l) => OLD_PENDING_RE.test(l.trim())).length;
  assert.equal(pendingIn(fixture('check-6.1.0-filled.details.txt')), 0, 'the 6.1.0 report no longer says it');

  // The document names the facts, in its fields.
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
});

// A CLI that answers each read with the real output captured for it: the document for `--json`, the
// report for anything else. The landing asks it which prose pairs still wait for a judgement.
function checkCli(t) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'yg-stub.mjs');
  const json = join(FIXTURES, 'check-6.1.0-filled.json');
  const text = join(FIXTURES, 'check-6.1.0-filled.details.txt');
  writeFileSync(stub, [
    "import { readFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "if (argv[0] === '--version') { console.log('6.1.0'); process.exit(0); }",
    `process.stdout.write(readFileSync(argv.includes('--json') ? ${JSON.stringify(json)} : ${JSON.stringify(text)}, 'utf8'));`,
    'process.exit(1);',
    '',
  ].join('\n'));
  return { dir, cfg: { ygCommand: `${process.execPath} ${stub}` } };
}

test('yg check: the landing names the prose pair still waiting', (t) => {
  const v61 = checkCli(t);
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

// ---- yg drill: the yg-drill/1 document ---------------------------------------------------------

// A CLI that answers `yg drill` like 6.1.0: its document for `--json`, or — standing in for a call
// the CLI does not know — a `usage` refusal, and the text for a person otherwise.
function drillCli(t, { json, jsonExit = 0, refuseJson = false, text = 'drill-6.1.0.txt', textExit = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-drill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'yg-stub.mjs');
  const calls = join(dir, 'calls.log');
  writeFileSync(stub, [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "if (argv[0] === '--version') { console.log('6.1.0'); process.exit(0); }",
    `appendFileSync(${JSON.stringify(calls)}, argv.join(' ') + '\\n');`,
    "if (argv.includes('--json')) {",
    refuseJson
      ? "  console.log(JSON.stringify({ schema: 'yg-error/1', code: 'usage', what: \"unknown option '--json'\", why: null, next: null })); process.exit(1);"
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

test('yg drill: a refusal is unread, and the text for a person is never asked for', (t) => {
  const cli = drillCli(t, { refuseJson: true });
  const res = runDrill(cli.dir, cli.cfg, 'no-marker');
  assert.equal(res.read, false);
  assert.equal(res.green, false);
  assert.match(res.out, /unknown option/, 'the refusal is reported in its own words');
  assert.deepEqual(cli.calls(), ['drill --aspect no-marker --json'], 'one run, never a second without --json');
});

// ---- yg aspects --health: yg-aspects-health/1 --------------------------------------------------

// A CLI that answers `yg aspects --health` like 6.1.0: the document for `--json`, or a refusal
// (a `usage` code, or a build from before the document as its `command-error`), and the table
// printed for a person otherwise — which Horde never asks for.
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
  else if (refusal === 'usage') lines.push("  console.log(JSON.stringify({ schema: 'yg-error/1', code: 'usage', what: \"unknown option '--json'\", why: null, next: null })); process.exit(1);");
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
  assert.equal(healthFromDoc(JSON.parse(fixture('check-6.1.0-filled.json'))), null, 'another document is not this one');

  const cli = healthCli(t, { json: 'health-6.1.0.json' });
  const read = readHealth(cli.dir, cli.cfg);
  assert.equal(read.read, true);
  assert.equal(read.health.get('no-marker').signal, 'active');
});

test('yg aspects --health: a CLI with no document is unread and says why — the table is never read', (t) => {
  const usage = readHealth(healthCli(t, { refusal: 'usage' }).dir, healthCli(t, { refusal: 'usage' }).cfg);
  assert.equal(usage.read, false);
  assert.match(usage.why, /Horde needs Yggdrasil 6\.1\.0 or newer/);
  const refused = healthCli(t, { refusal: 'yg-error' });
  const other = readHealth(refused.dir, refused.cfg);
  assert.equal(other.read, false);
  assert.match(other.why, /refused: --health cannot be combined with --json/);
});

// ---- the landing's reading of a red document (issues 291 and 296) ------------------------------

test('yg check: a fill the document calls aborted is a stop even when it does not say where', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-abort-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = { schema: 'yg-check/1', exit: { code: 1, status: 'aborted', reason: 'stopped' }, issues: [], pairs: [] };
  const body = join(dir, 'doc.json');
  writeFileSync(body, JSON.stringify(doc));
  const stub = join(dir, 'yg-stub.mjs');
  writeFileSync(stub, [
    "import { readFileSync } from 'node:fs';",
    "if (process.argv.includes('--version')) { console.log('6.1.0'); process.exit(0); }",
    `process.stdout.write(readFileSync(${JSON.stringify(body)}, 'utf8'));`,
    'process.exit(1);',
    '',
  ].join('\n'));
  const filled = fillDeterministic({ ygCommand: `${process.execPath} ${stub}` }, dir);
  assert.deepEqual(filled.aborted, { stage: null, issues: [] });
  assert.equal(filled.ok, false);
});

test('splitFindings: the parent\'s findings are counted, and a finding with no detail is the parent\'s only while the branch leaves it alone', () => {
  const refusal = (lines) => ({
    code: 'aspect-violation-enforced', severity: 'error', aspect: 'no-marker', unit: 'node:feature', node: 'feature',
    violations: lines.map((line) => ({ file: 'a.mjs', line, message: 'marker.' })),
  });
  const prose = { code: 'aspect-violation-enforced', severity: 'error', aspect: 'reads-well', unit: 'node:feature', node: 'feature' };
  const parent = { issues: [refusal([1]), prose] };
  const branch = { issues: [refusal([1, 7]), prose] };

  const untouched = splitFindings(branch, parent, { touched: () => false });
  assert.equal(untouched.introduced.length, 1, 'the second identical violation is the branch\'s');
  assert.deepEqual(untouched.introduced[0].violations.map((v) => v.line), [7]);
  assert.deepEqual(untouched.alsoOnParent[0].violations.map((v) => v.line), [1]);
  assert.deepEqual(untouched.inherited.map((f) => f.issue.aspect), ['reads-well'], 'the prose refusal is the parent\'s while nothing it judges moved');

  const touched = splitFindings(branch, parent, { touched: (i) => i.aspect === 'reads-well' });
  assert.ok(touched.introduced.some((f) => f.issue.aspect === 'reads-well'), 'once the branch touches what it judges, it is the branch\'s');

  const twice = splitFindings({ issues: [prose, { ...prose }] }, parent, { touched: () => false });
  assert.equal(twice.introduced.length, 1, 'one more of the same finding than the parent has is the branch\'s');

  const unread = splitFindings(branch, null);
  assert.equal(unread.inherited.length, 0, 'no parent reading, nothing inherited');
});

// Review of 297: the drill is refused on a CLI below the floor by the version it reports, before any
// case runs, and the refusal names the release Horde needs.
test('yg drill: a CLI below the floor (6.0.3) is refused by its version, and no case is run', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-yg-floor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.log');
  const stub = join(dir, 'yg-stub.mjs');
  writeFileSync(stub, [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(calls)}, argv.join(' ') + '\\n');`,
    "if (argv[0] === '--version') { console.log('6.0.3'); process.exit(0); }",
    `process.stdout.write(readFileSync(${JSON.stringify(join(FIXTURES, 'drill-6.1.0.json'))}, 'utf8'));`,
    '',
  ].join('\n'));
  const res = runDrill(dir, { ygCommand: `${process.execPath} ${stub}` }, 'no-marker');
  assert.equal(res.read, false);
  assert.equal(res.stale, true);
  assert.match(res.out, /reports version 6\.0\.3, and Horde needs 6\.1\.0 or newer/);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['--version'], 'the drill itself never ran');
});
