import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode, addAspect, yg, requireYg, MARKER_CHECK,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// node.mjs's "charter edit" takes its content on stdin, which run() (a plain argv exec) cannot
// supply.
function charterEdit(dir, node, stdin) {
  return execFileSync('node', [join(SCRIPTS_DIR, 'node.mjs'), 'charter', 'edit', node, '--json'], {
    cwd: dir, input: stdin, encoding: 'utf8',
  });
}

// ---- the graph is read only through the CLI ---------------------------------------------

test('node.mjs bind: the graph is read through the Yggdrasil CLI, and there is no way around it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('a fresh graph is readable and carries no component yet', () => {
    const r = run('node.mjs', ['bind'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.nodes, []);
  });

  await t.test('a component filed into the graph is listed', () => {
    addNode(dir, 'core', { mapping: ['src/core/**'] });
    addNode(dir, 'web', { mapping: ['src/web/**'], relations: [{ target: 'core', type: 'uses' }] });
    const r = run('node.mjs', ['bind'], dir);
    assert.deepEqual(r.json.nodes, ['core', 'web']);
    assert.match(run('node.mjs', ['bind'], dir, { json: false }).stdout, /graph readable through/);
  });

  await t.test('a CLI that cannot be started refuses, naming what to install', () => {
    run('horde.mjs', ['config', 'set', 'ygCommand', join(dir, 'no-such-yg')], dir);
    const r = run('node.mjs', ['bind'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not be started/);
    assert.match(r.stderr, /npm i -g @chrisdudek\/yg/);
    assert.match(r.stderr, /config set ygCommand/);
  });

  await t.test('a CLI that answers no document refuses, naming the release the documents arrived after', () => {
    const stale = join(dir, 'stale-yg.mjs');
    writeFileSync(stale, [
      "if (process.argv.includes('--version')) { console.log('5.7.3'); process.exit(0); }",
      "console.error(\"error: unknown option '--json'\");",
      'process.exit(1);',
      '',
    ].join('\n'));
    run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stale}`], dir);
    const r = run('node.mjs', ['bind'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /predates/);
    assert.match(r.stderr, /yg-node\/1, yg-context\/1 and yg-impact\/1/);
    assert.match(r.stderr, /later than 5\.8\.0/);
    assert.match(r.stderr, /reports version 5\.7\.3/);
    run('horde.mjs', ['config', 'set', 'ygCommand', requireYg()], dir);
  });
});

// ---- show ------------------------------------------------------------------------------

// A real graph with a real cascade: two rules attached to `src`, which reach `src/api` below it,
// and one attached to `src/api` itself at a status above the rule's own default. Everything
// node.mjs prints about rules comes from `yg context --node <p> --json` — this fixture is what
// makes that answer non-trivial.
function ruleGraph(dir) {
  addAspect(dir, 'house/no-console', {
    status: 'enforced', description: 'No console in shipped code.', check: MARKER_CHECK,
  });
  addAspect(dir, 'house/named-exports', {
    status: 'advisory', description: 'Exports are named.', check: MARKER_CHECK,
  });
  addAspect(dir, 'api/errors-are-typed', {
    name: 'ErrorsAreTyped', status: 'draft', description: 'Errors carry a type.', check: MARKER_CHECK,
  });
  addAspect(dir, 'api/someday', {
    status: 'draft', description: 'A rule nobody enforces yet.', check: MARKER_CHECK,
  });
  addNode(dir, 'src', {
    mapping: ['src/thing.mjs'],
    aspects: ['house/no-console', 'house/named-exports'],
  });
  const apiDir = join(dir, '.yggdrasil', 'model', 'src', 'api');
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(join(apiDir, 'yg-node.yaml'), [
    'name: api', 'type: module', 'description: the api',
    'aspects:',
    '  - id: api/errors-are-typed',
    '    status: advisory',
    '  - api/someday',
    'mapping:', '  - "src/api/**"',
    'relations: []',
    '',
  ].join('\n'));
  mkdirSync(join(dir, 'src', 'api'), { recursive: true });
  writeFileSync(join(dir, 'src', 'thing.mjs'), 'export const thing = 1;\n');
  writeFileSync(join(dir, 'src', 'api', 'handler.mjs'), 'export const handler = 1;\n');
}

test('node.mjs show: the rules in force come from the graph\'s own resolution', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  ruleGraph(dir);

  await t.test('every channel the graph resolves reaches the report, with its effective status', () => {
    const r = run('node.mjs', ['show', 'src/api'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.rules.source, /context --node src\/api --json$/);
    const byId = Object.fromEntries(r.json.rules.aspects.map((a) => [a.id, a]));

    // attached to the node above, reaching this one
    assert.equal(byId['house/no-console'].status, 'enforced');
    assert.match(byId['house/no-console'].via, /ancestor:src/);
    assert.equal(byId['house/named-exports'].status, 'advisory');
    // attached here, and raised above the rule's own draft default at the attachment
    assert.equal(byId['api/errors-are-typed'].status, 'advisory');
    assert.match(byId['api/errors-are-typed'].via, /own:src\/api/);
    assert.equal(byId['api/errors-are-typed'].description, 'ErrorsAreTyped');
    // a draft rule is named as inert, not left out
    assert.equal(byId['api/someday'].status, 'draft');
  });

  await t.test('a component above does not inherit the rules of one below it', () => {
    const r = run('node.mjs', ['show', 'src'], dir);
    assert.deepEqual(r.json.rules.aspects.map((a) => a.id).sort(), ['house/named-exports', 'house/no-console']);
  });

  await t.test('the status word beside each rule says what a refusal costs', () => {
    const r = run('node.mjs', ['show', 'src/api'], dir, { json: false });
    assert.match(r.stdout, /## Rules — what this node's code must satisfy/);
    assert.match(r.stdout, /\[enforced\] — blocks the merge/);
    assert.match(r.stdout, /\[advisory\] — warns, does not block/);
    assert.match(r.stdout, /\[draft\] — not in force yet/);
  });

  await t.test('boundary, type and description come from the component document', () => {
    const r = run('node.mjs', ['show', 'src/api'], dir);
    assert.deepEqual(r.json.boundary, ['src/api/**']);
    assert.equal(r.json.type, 'module');
    assert.equal(r.json.description, 'the api');
  });

  await t.test('show refuses a component the graph does not have', () => {
    const r = run('node.mjs', ['show', 'nope'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such node in the graph/);
  });

  await t.test('the charter\'s inherited-rules section is shown with the rules', () => {
    writeFileSync(join(dir, '.yggdrasil', 'model', 'src', 'api', 'charter.md'), [
      '# src/api', '', '## What lives here', '', 'the api', '',
      '## Rules inherited from above', '',
      '- No console in shipped code. — from the component above, `src` · status `enforced`',
      '', '## Sizing', '', 'small', '',
    ].join('\n'));
    const r = run('node.mjs', ['show', 'src/api'], dir);
    assert.match(r.json.rules.charterInherited, /^## Rules inherited from above/);
    assert.match(r.json.rules.charterInherited, /No console in shipped code/);
    assert.doesNotMatch(r.json.rules.charterInherited, /Sizing/);

    const human = run('node.mjs', ['show', 'src/api'], dir, { json: false });
    const rulesSection = human.stdout.slice(human.stdout.indexOf('## Rules —'), human.stdout.indexOf('## Ports'));
    assert.match(rulesSection, /Rules inherited from above/);
  });
});

// ---- the node's own committed files -------------------------------------------------------

test('node.mjs charter/log: the node\'s charter is committed beside its component file, its log is the graph\'s', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'] });

  await t.test('an empty stdin seeds the charter from the template', () => {
    const parsed = JSON.parse(charterEdit(dir, 'core', ''));
    assert.ok(parsed.bytes > 0);
    const charter = readFileSync(join(dir, '.yggdrasil', 'model', 'core', 'charter.md'), 'utf8');
    assert.match(charter, /# Node · core/);
    assert.doesNotMatch(charter, /\{\{/);
  });

  await t.test('content on stdin is written verbatim', () => {
    JSON.parse(charterEdit(dir, 'core', '# Node · core\n\nedited by the owner\n'));
    assert.match(readFileSync(join(dir, '.yggdrasil', 'model', 'core', 'charter.md'), 'utf8'), /edited by the owner/);
  });

  await t.test('charter edit refuses a component the graph does not have', () => {
    let refused = null;
    try {
      charterEdit(dir, 'invented', '# Node · invented\n');
    } catch (e) { refused = e; }
    assert.ok(refused, 'a component nobody filed has no charter to write');
    assert.match(refused.stderr.toString(), /no such node in the graph/);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'invented')), false);
  });

  await t.test('log prints the graph\'s own command, and --run runs it for real', () => {
    const printed = run('node.mjs', ['log', 'core', 'the boundary was widened for the migration'], dir);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.json.command, /log add --node core --reason/);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'core', 'log.md')), false);

    const ran = run('node.mjs', ['log', 'core', 'the boundary was widened for the migration', '--run'], dir);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.json.ran, true);
    const read = yg(dir, ['log', 'read', '--node', 'core']);
    assert.equal(read.code, 0, read.out);
    assert.match(read.out, /the boundary was widened for the migration/);
  });
});

// ---- ports are the contracts ---------------------------------------------------------------

test('node.mjs contract: a contract is a port on a component, proposed at a version with its test', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'auth', {
    mapping: ['src/auth/**'],
    ports: { policy: { version: 1, test: 'tests/contracts/policy.test.mjs' } },
  });
  addNode(dir, 'api', {
    mapping: ['src/api/**'],
    relations: [{ target: 'auth', type: 'uses', consumes: ['policy'] }],
  });

  await t.test('contracts lists the ports the graph declares, with version, test and consumers', () => {
    const r = run('node.mjs', ['contracts', '--node', 'auth'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.declared, [{
      node: 'auth',
      port: 'policy',
      version: 1,
      test: 'tests/contracts/policy.test.mjs',
      description: 'The policy promise.',
      consumers: ['api'],
    }]);
  });

  let bump;
  await t.test('proposing a bump defaults to one above what the graph publishes, and names the consumers', () => {
    const r = run('node.mjs', ['contract', 'propose', 'auth', 'policy', 'the decision shape gains a reason', '--as', 'tests/contracts/policy.test.mjs', '--by', 'owner-auth'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.version, 2);
    assert.equal(r.json.kind, 'bump');
    assert.equal(r.json.from, 1);
    assert.deepEqual(r.json.consumers, ['api']);
    bump = r.json.id;
  });

  await t.test('a version that does not raise the published one is refused', () => {
    const r = run('node.mjs', ['contract', 'propose', 'auth', 'policy', 'restating what is already there', '--as', 'tests/contracts/policy.test.mjs', '--version', '1', '--by', 'owner-auth'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already publishes version 1/);
  });

  await t.test('a proposal with no test is refused — a port\'s promise IS a test', () => {
    const r = run('node.mjs', ['contract', 'propose', 'auth', 'sessions', 'a new promise', '--by', 'owner-auth'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--as <test-path>/);
  });

  await t.test('a new port on a component that publishes none starts at 1', () => {
    const r = run('node.mjs', ['contract', 'propose', 'api', 'guard', 'the guard the web calls', '--as', 'tests/contracts/guard.test.mjs', '--by', 'owner-api'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.version, 1);
    assert.equal(r.json.kind, 'add');
  });

  await t.test('--pending shows what waits on the architect, and nothing else', () => {
    const r = run('node.mjs', ['contracts', '--pending'], dir);
    assert.equal(r.json.declared.length, 0);
    assert.deepEqual(r.json.proposals.map((p) => `${p.node}/${p.port}@${p.version}`).sort(), ['api/guard@1', 'auth/policy@2']);
  });

  await t.test('an approval prints the filing the architect makes by hand', () => {
    const r = run('node.mjs', ['contract', 'approve', bump, 'the consumers can take it', '--by', 'architect'], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /port proposal 1 approved — auth\/policy@2/);
    assert.match(r.stdout, /\.yggdrasil\/model\/auth\/yg-node\.yaml/);
    assert.match(r.stdout, /log add --node auth/);
    assert.match(r.stdout, /--approve --only-deterministic/);
  });

  await t.test('a vetoed proposal leaves nothing pending, and neither can be ruled twice', () => {
    const p = run('node.mjs', ['contract', 'propose', 'auth', 'policy', 'a second, disputed bump', '--as', 'tests/contracts/policy.test.mjs', '--version', '3', '--by', 'owner-auth'], dir);
    const vetoed = run('node.mjs', ['contract', 'veto', p.json.id, 'duplicates the one already approved', '--by', 'architect'], dir);
    assert.equal(vetoed.json.status, 'vetoed');
    const again = run('node.mjs', ['contract', 'approve', bump, '--by', 'architect'], dir);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already approved/);
  });

  await t.test('the horde wrote nothing into the graph — the port is still at the version the graph declares', () => {
    const doc = JSON.parse(yg(dir, ['node', 'auth', '--json']).out);
    assert.equal(doc.ports.policy.version, 1);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'auth', 'contracts.md')), false);
  });
});

// ---- consumersOf narrows to the port a relation actually names -----------------------------
//
// Yggdrasil normalizes a relation that names no port to portNames: ['default'], so consumersOf
// no longer treats an unnamed relation as a match for every port — only 'default' picks it up.

test('node.mjs contracts: consumersOf narrows to the exact port a relation names, not every port on a shared node', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const LEAF_COUNT = 30;
  addNode(dir, 'shared', {
    mapping: ['src/shared/**'],
    ports: {
      p: { description: 'The p promise.' },
      default: { description: 'The default promise.' },
      ghost: { description: 'Declared, but nothing relates to it.' },
    },
  });
  for (let i = 0; i < LEAF_COUNT; i++) {
    addNode(dir, `leaf${i}`, { mapping: [`src/leaf${i}/**`], relations: [{ target: 'shared', type: 'uses' }] });
  }

  const declaredByPort = () => {
    const r = run('node.mjs', ['contracts', '--node', 'shared'], dir);
    assert.equal(r.code, 0, r.stderr);
    return Object.fromEntries(r.json.declared.map((d) => [d.port, d]));
  };

  await t.test('thirty relations naming no port: the named port has no consumers, default has all thirty', () => {
    const declared = declaredByPort();
    assert.deepEqual(declared.p.consumers, []);
    assert.deepEqual(declared.default.consumers, Array.from({ length: LEAF_COUNT }, (_, i) => `leaf${i}`).sort());
  });

  await t.test('one relation naming the port explicitly: it alone consumes it, default drops by one', () => {
    addNode(dir, 'leaf0', { mapping: ['src/leaf0/**'], relations: [{ target: 'shared', type: 'uses', consumes: ['p'] }] });
    const declared = declaredByPort();
    assert.deepEqual(declared.p.consumers, ['leaf0']);
    assert.equal(declared.default.consumers.length, LEAF_COUNT - 1);
    assert.ok(!declared.default.consumers.includes('leaf0'));
  });

  await t.test('a relation naming both ports counts the node as a consumer of each, once', () => {
    addNode(dir, 'leaf-both', { mapping: ['src/leaf-both/**'], relations: [{ target: 'shared', type: 'uses', consumes: ['default', 'p'] }] });
    const declared = declaredByPort();
    assert.equal(declared.p.consumers.filter((n) => n === 'leaf-both').length, 1);
    assert.equal(declared.default.consumers.filter((n) => n === 'leaf-both').length, 1);
  });

  await t.test('a port with no relation pointing at it has no consumers, and the command does not crash on a missing dependents list', () => {
    const declared = declaredByPort();
    assert.deepEqual(declared.ghost.consumers, []);
  });

  await t.test('a node with zero ports declared returns an empty declared list, not a refusal', () => {
    addNode(dir, 'bare', { mapping: ['src/bare/**'] });
    const r = run('node.mjs', ['contracts', '--node', 'bare'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.declared, []);
  });

  await t.test('yg impact unavailable refuses with a CLI message, not a stack trace', () => {
    run('horde.mjs', ['config', 'set', 'ygCommand', join(dir, 'no-such-yg')], dir);
    const r = run('node.mjs', ['contracts', '--node', 'shared'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not be started/);
    assert.match(r.stderr, /config set ygCommand/);
    run('horde.mjs', ['config', 'set', 'ygCommand', requireYg()], dir);
  });

  await t.test('a yg-impact document at a version Horde does not know is refused by name, not silently emptied', () => {
    const real = requireYg();
    const stub = join(dir, 'stale-impact-yg.mjs');
    writeFileSync(stub, [
      "import { execFileSync } from 'node:child_process';",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'impact' && args.includes('--json')) {",
      "  console.log(JSON.stringify({ schema: 'yg-impact/2' }));",
      '  process.exit(0);',
      '}',
      `const real = ${JSON.stringify(real)}.split(/\\s+/);`,
      'try {',
      "  const out = execFileSync(real[0], [...real.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });",
      '  process.stdout.write(out);',
      '} catch (e) {',
      '  if (e.stdout) process.stdout.write(e.stdout);',
      '  if (e.stderr) process.stderr.write(e.stderr);',
      '  process.exit(e.status || 1);',
      '}',
      '',
    ].join('\n'));
    run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stub}`], dir);
    const r = run('node.mjs', ['contracts', '--node', 'shared'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /predates/);
    assert.match(r.stderr, /yg-impact\/1/);
    run('horde.mjs', ['config', 'set', 'ygCommand', real], dir);
  });

  await t.test('relations[].ports present but not an array does not crash — asArray is the only defense against a document that does not match its own schema', () => {
    const real = requireYg();
    const stub = join(dir, 'malformed-ports-yg.mjs');
    writeFileSync(stub, [
      "import { execFileSync } from 'node:child_process';",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'impact' && args.includes('--json')) {",
      "  console.log(JSON.stringify({ schema: 'yg-impact/1', ports: [], dependents: [{ node: 'leaf-malformed', relations: [{ ports: 'default' }] }] }));",
      '  process.exit(0);',
      '}',
      `const real = ${JSON.stringify(real)}.split(/\\s+/);`,
      'try {',
      "  const out = execFileSync(real[0], [...real.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });",
      '  process.stdout.write(out);',
      '} catch (e) {',
      '  if (e.stdout) process.stdout.write(e.stdout);',
      '  if (e.stderr) process.stderr.write(e.stderr);',
      '  process.exit(e.status || 1);',
      '}',
      '',
    ].join('\n'));
    run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stub}`], dir);
    const r = run('node.mjs', ['contracts', '--node', 'shared'], dir);
    assert.equal(r.code, 0, r.stderr);
    const declared = Object.fromEntries(r.json.declared.map((d) => [d.port, d]));
    assert.deepEqual(declared.p.consumers, []);
    run('horde.mjs', ['config', 'set', 'ygCommand', real], dir);
  });
});

// The mission charter's evidence catalogue, written from stdin through horde.mjs — separate from
// charterEdit() above, which writes a single node's charter through node.mjs.
function hordeCharter(dir, body) {
  return execFileSync('node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit', '--json'], {
    cwd: dir, input: body, encoding: 'utf8',
  });
}

test('queue.mjs plan: a ticket\'s approvals follow consumersOf\'s exact port match, not every neighbour of the node it touches', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  hordeCharter(dir, [
    '# Mission · port narrowing', '',
    '## Goal', '', 'Prove a ticket\'s approvals follow the port it names, not every neighbour.', '',
    '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |', '|---|---|---|---|',
    '| E1 | the shared node ships a p port | shared | |', '',
    '## Nodes', '', 'shared, named1, named2, plain1, plain2', '',
  ].join('\n'));
  addNode(dir, 'shared', { mapping: ['src/shared/**'] });
  addNode(dir, 'named1', { mapping: ['src/named1/**'], relations: [{ target: 'shared', type: 'uses', consumes: ['p'] }] });
  addNode(dir, 'named2', { mapping: ['src/named2/**'], relations: [{ target: 'shared', type: 'uses', consumes: ['p'] }] });
  addNode(dir, 'plain1', { mapping: ['src/plain1/**'], relations: [{ target: 'shared', type: 'uses' }] });
  addNode(dir, 'plain2', { mapping: ['src/plain2/**'], relations: [{ target: 'shared', type: 'uses' }] });

  const newTicket = (args) => {
    const r = run('tk.mjs', ['new', ...args, '--evidence', 'E1'], dir);
    if (r.code !== 0) throw new Error(`tk new failed: ${r.stderr}`);
    return r.json.id;
  };
  const id = newTicket(['bump-p', '--title', 'bump p', '--node', 'shared', '--class', 'sonnet', '--files', 'src/shared/p.ts', '--produces', 'shared/p@1']);
  run('queue.mjs', ['add', id], dir);

  const r = run('queue.mjs', ['plan'], dir);
  assert.equal(r.code, 0, r.stderr);
  const ticket = r.json.tickets.find((t2) => t2.id === id);
  assert.ok(ticket, 'the ticket appears in the plan');
  assert.deepEqual([...ticket.approvals].sort(), ['named1', 'named2', 'shared']);
});

// ---- graph-change proposals ----------------------------------------------------------------

test('node.mjs propose/approve/apply: the horde records the decision, the architect files it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'] });

  await t.test('propose, list open, veto', () => {
    const p = run('node.mjs', ['propose', 'rule', 'never bypass the shared validator', '--by', 'owner1'], dir);
    assert.equal(p.code, 0);
    assert.equal(p.json.status, 'open');
    assert.equal(run('node.mjs', ['proposals', '--open'], dir).json.length, 1);
    const vetoed = run('node.mjs', ['veto', p.json.id, 'not the right layer', '--by', 'architect'], dir);
    assert.equal(vetoed.json.status, 'vetoed');
    assert.equal(run('node.mjs', ['proposals', '--open'], dir).json.length, 0);
  });

  await t.test('apply refuses before approval, closes after, and refuses twice', () => {
    const p = run('node.mjs', ['propose', 'new-node', 'split core\'s widget layer out', '--by', 'owner1'], dir);
    const early = run('node.mjs', ['apply', p.json.id], dir);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /not approved/);

    run('node.mjs', ['approve', p.json.id, '--by', 'architect'], dir);
    const applied = run('node.mjs', ['apply', p.json.id], dir);
    assert.equal(applied.code, 0);
    assert.equal(applied.json.applied, true);

    const again = run('node.mjs', ['apply', p.json.id], dir);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already applied/);
  });

  await t.test('an approved move-boundary names the exact edit, and writes nothing itself', () => {
    const p = run('node.mjs', ['propose', 'move-boundary', 'core should also cover src/core2', '--by', 'owner1', '--node', 'core', '--boundary', 'src/core/**,src/core2/**'], dir);
    assert.deepEqual(p.json.boundary, ['src/core/**', 'src/core2/**']);
    run('node.mjs', ['approve', p.json.id, '--by', 'architect'], dir);
    const applied = run('node.mjs', ['apply', p.json.id], dir, { json: false });
    assert.equal(applied.code, 0);
    assert.match(applied.stdout, /set core's mapping: to src\/core\/\*\*, src\/core2\/\*\*/);
    assert.match(applied.stdout, /yg-architecture\.yaml needs the user's explicit confirmation/);
    // the graph still says what it said — the horde never writes it
    assert.deepEqual(JSON.parse(yg(dir, ['node', 'core', '--json']).out).mapping, ['src/core/**']);
  });

  await t.test('propose move-boundary requires --node and --boundary', () => {
    const r = run('node.mjs', ['propose', 'move-boundary', 'widen core', '--by', 'owner1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires --node/);
  });

  await t.test('--by traces that name in the roster when it is one, for both kinds of ruling', () => {
    const architect = run('roster.mjs', ['spawn', 'architect', '--class', 'opus'], dir);
    assert.equal(architect.code, 0, architect.stderr);
    const architectName = architect.json.name;
    const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
    const backdate = () => {
      const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
      const staleAt = new Date(Date.now() - 120 * 60000).toISOString();
      roster.entries.find((e) => e.name === architectName).lastTrace = staleAt;
      writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
      return staleAt;
    };

    let staleAt = backdate();
    const p = run('node.mjs', ['propose', 'rule', 'traced proposal', '--by', 'owner1'], dir);
    assert.equal(run('node.mjs', ['approve', p.json.id, '--by', architectName], dir).code, 0);
    let after = run('roster.mjs', ['list'], dir).json.find((e) => e.name === architectName);
    assert.notEqual(after.lastTrace, staleAt);

    staleAt = backdate();
    const c = run('node.mjs', ['contract', 'propose', 'core', 'render', 'traced port', '--as', 'tests/render.test.mjs', '--by', 'owner1'], dir);
    assert.equal(run('node.mjs', ['contract', 'approve', c.json.id, '--by', architectName], dir).code, 0);
    after = run('roster.mjs', ['list'], dir).json.find((e) => e.name === architectName);
    assert.notEqual(after.lastTrace, staleAt);
  });
});

test('node.mjs map: the mission\'s components with owner, ports and open port proposals', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'], ports: { render: { version: 2, test: 'tests/render.test.mjs' } } });
  run('node.mjs', ['contract', 'propose', 'core', 'render', 'the render surface gains slots', '--as', 'tests/render.test.mjs', '--by', 'owner1'], dir);

  const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
  writeFileSync(rosterPath, JSON.stringify({
    entries: [{ name: 'mission1-owner-core-1', role: 'owner', node: 'core', parent: null }],
  }, null, 2));

  const m = run('node.mjs', ['map'], dir);
  assert.equal(m.code, 0, m.stderr);
  const row = m.json.find((r) => r.node === 'core');
  assert.equal(row.owner, 'mission1-owner-core-1');
  assert.deepEqual(row.ports, ['render@2']);
  assert.equal(row.openPortProposals, 1);
  // stamps are retired: the lock says what is verified, and map does not keep a second answer
  assert.equal('stamp' in row, false);
});

// ---- the prose rules a judge still owes a verdict on ----------------------------------------

test('node.mjs verdicts: the prose rules waiting on a judgement, with the commands that answer them', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  // A reviewer tier, so the graph has an identity a verdict can bind to. No key, no judge: this is
  // exactly the state the external-judge channel exists for.
  assert.equal(yg(dir, ['init', '--provider', 'claude-code', '--model', 'sonnet']).code, 0);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'thing.mjs'), 'export const thing = 1;\n');
  addAspect(dir, 'reads-well', {
    description: 'Every exported name reads as a sentence a stranger understands.',
    content: '# Reads well\n\nAn exported name must read as something a stranger understands.\n',
  });
  addAspect(dir, 'no-marker', {
    description: 'Source files must not carry an unfinished-work marker.',
    check: MARKER_CHECK,
  });
  addNode(dir, 'core', { mapping: ['src/**'], aspects: ['reads-well', 'no-marker'] });

  await t.test('after the free run, what is left is judgement — and it is named with its commands', () => {
    assert.equal(yg(dir, ['check', '--approve', '--only-deterministic']).code, 1);
    const r = run('node.mjs', ['verdicts'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.pending.map((p) => `${p.aspect} ${p.unitKind}:${p.unit}`), ['reads-well node:core']);
    assert.match(r.json.pending[0].package, /verdict package --aspect reads-well --node core$/);
    assert.match(r.json.pending[0].record, /verdict record --aspect reads-well --node core --by/);
    assert.match(r.json.pending[0].record, /--hash <hashes\.pass or hashes\.refused from the package>/);
  });

  await t.test('the commands it prints are the ones that actually record the verdict', () => {
    const pending = run('node.mjs', ['verdicts', '--by', 'verifier-1'], dir).json.pending[0];
    const pkg = JSON.parse(yg(dir, ['verdict', 'package', '--aspect', 'reads-well', '--node', 'core']).out);
    assert.equal(pkg.schema, 'yg-review/1');
    assert.match(pending.record, /--by verifier-1/);

    const recorded = yg(dir, ['verdict', 'record', '--aspect', 'reads-well', '--node', 'core',
      '--by', 'verifier-1', '--verdict', 'pass', '--hash', pkg.hashes.pass]);
    assert.equal(recorded.code, 0, recorded.out);

    const after = run('node.mjs', ['verdicts'], dir);
    assert.deepEqual(after.json.pending, []);
    assert.equal(after.json.green, true);
    assert.match(run('node.mjs', ['verdicts'], dir, { json: false }).stdout, /no prose rule is waiting/);
  });
});

// ---- E16: node ownership is exclusive across live hordes on one repository --------------------

test('node.mjs bind: node-lease-across-hordes — exclusive across live hordes, --take needs a ruled escalation', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'alpha');
  initHorde(dir, 'beta');
  addNode(dir, 'shared', { mapping: ['src/shared/**'] });

  await t.test('the first horde binds a free node', () => {
    const r = run('node.mjs', ['bind', 'shared', '--horde', 'alpha'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.status, 'claimed');
    assert.equal(r.json.horde, 'alpha');
  });

  await t.test('binding it again for the same horde is a no-op, not a refusal', () => {
    const r = run('node.mjs', ['bind', 'shared', '--horde', 'alpha'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.status, 'held');
  });

  let refusalText;
  await t.test('a second live horde is refused, naming the holder and its last activity', () => {
    const r = run('node.mjs', ['bind', 'shared', '--horde', 'beta'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /leased by horde "alpha"/);
    assert.match(r.stderr, /last activity/);
    assert.match(r.stderr, /not archived/);
    refusalText = r.stderr.trim();
  });

  await t.test('the refusal names the escalation path, and --take without one is refused too', () => {
    assert.match(refusalText, /--take --escalation <id>/);
    const r = run('node.mjs', ['bind', 'shared', '--horde', 'beta', '--take'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--escalation <id>/);
  });

  let escalationId;
  await t.test('--take against an escalation that has not been ruled yet is refused', () => {
    const esc = run('escalate.mjs', ['add', 'beta needs shared', '--kind', 'conflict', '--horde', 'beta'], dir);
    assert.equal(esc.code, 0);
    escalationId = esc.json.id;
    const r = run('node.mjs', ['bind', 'shared', '--horde', 'beta', '--take', '--escalation', escalationId], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not ruled/);
  });

  await t.test('--take over a ruled escalation succeeds and writes the take-over to the graph\'s own log', () => {
    const ruled = run('escalate.mjs', ['rule', escalationId, 'beta takes "shared"; alpha no longer needs it', '--horde', 'beta'], dir);
    assert.equal(ruled.code, 0);

    const taken = run('node.mjs', ['bind', 'shared', '--horde', 'beta', '--take', '--escalation', escalationId], dir);
    assert.equal(taken.code, 0);
    assert.equal(taken.json.status, 'taken');
    assert.equal(taken.json.from, 'alpha');
    assert.equal(taken.json.escalation, escalationId);
    assert.equal(taken.json.logged, true);

    const log = yg(dir, ['log', 'read', '--node', 'shared']);
    assert.equal(log.code, 0, log.out);
    assert.match(log.out, new RegExp(`took the lease on "shared" from horde "alpha" over escalation ${escalationId}`));

    // alpha lost the lease entirely — beta is now the live holder, so alpha is refused in turn,
    // exactly as beta was before the take-over
    const stillAlpha = run('node.mjs', ['bind', 'shared', '--horde', 'alpha'], dir);
    assert.equal(stillAlpha.code, 1);
    assert.match(stillAlpha.stderr, /leased by horde "beta"/);
  });
});

test('node.mjs bind: archiving a horde releases its leases', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'gone');
  initHorde(dir, 'stays');
  run('node.mjs', ['bind', 'legacy', '--horde', 'gone'], dir);

  await t.test('a live holder still refuses', () => {
    const r = run('node.mjs', ['bind', 'legacy', '--horde', 'stays'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /leased by horde "gone"/);
  });

  await t.test('archiving the holder releases the lease', () => {
    const arch = run('horde.mjs', ['archive', 'gone'], dir);
    assert.equal(arch.code, 0);
    assert.deepEqual(arch.json.releasedLeases, ['legacy']);
  });

  await t.test('the freed node now binds cleanly, with no --take needed', () => {
    const r = run('node.mjs', ['bind', 'legacy', '--horde', 'stays'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.status, 'claimed');
    assert.equal(r.json.freedFrom, null);
  });
});
