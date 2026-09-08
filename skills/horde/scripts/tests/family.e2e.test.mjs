// E18 — the whole family, end to end, on the real builds.
//
// Every other test in this suite drives one tool over a fixture some other tool built. This one
// drives the LAYERS: a bare repository with real commit history, Grain reading that history into
// a proposed graph, Yggdrasil accepting it and baselining it, and only then a horde on top —
// charter, ticket, plan, worktree, two keys, the merge checklist with the graph's own verdict in
// it, a merge, a wave close, the mission's final gate and the chain of custody for one line.
//
// The point of it is the seams. A layer's own suite proves the layer; nothing but a walk like
// this proves that what Grain writes is what Yggdrasil accepts, that the node identity Yggdrasil
// hands back is the one a ticket is filed against, and that the keys a review leaves behind still
// name the diff the merge checklist reads at the end. Nothing here is stood in for: the graph is
// mined by the real `grain propose`, accepted by the real `yg adopt`, and the merge checklist's
// graph item is the real `yg check` on the branch's own worktree.
//
// It is skipped — loudly, with the reason and the path it looked at printed — when either build
// is missing, and never silently: a family test that quietly measures nothing is worse than no
// family test at all. `YG_BIN` and `GRAIN_BIN` name the two builds; both fall back to a sibling
// checkout's own build on a machine that has all three repositories out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, findRealYg } from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- the two builds ---------------------------------------------------------------------

// A command line ("yg", "node /path/to/bin.js") the way config.ygCommand carries one.
function asCommandLine(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1 && /\.(mjs|js|cjs)$/.test(parts[0])) return `node ${parts[0]}`;
  return parts.join(' ');
}

// Runs a command line and hands back its exit code and output — the probe both builds are found
// with, and the way this test invokes them for real afterwards.
function runCommandLine(cmdline, args, opts = {}) {
  const parts = cmdline.split(/\s+/);
  try {
    const out = execFileSync(parts[0], [...parts.slice(1), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
    });
    return { code: 0, out };
  } catch (e) {
    return {
      code: e.status === undefined || e.status === null ? 1 : e.status,
      out: ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || ''),
    };
  }
}

// Walks up from this repository looking for a sibling checkout — the layout of a machine that
// has the whole family out at once, which is the only machine this test can run on anyway.
function siblingPath(...tail) {
  let dir = SCRIPTS_DIR;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, ...tail);
    if (existsSync(candidate)) return candidate;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// The Yggdrasil build: YG_BIN first (the name the mission's own evidence catalogue uses), then
// whatever the rest of this suite already found (HORDE_TEST_YG, `yg` on PATH, a sibling build).
function findYg() {
  const named = process.env.YG_BIN ? asCommandLine(process.env.YG_BIN) : null;
  if (named) {
    return runCommandLine(named, ['--version']).code === 0
      ? { ok: true, cmd: named }
      : { ok: false, reason: `YG_BIN names "${named}", which does not answer \`--version\`` };
  }
  const found = findRealYg();
  if (found) return { ok: true, cmd: found };
  return {
    ok: false,
    reason: 'no Yggdrasil build — set YG_BIN to a built bin.js, put `yg` on PATH, or check '
      + 'Yggdrasil out beside this repository',
  };
}

// The Grain build. `propose` is what this test actually needs from it, so the probe asks for the
// usage text and requires `propose` to be in it: Grain's engine module and its dispatcher sit
// next to each other under the same name, and only one of them is a program that runs.
function findGrain() {
  const candidates = [];
  if (process.env.GRAIN_BIN) candidates.push(asCommandLine(process.env.GRAIN_BIN));
  else {
    candidates.push('grain');
    const sibling = siblingPath('Grain', 'plugins', 'grain', 'bin', 'grain.mjs');
    if (sibling) candidates.push(`node ${sibling}`);
  }
  for (const cmd of candidates.filter(Boolean)) {
    const probe = runCommandLine(cmd, ['--help']);
    if (probe.code === 0 && /\bpropose\b/.test(probe.out)) return { ok: true, cmd };
  }
  return {
    ok: false,
    reason: `no Grain build that answers \`--help\` with a \`propose\` command (tried: ${
      candidates.filter(Boolean).join(', ') || 'nothing'}) — set GRAIN_BIN to Grain's own `
      + 'dispatcher, or check Grain out beside this repository',
  };
}

const YG = findYg();
const GRAIN = findGrain();

// ---- the fixture repository --------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, rel, text) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

// A handler module, in the shape the whole repository writes them in — the repetition IS the
// evidence Grain reads: two directories of the same kind of file, each with a test beside it.
function handler(name) {
  return [
    "import { log } from '../shared/log.mjs';",
    '',
    `export function ${name}Handler(input) {`,
    `  log('${name}');`,
    '  const value = input.value;',
    '  if (!value) {',
    '    return null;',
    '  }',
    `  return { name: '${name}', value };`,
    '}',
    '',
  ].join('\n');
}

function handlerTest(area, name, expected) {
  return [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { ${name}Handler } from '../src/${area}/${name}.mjs';`,
    '',
    `test('${name}Handler', () => {`,
    `  assert.equal(${name}Handler({ value: ${expected} }).value, ${expected});`,
    '});',
    '',
  ].join('\n');
}

// A real repository with real history: two directories of source, a directory of tests, a build
// file that says how it is tested, and four commits that touch them. Grain has nothing to read
// but this, so this is what the graph will be made of.
function buildRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'horde-family-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'family@test.com'], dir);
  git(['config', 'user.name', 'Family Test'], dir);

  write(dir, 'src/shared/log.mjs', 'export function log(what) {\n  return what;\n}\n');
  for (const name of ['place', 'cancel', 'amend', 'split', 'hold']) {
    write(dir, `src/orders/${name}.mjs`, handler(name));
  }
  for (const name of ['issue', 'void', 'refund', 'credit', 'dunning']) {
    write(dir, `src/billing/${name}.mjs`, handler(name));
  }
  write(dir, 'package.json', `${JSON.stringify({
    name: 'shop', version: '1.0.0', scripts: { test: 'node --test' },
  }, null, 2)}\n`);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'orders and billing handlers'], dir);

  for (const name of ['place', 'cancel', 'amend']) {
    write(dir, `tests/orders-${name}.test.mjs`, handlerTest('orders', name, 1));
  }
  for (const name of ['issue', 'void', 'refund']) {
    write(dir, `tests/billing-${name}.test.mjs`, handlerTest('billing', name, 2));
  }
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'tests for the handlers'], dir);

  write(dir, 'src/orders/place.mjs', `${handler('place')}export const placeName = 'place';\n`);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'orders: name the handler'], dir);

  write(dir, 'src/billing/issue.mjs', `${handler('issue')}export const issueName = 'issue';\n`);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'billing: name the handler'], dir);

  return dir;
}

// The repository's own gate, run the way an adopter runs it — with the markers that tell a nested
// `node --test` it is already inside a test run stripped, since this suite IS one and Node would
// otherwise no-op the child and report a green that measured nothing.
const GATE = ['--test'];
function runGate(cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (env.NODE_OPTIONS) {
    const kept = env.NODE_OPTIONS.split(/\s+/).filter((t) => t && !t.startsWith('--test')).join(' ');
    if (kept) env.NODE_OPTIONS = kept; else delete env.NODE_OPTIONS;
  }
  try {
    execFileSync('node', GATE, {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (e) {
    return e.status === undefined || e.status === null ? 1 : e.status;
  }
}

// horde.mjs charter edit takes its content on stdin, which run()'s plain argv exec cannot supply.
function stdinRun(tool, args, cwd, input) {
  try {
    const out = execFileSync('node', [join(SCRIPTS_DIR, tool), ...args, '--json'], {
      cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, json: JSON.parse(out), stderr: '' };
  } catch (e) {
    return {
      code: e.status ?? 1, json: null, stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

const CHARTER = [
  '# Mission · Discounts on orders',
  '',
  '**Horde:** `family` · **Trunk:** `family/trunk` off `develop`',
  '',
  '## Goal',
  '',
  'An order can carry a discount, and the discount is proved by a test that fails without it.',
  '',
  '## Acceptance — the evidence catalogue',
  '',
  '| id | evidence | node | reproduced by |',
  '|---|---|---|---|',
  '| E1 | `node --test src/orders/discount.test.mjs` passes on the merged tree | src/orders | |',
  '| E2 | the repository gate is green at the trunk tip | src/orders | |',
  '',
].join('\n');

test('E18 — the family end to end: a bare repository, a mined graph, a merged and proven change', async (t) => {
  if (!YG.ok || !GRAIN.ok) {
    const reason = `E18 skipped — ${[!YG.ok ? YG.reason : null, !GRAIN.ok ? GRAIN.reason : null].filter(Boolean).join('; ')}`;
    process.stderr.write(`\n${reason}\n`);
    t.skip(reason);
    return;
  }

  const startedAt = Date.now();
  const dir = buildRepository();
  t.after(() => {
    process.stderr.write(`\nE18 wall clock: ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
    rmSync(dir, { recursive: true, force: true });
  });

  const YG_FLAGS = ['--yg', YG.cmd];

  await t.test('1. a bare repository with real history and no graph at all', () => {
    assert.equal(existsSync(join(dir, '.yggdrasil')), false);
    assert.equal(existsSync(join(dir, '.horde')), false);
    assert.equal(git(['rev-list', '--count', 'HEAD'], dir), '4');
    assert.equal(runGate(dir), 0, 'the repository this mission starts from is green');
  });

  await t.test('2. grain propose mines a graph from that history, and yg adopt accepts it', () => {
    // YG_BIN is how Grain finds a Yggdrasil to drill its candidate rules against; without one it
    // would still write a proposal, but every rule in it would be a draft nobody tried.
    const proposed = runCommandLine(GRAIN.cmd, ['propose', '.yggdrasil-proposal'], {
      cwd: dir, env: { ...process.env, YG_BIN: YG.cmd.replace(/^node\s+/, '') },
    });
    assert.equal(proposed.code, 0, `grain propose exited ${proposed.code}:\n${proposed.out}`);

    const proposal = JSON.parse(readFileSync(join(dir, '.yggdrasil-proposal', 'proposal.json'), 'utf8'));
    assert.equal(proposal.schema, 'grain-proposal/1');
    assert.equal(existsSync(join(dir, '.yggdrasil-proposal', '.yggdrasil')), true);

    const adopted = runCommandLine(YG.cmd, ['adopt', '.yggdrasil-proposal'], { cwd: dir });
    assert.equal(adopted.code, 0, `yg adopt exited ${adopted.code}:\n${adopted.out}`);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'yg-architecture.yaml')), true);

    // Nodes: the directory names under .yggdrasil/model/ ARE node identity, in all three layers.
    const nodes = [];
    const walk = (rel) => {
      const abs = join(dir, '.yggdrasil', 'model', rel);
      if (existsSync(join(abs, 'yg-node.yaml'))) nodes.push(rel);
      for (const d of readdirSync(abs, { withFileTypes: true })) {
        if (d.isDirectory()) walk(rel ? `${rel}/${d.name}` : d.name);
      }
    };
    walk('');
    assert.ok(nodes.includes('src/orders'), `mined nodes: ${nodes.join(', ')}`);
    assert.ok(nodes.includes('src/billing'), `mined nodes: ${nodes.join(', ')}`);

    // …and at least one rule, on the status ladder rather than enforced out of nowhere: a mined
    // rule arrives as a proposal about how the code is already written.
    const aspectsDir = join(dir, '.yggdrasil', 'aspects');
    const aspects = [];
    const walkAspects = (rel) => {
      const abs = join(aspectsDir, rel);
      if (existsSync(join(abs, 'yg-aspect.yaml'))) { aspects.push(rel); return; }
      for (const d of readdirSync(abs, { withFileTypes: true })) {
        if (d.isDirectory()) walkAspects(rel ? `${rel}/${d.name}` : d.name);
      }
    };
    walkAspects('');
    assert.ok(aspects.length >= 1, 'the proposal carried at least one rule');
    const statuses = aspects.map((a) => (/^status:\s*(\S+)/m
      .exec(readFileSync(join(aspectsDir, a, 'yg-aspect.yaml'), 'utf8')) || [])[1]);
    for (const s of statuses) assert.ok(['draft', 'advisory', 'enforced'].includes(s), `rule status: ${s}`);
    assert.ok(statuses.some((s) => s === 'draft' || s === 'advisory'), `rule statuses: ${statuses.join(', ')}`);

    // The graph rides on the branch, so it is committed before any branch is cut from it — and
    // `develop`, the horde's base, is cut here, with the graph already in it.
    git(['add', '.yggdrasil'], dir);
    git(['commit', '-qm', 'graph: mined by grain, accepted by yg'], dir);
    git(['branch', 'develop'], dir);
    assert.equal(runCommandLine(YG.cmd, ['check'], { cwd: dir }).code, 0, 'the accepted graph is green on the tree it was mined from');
  });

  let ownerName;
  let consumerOwnerName;
  let workerName;
  let verifierName;
  let stewardWorktree;

  await t.test('3. horde init on the graph the family just made, and the nodes it binds', () => {
    const init = run('horde.mjs', [
      'init', 'family', '--base', 'develop', '--title', 'Discounts on orders',
      ...YG_FLAGS, '--nodes', 'src/orders',
    ], dir);
    assert.equal(init.code, 0, init.stderr);
    // horde-requires-yggdrasil: the graph was already here, so init kept it rather than making one.
    assert.equal(init.json.graph.created, false);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'family', 'charter.md')), true);
    assert.match(git(['branch', '--list', 'family/trunk'], dir), /family\/trunk/);

    // It read the repository's own build file for the two things it must not invent.
    assert.match(init.json.gates.team, /test/);
    assert.ok(init.json.testGlobs.includes('**/*.test.*'), init.json.testGlobs.join(', '));

    // node-lease-across-hordes: --nodes leased the node this mission works on.
    const leases = JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8'));
    assert.equal(leases.leases['src/orders'].horde, 'family');

    // The gate this repository is held to for the rest of the walk, said once.
    for (const level of ['commit', 'team', 'trunk']) {
      assert.equal(run('horde.mjs', ['config', 'set', `gates.${level}`, `node ${GATE.join(' ')}`], dir).code, 0);
    }

    // The node is readable only through the CLI's own documents — there is no second graph.
    const show = run('node.mjs', ['show', 'src/orders'], dir);
    assert.equal(show.code, 0, show.stderr);
    assert.deepEqual(show.json.boundary, ['src/orders']);
  });

  await t.test('4. the charter, its two evidence rows, and the roster that will fill them', () => {
    const charter = stdinRun('horde.mjs', ['charter', 'edit'], dir, CHARTER);
    assert.equal(charter.code, 0, charter.stderr);
    assert.equal(charter.json.evidenceRows, 2);
    assert.match(readFileSync(join(dir, '.horde', 'hordes', 'family', 'charter.md'), 'utf8'), /\| E2 \|/);

    const steward = run('roster.mjs', ['spawn', 'steward', '--team', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(steward.code, 0, steward.stderr);
    stewardWorktree = steward.json.worktree;
    assert.equal(existsSync(stewardWorktree), true);

    const owner = run('roster.mjs', ['spawn', 'owner', '--node', 'src/orders', '--class', 'sonnet'], dir);
    assert.equal(owner.code, 0, owner.stderr);
    ownerName = owner.json.name;

    // The graph says `tests` uses `src/orders`, so the ticket below — which raises a port on
    // src/orders — changes a contract that node depends on, and its owner is owed a say.
    const consumerOwner = run('roster.mjs', ['spawn', 'owner', '--node', 'tests', '--class', 'sonnet'], dir);
    assert.equal(consumerOwner.code, 0, consumerOwner.stderr);
    consumerOwnerName = consumerOwner.json.name;
  });

  await t.test('5. the owner files a ticket with Files, Produces and Evidence; the plan is one layer', () => {
    const ticket = run('tk.mjs', [
      'new', 'order-discount', '--title', 'An order can carry a discount',
      '--node', 'src/orders', '--class', 'sonnet',
      '--files', 'src/orders/discount.mjs,src/orders/discount.test.mjs',
      '--produces', 'src/orders/apply-discount@1',
      '--evidence', 'E1 — node --test src/orders/discount.test.mjs passes on the merged tree',
      '--evidence', 'E2 — the repository gate is green at the tip',
    ], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    assert.equal(ticket.json.id, '001');
    assert.deepEqual(ticket.json.evidence, ['E1', 'E2']);
    assert.deepEqual(ticket.json.produces, ['src/orders/apply-discount@1']);

    const issue = readFileSync(join(
      dir, '.horde', 'hordes', 'family', 'teams', 'trunk', 'issues', ticket.json.dirName, 'issue.md',
    ), 'utf8');
    assert.match(issue, /\*\*Files:\*\* src\/orders\/discount\.mjs, src\/orders\/discount\.test\.mjs/);
    assert.match(issue, /\*\*Produces:\*\* src\/orders\/apply-discount@1/);
    assert.match(issue, /\*\*Evidence:\*\* E1, E2/);

    assert.equal(run('queue.mjs', ['add', '001'], dir).code, 0);
    const plan = run('queue.mjs', ['plan'], dir);
    assert.equal(plan.code, 0, plan.stderr);
    assert.equal(plan.json.schema, 'horde-plan/1');
    assert.deepEqual(plan.json.layers, [['001']]);
    assert.deepEqual(plan.json.uncoveredEvidence, [], 'both catalogue rows are claimed by a ticket');

    assert.equal(run('wave.mjs', ['start'], dir).json.n, '1');
  });

  let worktree;
  let tipSha;
  let patchId;

  await t.test('6. the worker gets a worktree, and lands a test that fails without the change', () => {
    const worker = run('roster.mjs', ['spawn', 'worker', '--team', 'trunk', '--class', 'sonnet', '--ticket', '001'], dir);
    assert.equal(worker.code, 0, worker.stderr);
    workerName = worker.json.name;

    const running = run('queue.mjs', ['set', '001', 'running', '--agent', workerName], dir);
    assert.equal(running.code, 0, running.stderr);
    assert.equal(running.json.branch, 'family/t-001');
    worktree = running.json.worktree;
    assert.equal(existsSync(worktree), true);

    write(worktree, 'src/orders/discount.test.mjs', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { applyDiscount } from './discount.mjs';",
      '',
      "test('applyDiscount takes the percentage off the total', () => {",
      '  assert.equal(applyDiscount({ total: 200 }, 10).total, 180);',
      '});',
      '',
    ].join('\n'));
    write(worktree, 'src/orders/discount.mjs', [
      "import { log } from '../shared/log.mjs';",
      '',
      'export function applyDiscount(order, percent) {',
      "  log('discount');",
      '  const total = order.total - ((order.total * percent) / 100);',
      '  return { ...order, total };',
      '}',
      '',
    ].join('\n'));
    git(['add', 'src/orders/discount.mjs', 'src/orders/discount.test.mjs'], worktree);
    git(['commit', '-qm', 'orders: an order can carry a discount'], worktree);
    tipSha = git(['rev-parse', 'family/t-001'], dir);

    // The test really is red on the branch this is merging into, and green on the branch itself.
    assert.equal(runGate(worktree), 0, 'the gate is green on the ticket branch');
    assert.notEqual(
      runCommandLine('node', ['--test', 'src/orders/discount.test.mjs'], { cwd: stewardWorktree }).code, 0,
      'the new test fails on the tree the ticket is merging into',
    );

    assert.equal(run('tk.mjs', ['log', '001', `landed ${tipSha.slice(0, 7)}`], dir).code, 0);
    const key = run('tk.mjs', ['key', '001', 'author', '--by', workerName], dir);
    assert.equal(key.code, 0, key.stderr);
  });

  await t.test('7. two keys: the verifier\'s verdict bound to the diff, and the owner\'s approval', () => {
    const verifier = run('roster.mjs', ['spawn', 'verifier', '--team', 'trunk', '--class', 'sonnet', '--ticket', '001'], dir);
    assert.equal(verifier.code, 0, verifier.stderr);
    verifierName = verifier.json.name;

    // keys-bind-to-patch-id: what the verdict is held to is the identity of the ticket's own diff
    // against the branch it merges into, computed here the same way _lib.mjs computes it.
    const diff = execFileSync('git', ['diff', '-U3', `family/trunk...family/t-001`], {
      cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    patchId = execFileSync('git', ['patch-id', '--stable'], { cwd: dir, input: diff, encoding: 'utf8' }).trim().split(/\s+/)[0];
    assert.match(patchId, /^[0-9a-f]{40}$/);

    const verdict = run('verify.mjs', [
      'record', '001', '--verdict', 'reproduced', '--revert', 'failed', '--by', verifierName,
      '--item', '1|node --test src/orders/discount.test.mjs|1 pass 0 fail',
      '--item', '2|node --test|7 pass 0 fail',
      '--ran', 'node --test src/orders/discount.test.mjs on the parent tree',
      '--saw', 'ERR_MODULE_NOT_FOUND — the test cannot pass without the change',
      '--gate', 'green', '--sha', tipSha,
    ], dir);
    assert.equal(verdict.code, 0, verdict.stderr);
    assert.equal(verdict.json.diff, patchId);

    const log = readFileSync(join(
      dir, '.horde', 'hordes', 'family', 'teams', 'trunk', 'issues', '001-order-discount', 'log.md',
    ), 'utf8');
    assert.match(log, new RegExp(`\\*\\*Diff:\\*\\* ${patchId}`));
    assert.match(log, new RegExp(`\\*\\*Gate:\\*\\*.*green at sha ${tipSha.slice(0, 7)}`));

    assert.equal(run('tk.mjs', ['review-request', '001'], dir).code, 0);
    // port-is-contract: the ticket raises a port, so the node the graph says consumes it is owed
    // an approval of its own — naming the node is how each owner says which one they speak for.
    const bare = run('tk.mjs', ['review', '001', 'approve', '--by', ownerName], dir);
    assert.equal(bare.code, 1, 'an unnamed approval on a ticket that owes two is refused');

    const review = run('tk.mjs', ['review', '001', 'approve', '--by', ownerName, '--node', 'src/orders'], dir);
    assert.equal(review.code, 0, review.stderr);
    assert.deepEqual(review.json.nodes, ['src/orders']);
    const consumerReview = run('tk.mjs', ['review', '001', 'approve', '--by', consumerOwnerName, '--node', 'tests'], dir);
    assert.equal(consumerReview.code, 0, consumerReview.stderr);

    const issue = readFileSync(join(
      dir, '.horde', 'hordes', 'family', 'teams', 'trunk', 'issues', '001-order-discount', 'issue.md',
    ), 'utf8');
    assert.match(issue, new RegExp(`author ${workerName}`));
    assert.match(issue, new RegExp(`verifier ${verifierName}`));
    assert.match(issue, new RegExp(`src/orders ${ownerName}@[0-9a-f]+\\+${patchId}`));
    assert.match(issue, new RegExp(`tests ${consumerOwnerName}@[0-9a-f]+\\+${patchId}`));
  });

  await t.test('8. the merge checklist, graph item included, is green through the real yg check', () => {
    const premerge = run('premerge.mjs', ['family/t-001', '--level', 'team'], dir);
    const byName = Object.fromEntries(premerge.json.checks.map((c) => [c.name, c]));
    assert.deepEqual(Object.keys(byName), [
      'base freshness', 'keys', 'scope', 'revert test', 'gate', 'graph', 'mapping', 'journal', 'graph text',
    ]);
    for (const [name, check] of Object.entries(byName)) {
      assert.equal(check.ok, true, `${name}: ${check.note}`);
    }
    assert.equal(byName.graph.pending, undefined, 'no rule is left waiting on a judgement');
    assert.equal(premerge.code, 0, premerge.stderr);
    assert.equal(premerge.json.ok, true);
  });

  let trunkSha;
  await t.test('9. the merge, and the wave close that turns both evidence rows green', () => {
    git(['merge', '--no-ff', 'family/t-001', '-m', 'merge 001: an order can carry a discount'], stewardWorktree);
    trunkSha = git(['rev-parse', 'family/trunk'], dir);
    assert.equal(runGate(stewardWorktree), 0, 'the gate is green at the trunk tip');
    assert.equal(runCommandLine(YG.cmd, ['check'], { cwd: stewardWorktree }).code, 0, 'and so is the graph');

    const merged = run('queue.mjs', ['set', '001', 'merged', '--sha', trunkSha.slice(0, 7)], dir);
    assert.equal(merged.code, 0, merged.stderr);
    assert.equal(existsSync(worktree), false);
    assert.equal(git(['branch', '--list', 'family/t-001'], dir), '');
    assert.equal(run('tk.mjs', ['status', '001', 'merged'], dir).json.status, 'merged');

    const close = run('wave.mjs', ['close', '--gate', 'green', '--sha', trunkSha.slice(0, 7)], dir);
    assert.equal(close.code, 0, close.stderr);

    const charter = readFileSync(join(dir, '.horde', 'hordes', 'family', 'charter.md'), 'utf8');
    assert.match(charter, new RegExp(`\\| E1 \\|[^|]*\\|[^|]*\\| ${verifierName} \\|`));
    assert.match(charter, new RegExp(`\\| E2 \\|[^|]*\\|[^|]*\\| ${verifierName} \\|`));
  });

  await t.test('10. the mission gate refuses without an audit, and passes with one', () => {
    const refused = run('horde.mjs', ['done'], dir);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /no audit verdict recorded for wave 1/);

    assert.equal(run('wave.mjs', ['audit', '001', 'clean', 'the evidence reproduces from the ticket alone'], dir).code, 0);

    const done = run('horde.mjs', ['done'], dir);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.json.evidence.green, 2);
    assert.equal(done.json.evidence.total, 2);
    assert.equal(done.json.audit.verdict, 'clean');
    assert.match(readFileSync(join(dir, '.horde', 'hordes', 'family', 'plan.md'), 'utf8'), /# Mission complete/);
  });

  await t.test('11. blame on a merged line prints the whole chain back to the graph', () => {
    const line = readFileSync(join(stewardWorktree, 'src/orders/discount.mjs'), 'utf8')
      .split('\n').findIndex((l) => l.includes('const total =')) + 1;
    assert.ok(line > 0);

    const blame = run('blame.mjs', [`src/orders/discount.mjs:${line}`], stewardWorktree);
    assert.equal(blame.code, 0, blame.stderr);
    assert.equal(blame.json.ticket.id, '001');
    assert.equal(blame.json.ticket.author, workerName);
    assert.equal(blame.json.ticket.verifier.name, verifierName);
    assert.equal(blame.json.ticket.ownerApprovals['src/orders'].startsWith(ownerName), true);
    assert.deepEqual(blame.json.ticket.catalogueEvidence.map((e) => e.id), ['E1', 'E2']);
    assert.equal(blame.json.rules.available, true);
    assert.equal(blame.json.rules.node, 'src/orders');
  });
});
