// E18 — the whole family, end to end, on the real builds.
//
// Every other test in this suite drives one tool over a fixture some other tool built. This one
// drives the LAYERS: a bare repository with real commit history, Grain reading that history into
// a proposed graph, Yggdrasil accepting it and baselining it, and only then a horde on top — the
// mission cut into territories, consulted, reviewed and framed; a tick handing the work out; a
// worker in their own worktree; a landing that gates and merges; a wave closed with what the
// mission did to the law; a retrospective; and the mission's own final gate.
//
// The point of it is the seams. A layer's own suite proves the layer; nothing but a walk like
// this proves that what Grain writes is what Yggdrasil accepts, and that the node identity
// Yggdrasil hands back is the one a territory is cut around, a ticket is filed against, and the
// landing gate's own graph item reads at the end. Nothing here is stood in for: the graph is mined
// by the real `grain propose`, accepted by the real `yg adopt`, and the gate's graph item is the
// real `yg check` on a fresh tree at the branch's own tip.
//
// Two things it deliberately does NOT do. It holds no keys and collects no second signature: a
// landing asks nobody for permission, and the commit that exists is the whole of the claim. And it
// never merges anything itself — `land.mjs` makes the merge commit, so what this walk does at that
// step is check that merge, its trailers and its parents, rather than perform one.
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
import {
  run, findRealYg, writeCostRuns,
} from './helpers.mjs';

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

  // A worker is a name string used for --agent and branch naming, and nothing else — there is no
  // roll of agents anywhere in this tool set to be on.
  let workerName;
  let trunkWorktree;

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

  await t.test('4. the charter, its two evidence rows, and a worktree on the team branch', () => {
    const charter = stdinRun('horde.mjs', ['charter', 'edit'], dir, CHARTER);
    assert.equal(charter.code, 0, charter.stderr);
    assert.equal(charter.json.evidenceRows, 2);
    assert.match(readFileSync(join(dir, '.horde', 'hordes', 'family', 'charter.md'), 'utf8'), /\| E2 \|/);

    // Nothing in this tool set keeps a worktree on the team branch — a landing makes its own
    // throwaway tree and removes it again. This one exists only so the walk can read the merged
    // trunk with ordinary tools at the end, and run the repository's gate against it.
    trunkWorktree = mkdtempSync(join(tmpdir(), 'family-trunk-'));
    git(['worktree', 'add', trunkWorktree, 'family/trunk'], dir);
    assert.equal(existsSync(trunkWorktree), true);
  });

  // ---- the mission is refined before anything is built ----------------------------------------
  //
  // `refine` is four passes, and each of the two that ask a question does it the same way: run
  // once to get a one-shot brief and the path of the file the answer goes in, write that file, run
  // again to have it checked and applied. Nothing comes back here as prose — the answer is always
  // a document on disk, which is what makes the pass re-runnable and the decision readable later.

  await t.test('5. refine --step cut: the mission is cut into territories, and each is leased', () => {
    const asked = run('refine.mjs', ['--step', 'cut', '--horde', 'family'], dir);
    assert.equal(asked.code, 0, asked.stderr);
    assert.equal(asked.json.state, 'awaiting', 'the first run asks; it does not decide');
    // The answer goes wherever the pass says it goes — the test writes to the path it was handed,
    // never to one it composed itself.
    assert.match(asked.json.file, /\.horde\/hordes\/family\/territories\.json$/);
    assert.doesNotMatch(asked.json.brief, /\{\{/);
    // Asking takes nothing. The file already holds the node lease `init --nodes` took in step 3;
    // what must not be in it yet is a territory, because no territory has been named yet.
    const beforeCut = JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8')).leases;
    assert.deepEqual(Object.keys(beforeCut), ['src/orders'], 'a brief takes no lease of its own');

    // The architect's answer: whole components, never split, each in exactly one territory. The
    // node ids here are the ones Grain mined and Yggdrasil accepted in step 2 — that identity
    // travelling this far intact is one of the seams this test exists for.
    writeFileSync(asked.json.file, `${JSON.stringify({
      'the shop front': { nodes: ['src/orders'], class: 'standard', why: 'Everything an order does to itself.' },
      'the ledger': { nodes: ['src/billing'], class: 'light', why: 'What the money side records, and nothing else.' },
    }, null, 2)}\n`);

    const accepted = run('refine.mjs', ['--step', 'cut', '--horde', 'family'], dir);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(accepted.json.state, 'accepted');
    assert.deepEqual(accepted.json.territories.map((x) => x.territory).sort(), ['the ledger', 'the shop front']);
    const front = accepted.json.territories.find((x) => x.territory === 'the shop front');
    assert.deepEqual(front.nodes, ['src/orders']);
    // The size a territory is held to is measured, not asserted: code plus the rules that reach it
    // plus its own logs, and the total is those three and nothing else.
    assert.equal(front.bytes.total, front.bytes.code + front.bytes.aspects + front.bytes.logs);
    assert.ok(front.bytes.total <= accepted.json.maxBytes, `${front.bytes.total} > ${accepted.json.maxBytes}`);

    const leases = JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8')).leases;
    assert.equal(leases['the shop front'].horde, 'family');
    assert.equal(leases['the ledger'].horde, 'family');
  });

  await t.test('6. refine --step consult: one spawn per territory, each carrying only its own', () => {
    const consult = run('refine.mjs', ['--step', 'consult', '--horde', 'family'], dir);
    assert.equal(consult.code, 0, consult.stderr);
    assert.deepEqual(consult.json.spawns.map((s) => s.territory).sort(), ['the ledger', 'the shop front']);

    const front = consult.json.spawns.find((s) => s.territory === 'the shop front');
    assert.equal(front.class, 'standard');
    assert.doesNotMatch(front.brief, /\{\{/);
    // Its own territory's components, and not the other's: a consultant proposing rules for an
    // area they do not work in is the thing this split exists to prevent.
    assert.match(front.brief, /src\/orders/);
    assert.doesNotMatch(front.brief, /src\/billing/);
  });

  await t.test('7. a ticket is filed as a proposal, with Files, Produces and Evidence', () => {
    const ticket = run('tk.mjs', [
      'new', 'order-discount', '--title', 'An order can carry a discount',
      '--node', 'src/orders', '--class', 'standard',
      '--files', 'src/orders/discount.mjs,src/orders/discount.test.mjs',
      '--produces', 'src/orders/apply-discount',
      '--evidence', 'E1 — node --test src/orders/discount.test.mjs passes on the merged tree',
      '--evidence', 'E2 — the repository gate is green at the tip',
    ], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    assert.equal(ticket.json.id, '001');
    assert.equal(ticket.json.ref, 't-001', 'one counter for the whole mission, and the kind is on the id');
    assert.deepEqual(ticket.json.evidence, ['E1', 'E2']);
    assert.deepEqual(ticket.json.produces, ['src/orders/apply-discount']);

    const issue = readFileSync(join(
      dir, '.horde', 'hordes', 'family', 'teams', 'trunk', 'issues', ticket.json.dirName, 'issue.md',
    ), 'utf8');
    assert.match(issue, /\*\*Files:\*\* src\/orders\/discount\.mjs, src\/orders\/discount\.test\.mjs/);
    assert.match(issue, /\*\*Produces:\*\* src\/orders\/apply-discount/);
    assert.match(issue, /\*\*Evidence:\*\* E1, E2/);

    // A consultant's ticket arrives as a proposal: in the queue, listed and counted, and not a
    // candidate for anyone to start. The only way out of it is the review pass below.
    const added = run('queue.mjs', ['add', '001', '--proposed'], dir);
    assert.equal(added.code, 0, added.stderr);
    assert.equal(added.json.state, 'proposed');
  });

  await t.test('8. refine --step review: the architect rules on the plan, and a pass becomes work', () => {
    const asked = run('refine.mjs', ['--step', 'review', '--horde', 'family'], dir);
    assert.equal(asked.code, 0, asked.stderr);
    assert.equal(asked.json.state, 'awaiting');
    assert.equal(existsSync(asked.json.plan), true, 'the whole plan is written to a file, not printed into a prompt');
    assert.doesNotMatch(asked.json.brief, /\{\{/);

    writeFileSync(asked.json.file, `${JSON.stringify({ '001': { verdict: 'pass' } }, null, 2)}\n`);

    const applied = run('refine.mjs', ['--step', 'review', '--horde', 'family'], dir);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(applied.json.state, 'applied');
    const ruling = applied.json.rulings.find((r) => r.ticket === '001');
    assert.equal(ruling.verdict, 'pass');
    assert.equal(ruling.status, 'queued');
    assert.equal(run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === '001').state, 'queued');

    const plan = run('queue.mjs', ['plan'], dir);
    assert.equal(plan.code, 0, plan.stderr);
    assert.equal(plan.json.schema, 'horde-plan/1');
    assert.deepEqual(plan.json.layers, [['001']]);
    assert.deepEqual(plan.json.uncoveredEvidence, [], 'both catalogue rows are claimed by a ticket');
  });

  await t.test('9. refine --step frame: what the client is shown, in their own words', () => {
    const frame = run('refine.mjs', ['--step', 'frame', '--horde', 'family'], dir);
    assert.equal(frame.code, 0, frame.stderr);
    assert.deepEqual(frame.json.sections.map((s) => s.title), [
      'What will change, and where', 'What it will prove', 'What the rules gain',
    ]);
    assert.ok(frame.json.sections[0].areas.length > 0, 'the client is told where the work lands');
    assert.deepEqual(frame.json.sections[1].proofs.map((p) => p.id), ['E1', 'E2']);

    // Nothing about how any of it is run. The check is on the prose this pass WRITES — its own
    // notes, and the names it gives the areas and the work — not on the evidence rows, which are
    // the client's own sentences from the charter quoted back verbatim and may say anything
    // (this mission's say `node --test …`, because that is what the client asked to be shown).
    const written = [
      ...frame.json.sections.map((s) => `${s.title} ${s.note}`),
      ...frame.json.sections[0].areas.flatMap((a) => [a.area, a.why, ...a.work.map((w) => w.what)]),
      ...frame.json.sections[2].rules.map((r) => `${r.says} ${r.where}`),
    ].join(' ');
    assert.doesNotMatch(written, /\.mjs/, 'no tool is named to the client');
    assert.doesNotMatch(written, /\.horde/, 'nothing inside the horde\'s own directory is named');
    assert.doesNotMatch(written, /\b(territory|queue|ticket)\b/i, 'none of the vocabulary the horde uses on itself');
  });

  let worktree;
  let tipSha;

  await t.test('10. tick: one run reconciles, hands the ticket out, and cuts its worktree', () => {
    assert.equal(run('wave.mjs', ['start'], dir).json.n, '1');

    const tick = run('tick.mjs', ['--horde', 'family'], dir);
    assert.equal(tick.code, 0, tick.stderr);
    assert.equal(tick.json.close, false, 'the queue is not empty, so the mission does not close');

    const entry = tick.json.spawn.find((s) => s.ticket === '001');
    assert.ok(entry, `nothing was handed out: ${JSON.stringify(tick.json.spawn)}`);
    assert.equal(entry.model, 'standard', 'the ticket\'s own class, never a default');
    assert.equal(entry.branch, 'family/t-001');
    // The branch and the worktree are already cut, so the brief on the entry renders against a
    // tree that exists — tick hands out work, it does not promise to.
    worktree = entry.worktree;
    assert.equal(existsSync(worktree), true);
    assert.match(entry.brief, /brief\.mjs worker/);
    assert.equal(run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === '001').state, 'running');
  });

  await t.test('11. the worker lands a test that fails without the change', () => {
    workerName = 'w-order-discount';

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
      runCommandLine('node', ['--test', 'src/orders/discount.test.mjs'], { cwd: trunkWorktree }).code, 0,
      'the new test fails on the tree the ticket is merging into',
    );

    assert.equal(run('tk.mjs', ['log', '001', `landed ${tipSha.slice(0, 7)}`], dir).code, 0);
    // review-request only appends a log note now. Nothing downstream reads it and nothing waits on
    // it — it is here because a real worker still writes one, not because it gates anything.
    assert.equal(run('tk.mjs', ['review-request', '001'], dir).code, 0);
  });

  let trunkSha;
  await t.test('12. the gate lands the ticket itself — every item green, then a merge commit', () => {
    // Nothing merges this by hand. `land` is the last command of the ticket: when every item is
    // green it makes the merge commit, removes the worktree and the branch, and records the landed
    // sha — which is the whole of what a signature used to be. Omitting --level defaults to the
    // same gate lookup a branch landing directly on the team branch always used.
    const landed = run('land.mjs', ['family/t-001'], dir);
    const byName = Object.fromEntries(landed.json.checks.map((c) => [c.name, c]));
    assert.deepEqual(Object.keys(byName), [
      'base freshness', 'judge', 'scope', 'revert test', 'gate', 'graph', 'mapping', 'journal', 'graph text', 'merge',
    ]);
    for (const [name, check] of Object.entries(byName)) {
      assert.equal(check.ok, true, `${name}: ${check.note}`);
    }
    assert.equal(landed.code, 0, landed.stderr);
    assert.equal(landed.json.ok, true);
    assert.deepEqual(landed.json.pairs, [], 'no rule is left waiting on a judgement');

    trunkSha = git(['rev-parse', 'family/trunk'], dir);
    assert.equal(landed.json.landed.sha, trunkSha);
    assert.match(git(['log', '-1', '--format=%s', 'family/trunk'], dir), /^merge 001/);
    assert.equal(git(['rev-list', '--count', '--merges', `${tipSha}..family/trunk`], dir), '1');
    // A --no-ff merge has two parents: the trunk tip it merged into, and the ticket branch's tip.
    const parents = git(['rev-list', '--parents', '-n', '1', 'family/trunk'], dir).split(' ');
    assert.equal(parents.length, 3, `the merge commit's parents: ${parents.join(' ')}`);
    assert.equal(parents[2], tipSha, 'the second parent is the ticket branch this landed');

    // What the merge commit says about itself, read with git's own trailer parser rather than by
    // scraping the message: which ticket, which catalogue rows it claims, and what it did to the
    // law. This is the record the mission is read back from a year later.
    assert.equal(
      git(['show', '-s', '--format=%(trailers:key=Ticket,valueonly)', 'family/trunk'], dir).trim(),
      't-001',
    );
    assert.equal(
      git(['show', '-s', '--format=%(trailers:key=Evidence,valueonly)', 'family/trunk'], dir).trim(),
      'E1, E2',
    );
  });

  await t.test('13. the landing left its own record, and the wave close turns both evidence rows green', () => {
    assert.equal(runGate(trunkWorktree), 0, 'the gate is green at the trunk tip');
    assert.equal(runCommandLine(YG.cmd, ['check'], { cwd: trunkWorktree }).code, 0, 'and so is the graph');

    assert.equal(existsSync(worktree), false);
    assert.equal(git(['branch', '--list', 'family/t-001'], dir), '');
    assert.equal(run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === '001').state, 'merged');
    assert.match(
      readFileSync(join(dir, '.horde', 'hordes', 'family', 'teams', 'trunk', 'issues', '001-order-discount', 'log.md'), 'utf8'),
      /landed 001 on family\/trunk as [0-9a-f]{7}/,
    );
    assert.equal(run('tk.mjs', ['status', '001', 'merged'], dir).json.status, 'merged');

    // A catalogue row is marked reproduced by the person who reproduced it, by name. Nothing
    // infers it from a recorded verdict — a claim about evidence is made by somebody, or not made.
    assert.equal(run('wave.mjs', ['evidence', 'E1', '--by', workerName], dir).code, 0);
    assert.equal(run('wave.mjs', ['evidence', 'E2', '--by', workerName], dir).code, 0);

    const close = run('wave.mjs', ['close', '--gate', 'green', '--sha', trunkSha.slice(0, 7)], dir);
    assert.equal(close.code, 0, close.stderr);

    const charter = readFileSync(join(dir, '.horde', 'hordes', 'family', 'charter.md'), 'utf8');
    assert.match(charter, new RegExp(`\\| E1 \\|[^|]*\\|[^|]*\\| ${workerName} \\|`));
    assert.match(charter, new RegExp(`\\| E2 \\|[^|]*\\|[^|]*\\| ${workerName} \\|`));

    // Closing a wave writes what the mission has done to the law so far — read off two real trees
    // through the real CLI, never scraped from anything's output. A wave that raised nothing still
    // gets the document, with three empty lists; that is a reading, not a missing file.
    assert.ok(close.json.law && close.json.law.path, 'the close says where the law document is');
    const law = JSON.parse(readFileSync(close.json.law.path, 'utf8'));
    assert.equal(law.schema, 'horde-law/1');
    assert.equal(law.horde, 'family');
    for (const section of ['added', 'raised', 'attached']) {
      assert.ok(Array.isArray(law[section]), `${section} is a list, empty or not`);
    }
  });

  // `done` counts four things: evidence reproduced, trunk gate green, cost recorded, and the
  // retrospective run over the mission as it stands. Three of the four are already true by now —
  // the tick in step 10 billed the run it handed out, which is the only thing that writes the
  // ledger — so the retrospective is the one refusal left to meet.
  await t.test('14. the mission gate refuses until the retrospective is run, and passes once it is', () => {
    const withoutRetro = run('horde.mjs', ['done'], dir);
    assert.equal(withoutRetro.code, 1);
    assert.match(withoutRetro.stderr, /no retrospective has been run on this mission/);
    assert.doesNotMatch(withoutRetro.stderr, /no cost has ever been recorded/, 'the tick that handed the work out billed it');

    // The retrospective, both runs: the gathering one prints what this mission wrote down, and the
    // one-shot's answer is written here by hand — nothing about what a model would decide is under
    // test, only that every item gets a class and the document comes out.
    const gathered = run('retro.mjs', ['--tree', dir, '--horde', 'family'], dir);
    assert.equal(gathered.code, 0, gathered.stderr);
    assert.equal(gathered.json.state, 'input');
    assert.ok(gathered.json.items.length > 0, 'a mission that landed a ticket wrote something down');
    writeFileSync(
      join(dir, '.horde', 'hordes', 'family', 'retro-classes.json'),
      `${JSON.stringify({ items: Object.fromEntries(gathered.json.items.map((i) => [i.key, { class: 'inexpressible' }])) }, null, 2)}\n`,
    );
    const retro = run('retro.mjs', ['--tree', dir, '--horde', 'family'], dir);
    assert.equal(retro.code, 0, retro.stderr);
    assert.equal(retro.json.schema, 'horde-retro/1');
    assert.equal(retro.json.inexpressible.length, gathered.json.items.length);

    const done = run('horde.mjs', ['done'], dir);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.json.evidence.green, 2);
    assert.equal(done.json.evidence.total, 2);
    assert.equal(done.json.cost.runs, 1);
    assert.equal(done.json.retro.inexpressible, gathered.json.items.length);

    // "done" is also where the mission files itself away: the horde's directory is marked with the
    // date and the trunk sha it handed over at, and moved under _archive/. Everything it wrote is
    // read back from where it now stands.
    assert.ok(done.json.archived && done.json.archived.to, 'done says where it archived the mission to');
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'family')), false);
    assert.match(readFileSync(join(done.json.archived.to, 'plan.md'), 'utf8'), /# Mission complete/);
    assert.match(readFileSync(join(done.json.archived.to, 'archived'), 'utf8'), /^\d{4}-\d{2}-\d{2} [0-9a-f]{40}$/m);
  });

  await t.test('15. blame on a merged line prints the whole chain back to the graph', () => {
    const line = readFileSync(join(trunkWorktree, 'src/orders/discount.mjs'), 'utf8')
      .split('\n').findIndex((l) => l.includes('const total =')) + 1;
    assert.ok(line > 0);

    const blame = run('blame.mjs', [`src/orders/discount.mjs:${line}`], trunkWorktree);
    assert.equal(blame.code, 0, blame.stderr);
    assert.equal(blame.json.ticket.id, '001');
    // blame.mjs still parses the "**Keys:**" line a mission started on an older release wrote, so
    // a ticket read back from one keeps reporting what it recorded. A ticket filed today carries
    // no such line — nothing writes one — so those fields read as the honest unset marker rather
    // than as a claim nobody made.
    assert.equal(blame.json.ticket.author, '—');
    assert.equal(blame.json.ticket.verifier.name, '—');
    assert.deepEqual(blame.json.ticket.ownerApprovals, { 'src/orders': '—' });
    assert.deepEqual(blame.json.ticket.catalogueEvidence.map((e) => e.id), ['E1', 'E2']);
    assert.equal(blame.json.rules.available, true);
    assert.equal(blame.json.rules.node, 'src/orders');
  });
});
