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
    assert.match(r.stderr, /later than 6\.0\.0/);
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
});

// ---- the node's own committed files -------------------------------------------------------

test('node.mjs log: the node\'s log is the graph\'s own', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'] });

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

// node charters (charter.md per component, and node.mjs's own "charter edit" command) are gone
// entirely — task 014 deleted templates/node-charter.md and the command with it. "charter edit"
// now falls straight through to the dispatcher's generic unknown-command branch, the same as any
// other made-up word, rather than a charter-specific refusal.
test('node.mjs charter: "charter edit" is gone — refused as an unknown command, not a specific charter error', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'] });

  await t.test('charter edit falls through to the generic unknown-command refusal', () => {
    const r = run('node.mjs', ['charter', 'edit', 'core'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown command: charter/);
    assert.doesNotMatch(r.stderr, /no such node in the graph/); // not the old, node-specific charter refusal
    assert.match(r.stderr, /--help/);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'core', 'charter.md')), false);
  });

  await t.test('--help, reached the same generic path, names commands that actually exist', () => {
    const help = run('node.mjs', ['--help'], dir, { json: false });
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /\bbind\b/);
    assert.match(help.stdout, /\bshow\b/);
    assert.doesNotMatch(help.stdout, /charter edit/);
  });
});

// ---- ports are the contracts ---------------------------------------------------------------

test('node.mjs contract: a contract is a port on a component, proposed by name — there is no version', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'auth', {
    mapping: ['src/auth/**'],
    ports: { policy: { description: 'The policy promise.' } },
  });
  addNode(dir, 'api', {
    mapping: ['src/api/**'],
    relations: [{ target: 'auth', type: 'uses', consumes: ['policy'] }],
  });

  await t.test('contracts lists the ports the graph declares, with description and consumers', () => {
    const r = run('node.mjs', ['contracts', '--node', 'auth'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.declared, [{
      node: 'auth',
      port: 'policy',
      description: 'The policy promise.',
      consumers: ['api'],
    }]);
  });

  let change;
  await t.test('proposing a change to a published port names it and its consumers', () => {
    const r = run('node.mjs', ['contract', 'propose', 'auth', 'policy', 'the decision shape gains a reason', '--by', 'owner-auth'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.kind, 'change');
    assert.deepEqual(r.json.consumers, ['api']);
    change = r.json.id;
  });

  await t.test('a new port on a component that publishes none is an add, with no consumers yet', () => {
    const r = run('node.mjs', ['contract', 'propose', 'api', 'guard', 'the guard the web calls', '--by', 'owner-api'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.kind, 'add');
    assert.deepEqual(r.json.consumers, []);
  });

  await t.test('--pending shows what waits on the architect, and nothing else', () => {
    const r = run('node.mjs', ['contracts', '--pending'], dir);
    assert.equal(r.json.declared.length, 0);
    assert.deepEqual(r.json.proposals.map((p) => `${p.node}/${p.port}`).sort(), ['api/guard', 'auth/policy']);
  });

  await t.test('an approval prints the filing the architect makes by hand', () => {
    const r = run('node.mjs', ['contract', 'approve', change, 'the consumers can take it', '--by', 'architect'], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`port proposal ${change} approved — auth/policy`));
    assert.match(r.stdout, /\.yggdrasil\/model\/auth\/yg-node\.yaml/);
    assert.match(r.stdout, /log add --node auth/);
    assert.match(r.stdout, /--approve --only-deterministic/);
  });

  await t.test('a vetoed proposal leaves nothing pending, and neither can be ruled twice', () => {
    const p = run('node.mjs', ['contract', 'propose', 'auth', 'policy', 'a second, disputed change', '--by', 'owner-auth'], dir);
    const vetoed = run('node.mjs', ['contract', 'veto', p.json.id, 'duplicates the one already approved', '--by', 'architect'], dir);
    assert.equal(vetoed.json.status, 'vetoed');
    const again = run('node.mjs', ['contract', 'approve', change, '--by', 'architect'], dir);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already approved/);
  });

  await t.test('the horde wrote nothing into the graph — the port still reads what the graph declares', () => {
    const doc = JSON.parse(yg(dir, ['node', 'auth', '--json']).out);
    assert.equal(doc.ports.policy.description, 'The policy promise.');
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

// The mission charter's evidence catalogue, written from stdin through horde.mjs. This is the
// mission-level charter horde.mjs still owns — unrelated to the per-node charter.md/`node.mjs
// charter edit` that task 014 removed outright (see the "node.mjs charter" test above).
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
  const id = newTicket(['bump-p', '--title', 'bump p', '--node', 'shared', '--class', 'standard', '--files', 'src/shared/p.ts', '--produces', 'shared/p']);
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

  // The roster is gone (task 014) and `--by` is no longer traced against one: it is the name of a
  // territory, a ticket or whoever is answering, recorded verbatim and nothing more. The seat that
  // used to be looked up here does not exist, so neither does the lookup.
  await t.test('--by is recorded verbatim, and no roster file is read or written', () => {
    const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
    const p = run('node.mjs', ['propose', 'rule', 'an untraced proposal', '--by', 'the-checkout-territory'], dir);
    assert.equal(p.code, 0, p.stderr);
    assert.equal(p.json.by, 'the-checkout-territory');
    const ruled = run('node.mjs', ['approve', p.json.id, '--by', 'the-checkout-territory'], dir);
    assert.equal(ruled.code, 0, ruled.stderr);
    assert.equal(ruled.json.rulingBy, 'the-checkout-territory');
    assert.equal(existsSync(rosterPath), false, 'nothing in this tool set reads or writes a roster any more');
  });
});

test('node.mjs map: the mission\'s components with owner, ports and open port proposals', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'], ports: { render: { description: 'The render promise.' } } });
  run('node.mjs', ['contract', 'propose', 'core', 'render', 'the render surface gains slots', '--by', 'owner1'], dir);

  const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
  writeFileSync(rosterPath, JSON.stringify({
    entries: [{ name: 'mission1-owner-core-1', role: 'owner', node: 'core', parent: null }],
  }, null, 2));

  const m = run('node.mjs', ['map'], dir);
  assert.equal(m.code, 0, m.stderr);
  const row = m.json.find((r) => r.node === 'core');
  assert.equal(row.owner, 'mission1-owner-core-1');
  assert.deepEqual(row.ports, ['render']);
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

test('node.mjs bind: node-lease-across-hordes — exclusive across live hordes, --take needs an answered ask', async (t) => {
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

  await t.test('the refusal names the ask path, and --take without one is refused too', () => {
    assert.match(refusalText, /--take --ask <id>/);
    const r = run('node.mjs', ['bind', 'shared', '--horde', 'beta', '--take'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--ask <id>/);
  });

  let askId;
  await t.test('--take against an ask that has not been answered yet is refused', () => {
    const opened = run('ask.mjs', ['add', 'beta needs shared', '--kind', 'charter', '--horde', 'beta'], dir);
    assert.equal(opened.code, 0);
    askId = opened.json.id;
    const r = run('node.mjs', ['bind', 'shared', '--horde', 'beta', '--take', '--ask', askId], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not answered/);
  });

  await t.test('--take over an answered ask succeeds and writes the take-over to the graph\'s own log', () => {
    const answered = run('ask.mjs', ['answer', askId, 'beta takes "shared"; alpha no longer needs it', '--horde', 'beta'], dir);
    assert.equal(answered.code, 0);

    const taken = run('node.mjs', ['bind', 'shared', '--horde', 'beta', '--take', '--ask', askId], dir);
    assert.equal(taken.code, 0);
    assert.equal(taken.json.status, 'taken');
    assert.equal(taken.json.from, 'alpha');
    assert.equal(taken.json.ask, askId);
    assert.equal(taken.json.logged, true);

    const log = yg(dir, ['log', 'read', '--node', 'shared']);
    assert.equal(log.code, 0, log.out);
    assert.match(log.out, new RegExp(`took the lease on "shared" from horde "alpha" over ask ${askId}`));

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

// ---- one counter, three prefixes ---------------------------------------------------------------
//
// Everything the horde numbers comes out of hordes/<h>/counter.json, and wears the prefix that says
// what kind of thing it is. Before this, tickets, ports and proposals each ran their own sequence
// from 1, so one mission could hold three different things all called "1" and an id on its own was
// an ambiguous question.

test('the horde numbers everything from one counter, with one prefix per kind', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'] });

  await t.test('a ticket, a graph item and a question to the client take consecutive numbers', async () => {
    const ticket = run('tk.mjs', ['new', 'first', '--title', 'First', '--node', 'core', '--class', 'standard'], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    assert.equal(ticket.json.ref, 't-001');
    assert.equal(ticket.json.id, '001', 'the number on its own is still what names the folder on disk');

    const proposal = run('node.mjs', ['propose', 'rule', 'never bypass the validator', '--by', 'core'], dir);
    assert.equal(proposal.code, 0, proposal.stderr);
    assert.equal(proposal.json.id, 'g-002');

    // The client channel is the third kind. Nothing files one yet, so this asks the allocator
    // directly — the point under test is that all three come out of the same sequence.
    const { allocateId } = await import('../_lib.mjs');
    const prevCwd = process.cwd();
    process.chdir(dir);
    let ask;
    try { ask = allocateId('mission1', 'ask'); } finally { process.chdir(prevCwd); }
    assert.equal(ask.id, 'a-003');

    const second = run('tk.mjs', ['new', 'second', '--title', 'Second', '--node', 'core', '--class', 'standard'], dir);
    assert.equal(second.json.ref, 't-004', 'the ticket sequence never restarts beside the others');
  });

  await t.test('a contract proposal is a graph item like any other, with no letter of its own', () => {
    const port = run('node.mjs', ['contract', 'propose', 'core', 'render', 'the render promise', '--by', 'core'], dir);
    assert.equal(port.code, 0, port.stderr);
    assert.match(port.json.id, /^g-\d{3}$/);
  });

  await t.test('a port proposal always carries an aspects field, empty when none was named', () => {
    const named = run('node.mjs', ['contract', 'propose', 'core', 'guard', 'the guard promise', '--aspects', 'no-marker, tidy', '--by', 'core'], dir);
    assert.equal(named.code, 0, named.stderr);
    assert.deepEqual(named.json.aspects, ['no-marker', 'tidy']);

    const bare = run('node.mjs', ['contract', 'propose', 'core', 'shape', 'the shape promise', '--by', 'core'], dir);
    assert.equal(bare.code, 0, bare.stderr);
    assert.deepEqual(bare.json.aspects, [], 'the field is written whether or not one was named — a missing field is a record Yggdrasil cannot read');
  });

  await t.test('no identifier wears a letter the model no longer has', () => {
    const graph = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'graph.json'), 'utf8'));
    const ids = [...graph.proposals, ...graph.ports].map((x) => x.id);
    assert.ok(ids.length > 0);
    for (const id of ids) {
      assert.doesNotMatch(id, /^e-/, 'escalation folded into the client channel and has no kind of its own');
      assert.doesNotMatch(id, /^d-/, 'dissent folded into the client channel and has no kind of its own');
    }
    assert.equal(new Set(ids).size, ids.length, 'no two items in one file wear the same number');
  });

  await t.test('a bare number still resolves, and says so', () => {
    const proposal = run('node.mjs', ['propose', 'rule', 'referenced the old way', '--by', 'core'], dir);
    const n = proposal.json.id.replace(/^g-0*/, '');
    const ruled = run('node.mjs', ['approve', n, '--by', 'core'], dir, { json: false });
    assert.equal(ruled.code, 0, ruled.stderr);
    assert.match(ruled.stdout, new RegExp(`proposal ${proposal.json.id} approved`));
    assert.match(ruled.stdout, /was read as/);
    assert.match(ruled.stdout, /accepted for one release/);
  });
});

test('a graph.json from before the shared counter reads without collision, and never repeats a number', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['src/core/**'] });

  // The real migration case: two independent sequences, both starting at 1, so a port and a
  // proposal in the same file both call themselves "1".
  const hordeDir = join(dir, '.horde', 'hordes', 'mission1');
  writeFileSync(join(hordeDir, 'graph.json'), `${JSON.stringify({
    proposals: [
      { id: '1', kind: 'rule', text: 'the old proposal', by: 'owner1', status: 'open', at: '2026-01-01T00:00:00.000Z' },
      { id: '2', kind: 'rule', text: 'another old proposal', by: 'owner1', status: 'open', at: '2026-01-01T00:00:00.000Z' },
    ],
    ports: [
      { id: '1', node: 'core', port: 'render', version: 1, test: 'tests/r.test.mjs', kind: 'add', from: null, text: 'the old port', status: 'proposed', by: 'owner1', at: '2026-01-01T00:00:00.000Z' },
    ],
    aspects: [],
    advisories: [],
  }, null, 2)}\n`);
  writeFileSync(join(hordeDir, 'counter.json'), `${JSON.stringify({ next: 1 })}\n`);

  await t.test('both old sequences are still readable, each item by its own id', () => {
    const proposals = run('node.mjs', ['proposals', '--open'], dir);
    assert.deepEqual(proposals.json.map((p) => p.id), ['1', '2']);
    const ports = run('node.mjs', ['contracts', '--pending'], dir);
    assert.equal(ports.code, 0, ports.stderr);
  });

  await t.test('a new item takes a number above the highest of BOTH old sequences', () => {
    const fresh = run('node.mjs', ['propose', 'rule', 'the first one issued by the shared counter', '--by', 'core'], dir);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.equal(fresh.json.id, 'g-003', 'counter.json said 1; the file already held 1 and 2, so the next free number is 3');

    const ticket = run('tk.mjs', ['new', 'after-migration', '--title', 'After', '--node', 'core', '--class', 'standard'], dir);
    assert.equal(ticket.json.ref, 't-004');

    // The old file's own two "1"s stay exactly as they were — nothing rewrites history. What must
    // never happen is a THIRD one: every number the shared counter issues from here clears both.
    const graph = JSON.parse(readFileSync(join(hordeDir, 'graph.json'), 'utf8'));
    const oldNumbers = new Set(['1', '2']);
    const issued = [...graph.proposals, ...graph.ports].map((x) => x.id).filter((id) => id.startsWith('g-'));
    assert.deepEqual(issued, ['g-003']);
    for (const id of issued) {
      assert.equal(oldNumbers.has(id.replace(/^g-0*/, '')), false, 'the migration never hands out a number the file already carries');
    }
  });
});
