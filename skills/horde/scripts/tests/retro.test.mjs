import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, initHorde, addNode, run, yg,
  writeEvidenceJudgement, NO_EVIDENCE_LAYER, A_TEST_SUITE,
} from './helpers.mjs';
import { raceOneLock, overlaps, describeRace } from './lock-race/harness.mjs';
import { wilson, ticketDeclares } from '../retro.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Every refusal below goes through run() — a child process — and never by importing retro.mjs
// here: fail() calls process.exit(), which would take this whole test run with it. `wilson` is
// the one exception, because it is arithmetic and refuses nothing.

function git(args, dir) { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); }

function hordeFile(dir, horde, ...parts) {
  return join(dir, '.horde', 'hordes', horde, ...parts);
}

// A graph with two real components, so a taste item has somewhere to be logged and a rule
// proposal has a component to name.
function graphFixture(dir) {
  yg(dir, ['init']);
  addNode(dir, 'auth', { description: 'Signing people in.', mapping: ['src/auth/**'] });
  addNode(dir, 'api', { description: 'The HTTP surface.', mapping: ['src/api/**'] });
  mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
  mkdirSync(join(dir, 'src', 'api'), { recursive: true });
  writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export const login = 1;\n');
  writeFileSync(join(dir, 'src', 'api', 'routes.mjs'), 'export const routes = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
}

// One ticket on disk, the way tk.mjs leaves one: an issue.md, a log.md whose lines are either a
// state entry (what transitionStatus writes) or a remark (what appendLog writes), and — where the
// gate has run — the land result file.
function seedTicket(dir, horde, id, {
  slug = 'a-ticket', remarks = [], states = ['queued'], refusals = [], landed = false,
  noLog = false, badResult = false, files = [], fates = [],
} = {}) {
  const issues = hordeFile(dir, horde, 'teams', 'trunk', 'issues');
  const ticketDir = join(issues, `${id}-${slug}`);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(join(ticketDir, 'issue.md'), [
    `# ${id} · ${slug}`, '', '**Status:** merged',
    // The real **Files:** bold field (templates/ticket.md), not a heading — ticketFiles() parses
    // this exact shape, and a fixture that wrote something else would let a substring match pass
    // a test that a real ticket's issue.md never could.
    ...(files.length ? [`**Files:** ${files.join(', ')}`] : []),
    '',
    '## Acceptance', '', '- [x] it works', '',
  ].join('\n'));
  if (!noLog) {
    const lines = [
      ...states.map((s) => `- 2026-09-11T09:00:00.000Z status: ${s}`),
      ...remarks.map((r) => `- 2026-09-11T10:00:00.000Z ${r}`),
    ];
    writeFileSync(join(ticketDir, 'log.md'), lines.length ? `${lines.join('\n')}\n` : '');
  }

  const resultPath = hordeFile(dir, horde, 'land', `${id}.json`);
  if (badResult) {
    mkdirSync(join(resultPath, '..'), { recursive: true });
    writeFileSync(resultPath, '{"ticket": "001", "checks": [{"name": "gate"');
    return ticketDir;
  }
  if (refusals.length || landed || fates.length) {
    mkdirSync(join(resultPath, '..'), { recursive: true });
    writeFileSync(resultPath, `${JSON.stringify({
      ticket: id,
      branch: `${horde}/t-${id}`,
      sha: 'a'.repeat(40),
      ok: refusals.length === 0,
      checks: [
        ...refusals.map((note, i) => ({ name: ['gate', 'graph', 'mapping', 'judge'][i % 4], ok: false, note })),
        { name: 'tests', ok: true, note: 'the suite is green' },
      ],
      pairs: [],
      brief: null,
      landed: landed ? { ticket: id, sha: `${id}`.padStart(40, 'b'), at: '2026-09-11T11:00:00.000Z' } : null,
      // What `land.mjs --fate` appends once the landing turned out not to have been the end of it.
      ...(fates.length ? { fates } : {}),
    }, null, 2)}\n`);
  }
  return ticketDir;
}

function writeClasses(dir, horde, items) {
  writeFileSync(hordeFile(dir, horde, 'retro-classes.json'), `${JSON.stringify({ items }, null, 2)}\n`);
}

// A stand-in Yggdrasil CLI that records every invocation to a file, so a test can assert that a
// command was never run at all — the one thing a real CLI cannot be asked — and that holds
// verdicts the way a real graph does, because the whole of the two-judge measurement turns on that
// shape:
//
//   * ONE slot per (rule, unit) pair. The lock below is a map keyed by the pair, so two verdicts
//     for one pair cannot be represented at all, and `verdict read` can never answer with two. A
//     fixture free to hand back two entries for one pair — which this used to be — lets a test go
//     green against a CLI nobody has.
//   * Every `verdict record` overwrites that slot, whoever wrote what was there before. Recording
//     the second judge's opinion is what destroys the first, and a test drives that sequence for
//     real rather than describing it.
//   * A verdict is bound to a hash of the inputs WITH THE VERDICT WORD FOLDED IN — `hashFor` over
//     the same code gives one hash for a pass and a different one for a refusal, which is exactly
//     why the recorded entry's own hash cannot be used to ask whether the code moved. `verdict
//     package` prints both, from one content token per pair that `codeMoves` below bumps.
//   * A pair whose CURRENT slot holds a pass still bound to the current content refuses both
//     `verdict package` and `verdict record` outright — the one refusal Yggdrasil's real
//     `resolvePair` raises unconditionally, on a pair whose stored entry is a `kind === 'verified'`
//     pass. The guard is derived fresh from the same content tracking `hashes` above already uses
//     (never a static "in force" flag frozen at record time), so a pass that has since gone stale —
//     `codeMoves` moved the content out from under it — is not "still holding" here either, exactly
//     as the real graph would see it. A REFUSED entry never triggers this, in force or not: the
//     real CLI's `kind === 'refused'` branch is one `resolvePair` lets straight through.
function stubSource({ calls, lock, content, packageFails }) {
  return `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const CALLS = ${JSON.stringify(calls)};
const LOCK = ${JSON.stringify(lock)};
const CONTENT = ${JSON.stringify(content)};
const PACKAGE_FAILS = ${packageFails ? 'true' : 'false'};

const args = process.argv.slice(2);
appendFileSync(CALLS, args.join(' ') + '\\n');

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const target = () => {
  const node = flag('--node');
  return node === null ? { kind: 'file', path: flag('--file') } : { kind: 'node', path: node };
};
const key = (aspect, unit) => aspect + ' ' + unit.kind + ':' + unit.path;
const hashes = (k) => {
  const content = readJson(CONTENT, {})[k] || 'c1';
  return { pass: content + '-pass', refused: content + '-refused' };
};
// The refusal both verdict package and verdict record run through before anything else — the
// stand-in's own resolvePair. Re-derived from LOCK and the current content every call, never from
// a stored flag: only a pass whose recorded hash still equals hashes(k).pass right now is "in
// force"; a refused entry, or a pass the content has since moved past, falls through untouched.
const refuseIfPassInForce = (aspect, unit) => {
  const k = key(aspect, unit);
  const entry = readJson(LOCK, {})[k];
  if (!entry || entry.verdict !== 'pass' || entry.hash !== hashes(k).pass) return;
  console.error(
    aspect + ' on ' + unit.kind + ':' + unit.path + ' already holds a verdict for exactly these inputs. '
    + 'A verdict in force is re-proved by hashing, and recording a second one over it would replace a '
    + 'judgement that still applies with no evidence that anything changed.',
  );
  process.exit(1);
};

if (args[0] === '--version') { console.log('6.0.0'); process.exit(0); }

if (args[0] === 'verdict' && args[1] === 'read') {
  const lock = readJson(LOCK, {});
  console.log(JSON.stringify({
    schema: 'yg-verdicts/1',
    verdicts: Object.keys(lock).sort().map((k) => lock[k]),
  }));
  process.exit(0);
}

if (args[0] === 'verdict' && args[1] === 'package') {
  if (PACKAGE_FAILS) { console.error('no pending pair for that rule and unit'); process.exit(1); }
  const unit = target();
  const aspect = flag('--aspect');
  refuseIfPassInForce(aspect, unit);
  console.log(JSON.stringify({ schema: 'yg-review/1', unit, hashes: hashes(key(aspect, unit)) }));
  process.exit(0);
}

if (args[0] === 'verdict' && args[1] === 'record') {
  const aspect = flag('--aspect');
  const unit = target();
  refuseIfPassInForce(aspect, unit);
  const k = key(aspect, unit);
  const verdict = flag('--verdict');
  const want = hashes(k)[verdict];
  if (want === undefined || flag('--hash') !== want) {
    console.error('The hash this verdict is bound to is not the hash of what is on disk now.');
    process.exit(1);
  }
  const lock = readJson(LOCK, {});
  lock[k] = { aspect, unit, verdict, judge: flag('--by'), hash: want, inForce: true };
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\\n');
  process.exit(0);
}

process.exit(0);
`;
}

const stubPath = (dir) => join(dir, 'yg-stub.mjs');
const lockPath = (dir) => join(dir, 'yg-lock.json');
const contentPath = (dir) => join(dir, 'yg-content.json');

function recordingYg(dir, { record = 'yg-calls.txt', verdicts = null, packageFails = false } = {}) {
  writeFileSync(stubPath(dir), stubSource({
    calls: join(dir, record), lock: lockPath(dir), content: contentPath(dir), packageFails,
  }));

  // A seed goes into the same one-slot map the stub itself writes, and two entries for one pair
  // are refused here rather than quietly collapsing: a test that asked for an impossible shape
  // should say so out loud, not get a plausible-looking one back.
  const seeded = {};
  for (const v of verdicts || []) {
    const k = `${v.aspect} ${v.unit.kind}:${v.unit.path}`;
    if (seeded[k]) {
      throw new Error(`two verdicts seeded for "${k}": a graph holds one verdict per (rule, unit) pair, so `
        + '`yg verdict read` can never answer with two');
    }
    seeded[k] = v;
  }
  writeFileSync(lockPath(dir), `${JSON.stringify(seeded, null, 2)}\n`);
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stubPath(dir)}`], dir);
  return join(dir, record);
}

function stub(dir, args) {
  return execFileSync('node', [stubPath(dir), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A judge takes the pair the tool handed back and runs the command it printed: package it, read
// the hash for the verdict being given, record it. Whatever was in the slot is gone afterwards.
function judgeRecords(dir, { aspect, unit, by, verdict }) {
  const unitFlag = unit.kind === 'node' ? '--node' : '--file';
  const pkg = JSON.parse(stub(dir, ['verdict', 'package', '--aspect', aspect, unitFlag, unit.path]));
  stub(dir, [
    'verdict', 'record', '--aspect', aspect, unitFlag, unit.path,
    '--by', by, '--verdict', verdict, '--hash', pkg.hashes[verdict],
  ]);
}

// The code under a pair changes, so its package prints hashes nothing already recorded is bound
// to. Called again, it moves again.
function codeMoves(dir, { aspect, unit }) {
  const k = `${aspect} ${unit.kind}:${unit.path}`;
  const content = existsSync(contentPath(dir)) ? JSON.parse(readFileSync(contentPath(dir), 'utf8')) : {};
  content[k] = `${content[k] || 'c1'}+`;
  writeFileSync(contentPath(dir), `${JSON.stringify(content, null, 2)}\n`);
}

function ygVerdicts(dir) {
  return JSON.parse(stub(dir, ['verdict', 'read', '--json'])).verdicts;
}

// ---- the interval a disagreement is reported at ------------------------------------------------

// The values below were taken from the implementation where it used to live, before the move, and
// are asserted to the bit. A measurement that changed its answer by moving file would not be the
// same measurement — and every number this tool puts in front of a client rests on that.
test('wilson: the interval is bit-identical to the one this arithmetic gave before it moved file', () => {
  assert.deepEqual(wilson(0, 5), { low: 0, high: 0.43449149475208104 });
  assert.equal(wilson(0, 5).high.toExponential(20), '4.34491494752081042208e-1');

  assert.equal(wilson(1, 5).low.toExponential(20), '3.62231609697874490372e-2');
  assert.equal(wilson(1, 5).high.toExponential(20), '6.24471735881461320616e-1');
  assert.equal(wilson(2, 7).low.toExponential(20), '8.22171657090154939240e-2');
  assert.equal(wilson(2, 7).high.toExponential(20), '6.41070909851787273936e-1');
  assert.equal(wilson(3, 10).low.toExponential(20), '1.07789287486211832201e-1');
  assert.equal(wilson(3, 10).high.toExponential(20), '6.03226780020434727447e-1');
  assert.equal(wilson(0, 100).high.toExponential(20), '3.69948074760019091078e-2');
  assert.equal(wilson(50, 100).low.toExponential(20), '4.03829828590147155154e-1');
  assert.deepEqual(wilson(1, 10, 1.0), { low: 0.03887449732033085, high: 0.2338527754069419 });
});

test('wilson: no samples is null and never a division by zero, and one sample is an interval', () => {
  assert.equal(wilson(0, 0), null);
  assert.equal(wilson(3, 0), null);
  assert.equal(wilson(1, 0), null);

  const one = wilson(1, 1);
  assert.ok(Number.isFinite(one.low) && Number.isFinite(one.high), JSON.stringify(one));
  assert.equal(one.high, 1);
  assert.equal(one.low.toExponential(20), '2.06543291473892942633e-1');
  assert.ok(one.low >= 0 && one.high <= 1);
});

// ---- the brief and the role list ---------------------------------------------------------------

test('brief.mjs retro: the mission-wide one-shot, its disciplines, and the role list it closes', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', {
    remarks: ['the two loops stayed separate — fusing them needed a flag to say which half it was in'],
    refusals: ['gate: 1 test failed — tests/auth.test.mjs:12'],
  });

  await t.test('it renders, with no placeholder left in it, and carries the whole mission', () => {
    const r = run('brief.mjs', ['retro', '--name', 'mission1-retro-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.json.brief, /\{\{/);
    assert.match(r.json.brief, /You are \*\*mission1-retro-1\*\*, running the retrospective/);
    assert.match(r.json.brief, /`gate:001:0` · ticket 001/);
    assert.match(r.json.brief, /`log:001:1` · ticket 001/);
    assert.equal(r.json.items, 2);
  });

  await t.test('it is held to the review discipline and to verification', () => {
    const r = run('brief.mjs', ['retro', '--name', 'mission1-retro-1'], dir);
    const at = r.json.brief.indexOf('## Law');
    assert.ok(at !== -1, 'the brief has a Law section');
    const law = r.json.brief.slice(at);
    // The review discipline's own three words, and verification's own title — both inlined, not
    // named, so an edit to either text reaches this brief without a second copy going stale.
    assert.match(law, /Minor\*\* — taste/);
    assert.match(law, /### Findings with a severity/);
    assert.match(law, /### Evidence before the claim/);
  });

  await t.test('a request for a role this tool does not have is refused, naming every role it does', () => {
    const r = run('brief.mjs', ['steward', '--name', 'x'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: steward/);
    assert.match(r.stderr, /roles: worker, architect, legislate, retro/);
  });
});

// ---- classification ------------------------------------------------------------------------------

function threeRefusalsTwoRemarks(dir) {
  seedTicket(dir, 'mission1', '001', {
    slug: 'login-form',
    refusals: ['gate: 1 test failed — tests/auth.test.mjs:12', 'mapping: src/auth/new.mjs belongs to no component'],
    remarks: ['naming: this area writes readX for file IO — followed that'],
    landed: true,
  });
  seedTicket(dir, 'mission1', '002', {
    slug: 'routes',
    refusals: ['graph: no valid verdict for one rule on node:api'],
    remarks: ['the client meant something narrower than the ticket said; asked and got an answer'],
    landed: true,
  });
}

const FIVE_CLASSES = {
  'gate:001:0': {
    class: 'rule', rule: 'Every change that touches authentication ships a test that fails without it.', node: 'auth', kind: 'check', evidence: 'tests/auth.test.mjs:12',
  },
  'gate:001:1': {
    class: 'rule', rule: 'A file added to this repository belongs to a component in the same commit.', node: 'auth', kind: 'check',
  },
  'log:001:1': { class: 'taste', node: 'auth' },
  'gate:002:0': { class: 'taste', node: 'api' },
  'log:002:1': { class: 'inexpressible' },
};

test('retro.mjs: five items, five classes, and what each class does with its item', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  threeRefusalsTwoRemarks(dir);

  await t.test('the first run gathers the input and asks for the one-shot, writing no document', () => {
    const r = run('retro.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'input');
    assert.equal(r.json.items.length, 5);
    assert.equal(r.json.items.filter((i) => i.source === 'gate').length, 3);
    assert.equal(r.json.items.filter((i) => i.source === 'log').length, 2);
    assert.ok(!existsSync(hordeFile(dir, 'mission1', 'retro.json')), 'no document before the classification exists');
  });

  await t.test('a classification that leaves an item out is refused, naming the key', () => {
    writeClasses(dir, 'mission1', { 'gate:001:0': { class: 'inexpressible' } });
    const r = run('retro.mjs', [], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unclassified: /);
    assert.match(r.stderr, /log:001:1/);
  });

  await t.test('every item comes back with exactly one class and the source it came from', () => {
    writeClasses(dir, 'mission1', FIVE_CLASSES);
    const r = run('retro.mjs', ['--tree', dir], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.items.length, 5);
    assert.equal(r.json.cost, undefined, 'the document carries no cost section');
    for (const it of r.json.items) {
      assert.ok(['rule', 'taste', 'inexpressible'].includes(it.class), it.class);
      assert.ok(['gate', 'log'].includes(it.source), it.source);
      assert.ok(it.ticket, 'every item names its ticket');
    }
  });

  await t.test('a rule item carries the rule and the component; a taste item carries no proposal', () => {
    const r = run('retro.mjs', ['--tree', dir], dir);
    const rules = r.json.items.filter((i) => i.class === 'rule');
    assert.equal(rules.length, 2);
    for (const it of rules) {
      assert.ok(it.proposal.rule.length > 0, 'a rule item says the rule');
      assert.ok(it.proposal.node.length > 0, 'a rule item names the component');
    }
    assert.equal(r.json.law.length, 2);

    for (const it of r.json.items.filter((i) => i.class === 'taste')) {
      assert.equal(it.proposal, null, 'taste proposes nothing');
    }
  });

  await t.test('taste leaves one line in the component\'s own log and nothing anywhere else', () => {
    const log = yg(dir, ['log', 'read', '--node', 'auth']);
    assert.equal(log.code, 0, log.out);
    assert.match(log.out, /readX for file IO/);

    const doc = JSON.parse(readFileSync(hordeFile(dir, 'mission1', 'retro.json'), 'utf8'));
    assert.equal(doc.taste.length, 2);
    // Nothing was proposed, nothing was raised, and nothing went to the client list for a taste
    // item: the component's log is the whole of where it lands.
    for (const it of doc.taste) {
      assert.ok(!doc.law.some((p) => p.evidence === it.text), 'no taste item became a rule proposal');
      assert.ok(!doc.inexpressible.some((x) => x.text === it.text), 'no taste item went to the client list');
    }
  });

  await t.test('the items the law will not say are handed back as facts, never as a written sentence', () => {
    const doc = JSON.parse(readFileSync(hordeFile(dir, 'mission1', 'retro.json'), 'utf8'));
    assert.equal(doc.inexpressible.length, 1);
    const [it] = doc.inexpressible;
    assert.deepEqual(Object.keys(it).sort(), ['source', 'text', 'ticket']);
    assert.equal(it.ticket, '002');
    assert.match(it.text, /the client meant something narrower/);
  });

  await t.test('the document names no seat that no longer exists — a scan by word', () => {
    const json = readFileSync(hordeFile(dir, 'mission1', 'retro.json'), 'utf8');
    const md = readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8');
    for (const word of ['audit', 'auditor', 'roster']) {
      assert.doesNotMatch(json, new RegExp(word, 'i'), `retro.json names "${word}"`);
      assert.doesNotMatch(md, new RegExp(word, 'i'), `retro.md names "${word}"`);
    }
    assert.equal(JSON.parse(json).audit, undefined);
  });

  await t.test('the bar the "will not say" pile is held to is printed beside the number', () => {
    const doc = JSON.parse(readFileSync(hordeFile(dir, 'mission1', 'retro.json'), 'utf8'));
    assert.equal(doc.threshold.count, 1);
    assert.equal(doc.threshold.of, 5);
    assert.equal(doc.threshold.share, 0.2);
    assert.equal(doc.threshold.threshold, null);
    assert.match(doc.threshold.note, /before the next mission starts/);

    run('horde.mjs', ['config', 'set', 'retro.inexpressibleThreshold', '0.1'], dir);
    const r = run('retro.mjs', ['--tree', dir], dir);
    assert.equal(r.json.threshold.threshold, 0.1);
    assert.equal(r.json.threshold.over, true);
    assert.match(readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8'), /against a bar of 0\.1 — OVER/);
  });
});

test('retro.mjs: a classification that does not hold together is refused by key, never half-read', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: it went red'] });

  const only = (given) => {
    writeClasses(dir, 'mission1', { 'gate:001:0': given });
    return run('retro.mjs', ['--tree', dir], dir);
  };

  await t.test('an unknown class', () => {
    const r = only({ class: 'minor' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /has class "minor"/);
  });

  await t.test('a rule with no sentence', () => {
    const r = only({ class: 'rule', node: 'auth', kind: 'check' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /says no rule/);
  });

  await t.test('a rule with no component', () => {
    const r = only({ class: 'rule', rule: 'Something must hold.', kind: 'check' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /names no component/);
  });

  await t.test('a rule with no kind', () => {
    const r = only({ class: 'rule', rule: 'Something must hold.', node: 'auth' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /says kind "\(none\)"/);
  });

  await t.test('taste with no component to log to', () => {
    const r = only({ class: 'taste' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /names no component/);
  });

  await t.test('a key this mission has no item for', () => {
    writeClasses(dir, 'mission1', { 'gate:001:0': { class: 'inexpressible' }, 'gate:999:0': { class: 'inexpressible' } });
    const r = run('retro.mjs', ['--tree', dir], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /gate:999:0/);
  });

  await t.test('a file that will not parse is refused by name, never read as empty', () => {
    writeFileSync(hordeFile(dir, 'mission1', 'retro-classes.json'), '{"items": {"gate:001:0": {"class": "rul');
    const r = run('retro.mjs', ['--tree', dir], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /will not parse/);
    assert.match(r.stderr, /retro-classes\.json/);
  });
});

// ---- the judge measurement -----------------------------------------------------------------------

test('retro.mjs: at a rate of zero nothing is re-judged and no verdict command is run at all', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: it went red'], landed: true });
  writeClasses(dir, 'mission1', { 'gate:001:0': { class: 'inexpressible' } });

  const calls = recordingYg(dir);
  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);

  assert.equal(r.json.judge.sampled, 0);
  assert.deepEqual(r.json.judge.pairs, []);
  assert.equal(r.json.judge.interval, null);
  assert.match(r.json.judge.note, /judgeSampleRate is 0/);

  const said = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(said, /verdict/, `a verdict command was run: ${said}`);
});

test('retro.mjs: at a positive rate the sample has a declared size and comes only from landed tickets', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  // Two landed, two that never landed. Whatever the draw, it may only ever name the first two.
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: red'], landed: true, files: ['src/auth/login.mjs'] });
  seedTicket(dir, 'mission1', '002', { refusals: ['gate: red'], landed: true, files: ['src/api/routes.mjs'] });
  seedTicket(dir, 'mission1', '003', { refusals: ['gate: red'], landed: false });
  seedTicket(dir, 'mission1', '004', { refusals: ['gate: red'], landed: false });
  writeClasses(dir, 'mission1', {
    'gate:001:0': { class: 'inexpressible' },
    'gate:002:0': { class: 'inexpressible' },
    'gate:003:0': { class: 'inexpressible' },
    'gate:004:0': { class: 'inexpressible' },
  });
  run('horde.mjs', ['config', 'set', 'retro.judgeSampleRate', '1'], dir);
  recordingYg(dir, { verdicts: [] });

  for (let i = 0; i < 5; i += 1) {
    const r = run('retro.mjs', ['--tree', dir], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.judge.sampled, 2, 'the whole landed set, at a rate of 1');
    assert.equal(r.json.judge.tickets.length, 2);
    for (const id of r.json.judge.tickets) {
      assert.ok(['001', '002'].includes(id), `${id} never landed and must not be in the sample`);
    }
  }

  const half = run('horde.mjs', ['config', 'set', 'retro.judgeSampleRate', '0.5'], dir);
  assert.equal(half.code, 0, half.stderr);
  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.json.judge.sampled, 1, 'half of two landed tickets is one');
  assert.equal(r.json.judge.tickets.length, 1);
  assert.ok(['001', '002'].includes(r.json.judge.tickets[0]));
});

test('retro.mjs: the sample is seeded from mission state, so two runs on the same landed set draw the same sample', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  // Four landed tickets and a rate below 1, so the draw actually has to choose among them — a
  // fixed seed that always kept the whole set would hide the bug this proves against.
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: red'], landed: true, files: ['src/auth/login.mjs'] });
  seedTicket(dir, 'mission1', '002', { refusals: ['gate: red'], landed: true, files: ['src/api/routes.mjs'] });
  seedTicket(dir, 'mission1', '003', { refusals: ['gate: red'], landed: true, files: ['src/auth/login.mjs'] });
  seedTicket(dir, 'mission1', '004', { refusals: ['gate: red'], landed: true, files: ['src/api/routes.mjs'] });
  writeClasses(dir, 'mission1', {
    'gate:001:0': { class: 'inexpressible' },
    'gate:002:0': { class: 'inexpressible' },
    'gate:003:0': { class: 'inexpressible' },
    'gate:004:0': { class: 'inexpressible' },
  });
  run('horde.mjs', ['config', 'set', 'retro.judgeSampleRate', '0.5'], dir);
  recordingYg(dir, { verdicts: [] });

  const runs = [];
  for (let i = 0; i < 4; i += 1) {
    const r = run('retro.mjs', ['--tree', dir], dir);
    assert.equal(r.code, 0, r.stderr);
    runs.push(r.json.judge);
  }

  const [first, ...rest] = runs;
  assert.equal(first.sampled, 2);
  assert.ok(Number.isInteger(first.seed), 'the document names the seed the sample was drawn with');
  for (const j of rest) {
    assert.equal(j.seed, first.seed, 'the same mission state must derive the same seed');
    assert.deepEqual(j.tickets, first.tickets, 'the same seed over the same pool must draw the same sample, in the same order');
  }

  // The written document is the one this reads back on the next run — the seed and the sample it
  // drew must both be on it, not only on the command's own stdout.
  const doc = JSON.parse(readFileSync(hordeFile(dir, 'mission1', 'retro.json'), 'utf8'));
  assert.equal(doc.judge.seed, first.seed);
  assert.deepEqual(doc.judge.tickets, first.tickets);
});

test('retro.mjs: a packaging refusal on a sampled pair is a reason the sample was skipped, and retro still ends green', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: red'], landed: true, files: ['src/auth/login.mjs'] });
  writeClasses(dir, 'mission1', { 'gate:001:0': { class: 'inexpressible' } });
  run('horde.mjs', ['config', 'set', 'retro.judgeSampleRate', '1'], dir);
  // Refused, not passed: a pass still in force is caught earlier, before packaging is ever
  // attempted (its own test, below) — this fixture is for every OTHER reason `yg verdict package`
  // can refuse, which a still-in-force refusal is free to hit exactly like anything else.
  recordingYg(dir, {
    packageFails: true,
    verdicts: [{
      aspect: 'one-sentence', unit: { kind: 'file', path: 'src/auth/login.mjs' }, verdict: 'refused', judge: 'tier-a', hash: 'h', inForce: true,
    }],
  });

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, `a measurement never refuses: ${r.stderr}`);
  assert.equal(r.json.judge.sampled, 1);
  assert.equal(r.json.judge.disagreements, 0);
  assert.equal(r.json.judge.pairs.length, 0);
  assert.equal(r.json.judge.skipped.length, 1);
  assert.match(r.json.judge.skipped[0].why, /refused/);
  assert.match(r.json.judge.skipped[0].why, /no pending pair/);
  assert.equal(r.json.judge.skipped[0].ticket, '001');
  assert.equal(r.json.judge.passInForce.length, 0, 'a plain packaging refusal is not the pass-in-force kind');
});

// ---- the two-judge comparison, over the sequence that can actually happen -----------------------
//
// A graph holds one verdict per (rule, unit) pair, so the two opinions this measures are never on
// disk at the same time: recording the second judge's is what destroys the first. Every test below
// drives that sequence for real — one run writes the first judgement down, a judge then runs the
// command the tool printed, and a second run puts the two side by side — rather than handing the
// tool two entries for one pair at once, which is a shape no `yg verdict read` can answer with.

const THE_PAIR = { aspect: 'one-sentence', unit: { kind: 'file', path: 'src/auth/login.mjs' } };

function judgeFixture(t) {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: red'], landed: true, files: ['src/auth/login.mjs'] });
  writeClasses(dir, 'mission1', { 'gate:001:0': { class: 'inexpressible' } });
  run('horde.mjs', ['config', 'set', 'retro.judgeSampleRate', '1'], dir);
  run('horde.mjs', ['config', 'set', 'retro.judgeTier', 'tier-b'], dir);
  recordingYg(dir);
  return dir;
}

const samplesFile = (dir) => hordeFile(dir, 'mission1', 'cache', 'judge-samples.json');
const onFile = (dir) => Object.values(JSON.parse(readFileSync(samplesFile(dir), 'utf8')));

test('retro.mjs: two judges that disagree come back with the count and the interval at that sample size', async (t) => {
  const dir = judgeFixture(t);
  // tier-a refuses first, never passes: a pass still in force can never be packaged for a second
  // judge at all (its own test, below), so the only first judgement this measurement can ever
  // capture and later compare is a refusal — or a pass that has already gone stale.
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'refused' });

  // Run one. The slot holds tier-a's refusal and nothing else, so there is nothing yet to
  // compare: the pair comes back on `pending`, with tier-a's opinion written down and the
  // command that puts the same pair to tier-b.
  const first = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.judge.pairs.length, 0);
  assert.equal(first.json.judge.disagreements, 0);
  assert.equal(first.json.judge.pending.length, 1);
  assert.equal(first.json.judge.pending[0].held, 'refused');
  assert.equal(first.json.judge.pending[0].heldBy, 'tier-a');
  assert.match(first.json.judge.pending[0].record, /verdict record .*--by tier-b/);

  const [kept] = onFile(dir);
  assert.equal(kept.judge, 'tier-a');
  assert.equal(kept.verdict, 'refused');

  // The second judge runs exactly that command, and it overwrites the slot. tier-a's verdict is
  // gone from the graph — this is the one thing no later read can undo, and the reason the copy
  // above had to be taken first.
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-b', verdict: 'pass' });
  const inventory = ygVerdicts(dir);
  assert.equal(inventory.length, 1, 'a graph holds one verdict per pair, never two');
  assert.equal(inventory[0].judge, 'tier-b');
  assert.equal(inventory[0].verdict, 'pass');

  // Run two: one opinion on file, one in the slot, two different judges, and they disagree.
  const second = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.judge.tier, 'tier-b');
  assert.equal(second.json.judge.disagreements, 1);
  assert.equal(second.json.judge.pairs.length, 1);
  assert.equal(second.json.judge.pairs[0].agrees, false);
  assert.deepEqual(second.json.judge.interval, wilson(1, 1));
  assert.ok(second.json.judge.interval.low > 0 && second.json.judge.interval.high <= 1);
  assert.equal(second.json.judge.passInForce.length, 0, 'a real disagreement is not the pass-in-force kind either');

  // The figure just asserted above is honest about its own reach: once there is a count to read,
  // the document says outright that it only ever covers pairs whose first judge refused (or had
  // gone stale), never one that passed and still holds — so a reader is never left thinking this
  // disagreement rate was measured over the whole sample.
  assert.match(second.json.judge.note, /only.*REFUSED/);
  assert.match(second.json.judge.note, /never.*PASSED/);
  assert.match(second.json.judge.note, /0 of this sample's pair\(s\) were out of reach/);

  // Both sides of it are named, so the number can be read back and argued with. The two hashes
  // here are NOT equal — a verdict binds to a hash with its own verdict word folded in, so two
  // judges who disagree about code that never moved always record two different hashes. Reading
  // that as "the code changed" would drop every disagreement there is.
  const [p] = second.json.judge.pairs;
  assert.equal(p.held, 'refused');
  assert.equal(p.heldBy, 'tier-a');
  assert.equal(p.second, 'pass');
  assert.equal(p.secondBy, 'tier-b');
  assert.notEqual(kept.hash, inventory[0].hash, 'the two judgements are bound to two different hashes');
  assert.equal(kept.hashes.pass, inventory[0].hash, 'and to the same code, which is what makes them comparable');

  // Running it again says the same thing: the copy is kept, not re-taken, so the measurement does
  // not answer differently every time it is run over the same mission.
  const third = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(third.json.judge.disagreements, 1);
  assert.equal(third.json.judge.pairs.length, 1);
  assert.equal(onFile(dir)[0].at, kept.at, 'the first judgement on file was not written over');
});

test('retro.mjs: two judges that agree are counted as a pair and not as a disagreement', async (t) => {
  const dir = judgeFixture(t);
  // Both refuse: a pass still in force could never be captured as the held first judgement in the
  // first place (its own test, below), so an agreement this measurement can actually reach is two
  // judges refusing the same code alike, not two judges passing it alike.
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'refused' });
  run('retro.mjs', ['--tree', dir], dir);
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-b', verdict: 'refused' });

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.judge.pairs.length, 1);
  assert.equal(r.json.judge.pairs[0].agrees, true);
  assert.equal(r.json.judge.pairs[0].held, 'refused');
  assert.equal(r.json.judge.pairs[0].second, 'refused');
  assert.equal(r.json.judge.disagreements, 0);
  assert.deepEqual(r.json.judge.interval, wilson(0, 1));
  assert.equal(r.json.judge.skipped.length, 0, JSON.stringify(r.json.judge.skipped));
  assert.equal(r.json.judge.passInForce.length, 0, JSON.stringify(r.json.judge.passInForce));
});

test('retro.mjs: two judgements taken over code that moved between them are counted neither way', async (t) => {
  const dir = judgeFixture(t);
  // Refused, not passed — a pass still in force is never even captured as a held first judgement
  // (its own test, below), so the only way this scenario is reachable at all is starting from a
  // refusal.
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'refused' });
  run('retro.mjs', ['--tree', dir], dir);

  // The code under the pair changes, and only then does the second judge reach it. The two are
  // judgements of two different things, and a disagreement between them would mean nothing.
  codeMoves(dir, THE_PAIR);
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-b', verdict: 'refused' });

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, `a measurement never refuses: ${r.stderr}`);
  assert.equal(r.json.judge.pairs.length, 0, 'nothing comparable, so nothing compared');
  assert.equal(r.json.judge.disagreements, 0);
  assert.equal(r.json.judge.interval, null);
  assert.equal(r.json.judge.skipped.length, 1);
  assert.match(r.json.judge.skipped[0].why, /not the same code/);
  assert.equal(r.json.judge.skipped[0].ticket, '001');
  assert.equal(r.json.judge.skipped[0].unit, 'file:src/auth/login.mjs');
  assert.equal(r.json.judge.passInForce.length, 0, 'code moving apart is not the pass-in-force kind either');
});

// ---- a pass that still holds is out of reach, not a plain skip ---------------------------------
//
// `yg verdict package`/`yg verdict record` both resolve a pair through Yggdrasil's own
// `resolvePair`, which refuses outright once a pair already holds a verdict for exactly these
// inputs: recording a second one over it would replace a judgement that still applies with no
// evidence that anything changed. That refusal fires for a PASS in force and never for a REFUSAL
// in force — so a pair whose first judge passed it, and whose pass still holds, can never be
// packaged for a second judge and can never be recorded over. Every test above starts its held
// first judgement from a refusal for exactly this reason; this one is the mirror case, proving
// what happens to the one shape that can never get there.
test('retro.mjs: a pair whose first judge passed it, and whose pass still holds, is out of reach — its own kind of skip, never a silent miscount', async (t) => {
  const dir = judgeFixture(t);
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'pass' });

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, `a measurement never refuses: ${r.stderr}`);
  assert.equal(r.json.judge.pairs.length, 0, 'a pass still in force was never compared');
  assert.equal(r.json.judge.disagreements, 0);
  assert.equal(r.json.judge.interval, null);
  assert.equal(r.json.judge.pending.length, 0, 'nothing is offered to a second judge for a pair that can never reach one');
  assert.equal(r.json.judge.skipped.length, 0, 'not the generic skip pile — its own distinguishable kind');
  assert.equal(r.json.judge.passInForce.length, 1);
  assert.equal(r.json.judge.passInForce[0].ticket, '001');
  assert.equal(r.json.judge.passInForce[0].aspect, 'one-sentence');
  assert.equal(r.json.judge.passInForce[0].unit, 'file:src/auth/login.mjs');
  assert.match(r.json.judge.passInForce[0].why, /tier-a passed this pair and that pass still holds/);
  assert.match(r.json.judge.passInForce[0].why, /can never reach a second judge/);
  assert.ok(!existsSync(samplesFile(dir)), 'nothing was written down — there is no first judgement to compare later');

  // The document itself says the population this run could not reach at all, plainly, rather than
  // a note left over from the "still waiting" case (which nothing here is).
  assert.match(r.json.judge.note, /nothing in it reached a second judge this run/);
  assert.match(r.json.judge.note, /`skipped` and `passInForce`/);
  const md = readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8');
  assert.match(md, /out of reach ticket 001: tier-a passed this pair and that pass still holds/);

  // Running it again says the same thing — this is a structural fact about the pair, re-derived
  // from the graph's own inventory every time, never a one-off command failure that might clear.
  const again = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(again.json.judge.passInForce.length, 1);
  assert.equal(again.json.judge.pending.length, 0);
  assert.ok(!existsSync(samplesFile(dir)));
});

test('retro.mjs: a pair nobody has given a second judgement stays pending, run after run, with the first kept', async (t) => {
  const dir = judgeFixture(t);
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'refused' });

  const first = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.judge.pending.length, 1);
  assert.equal(first.json.judge.pairs.length, 0);
  assert.equal(first.json.judge.passInForce.length, 0, 'a refusal on file is not the pass-in-force kind');
  assert.match(first.json.judge.note, /waiting for the command beside it/);
  const [kept] = onFile(dir);

  const second = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.judge.pending.length, 1);
  assert.equal(second.json.judge.pairs.length, 0);
  assert.equal(second.json.judge.disagreements, 0);
  assert.deepEqual(onFile(dir)[0], kept, 'the first judgement on file is written once and left alone');

  // And the document says whose opinion is being held and what it is, not merely that something
  // is waiting.
  assert.match(
    readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8'),
    /waiting on a second judgement: one-sentence on file:src\/auth\/login\.mjs \(tier-a said refused, written down here\)/,
  );
});

test('retro.mjs: a pair only the second judge has ever judged is a skip, never a judge against themselves', async (t) => {
  const dir = judgeFixture(t);
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-b', verdict: 'pass' });

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.judge.pairs.length, 0, 'one judge is not two judges');
  assert.equal(r.json.judge.disagreements, 0);
  assert.equal(r.json.judge.pending.length, 0);
  assert.equal(r.json.judge.skipped.length, 1);
  assert.match(r.json.judge.skipped[0].why, /no first judgement here for it to be compared against/);
  assert.equal(r.json.judge.passInForce.length, 0, 'a lone second-judge verdict is not the pass-in-force kind');
  assert.ok(!existsSync(samplesFile(dir)), 'and nothing was written down to be compared against itself later');
});

test('the stand-in CLI cannot be made to hold two verdicts for one pair, because a graph cannot', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  assert.throws(
    () => recordingYg(dir, {
      verdicts: [
        { ...THE_PAIR, verdict: 'pass', judge: 'tier-a' },
        { ...THE_PAIR, verdict: 'refused', judge: 'tier-b' },
      ],
    }),
    /one verdict per \(rule, unit\) pair/,
  );

  // And the slot really is last-write-wins: two judges in turn leave one entry, the second's.
  // tier-a refuses first, never passes — a pass still in force can never be packaged or recorded
  // over (the stand-in's own refusal, proved directly below), so the only sequence that can ever
  // put a second judgement in the slot at all starts from a refusal, exactly like every other
  // two-judge fixture in this file.
  recordingYg(dir);
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'refused' });
  assert.deepEqual(ygVerdicts(dir).map((v) => `${v.judge} ${v.verdict}`), ['tier-a refused']);
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-b', verdict: 'pass' });
  assert.deepEqual(ygVerdicts(dir).map((v) => `${v.judge} ${v.verdict}`), ['tier-b pass'],
    'recording the second judgement is what destroys the first');
});

// The real Yggdrasil CLI refuses `verdict package` and `verdict record` outright on a pair whose
// currently recorded verdict is a pass still bound to the current content — `resolvePair`'s own
// `kind === 'verified'` branch (source/cli/src/cli/verdict.ts). Nothing above ever needed the
// stand-in to enforce that: every fixture that reaches a real second `verdict package`/`record`
// call starts its held first judgement from a refusal, precisely because a pass in force can never
// get there. These two tests are what closes the gap that leaves open either way: the stand-in's
// own refusal, proved directly; and retro.mjs meeting that exact refusal for real, not merely its
// own prediction of it.
test('the stand-in CLI refuses verdict package and verdict record on a pair whose pass is still in force, the one refusal the real CLI always raises there', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  recordingYg(dir);
  judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'pass' });
  assert.deepEqual(ygVerdicts(dir).map((v) => `${v.judge} ${v.verdict}`), ['tier-a pass']);

  const unitFlag = THE_PAIR.unit.kind === 'node' ? '--node' : '--file';
  const packageArgs = ['verdict', 'package', '--aspect', THE_PAIR.aspect, unitFlag, THE_PAIR.unit.path];
  const recordArgs = [
    'verdict', 'record', '--aspect', THE_PAIR.aspect, unitFlag, THE_PAIR.unit.path,
    '--by', 'tier-b', '--verdict', 'refused', '--hash', 'whatever-a-second-judge-would-have-been-told',
  ];

  await t.test('verdict package refuses outright — exit 1, naming the pair as already holding a verdict', () => {
    assert.throws(() => stub(dir, packageArgs), (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /already holds a verdict for exactly these inputs/);
      return true;
    });
  });

  await t.test('verdict record refuses the same way, before it ever looks at what --hash was given', () => {
    assert.throws(() => stub(dir, recordArgs), (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /already holds a verdict for exactly these inputs/);
      return true;
    });
  });

  await t.test('a REFUSED entry never triggers this, in force or not — only a pass does', () => {
    recordingYg(dir);
    judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'refused' });
    stub(dir, packageArgs); // throws if wrongly refused — it must not
    judgeRecords(dir, { ...THE_PAIR, by: 'tier-b', verdict: 'pass' });
    assert.deepEqual(ygVerdicts(dir).map((v) => `${v.judge} ${v.verdict}`), ['tier-b pass']);
  });

  await t.test('a pass the content has since moved past is not "in force" either — content-keyed, not a static flag', () => {
    codeMoves(dir, THE_PAIR);
    stub(dir, packageArgs); // throws if wrongly refused — it must not: the recorded hash is now stale
    judgeRecords(dir, { ...THE_PAIR, by: 'tier-a', verdict: 'refused' });
    assert.deepEqual(ygVerdicts(dir).map((v) => `${v.judge} ${v.verdict}`), ['tier-a refused']);
  });
});

test('retro.mjs: a real verdict-package refusal on a still-in-force pass is skipped cleanly even when the inventory did not flag it as in force first', async (t) => {
  const dir = judgeFixture(t);
  // Seeded straight into the slot rather than reached through judgeRecords: a pass whose hash is
  // bound to the CURRENT content — so the stand-in's own content-keyed guard sees it as genuinely
  // still holding — but with inForce explicitly false, the one field measureJudge's own prediction
  // reads to decide whether to call `verdict package` at all (see the `!held` branch in retro.mjs).
  // This is the shape a bug in that prediction would produce: retro.mjs believes there is nothing
  // to skip in advance and calls package for real, and what it meets there is the stand-in's own
  // refusal — not the predicted shortcut, the actual command a caller gets back.
  recordingYg(dir, {
    verdicts: [{
      ...THE_PAIR, verdict: 'pass', judge: 'tier-a', hash: 'c1-pass', inForce: false,
    }],
  });

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, `a measurement never refuses: ${r.stderr}`);
  assert.equal(r.json.judge.sampled, 1);
  assert.equal(r.json.judge.pairs.length, 0);
  assert.equal(r.json.judge.disagreements, 0);
  assert.equal(r.json.judge.pending.length, 0);
  assert.equal(r.json.judge.skipped.length, 1);
  assert.equal(r.json.judge.skipped[0].ticket, '001');
  assert.equal(r.json.judge.skipped[0].unit, 'file:src/auth/login.mjs');
  assert.match(r.json.judge.skipped[0].why, /refused/);
  assert.match(r.json.judge.skipped[0].why, /already holds a verdict for exactly these inputs/);
  assert.equal(
    r.json.judge.passInForce.length, 0,
    'the inventory said inForce: false, so this never took the predicted shortcut — it is a real refusal landing in the ordinary skip pile',
  );
  assert.ok(!existsSync(samplesFile(dir)), 'nothing was written down — the refusal was met before there was a first judgement to keep');
});

test('ticketDeclares: a verdict\'s unit belongs to a ticket by its declared Files, never by substring', (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ticketDir = join(dir, '001-a-ticket');
  mkdirSync(ticketDir, { recursive: true });
  // "src/ab" contains "src/a" as a substring — the exact trap the old text.includes(unit) fell
  // into. A ticket that declared only src/ab must never be credited with a verdict on src/a.
  writeFileSync(join(ticketDir, 'issue.md'), [
    '# 001 · a-ticket', '', '**Status:** merged', '**Files:** src/ab', '',
    '## Acceptance', '', '- [x] it works', '',
  ].join('\n'));

  assert.equal(
    ticketDeclares(dir, {}, ticketDir, 'src/a'),
    false,
    'src/a must not match a ticket that only declared src/ab',
  );
  assert.equal(ticketDeclares(dir, {}, ticketDir, 'src/ab'), true, 'the declared file itself still matches');
});

// ---- broken states -------------------------------------------------------------------------------

test('retro.mjs: a mission with nothing to say gives a document with empty lists and does not refuse', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { states: ['queued', 'merged'] });
  writeClasses(dir, 'mission1', {});

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.items, []);
  assert.deepEqual(r.json.law, []);
  assert.deepEqual(r.json.inexpressible, []);
  assert.equal(r.json.threshold.of, 0);
  assert.equal(r.json.threshold.share, 0);
});

test('retro.mjs: nothing landed at all still gives a document, with no items and no sample', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { states: ['queued'] });
  writeClasses(dir, 'mission1', {});
  run('horde.mjs', ['config', 'set', 'retro.judgeSampleRate', '1'], dir);
  const calls = recordingYg(dir);

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.items, []);
  assert.equal(r.json.judge.sampled, 0);
  assert.match(r.json.judge.note, /nothing landed/);
  const said = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(said, /verdict/);
});

test('retro.mjs: everything that cannot be read is a note on the document, never a stop', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);

  // A result file that will not parse; a ticket whose directory exists with no log at all; a
  // ticket whose log is zero bytes; and one good remark, so the run has something to classify.
  seedTicket(dir, 'mission1', '001', { badResult: true, remarks: ['a remark that still gets read'] });
  seedTicket(dir, 'mission1', '002', { noLog: true, refusals: ['gate: red'] });
  seedTicket(dir, 'mission1', '003', { states: [], remarks: [] });

  const first = run('retro.mjs', [], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.items.filter((i) => i.ticket === '003').length, 0, 'a zero-length log gives no item');
  assert.equal(first.json.items.filter((i) => i.ticket === '001' && i.source === 'gate').length, 0, 'an unparsable result file gives no gate item');
  assert.equal(first.json.items.filter((i) => i.ticket === '002' && i.source === 'gate').length, 1, 'a readable result file beside a missing log still gives its refusal');
  assert.ok(first.json.notes.some((n) => /would not parse/.test(n)), JSON.stringify(first.json.notes));
  assert.ok(first.json.notes.some((n) => /log\.md does not/.test(n)), JSON.stringify(first.json.notes));

  const keys = Object.fromEntries(first.json.items.map((i) => [i.key, { class: 'inexpressible' }]));
  writeClasses(dir, 'mission1', keys);
  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.notes.length >= 2);
  assert.match(readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8'), /## What could not be read/);
});

test('retro.mjs: a document from an earlier run is overwritten, never appended to', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: red', 'mapping: red'] });
  writeClasses(dir, 'mission1', {
    'gate:001:0': { class: 'inexpressible' },
    'gate:001:1': { class: 'inexpressible' },
  });

  const first = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(first.json.inexpressible.length, 2);

  writeClasses(dir, 'mission1', {
    'gate:001:0': { class: 'taste', node: 'auth' },
    'gate:001:1': { class: 'inexpressible' },
  });
  const second = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.items.length, 2, 'the second run replaced the first, it did not add to it');
  assert.equal(second.json.inexpressible.length, 1);

  const doc = JSON.parse(readFileSync(hordeFile(dir, 'mission1', 'retro.json'), 'utf8'));
  assert.equal(doc.items.length, 2);
});

test('retro.mjs: two retrospectives at once leave one document and one line in the component log', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { remarks: ['ordering the cheap check first cut the failing path from 40s to 2s'] });
  writeClasses(dir, 'mission1', { 'log:001:1': { class: 'taste', node: 'auth' } });

  function spawnRetro() {
    const child = spawn('node', [join(SCRIPTS_DIR, 'retro.mjs'), '--tree', dir, '--json'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = new Promise((resolve) => { child.on('close', (code) => resolve({ code, out, err })); });
    return { pid: child.pid, done };
  }

  // Two retros are safe together because the second one finds the first one's lock file already
  // on disk, never because `spawn` happened to start both close enough together to collide by
  // luck — hoping for that is exactly what made this test flaky under machine load (a slow
  // process start can let one finish before the other even begins, or let a loaded machine widen
  // the window between them unpredictably either way). So: let the first retro run alone until
  // its lock file is actually on disk and names its own pid — a fact read off the filesystem, not
  // a guess about how fast two processes start — then start the second. It now always meets a
  // genuinely held lock, on any machine, at any load.
  const lockFile = hordeFile(dir, 'mission1', 'retro.lock');
  async function waitHeldBy(pid, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (existsSync(lockFile)) {
        try {
          if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === pid) return;
        } catch { /* the write is still in flight; keep polling instead of calling it absent */ }
      }
      if (Date.now() >= deadline) throw new Error(`${lockFile} never showed pid ${pid} holding it`);
      await new Promise((r) => { setTimeout(r, 10); });
    }
  }

  const first = spawnRetro();
  await waitHeldBy(first.pid);
  const second = spawnRetro();

  const both = await Promise.all([first.done, second.done]);
  for (const r of both) assert.equal(r.code, 0, r.err);

  const log = yg(dir, ['log', 'read', '--node', 'auth']);
  assert.equal(log.code, 0, log.out);
  const hits = log.out.split('\n').filter((l) => /cut the failing path/.test(l));
  assert.equal(hits.length, 1, `the same taste line was written ${hits.length} time(s):\n${log.out}`);

  const doc = JSON.parse(readFileSync(hordeFile(dir, 'mission1', 'retro.json'), 'utf8'));
  assert.equal(doc.taste.length, 1);
  assert.equal(doc.logged.length, 1);
});

test('retro.mjs: a lock caught half-made is waited for, never taken for an abandoned one', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  // Two real processes take the shipped lock — in child processes, like every other refusal
  // here — with one of them paused mid-creation and the other held at the door until that pause
  // begins. That puts the second process inside the window every run, where a scheduler would
  // need thousands of tries to put it there once. What comes back is the window each one held
  // the lock for, and a lock that holds keeps those apart.
  const race = await raceOneLock(dir, 'retro');
  assert.ok(race.paused, `nothing was ever paused, so this run proves nothing:\n${describeRace(race)}`);
  assert.equal(race.slow.code, 0, describeRace(race));
  assert.equal(race.other.code, 0, describeRace(race));

  const paused = race.slow.window;
  const other = race.other.window;
  assert.ok(paused && paused.ok && other && other.ok, describeRace(race));
  assert.notEqual(paused.pid, other.pid, 'two processes, not one');
  assert.equal(overlaps(paused, other), false,
    'both processes held the retrospective lock at the same time: the one paused mid-creation had '
    + `its file read as an abandoned one and taken.\n${describeRace(race)}`);
});

test('retro.mjs: a ticket directory named in unicode is read through without distortion', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', {
    slug: 'zażółć-gęślą-jaźń-日本語',
    remarks: ['zażółć gęślą jaźń — the note itself is unicode too'],
    refusals: ['gate: ścieżka src/auth/łóżko.mjs belongs to no component'],
  });

  const first = run('retro.mjs', [], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.items.length, 2);
  assert.equal(first.json.items[0].ticket, '001');
  assert.match(first.json.items[0].text, /ścieżka src\/auth\/łóżko\.mjs/);
  assert.match(first.json.items[1].text, /zażółć gęślą jaźń/);

  writeClasses(dir, 'mission1', {
    'gate:001:0': { class: 'inexpressible' },
    'log:001:1': { class: 'taste', node: 'auth' },
  });
  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.inexpressible[0].text, /łóżko\.mjs/);
  const log = yg(dir, ['log', 'read', '--node', 'auth']);
  assert.match(log.out, /zażółć gęślą jaźń/);
});

// ---- what came back after landing --------------------------------------------------------------
//
// A refusal is the law catching something before it landed. A return is the evidence failing after
// everyone had agreed it was enough — the strongest thing a mission writes down about its own bar,
// and the one thing nothing used to read. These tests hold it to being its own source all the way
// through: gathered under its own key, classified like everything else, and named on the document
// whatever class it was given.

test('retro.mjs: a return after landing is its own source, beside the refusals and the remarks', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);

  seedTicket(dir, 'mission1', '001', {
    slug: 'login-form',
    refusals: ['gate: 1 test failed — tests/auth.test.mjs:12'],
    remarks: ['naming: this area writes readX for file IO — followed that'],
    landed: true,
    fates: [{ fate: 'reopened', by: 't-004', at: '2026-09-12T09:00:00.000Z' }],
  });
  seedTicket(dir, 'mission1', '002', {
    slug: 'routes',
    landed: true,
    fates: [{ fate: 'reverted', by: 'c'.repeat(40), at: '2026-09-12T10:00:00.000Z' }],
  });

  await t.test('the gathering run keys and counts returns apart from everything else', () => {
    const r = run('retro.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);

    const bySource = (s) => r.json.items.filter((i) => i.source === s);
    assert.equal(bySource('gate').length, 1);
    assert.equal(bySource('log').length, 1);
    assert.equal(bySource('reopen').length, 1);
    assert.equal(bySource('revert').length, 1);

    const [reopen] = bySource('reopen');
    assert.equal(reopen.key, 'reopen:001:0');
    assert.equal(reopen.ticket, '001');
    assert.match(reopen.text, /^reopened by t-004 —/);
    assert.match(reopen.text, /went red again/);

    const [revert] = bySource('revert');
    assert.equal(revert.key, 'revert:002:0');
    assert.equal(revert.ticket, '002');
    assert.match(revert.text, /^reverted at c{40} —/);
  });

  await t.test('and says so in its own words, never folded into the refusal count', () => {
    const r = run('retro.mjs', [], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 gate refusal\(s\), 1 reopen\(s\), 1 revert\(s\), 1 remark\(s\)/);
  });

  await t.test('a return is classified like any other item, and one left out is refused by key', () => {
    writeClasses(dir, 'mission1', {
      'gate:001:0': { class: 'taste', node: 'auth' },
      'log:001:1': { class: 'taste', node: 'auth' },
      'revert:002:0': { class: 'inexpressible' },
    });
    const r = run('retro.mjs', ['--tree', dir], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unclassified: reopen:001:0/);
  });

  await t.test('the document carries the returns as a list of their own, whatever class each got', () => {
    writeClasses(dir, 'mission1', {
      'gate:001:0': { class: 'taste', node: 'auth' },
      'log:001:1': { class: 'taste', node: 'auth' },
      'reopen:001:0': {
        class: 'rule', rule: 'An evidence row is green only once a test reproduces it without the author.', node: 'auth', kind: 'prose',
      },
      'revert:002:0': { class: 'inexpressible' },
    });
    const r = run('retro.mjs', ['--tree', dir], dir);
    assert.equal(r.code, 0, r.stderr);

    assert.deepEqual(
      r.json.returns.map((x) => `${x.ticket} ${x.source} ${x.class}`).sort(),
      ['001 reopen rule', '002 revert inexpressible'],
    );
    // Named on the document itself, not merely recoverable by filtering the item list.
    const md = readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8');
    const at = md.indexOf('## What came back after landing');
    assert.ok(at !== -1, 'the document has the section');
    const section = md.slice(at).split('\n## ')[0];
    assert.match(section, /- ticket 001 · reopen — reopened by t-004/);
    assert.match(section, /- ticket 002 · revert — reverted at c{40}/);

    // And the classification still did its own work: the rule proposal is there, and the item the
    // law will not say still carries the source it came from.
    assert.equal(r.json.law.length, 1);
    assert.equal(r.json.inexpressible[0].source, 'revert');
  });
});

test('retro.mjs: a mission where nothing came back says so, rather than saying nothing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: it went red'], landed: true });

  writeClasses(dir, 'mission1', { 'gate:001:0': { class: 'inexpressible' } });
  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.returns, []);
  assert.match(
    readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8'),
    /## What came back after landing\n\n\(nothing — no merge on this mission was undone/,
  );
});

// ---- a mission with no evidence layer says so in the retrospective too ------------------------
//
// A retrospective on a mission that had a suite behind it and one on a mission where every row was
// somebody going and looking are read differently, and nothing else on the document says which
// this was. So the document says it, at the top, before anything the mission wrote down is read
// back.
test('retro.mjs: a mission whose charter found no evidence layer says so on the document', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  await writeEvidenceJudgement(dir, NO_EVIDENCE_LAYER);
  seedTicket(dir, 'mission1', '001', { states: ['queued', 'merged'] });
  writeClasses(dir, 'mission1', {});

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.noEvidenceLayer, /^No evidence layer in this repository:/);

  const document = readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8');
  const sentence = document.indexOf('No evidence layer in this repository:');
  assert.notEqual(sentence, -1, document);
  assert.ok(sentence < document.indexOf('## What the law could say'), 'it stands above what it frames');
});

test('retro.mjs: a mission that has an evidence layer says nothing about one', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  await writeEvidenceJudgement(dir, A_TEST_SUITE);
  seedTicket(dir, 'mission1', '001', { states: ['queued', 'merged'] });
  writeClasses(dir, 'mission1', {});

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.noEvidenceLayer, null);
  assert.doesNotMatch(readFileSync(hordeFile(dir, 'mission1', 'retro.md'), 'utf8'), /No evidence layer in this repository/);
});

// ---- the tree the second run's own graph read (taste logging, judge measurement) runs in, with
// and without --horde written out (issue 114) ------------------------------------------------------
//
// The same shared contract every other tool here reads (node.mjs main()'s own comment above its
// resolveTree call, tree.test.mjs, and tick.test.mjs/land.test.mjs/horde.test.mjs's own versions of
// this test): an ordinary run with neither --tree nor --horde stays on cwd, whatever tree that
// happens to be — a resolvable horde is not by itself a second signal for "read trunk instead"
// (ask a-002, decisions.md: always cwd, full stop). --horde WRITTEN OUT is the one thing that does
// mean this horde's own trunk, exactly as queue.mjs plan/quality, tick.mjs, land.mjs and horde.mjs
// done already read it. Before this fix, the second run's own resolveTree call forwarded the
// RESOLVED horde (main()'s own resolveHorde(flags), which defaults to the sole horde in a
// single-horde repository even with nothing typed at all) instead of the raw flag, so a bare second
// run in this single-horde fixture read trunk unconditionally, never cwd. The first (gathering) run
// resolves no tree at all — see its own comment in retro.mjs — and is not retested here.
//
// retro-classes.json has to already exist for the second run to be reached at all (with none on
// file, cmdRetro returns the "spawn the one-shot" reading before any tree is ever resolved) —
// written here exactly like every other second-run test in this file, empty, so this test proves
// only the tree question and nothing about classification. What is left to differ, and what this
// test actually proves, is whether the second run ever provisions this horde's own trunk WORKTREE —
// a resource only --horde written out reaches — while running from a shell sitting on "develop"
// (the mission's own base branch, checked out but never itself mission1/trunk).
test('retro.mjs: no --horde stays on cwd; --horde written out resolves to that horde\'s own trunk instead', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { states: ['queued'] });
  writeClasses(dir, 'mission1', {});
  const trunkWorktree = join(dir, '.horde', 'worktrees', 'mission1', 'trunk');
  git(['checkout', 'develop'], dir);

  await t.test('no --horde at all: cwd — trunk\'s own separate worktree is never touched', () => {
    const r = run('retro.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(trunkWorktree), false, 'trunk\'s own separate worktree was never provisioned');
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), 'develop');
  });

  await t.test('--horde mission1 written out: this horde\'s own trunk worktree gets provisioned, a different tree entirely', () => {
    const r = run('retro.mjs', ['--horde', 'mission1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(trunkWorktree), true, '--horde written out: trunk\'s own separate worktree was provisioned');
    // Shared state, not part of either tree: the main checkout is left exactly where it was.
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), 'develop');
  });
});
