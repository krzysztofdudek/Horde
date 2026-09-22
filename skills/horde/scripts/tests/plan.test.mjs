import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// The mission charter is written through horde.mjs, from stdin — the run() helper is a plain
// argv exec, so the two commands that read stdin get their own tiny wrapper here.
function charter(dir, rows) {
  const body = [
    '# Mission · policy migration', '',
    '## Goal', '', 'Move authorisation from roles to a policy engine.', '',
    '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.text} | ${r.node} | |`),
    '', '## Nodes', '', 'auth, api, web, cli', '',
  ].join('\n');
  return execFileSync('node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit', '--json'], {
    cwd: dir, input: body, encoding: 'utf8',
  });
}

// The horde numbers tickets from 1; the worked example this fixture reproduces numbers them from
// 101, and the plan reads better against the design when the ids match it. The counter is a
// plain integer the ticket tool owns — seeded here, then every ticket is filed by the tool.
function startTicketsAt(dir, horde, n) {
  writeFileSync(join(dir, '.horde', 'hordes', horde, 'counter.json'), `${JSON.stringify({ next: n }, null, 2)}\n`);
}

function tk(dir, args) {
  const r = run('tk.mjs', ['new', ...args, '--evidence', 'it works'], dir);
  if (r.code !== 0) throw new Error(`tk new failed: ${r.stderr}`);
  return r.json.id;
}

// The six tickets of the worked example: 101 produces the engine's contract, 102/103/104 consume
// it, 105 waits on all three by hand, 106 is unrelated web work whose files are disjoint from
// 103's. Node boundaries come from the repository's graph, which `horde init` created.
function makeSixTicketFixture(dir) {
  initHorde(dir);
  startTicketsAt(dir, 'mission1', 101);
  charter(dir, [
    { id: 'E1', text: 'the engine denies by default', node: 'auth' },
    { id: 'E2', text: 'the api guard asks the engine', node: 'api' },
    { id: 'E3', text: 'the cli asks the engine', node: 'cli' },
    { id: 'E4', text: 'the role tables are gone from the schema', node: 'auth' },
  ]);
  addNode(dir, 'auth', { mapping: ['src/auth/**'] });
  addNode(dir, 'api', { mapping: ['src/api/**'], relations: [{ target: 'auth', type: 'uses', consumes: ['policy'] }] });
  addNode(dir, 'web', { mapping: ['src/web/**'], relations: [{ target: 'auth', type: 'uses', consumes: ['policy'] }] });
  addNode(dir, 'cli', { mapping: ['src/cli/**'], relations: [{ target: 'auth', type: 'uses', consumes: ['policy'] }] });

  tk(dir, ['policy-engine', '--title', 'policy engine', '--node', 'auth', '--class', 'standard',
    '--files', 'src/auth/policy.ts,src/auth/policy.test.ts', '--produces', 'auth/policy', '--evidence', 'E1']);
  tk(dir, ['api-guard', '--title', 'api guard on the engine', '--node', 'api', '--class', 'standard',
    '--files', 'src/api/guard.ts,src/api/guard.test.ts', '--consumes', 'auth/policy', '--evidence', 'E2']);
  tk(dir, ['web-session', '--title', 'web session on the engine', '--node', 'web', '--class', 'standard',
    '--files', 'src/web/session.ts,src/web/session.test.ts', '--consumes', 'auth/policy']);
  tk(dir, ['cli-auth', '--title', 'cli on the engine', '--node', 'cli', '--class', 'standard',
    '--files', 'src/cli/auth.ts,src/cli/auth.test.ts', '--consumes', 'auth/policy', '--evidence', 'E3']);
  tk(dir, ['drop-roles', '--title', 'drop the role tables', '--node', 'auth', '--class', 'standard',
    '--files', 'src/auth/roles.ts,src/auth/roles.test.ts', '--depends', '102,103,104']);
  tk(dir, ['web-theme', '--title', 'web theme', '--node', 'web', '--class', 'standard',
    '--files', 'src/web/theme.ts']);
  for (const id of ['101', '102', '103', '104', '105', '106']) run('queue.mjs', ['add', id], dir);
}

test('queue.mjs plan: the six-ticket worked example — layers, critical path, one component, no lock conflict, an evidence row nobody builds', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  makeSixTicketFixture(dir);

  const r = run('queue.mjs', ['plan'], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  const plan = r.json;

  await t.test('the document says what it is', () => {
    assert.equal(plan.schema, 'horde-plan/1');
    assert.equal(plan.team, 'trunk');
    assert.equal(plan.tickets.length, 6);
  });

  await t.test('layers are the topological antichains of the derived DAG', () => {
    assert.deepEqual(plan.layers, [['101', '106'], ['102', '103', '104'], ['105']]);
  });

  await t.test('the edges come from the ports, not from anybody typing them', () => {
    const derived = plan.edges.filter((e) => e.why.startsWith('consumes'));
    assert.deepEqual(derived.map((e) => `${e.from}->${e.on}`).sort(), ['102->101', '103->101', '104->101']);
    const manual = plan.edges.filter((e) => e.why === 'declared dependency');
    assert.deepEqual(manual.map((e) => `${e.from}->${e.on}`).sort(), ['105->102', '105->103', '105->104']);
  });

  await t.test('critical path is three tickets, and the loose ticket is not a second component', () => {
    assert.equal(plan.criticalPath.length, 3);
    assert.deepEqual(plan.criticalPath.tickets, ['101', '102', '105']);
    assert.equal(plan.criticalPath.weight, 9);
    assert.equal(plan.components.length, 1);
    assert.deepEqual(plan.loose, ['106']);
  });

  await t.test('103 and 106 share the node web but not a file, so nothing is locked', () => {
    assert.deepEqual(plan.lockConflicts, []);
    assert.deepEqual(plan.hubFiles, []);
  });

  await t.test('the charter row no ticket names is the one thing nobody is building', () => {
    assert.deepEqual(plan.uncoveredEvidence.map((e) => e.id), ['E4']);
    assert.deepEqual(plan.consumesWithoutProducer, []);
  });

  await t.test('a port change owes an approval to every node that consumes the port', () => {
    const t101 = plan.tickets.find((x) => x.id === '101');
    assert.deepEqual(t101.approvals, ['auth', 'api', 'cli', 'web']);
    const t106 = plan.tickets.find((x) => x.id === '106');
    assert.deepEqual(t106.approvals, ['web']);
  });

  await t.test('weight and waves are counted, not guessed', () => {
    assert.equal(plan.weight.estimate, 36); // six standard tickets, weight 3, two runs each
    assert.equal(plan.waves.estimated, 3);
    assert.equal(plan.waves.parallelism, 6);
  });

  await t.test('the human rendering prints the layers and every finding', () => {
    const human = run('queue.mjs', ['plan'], dir, { json: false });
    assert.match(human.stdout, /L0 {2}101 106/);
    assert.match(human.stdout, /L1 {2}102 103 104/);
    assert.match(human.stdout, /L2 {2}105/);
    assert.match(human.stdout, /critical path: 3 ticket\(s\), weight 9 — 101 → 102 → 105/);
    assert.match(human.stdout, /components: 1 · loose: 106/);
    assert.match(human.stdout, /file locks: none/);
    assert.match(human.stdout, /evidence nobody is building: E4/);
  });

  await t.test('a merged ticket leaves the plan; what remains re-layers itself', () => {
    run('tk.mjs', ['status', '101', 'merged'], dir);
    const after = run('queue.mjs', ['plan'], dir);
    assert.equal(after.json.tickets.length, 5);
    assert.deepEqual(after.json.layers, [['102', '103', '104', '106'], ['105']]);
  });
});

test('queue.mjs plan: two tickets claiming the same file with no order between them, and --apply-order', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'web', '--boundary', 'src/web/'], dir);

  const a = tk(dir, ['session-copy', '--title', 'session copy', '--node', 'web', '--class', 'standard',
    '--files', 'src/web/session.ts,src/web/session.test.ts,src/web/util.ts']);
  const b = tk(dir, ['session-rename', '--title', 'session rename', '--node', 'web', '--class', 'standard',
    '--files', 'src/web/session.ts']);
  run('queue.mjs', ['add', a], dir);
  run('queue.mjs', ['add', b], dir);

  const plan = run('queue.mjs', ['plan'], dir).json;
  assert.equal(plan.lockConflicts.length, 1);
  assert.deepEqual(plan.lockConflicts[0].tickets, [a, b]);
  assert.deepEqual(plan.lockConflicts[0].files, ['src/web/session.ts']);
  assert.deepEqual(plan.lockConflicts[0].order, [b, a]); // fewer files first

  await t.test('--apply-order records the proposed order as an ordinary dependency, with a note', () => {
    const applied = run('queue.mjs', ['plan', '--apply-order'], dir);
    assert.equal(applied.code, 0);
    assert.deepEqual(applied.json.applied.map((x) => `${x.ticket}->${x.on}`), [`${a}->${b}`]);
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === a);
    assert.deepEqual(item.dependsOn, [b]);
    assert.match(item.notes[item.notes.length - 1].text, /plan: ordered after .* both declare src\/web\/session\.ts/);
  });

  await t.test('with an order between them the same two tickets no longer collide', () => {
    const after = run('queue.mjs', ['plan'], dir).json;
    assert.deepEqual(after.lockConflicts, []);
    assert.deepEqual(after.layers, [[b], [a]]);
  });
});

test('queue.mjs plan --apply-order: a file three tickets share gets a chain, not every pair, and skips the one edge that would close a loop with a port', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'] });

  // c consumes core/x; p produces it — a real port edge, c depends on p (buildPlan's own "consumes"
  // edge). p has to exist before c: tk.mjs new refuses a Consumes with no producer yet.
  const p = tk(dir, ['producer', '--title', 'producer', '--node', 'core', '--class', 'standard',
    '--files', 'src/core/shared.ts,src/core/extra.ts', '--produces', 'core/x']);
  const c = tk(dir, ['consumer', '--title', 'consumer', '--node', 'core', '--class', 'standard',
    '--files', 'src/core/shared.ts', '--consumes', 'core/x']);
  // A third ticket on the same file, with nothing to do with the port either way.
  const b = tk(dir, ['bystander', '--title', 'bystander', '--node', 'core', '--class', 'standard',
    '--files', 'src/core/shared.ts,src/core/f1.ts,src/core/f2.ts']);
  for (const id of [p, c, b]) run('queue.mjs', ['add', id], dir);

  // The port edge alone is not a cycle.
  assert.equal(run('queue.mjs', ['plan'], dir).code, 0);

  const r = run('queue.mjs', ['plan', '--apply-order'], dir);
  assert.equal(r.code, 0, r.stderr);

  // --apply-order's own key is fewer declared files first: c (1 file) sorts before p (2), which
  // sorts before b (3) — a chain, not all three pairs. The c/p seam would write "p depends on c",
  // which together with the port edge ("c depends on p") closes a two-ticket loop, so it is
  // skipped and named rather than written; the p/b seam has nothing standing in its way.
  assert.deepEqual(r.json.applied.map((a) => `${a.ticket}->${a.on}`), [`${b}->${p}`]);
  assert.equal(r.json.skipped.length, 1);
  assert.equal(r.json.skipped[0].ticket, p);
  assert.equal(r.json.skipped[0].on, c);
  assert.equal(r.json.skipped[0].file, 'src/core/shared.ts');
  assert.match(r.json.skipped[0].reason, /cycle/);

  const human = run('queue.mjs', ['plan', '--apply-order'], dir, { json: false });
  assert.match(human.stdout, /skipped, would cycle:.*cycle/);

  const items = run('queue.mjs', ['list'], dir).json;
  assert.deepEqual(items.find((i) => i.ticket === p).dependsOn, []);
  assert.deepEqual(items.find((i) => i.ticket === c).dependsOn, []); // the port edge is never written to queue.json
  assert.deepEqual(items.find((i) => i.ticket === b).dependsOn, [p]);

  // No cycle got written: plan still passes.
  const after = run('queue.mjs', ['plan'], dir);
  assert.equal(after.code, 0, after.stderr);
  assert.equal(after.json.cycles.length, 0);
});

test('queue.mjs plan: a file three tickets claim is named as a hub', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'core', '--boundary', 'src/core/'], dir);
  const ids = [];
  for (const n of ['one', 'two', 'three']) {
    ids.push(tk(dir, [`hub-${n}`, '--title', `hub ${n}`, '--node', 'core', '--class', 'standard',
      '--files', `src/core/registry.ts,src/core/${n}.ts`]));
  }
  for (const id of ids) run('queue.mjs', ['add', id], dir);
  const plan = run('queue.mjs', ['plan'], dir).json;
  assert.deepEqual(plan.hubFiles.map((h) => h.file), ['src/core/registry.ts']);
  assert.deepEqual(plan.hubFiles[0].tickets, ids);
  const human = run('queue.mjs', ['plan'], dir, { json: false });
  assert.match(human.stdout, /hub files: src\/core\/registry\.ts/);
});

test('queue.mjs plan: a circle of dependencies is refused, with the circle printed', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'core', '--boundary', 'src/core/'], dir);
  // Two owners, each waiting on the other: the first ticket is filed depending on the number the
  // second will get, the second depending on the first. Both are written by the ticket tool, the
  // way an owner writes them, and the circle only exists once both are on file.
  const a = tk(dir, ['first', '--title', 'first', '--node', 'core', '--class', 'standard', '--depends', '002']);
  const b = tk(dir, ['second', '--title', 'second', '--node', 'core', '--class', 'standard', '--depends', a]);
  assert.equal(b, '002');

  run('queue.mjs', ['add', a], dir);
  run('queue.mjs', ['add', b], dir);
  const r = run('queue.mjs', ['plan'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /depend on each other in a circle/);
  assert.match(r.stderr, new RegExp(`${a}.*${b}|${b}.*${a}`));
});

test('queue.mjs plan: a consumed port nobody produces is named', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'api', '--boundary', 'src/api/'], dir);
  run('node.mjs', ['new', 'auth', '--boundary', 'src/auth/'], dir);
  const producer = tk(dir, ['engine', '--title', 'engine', '--node', 'auth', '--class', 'standard',
    '--produces', 'auth/policy']);
  const consumer = tk(dir, ['guard', '--title', 'guard', '--node', 'api', '--class', 'standard',
    '--consumes', 'auth/policy']);
  run('queue.mjs', ['add', producer], dir);
  run('queue.mjs', ['add', consumer], dir);

  // The producing ticket is dropped after the fact — the consumer is now planning against
  // something nobody is building, and the plan says so instead of laying it out as ready.
  run('tk.mjs', ['status', producer, 'dropped'], dir);
  const plan = run('queue.mjs', ['plan'], dir).json;
  assert.deepEqual(plan.consumesWithoutProducer, [{ ticket: consumer, port: 'auth/policy' }]);
  const human = run('queue.mjs', ['plan'], dir, { json: false });
  assert.match(human.stdout, /consumes without a producer: \d+ needs auth\/policy/);
});

// --- the graph's own edge -----------------------------------------------------------
//
// "Who consumes this port" has exactly one authority — `yg impact --node <p> --json`, the
// yg-impact/1 document — and no second reading to fall back to. A relation naming no port
// resolves to 'default', never to every port the target publishes (Yggdrasil does not offer a
// "consumes it whole" reading any more), so both consumers here name the port explicitly. Both
// must land in the plan, and a CLI that cannot answer must stop the plan rather than quietly
// produce a smaller one.
function makeConsumerFixture(dir) {
  initHorde(dir);
  addNode(dir, 'auth', {
    type: 'module',
    mapping: ['src/auth/**'],
    ports: { policy: { description: 'The policy promise.' } },
  });
  addNode(dir, 'api', {
    mapping: ['src/api/**'],
    relations: [{ target: 'auth', type: 'uses', consumes: ['policy'] }],
  });
  addNode(dir, 'mobile', {
    mapping: ['src/mobile/**'],
    relations: [{ target: 'auth', type: 'uses', consumes: ['policy'] }],
  });

  const producer = tk(dir, ['engine', '--title', 'policy engine', '--node', 'auth', '--class', 'standard',
    '--files', 'src/auth/policy.ts', '--produces', 'auth/policy']);
  const apiTicket = tk(dir, ['guard', '--title', 'api guard', '--node', 'api', '--class', 'standard',
    '--files', 'src/api/guard.ts', '--consumes', 'auth/policy']);
  const mobileTicket = tk(dir, ['app', '--title', 'mobile app', '--node', 'mobile', '--class', 'standard',
    '--files', 'src/mobile/app.ts', '--consumes', 'auth/policy']);
  for (const id of [producer, apiTicket, mobileTicket]) run('queue.mjs', ['add', id], dir);
  return { producer, apiTicket, mobileTicket };
}

test('queue.mjs plan: the graph edge comes from yg-impact/1, and a CLI that cannot answer stops the plan', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { producer, apiTicket, mobileTicket } = makeConsumerFixture(dir);

  await t.test('every consumer the document names is ordered after the port\'s producer', () => {
    const plan = run('queue.mjs', ['plan'], dir).json;
    const edges = plan.edges.filter((e) => e.why.startsWith('consumes')).map((e) => `${e.from}->${e.on}`).sort();
    assert.deepEqual(edges, [`${apiTicket}->${producer}`, `${mobileTicket}->${producer}`]);
    assert.deepEqual(plan.tickets.find((x) => x.id === producer).approvals, ['auth', 'api', 'mobile']);
    assert.deepEqual(plan.layers, [[producer], [apiTicket, mobileTicket].sort()]);
  });

  await t.test('a CLI that cannot be started is a refusal naming what to install, not a smaller plan', () => {
    run('horde.mjs', ['config', 'set', 'ygCommand', 'definitely-not-installed-yg'], dir);
    const r = run('queue.mjs', ['plan'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not be started/);
    assert.match(r.stderr, /@chrisdudek\/yg/);
    assert.match(r.stderr, /config set ygCommand/);
  });
});

test('queue.mjs plan: a ticket with no Files is named as holding its node, and one on a node that maps no code as unable to land a source file', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'] });
  addNode(dir, 'docs', { mapping: [] });
  const declared = tk(dir, ['declared', '--title', 'declared', '--node', 'core', '--class', 'standard', '--files', 'src/core/a.ts']);
  const bare = tk(dir, ['bare-core', '--title', 'bare core', '--node', 'core', '--class', 'standard']);
  const unmapped = tk(dir, ['bare-docs', '--title', 'bare docs', '--node', 'docs', '--class', 'standard']);
  // A node's own log.md is not a work file (queue.mjs's ticketWorkFiles strips it, see issue 042) —
  // declaring only the log counts as declaring nothing, same as `unmapped`. A real file beside it,
  // even one that also lies under the node's own graph directory, is what actually narrows scope.
  const logOnly = tk(dir, ['docs-log-only', '--title', 'docs log only', '--node', 'docs', '--class', 'standard', '--files', '.yggdrasil/model/docs/log.md']);
  const withFilesOnUnmapped = tk(dir, ['docs-with-files', '--title', 'docs with files', '--node', 'docs', '--class', 'standard', '--files', '.yggdrasil/model/docs/log.md,.yggdrasil/model/docs/decisions.md']);
  for (const id of [declared, bare, unmapped, logOnly, withFilesOnUnmapped]) run('queue.mjs', ['add', id], dir);

  const plan = run('queue.mjs', ['plan'], dir).json;
  assert.deepEqual(plan.filesBlockingNode, [
    { ticket: bare, nodes: ['core'] },
    { ticket: unmapped, nodes: ['docs'] },
    { ticket: logOnly, nodes: ['docs'] },
  ]);
  assert.deepEqual(plan.noCodeToLandOn, [
    { ticket: unmapped, nodes: ['docs'] },
    { ticket: logOnly, nodes: ['docs'] },
  ]);

  const human = run('queue.mjs', ['plan'], dir, { json: false }).stdout;
  assert.match(human, new RegExp(`no Files, holding their whole node: ${bare} \\(core\\) · ${unmapped} \\(docs\\) · ${logOnly} \\(docs\\)`));
  assert.match(human, new RegExp(`no Files on a node that maps no code, so no source file can land: ${unmapped} \\(docs\\) · ${logOnly} \\(docs\\)`));

  await t.test('a plan where every ticket names its Files says none, twice', () => {
    run('tk.mjs', ['edit', bare, '--by', 'owner', '--files', 'src/core/b.ts'], dir);
    run('tk.mjs', ['edit', unmapped, '--by', 'owner', '--files', '.yggdrasil/model/docs/yg-node.yaml'], dir);
    run('tk.mjs', ['edit', logOnly, '--by', 'owner', '--files', '.yggdrasil/model/docs/log.md,.yggdrasil/model/docs/yg-node.yaml'], dir);
    const clean = run('queue.mjs', ['plan'], dir).json;
    assert.deepEqual(clean.filesBlockingNode, []);
    assert.deepEqual(clean.noCodeToLandOn, []);
    const text = run('queue.mjs', ['plan'], dir, { json: false }).stdout;
    assert.match(text, /no Files, holding their whole node: none/);
    assert.match(text, /no Files on a node that maps no code: none/);
  });
});
