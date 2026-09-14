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
// command was never run at all — the one thing a real CLI cannot be asked.
function recordingYg(dir, { record = 'yg-calls.txt', verdicts = null, packageFails = false } = {}) {
  const stub = join(dir, 'yg-stub.mjs');
  writeFileSync(stub, [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(join(dir, record))}, args.join(' ') + '\\n');`,
    "if (args[0] === '--version') { console.log('6.0.0'); process.exit(0); }",
    "if (args[0] === 'verdict' && args[1] === 'read') {",
    `  console.log(JSON.stringify(${JSON.stringify({ schema: 'yg-verdicts/1', verdicts: verdicts || [] })}));`,
    '  process.exit(0);',
    '}',
    "if (args[0] === 'verdict' && args[1] === 'package') {",
    `  if (${packageFails ? 'true' : 'false'}) { console.error('no pending pair for that rule and unit'); process.exit(1); }`,
    "  console.log(JSON.stringify({ schema: 'yg-review/1', hashes: { pass: 'p', refused: 'r' } }));",
    '  process.exit(0);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stub}`], dir);
  return join(dir, record);
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
  recordingYg(dir, {
    packageFails: true,
    verdicts: [{
      aspect: 'one-sentence', unit: { kind: 'file', path: 'src/auth/login.mjs' }, verdict: 'pass', judge: 'tier-a', hash: 'h', inForce: true,
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
});

test('retro.mjs: two judges that disagree come back with the count and the interval at that sample size', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir);
  seedTicket(dir, 'mission1', '001', { refusals: ['gate: red'], landed: true, files: ['src/auth/login.mjs'] });
  writeClasses(dir, 'mission1', { 'gate:001:0': { class: 'inexpressible' } });
  run('horde.mjs', ['config', 'set', 'retro.judgeSampleRate', '1'], dir);
  run('horde.mjs', ['config', 'set', 'retro.judgeTier', 'tier-b'], dir);
  recordingYg(dir, {
    verdicts: [
      {
        aspect: 'one-sentence', unit: { kind: 'file', path: 'src/auth/login.mjs' }, verdict: 'pass', judge: 'tier-a', hash: 'h', inForce: true,
      },
      {
        aspect: 'one-sentence', unit: { kind: 'file', path: 'src/auth/login.mjs' }, verdict: 'refused', judge: 'tier-b', hash: 'h', inForce: true,
      },
    ],
  });

  const r = run('retro.mjs', ['--tree', dir], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.judge.tier, 'tier-b');
  assert.equal(r.json.judge.disagreements, 1);
  assert.equal(r.json.judge.pairs.length, 1);
  assert.equal(r.json.judge.pairs[0].agrees, false);
  assert.deepEqual(r.json.judge.interval, wilson(1, 1));
  assert.ok(r.json.judge.interval.low > 0 && r.json.judge.interval.high <= 1);
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
