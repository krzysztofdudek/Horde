import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde,
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
  const r = run('tk.mjs', ['new', ...args], dir);
  if (r.code !== 0) throw new Error(`tk new failed: ${r.stderr}`);
  return r.json.id;
}

// The six tickets of the worked example: 101 produces the engine's contract, 102/103/104 consume
// it, 105 waits on all three by hand, 106 is unrelated web work whose files are disjoint from
// 103's. Node boundaries are the horde's own committed node map (no Yggdrasil in this fixture).
function makeSixTicketFixture(dir) {
  initHorde(dir);
  startTicketsAt(dir, 'mission1', 101);
  charter(dir, [
    { id: 'E1', text: 'the engine denies by default', node: 'auth' },
    { id: 'E2', text: 'the api guard asks the engine', node: 'api' },
    { id: 'E3', text: 'the cli asks the engine', node: 'cli' },
    { id: 'E4', text: 'the role tables are gone from the schema', node: 'auth' },
  ]);
  run('node.mjs', ['new', 'auth', '--boundary', 'src/auth/'], dir);
  run('node.mjs', ['new', 'api', '--boundary', 'src/api/', '--depends', 'auth'], dir);
  run('node.mjs', ['new', 'web', '--boundary', 'src/web/', '--depends', 'auth'], dir);
  run('node.mjs', ['new', 'cli', '--boundary', 'src/cli/', '--depends', 'auth'], dir);

  tk(dir, ['policy-engine', '--title', 'policy engine', '--node', 'auth', '--class', 'sonnet',
    '--files', 'src/auth/policy.ts,src/auth/policy.test.ts', '--produces', 'auth/policy@2', '--evidence', 'E1']);
  tk(dir, ['api-guard', '--title', 'api guard on the engine', '--node', 'api', '--class', 'sonnet',
    '--files', 'src/api/guard.ts,src/api/guard.test.ts', '--consumes', 'auth/policy@2', '--evidence', 'E2']);
  tk(dir, ['web-session', '--title', 'web session on the engine', '--node', 'web', '--class', 'sonnet',
    '--files', 'src/web/session.ts,src/web/session.test.ts', '--consumes', 'auth/policy@2']);
  tk(dir, ['cli-auth', '--title', 'cli on the engine', '--node', 'cli', '--class', 'sonnet',
    '--files', 'src/cli/auth.ts,src/cli/auth.test.ts', '--consumes', 'auth/policy@2', '--evidence', 'E3']);
  tk(dir, ['drop-roles', '--title', 'drop the role tables', '--node', 'auth', '--class', 'sonnet',
    '--files', 'src/auth/roles.ts,src/auth/roles.test.ts', '--depends', '102,103,104']);
  tk(dir, ['web-theme', '--title', 'web theme', '--node', 'web', '--class', 'sonnet',
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

  await t.test('the version bump owes an approval to every node that consumes the port', () => {
    const t101 = plan.tickets.find((x) => x.id === '101');
    assert.deepEqual(t101.approvals, ['auth', 'api', 'cli', 'web']);
    const t106 = plan.tickets.find((x) => x.id === '106');
    assert.deepEqual(t106.approvals, ['web']);
  });

  await t.test('cost and waves are counted, not guessed', () => {
    assert.equal(plan.cost.estimate, 36); // six sonnet tickets, weight 3, two runs each
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

  const a = tk(dir, ['session-copy', '--title', 'session copy', '--node', 'web', '--class', 'sonnet',
    '--files', 'src/web/session.ts,src/web/session.test.ts,src/web/util.ts']);
  const b = tk(dir, ['session-rename', '--title', 'session rename', '--node', 'web', '--class', 'sonnet',
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

test('queue.mjs plan: a file three tickets claim is named as a hub', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'core', '--boundary', 'src/core/'], dir);
  const ids = [];
  for (const n of ['one', 'two', 'three']) {
    ids.push(tk(dir, [`hub-${n}`, '--title', `hub ${n}`, '--node', 'core', '--class', 'sonnet',
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
  const a = tk(dir, ['first', '--title', 'first', '--node', 'core', '--class', 'sonnet', '--depends', '002']);
  const b = tk(dir, ['second', '--title', 'second', '--node', 'core', '--class', 'sonnet', '--depends', a]);
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
  const producer = tk(dir, ['engine', '--title', 'engine', '--node', 'auth', '--class', 'sonnet',
    '--produces', 'auth/policy@2']);
  const consumer = tk(dir, ['guard', '--title', 'guard', '--node', 'api', '--class', 'sonnet',
    '--consumes', 'auth/policy@2']);
  run('queue.mjs', ['add', producer], dir);
  run('queue.mjs', ['add', consumer], dir);

  // The producing ticket is dropped after the fact — the consumer is now planning against
  // something nobody is building, and the plan says so instead of laying it out as ready.
  run('tk.mjs', ['status', producer, 'dropped'], dir);
  const plan = run('queue.mjs', ['plan'], dir).json;
  assert.deepEqual(plan.consumesWithoutProducer, [{ ticket: consumer, port: 'auth/policy@2' }]);
  const human = run('queue.mjs', ['plan'], dir, { json: false });
  assert.match(human.stdout, /consumes without a producer: \d+ needs auth\/policy@2/);
});

test('queue.mjs plan: a producer in another team resolves, and the edge points out of the team', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'auth', '--boundary', 'src/auth/'], dir);
  run('node.mjs', ['new', 'api', '--boundary', 'src/api/'], dir);
  run('roster.mjs', ['spawn', 'steward', '--team', 'alfa', '--parent', 'trunk', '--class', 'sonnet'], dir);

  const producer = tk(dir, ['engine', '--title', 'engine', '--node', 'auth', '--class', 'sonnet',
    '--team', 'alfa', '--produces', 'auth/policy@2']);
  const consumer = tk(dir, ['guard', '--title', 'guard', '--node', 'api', '--class', 'sonnet',
    '--consumes', 'auth/policy@2']);
  run('queue.mjs', ['add', consumer], dir);
  run('queue.mjs', ['add', producer, '--team', 'alfa'], dir);

  const plan = run('queue.mjs', ['plan'], dir).json;
  assert.equal(plan.tickets.length, 1);
  assert.deepEqual(plan.edges.map((e) => `${e.from}->${e.on}`), [`${consumer}->alfa:${producer}`]);
  assert.deepEqual(plan.tickets[0].waitsOnOutside, [`alfa:${producer}`]);
  assert.deepEqual(plan.consumesWithoutProducer, []);
});

// --- the graph's own edge, both ways of reading it ---------------------------------
//
// With Yggdrasil the question "who consumes this port" has an authority — `yg impact --node
// <p> --json`, the yg-impact/1 document. Without a CLI that produces it, the same question is
// answered from the relations in the graph files. Both are exercised here against one fixture,
// with a stand-in `yg` that prints a document of the agreed shape.
function makeYggdrasilFixture(dir) {
  const model = join(dir, '.yggdrasil', 'model');
  mkdirSync(join(model, 'auth'), { recursive: true });
  writeFileSync(join(model, 'auth', 'yg-node.yaml'), [
    'name: auth', 'type: domain', 'description: "authorisation"', '',
    'mapping:', '  - src/auth/', '',
    'ports:', '  policy:', '    description: "the policy engine"', '    version: 1',
    '    test: tests/contracts/policy.test.mjs', '',
  ].join('\n'));
  mkdirSync(join(model, 'api'), { recursive: true });
  writeFileSync(join(model, 'api', 'yg-node.yaml'), [
    'name: api', 'type: service', 'description: "the http surface"', '',
    'mapping:', '  - src/api/', '',
    'relations:', '  - target: auth', '    type: uses', '    consumes:', '      - policy', '',
  ].join('\n'));
  mkdirSync(join(model, 'mobile'), { recursive: true });
  writeFileSync(join(model, 'mobile', 'yg-node.yaml'), [
    'name: mobile', 'type: client', 'description: "the app"', '',
    'mapping:', '  - src/mobile/', '',
  ].join('\n'));
  writeFileSync(join(dir, '.yggdrasil', 'yg-architecture.yaml'), 'placeholder: true\n');

  // A stand-in for the Yggdrasil CLI: `impact --node auth --json` answers with the document the
  // layers agreed on, naming one consumer the graph files here do not — mobile — so which of the
  // two readings the plan used is visible in its output.
  writeFileSync(join(dir, 'fake-yg.mjs'), `
const args = process.argv.slice(2);
const schema = process.env.FAKE_YG_SCHEMA || 'yg-impact/1';
if (args[0] === 'impact' && args[2] === 'auth') {
  process.stdout.write(JSON.stringify({
    schema,
    subject: { kind: 'node', path: 'auth' },
    ports: [{ name: 'policy', version: 1, test: 'tests/contracts/policy.test.mjs',
      consumers: [{ node: 'api', relation: 'uses' }, { node: 'mobile', relation: 'uses' }] }],
    dependents: [{ node: 'api', direct: true, relations: [{ type: 'uses', ports: ['policy'] }] }],
    transitive: [],
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ schema, ports: [], dependents: [], transitive: [] }));
`);
  initHorde(dir);
  const producer = tk(dir, ['engine', '--title', 'policy engine', '--node', 'auth', '--class', 'sonnet',
    '--files', 'src/auth/policy.ts', '--produces', 'auth/policy@2']);
  const apiTicket = tk(dir, ['guard', '--title', 'api guard', '--node', 'api', '--class', 'sonnet',
    '--files', 'src/api/guard.ts', '--consumes', 'auth/policy@1']);
  const mobileTicket = tk(dir, ['app', '--title', 'mobile app', '--node', 'mobile', '--class', 'sonnet',
    '--files', 'src/mobile/app.ts', '--consumes', 'auth/policy@1']);
  for (const id of [producer, apiTicket, mobileTicket]) run('queue.mjs', ['add', id], dir);
  return { producer, apiTicket, mobileTicket };
}

test('queue.mjs plan: the graph edge from yg-impact/1 when the CLI produces it, from the graph files when it does not', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { producer, apiTicket, mobileTicket } = makeYggdrasilFixture(dir);

  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${join(dir, 'fake-yg.mjs')}`], dir);

  await t.test('with yg-impact/1 the plan orders every consumer the document names', () => {
    const plan = run('queue.mjs', ['plan'], dir).json;
    const edges = plan.edges.filter((e) => e.why.includes('raises')).map((e) => `${e.from}->${e.on}`).sort();
    assert.deepEqual(edges, [`${apiTicket}->${producer}`, `${mobileTicket}->${producer}`]);
    assert.deepEqual(plan.tickets.find((x) => x.id === producer).approvals, ['auth', 'api', 'mobile']);
    assert.deepEqual(plan.layers, [[producer], [apiTicket, mobileTicket].sort()]);
  });

  await t.test('a CLI whose document says another schema is ignored — the graph files are read', () => {
    const wrongSchema = execFileSync('node', [join(SCRIPTS_DIR, 'queue.mjs'), 'plan', '--json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, FAKE_YG_SCHEMA: 'yg-impact/0' },
    });
    const plan = JSON.parse(wrongSchema);
    const edges = plan.edges.filter((e) => e.why.includes('raises')).map((e) => `${e.from}->${e.on}`);
    assert.deepEqual(edges, [`${apiTicket}->${producer}`]);
    assert.deepEqual(plan.tickets.find((x) => x.id === producer).approvals, ['auth', 'api']);
    assert.deepEqual(plan.layers, [[producer, mobileTicket].sort(), [apiTicket]]);
  });

  await t.test('no CLI at all falls back the same way', () => {
    run('horde.mjs', ['config', 'set', 'ygCommand', 'definitely-not-installed-yg'], dir);
    const plan = run('queue.mjs', ['plan'], dir).json;
    const edges = plan.edges.filter((e) => e.why.includes('raises')).map((e) => `${e.from}->${e.on}`);
    assert.deepEqual(edges, [`${apiTicket}->${producer}`]);
  });
});
