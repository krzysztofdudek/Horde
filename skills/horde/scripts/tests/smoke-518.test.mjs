// The defects the smoke mission of the rebuilt Horde met, each reproduced on a real repository with
// the real Yggdrasil, Grain and Jarl the suite runs against. The mission: a small library with real
// history and no graph, cut into two territories, two tickets, one of them refused by the gate for
// having no test and then declared as needing none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  makeRepo, rmRepo, run, requireYg, requireGrain, git, initHorde, addNode, ygInit,
} from './helpers.mjs';

// The real Yggdrasil as a node script path. The smoke mission named its build with `--yg "node
// <bin.js>"`; the suite's own may be `yg` on PATH, which is resolved to the script it links to.
function ygScript() {
  const line = requireYg();
  const m = /^node\s+(\S+)$/.exec(line.trim());
  if (m) return m[1];
  const found = execFileSync('which', [line.trim()], { encoding: 'utf8' }).trim();
  return realpathSync(found);
}

// A stand-in for an older Yggdrasil first on PATH, answering the root-parent probe the way 6.0.0
// did: `root` in `parents:` is an undefined type.
function oldYgOnPath(dir) {
  const bin = join(dir, '.old-yg-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'yg'), [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo 6.0.0 ;;',
    '  check) echo \'{"issues":[{"code":"type-unknown-parent"}]}\' ;;',
    '  *) echo "old yg: $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'yg'), 0o755);
  return bin;
}

// The smoke mission's repository: strings and math helpers with their tests, built over nine
// commits, no graph.
const TOY = [
  ['strings: slugify with test', {
    'package.json': '{\n  "name": "toy",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
    'src/strings/slugify.js': "export function slugify(input) {\n  return String(input).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');\n}\n",
    'test/strings/slugify.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../../src/strings/slugify.js';\n\ntest('slugify', () => {\n  assert.equal(slugify('A b'), 'a-b');\n});\n",
  }],
  ['math: sum with test', {
    'src/math/sum.js': 'export function sum(values) {\n  return values.reduce((acc, v) => acc + v, 0);\n}\n',
    'test/math/sum.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../../src/math/sum.js';\n\ntest('sum', () => {\n  assert.equal(sum([1, 2]), 3);\n});\n",
  }],
  ['strings: padLeft with test', {
    'src/strings/pad.js': "export function padLeft(input, width, fill = ' ') {\n  return String(input).padStart(width, fill);\n}\n",
    'test/strings/pad.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { padLeft } from '../../src/strings/pad.js';\n\ntest('padLeft', () => {\n  assert.equal(padLeft('7', 3, '0'), '007');\n});\n",
  }],
  ['math: clamp with test', {
    'src/math/clamp.js': 'export function clamp(value, min, max) {\n  return Math.min(Math.max(value, min), max);\n}\n',
    'test/math/clamp.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../../src/math/clamp.js';\n\ntest('clamp', () => {\n  assert.equal(clamp(5, 0, 3), 3);\n});\n",
  }],
  ['strings: slugify tolerates null input', {
    'src/strings/slugify.js': "export function slugify(input) {\n  return String(input ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');\n}\n",
    'test/strings/slugify.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../../src/strings/slugify.js';\n\ntest('slugify', () => {\n  assert.equal(slugify('A b'), 'a-b');\n  assert.equal(slugify(null), '');\n});\n",
  }],
  ['math: sum tolerates missing list', {
    'src/math/sum.js': 'export function sum(values) {\n  return (values ?? []).reduce((acc, v) => acc + v, 0);\n}\n',
    'test/math/sum.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../../src/math/sum.js';\n\ntest('sum', () => {\n  assert.equal(sum([1, 2]), 3);\n  assert.equal(sum(), 0);\n});\n",
  }],
  ['index and readme', {
    'README.md': '# toy\n',
    'src/index.js': "export { slugify } from './strings/slugify.js';\nexport { padLeft } from './strings/pad.js';\nexport { sum } from './math/sum.js';\nexport { clamp } from './math/clamp.js';\n",
  }],
  ['strings: padLeft long-input test', {
    'test/strings/pad.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { padLeft } from '../../src/strings/pad.js';\n\ntest('padLeft', () => {\n  assert.equal(padLeft('7', 3, '0'), '007');\n  assert.equal(padLeft('1234', 3), '1234');\n});\n",
  }],
];

export function makeToyRepo() {
  const dir = makeRepo();
  for (const [message, files] of TOY) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(['add', '-A'], dir);
    git(['commit', '-qm', message], dir);
  }
  return dir;
}

// ---- 519: the Yggdrasil `init` adopts with is the one Grain proposes against ----------------------

test('519 — init with --yg naming a build while an older yg sits on PATH mines a graph that is adopted and committed before the trunk', async (t) => {
  const grain = requireGrain();
  const script = ygScript();

  await t.test('on the base branch: the graph is committed there and the trunk is cut after it', () => {
    const dir = makeToyRepo();
    t.after(() => rmRepo(dir));
    const oldBin = oldYgOnPath(dir);
    const env = { PATH: `${oldBin}:${process.env.PATH}`, YG_BIN: '' };
    const r = run('horde.mjs', ['init', 'truncate', '--base', 'main', '--yg', `node ${script}`, '--grain', grain, '--test-globs', '**/*.test.*'], dir, { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.graph.created, true);
    assert.equal(r.json.graph.mined, true, r.json.graph.notes.join('\n'));
    // Components, not an empty graph…
    const nodes = run('node.mjs', ['bind', '--horde', 'truncate'], dir, { env }).json.nodes;
    assert.ok(nodes.length >= 3, `expected a mined graph, got ${JSON.stringify(nodes)}`);
    // …committed on main, and the trunk carries them.
    assert.equal(git(['log', '-1', '--format=%s', 'main'], dir), 'architecture graph: yg init, and the proposal Grain mined from this repository adopted');
    assert.equal(git(['rev-parse', 'truncate/trunk'], dir), git(['rev-parse', 'main'], dir));
    const onTrunk = git(['ls-tree', '-r', '--name-only', 'truncate/trunk'], dir).split('\n');
    assert.ok(onTrunk.some((p) => p.startsWith('.yggdrasil/model/') && p.endsWith('yg-node.yaml')), onTrunk.join('\n'));
    assert.ok(onTrunk.includes('.yggdrasil/yg-architecture.yaml'));
    assert.equal(git(['status', '--porcelain', '--', '.yggdrasil', 'AGENTS.md'], dir), '');
  });

  await t.test('off the base branch: the base is left alone and the graph is the trunk\'s first commit', () => {
    const dir = makeToyRepo();
    t.after(() => rmRepo(dir));
    const oldBin = oldYgOnPath(dir);
    const env = { PATH: `${oldBin}:${process.env.PATH}`, YG_BIN: '' };
    git(['branch', '-f', 'develop', 'main'], dir);
    const developBefore = git(['rev-parse', 'develop'], dir);
    const r = run('horde.mjs', ['init', 'truncate', '--base', 'develop', '--yg', `node ${script}`, '--grain', grain, '--test-globs', '**/*.test.*'], dir, { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.graph.mined, true, r.json.graph.notes.join('\n'));
    assert.equal(git(['rev-parse', 'develop'], dir), developBefore);
    assert.equal(git(['rev-parse', 'truncate/trunk^'], dir), developBefore);
    const onTrunk = git(['ls-tree', '-r', '--name-only', 'truncate/trunk'], dir).split('\n');
    assert.ok(onTrunk.some((p) => p.startsWith('.yggdrasil/model/') && p.endsWith('yg-node.yaml')), onTrunk.join('\n'));
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model')), true);
  });
});

// ---- the mission's landing: a ticket whose change adds no test --------------------------------------
//
// A graph with one component over src/, committed on the trunk; the gate command green; tests named
// *.test.*. Ticket "export" changes src/index.mjs and nothing else, so the revert test refuses it for
// having no test file, until the ticket declares "**No new tests:**".

const WAIT_MS = process.platform === 'win32' ? 300000 : 90000;

function landingFixture(t) {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir, 'mission1', ['--test-globs', '**/*.test.*']);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  git(['checkout', '-q', 'mission1/trunk'], dir);
  addNode(dir, 'core', { mapping: ['src/**'] });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.mjs'), 'export const a = 1;\n');
  git(['add', '-A', '--', '.yggdrasil', 'src'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  return dir;
}

async function quietRm(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { rmRepo(dir); return; } catch { await new Promise((r) => { setTimeout(r, 150); }); }
  }
  rmRepo(dir);
}

function queueItem(dir, id) {
  return JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json'), 'utf8')).items.find((i) => i.ticket === id);
}

function landResult(dir, id) {
  const p = join(dir, '.horde', 'hordes', 'mission1', 'land', `${id}.json`);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

async function until(what, fn) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 200); });
  }
}

// A worker's turn: the change committed on the ticket's branch, and its hand-off line.
function workerCommits(dir, id, text) {
  const item = queueItem(dir, id);
  writeFileSync(join(item.worktree, 'src', 'index.mjs'), text);
  git(['-C', item.worktree, 'commit', '-qam', `ticket ${id}`], dir);
  const sha = git(['-C', item.worktree, 'rev-parse', '--short', 'HEAD'], dir);
  assert.equal(run('tk.mjs', ['log', id, `landed ${sha} — the export`], dir).code, 0);
  return sha;
}

function exportTicket(dir, extra = []) {
  const r = run('tk.mjs', ['new', 'export', '--title', 'Export b', '--node', 'core', '--class', 'standard', '--files', 'src/index.mjs', '--evidence', 'b is exported from src/index.mjs', ...extra], dir);
  assert.equal(r.code, 0, r.stderr);
  const id = r.json.id;
  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  return id;
}

// Dispatch, the worker's commit, the review raised and closed with nothing found: the next tick asks the gate.
function throughReviewToGate(dir, id) {
  const first = run('tick.mjs', [], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(first.json.spawn.some((s) => s.ticket === id), JSON.stringify(first.json.spawn));
  workerCommits(dir, id, 'export const a = 1;\nexport const b = 2;\n');
  const raised = run('tick.mjs', [], dir);
  assert.equal(raised.code, 0, raised.stderr);
  assert.equal(raised.json.landed.find((l) => l.ticket === id)?.action, 'review', JSON.stringify(raised.json.landed));
  assert.equal(run('tk.mjs', ['review-close', id, '--by', `r-${id}`], dir).code, 0);
  return first;
}

// ---- 523: a gate result is about the commit and the ticket together ---------------------------------

test('523 — a red revert test, then "No new tests" declared with no new commit: the next tick runs the gate again and the ticket lands', async (t) => {
  const dir = landingFixture(t);
  const id = exportTicket(dir);
  throughReviewToGate(dir, id);

  const gated = run('tick.mjs', [], dir);
  assert.equal(gated.code, 0, gated.stderr);
  assert.equal(gated.json.landed.find((l) => l.ticket === id)?.action, 'gate', JSON.stringify(gated.json.landed));
  const red = await until('the red landing', () => { const r = landResult(dir, id); return r && r.ok === false ? r : null; });
  assert.ok(red.checks.some((c) => c.name === 'revert test' && !c.ok && /No new tests/.test(c.note)), JSON.stringify(red.checks));
  assert.ok(red.ticketState, 'the result records the ticket state it was run against');

  // The refusal goes back to the worker as a round; the director declares the reason instead.
  const back = run('tick.mjs', [], dir);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(back.json.landed.find((l) => l.ticket === id)?.action, 'changes', JSON.stringify(back.json.landed));
  const declared = run('tk.mjs', ['edit', id, '--no-new-tests', 'a one-line export the existing tests cover', '--by', 'director'], dir);
  assert.equal(declared.code, 0, declared.stderr);
  // The worker has nothing to change, and hands the same commit back.
  const sha = git(['-C', queueItem(dir, id).worktree, 'rev-parse', '--short', 'HEAD'], dir);
  assert.equal(run('tk.mjs', ['log', id, `landed ${sha} — nothing to change; the reason is declared on the ticket`], dir).code, 0);

  const again = run('tick.mjs', [], dir);
  assert.equal(again.code, 0, again.stderr);
  const step = again.json.landed.find((l) => l.ticket === id);
  assert.equal(step?.action, 'gate', `the gate is asked again, not answered with the old refusal: ${JSON.stringify(again.json.landed)}`);
  assert.match(step.note, /ticket's own fields changed/);
  await until('the merge', () => { run('tick.mjs', [], dir); return queueItem(dir, id).state === 'merged'; });
});

// ---- 524: the declaration has a command, and the plan review names who lacks it ----------------------

test('524 — tk.mjs new/edit --no-new-tests writes the declaration, "" withdraws it, and the plan review lists tickets with no test file and no reason', async (t) => {
  const dir = landingFixture(t);
  const bare = run('tk.mjs', ['new', 'bare', '--title', 'Bare', '--node', 'core', '--class', 'standard', '--files', 'src/index.mjs', '--evidence', 'it works'], dir);
  assert.equal(bare.code, 0, bare.stderr);
  const said = run('tk.mjs', ['new', 'said', '--title', 'Said', '--node', 'core', '--class', 'standard', '--files', 'src/other.mjs', '--evidence', 'it works', '--no-new-tests', 'a rename · nothing else'], dir);
  assert.equal(said.code, 0, said.stderr);
  const tested = run('tk.mjs', ['new', 'tested', '--title', 'Tested', '--node', 'core', '--class', 'standard', '--files', 'src/x.mjs,src/x.test.mjs', '--evidence', 'it works'], dir);
  assert.equal(tested.code, 0, tested.stderr);
  for (const r of [bare, said, tested]) assert.equal(run('queue.mjs', ['add', r.json.id, '--proposed'], dir).code, 0);

  await t.test('new --no-new-tests writes the field as one header line', () => {
    const text = run('tk.mjs', ['show', said.json.id], dir, { json: false }).stdout;
    assert.match(text, /\*\*No new tests:\*\* a rename, nothing else$/m);
  });

  await t.test('the plan review names the ticket with no test file and no reason, and only it', () => {
    const r = run('refine.mjs', ['--step', 'review', '--horde', 'mission1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.untested.map((u) => u.id), [bare.json.id]);
    assert.match(r.json.brief, /## Tickets that name no test file/);
    assert.match(r.json.brief, new RegExp(`- ${bare.json.id} — files: src/index\\.mjs`));
    assert.match(r.json.brief, /tk\.mjs edit <ticket> --no-new-tests "<reason>" --by <name>/);
  });

  await t.test('edit --no-new-tests declares it, logs who did, and "" withdraws it', () => {
    const e = run('tk.mjs', ['edit', bare.json.id, '--no-new-tests', 'configuration only', '--by', 'director'], dir);
    assert.equal(e.code, 0, e.stderr);
    assert.match(run('tk.mjs', ['show', bare.json.id], dir, { json: false }).stdout, /\*\*No new tests:\*\* configuration only$/m);
    assert.match(run('tk.mjs', ['show', bare.json.id, '--log'], dir, { json: false }).stdout, /no new tests: configuration only — changed by director/);
    assert.deepEqual(run('refine.mjs', ['--step', 'review', '--horde', 'mission1'], dir).json.untested, []);
    const w = run('tk.mjs', ['edit', bare.json.id, '--no-new-tests', '', '--by', 'director'], dir);
    assert.equal(w.code, 0, w.stderr);
    assert.doesNotMatch(run('tk.mjs', ['show', bare.json.id], dir, { json: false }).stdout, /\*\*No new tests:\*\* \S/);
  });

  await t.test('the MCP command table carries the flag on new and edit', async () => {
    const { COMMANDS } = await import('../commands.mjs');
    assert.equal(COMMANDS['tk new'].flags['no-new-tests'], 'value');
    assert.equal(COMMANDS['tk edit'].flags['no-new-tests'], 'value');
  });
});

// ---- 522, 525, 526, 527: one ticket from the first dispatch to the retrospective ---------------------
//
// Sent back by its review for an Important finding, then refused by the gate for having no test, then
// declared as needing none and landed; the wave closed, and the retrospective run over it.

test('522 525 526 527 — a ticket sent back twice, landed, its wave closed and its mission read back', async (t) => {
  const dir = landingFixture(t);
  const id = exportTicket(dir);
  const worktreeBrief = (name) => {
    const r = run('brief.mjs', ['worker', id, '--name', name], dir);
    assert.equal(r.code, 0, r.stderr);
    return r.json.brief;
  };

  const first = run('tick.mjs', [], dir);
  assert.equal(first.code, 0, first.stderr);

  await t.test('526: the tick that hands out the first ticket opens wave 1, with the plan it starts from', () => {
    assert.ok(first.json.spawn.some((s) => s.ticket === id));
    assert.equal(first.json.waveOpened && first.json.waveOpened.n, '1', JSON.stringify(first.json.waveOpened));
    assert.equal(run('wave.mjs', ['current'], dir).json.current, '1');
    assert.match(run('tick.mjs', [], dir, { json: false }).stdout, /^(?!.*wave 1 opened)/s, 'a wave already open is not opened again');
  });

  await t.test('522: a first brief carries no fix round', () => {
    assert.doesNotMatch(worktreeBrief(`w-${id}`), /## Fix round/);
  });

  workerCommits(dir, id, 'export const a = 1;\nexport const b = 2;\n');
  const raised = run('tick.mjs', [], dir);
  assert.equal(raised.json.landed.find((l) => l.ticket === id)?.action, 'review');
  const finding = `review: core changes by r-${id} — Important: src/index.mjs:2 — b is exported under a name the ticket does not ask for`;
  assert.equal(run('tk.mjs', ['log', id, finding], dir).code, 0);
  assert.equal(run('tk.mjs', ['review-close', id, '--by', `r-${id}`], dir).code, 0);
  const sent = run('tick.mjs', [], dir);
  assert.equal(sent.json.landed.find((l) => l.ticket === id)?.action, 'changes', JSON.stringify(sent.json.landed));

  await t.test('522: the fix-round brief carries the round, the review\'s own words and where the log is', () => {
    const brief = worktreeBrief(`w-${id}-r1`);
    assert.match(brief, /## Fix round 1 of 5 \(resume same worker\)/);
    assert.match(brief, /b is exported under a name the ticket does not ask for/);
    assert.match(brief, /The review's findings on the attempt it answers:/);
    assert.match(brief, new RegExp(`tk\\.mjs show ${id} --log`));
  });

  workerCommits(dir, id, 'export const a = 1;\nexport const b = a + 1;\n');
  const gated = run('tick.mjs', [], dir);
  assert.equal(gated.json.landed.find((l) => l.ticket === id)?.action, 'gate', JSON.stringify(gated.json.landed));
  await until('the red landing', () => { const r = landResult(dir, id); return r && r.ok === false ? r : null; });
  const back = run('tick.mjs', [], dir);
  assert.equal(back.json.landed.find((l) => l.ticket === id)?.action, 'changes');

  await t.test('522: after a red gate the brief carries the gate\'s refusal and round 2', () => {
    const brief = worktreeBrief(`w-${id}-r2`);
    assert.match(brief, /## Fix round 2 of 5/);
    assert.match(brief, /The landing gate's refusal on [0-9a-f]+:/);
    assert.match(brief, /- revert test — no new or changed test files in diff/);
    assert.doesNotMatch(brief, /b is exported under a name/, 'the review\'s findings belong to the round before');
  });

  assert.equal(run('tk.mjs', ['edit', id, '--no-new-tests', 'one export the existing tests cover', '--by', 'director'], dir).code, 0);
  const sha = git(['-C', queueItem(dir, id).worktree, 'rev-parse', '--short', 'HEAD'], dir);
  assert.equal(run('tk.mjs', ['log', id, `landed ${sha} — the reason is declared on the ticket`], dir).code, 0);
  let closing = null;
  await until('the merge', () => { closing = run('tick.mjs', [], dir); return queueItem(dir, id).state === 'merged'; });
  if (!closing.json.close) closing = run('tick.mjs', [], dir);

  await t.test('526: once the queue is empty, the close tick names goes through without a start by hand', () => {
    assert.equal(closing.json.close, true);
    const closed = run('wave.mjs', ['close', '--horde', 'mission1'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.match(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8'), /plan: layers 1 · planned parallelism 1/);
  });

  // The director's own checkout is on the base branch, as on a real mission: the trunk moves under the
  // tools, never under somebody's working tree.
  git(['checkout', '-q', 'develop'], dir);
  const input = run('retro.mjs', ['--horde', 'mission1'], dir);
  assert.equal(input.code, 0, input.stderr);

  await t.test('525: the refusal a green landing wrote over is still counted', () => {
    const gate = input.json.items.filter((i) => i.source === 'gate');
    assert.equal(gate.length, 1, JSON.stringify(input.json.items));
    assert.match(gate[0].text, /revert test: no new or changed test files/);
  });

  await t.test('527: the tools\' own bookkeeping lines are not handed to the retrospective', () => {
    const texts = input.json.items.filter((i) => i.source === 'log').map((i) => i.text);
    assert.ok(texts.some((x) => /b is exported under a name/.test(x)), 'the review\'s finding is a remark');
    for (const x of texts) {
      assert.doesNotMatch(x, / landed [0-9a-f]+/, x);
      assert.doesNotMatch(x, /review closed by/, x);
      assert.doesNotMatch(x, / — changed by /, x);
    }
  });

  await t.test('527: taste goes into the component\'s log in a commit on the trunk, and nothing is left uncommitted', () => {
    const items = Object.fromEntries(input.json.items.map((i) => [i.key, i.source === 'log' ? { class: 'taste', node: 'core' } : { class: 'inexpressible' }]));
    writeFileSync(join(dir, '.horde', 'hordes', 'mission1', 'retro-classes.json'), `${JSON.stringify({ items }, null, 2)}\n`);
    const before = git(['rev-parse', 'mission1/trunk'], dir);
    const doc = run('retro.mjs', ['--horde', 'mission1'], dir);
    assert.equal(doc.code, 0, doc.stderr);
    assert.ok(doc.json.tasteCommit, JSON.stringify(doc.json.notes));
    assert.equal(git(['rev-parse', 'mission1/trunk'], dir), doc.json.tasteCommit);
    assert.equal(git(['rev-parse', `${doc.json.tasteCommit}^`], dir), before);
    assert.match(git(['show', 'mission1/trunk:.yggdrasil/model/core/log.md'], dir), /b is exported under a name/);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'core', 'log.md')), false, 'nothing was written into the director\'s checkout');
    const trunkTree = join(dir, '.horde', 'worktrees', 'mission1', 'trunk');
    if (existsSync(trunkTree)) assert.equal(git(['-C', trunkTree, 'status', '--porcelain', '--', '.yggdrasil'], dir), '');
    // A second run logs nothing twice.
    const again = run('retro.mjs', ['--horde', 'mission1'], dir);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(git(['rev-parse', 'mission1/trunk'], dir), doc.json.tasteCommit);
  });
});

// ---- 520, 521: the cut of a nested graph, and the consultants it briefs --------------------------------
//
// The graph Grain proposes nests components: `app` maps src/ and owns what no child maps (the barrel),
// `app/strings` maps src/strings/. A cut putting the child in one territory and its parent in another
// is two disjoint territories — each component whole, in one territory — and is scored like any other.

function nestedRepo() {
  const dir = makeRepo();
  ygInit(dir);
  addNode(dir, 'app', { description: 'The library and its barrel.', mapping: ['src/**'] });
  addNode(dir, 'app/strings', { description: 'String helpers.', mapping: ['src/strings/**'] });
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('src/index.mjs', "export { pad } from './strings/pad.mjs';\n");
  write('src/strings/pad.mjs', 'export const pad = (s) => s;\n');
  write('src/strings/slug.mjs', 'export const slug = (s) => s;\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  for (let i = 1; i <= 6; i++) {
    write('src/strings/pad.mjs', `export const pad = (s) => s + ${i};\n`);
    write('src/strings/slug.mjs', `export const slug = (s) => s + ${i};\n`);
    git(['add', '-A'], dir);
    git(['commit', '-qm', `strings ${i}`], dir);
  }
  for (let i = 1; i <= 3; i++) {
    write('src/index.mjs', `export { pad } from './strings/pad.mjs';\nexport const v = ${i};\n`);
    git(['add', '-A'], dir);
    git(['commit', '-qm', `barrel ${i}`], dir);
  }
  git(['branch', '-f', 'develop', 'HEAD'], dir);
  initHorde(dir, 'm1');
  return dir;
}

test('520 521 — a parent and its child in two territories are scored, and the consultants\' brief shows an acceptance line', async (t) => {
  const dir = nestedRepo();
  t.after(() => rmRepo(dir));
  const territories = {
    strings: { nodes: ['app/strings'], class: 'standard', why: 'The helpers.' },
    entry: { nodes: ['app'], class: 'light', why: 'The barrel.' },
  };
  writeFileSync(join(dir, '.horde', 'hordes', 'm1', 'territories.json'), `${JSON.stringify(territories, null, 2)}\n`);

  await t.test('520: the cut is accepted and scored, not refused for a file in two parts', () => {
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.score.scored, true, JSON.stringify(r.json.score));
    assert.equal(r.json.score.territories, 2);
    assert.ok(r.json.score.commits.inside >= 9, JSON.stringify(r.json.score.commits));
  });

  await t.test('521: the consultant\'s brief files a ticket with its acceptance line, and says a bare id fills only the field', () => {
    const r = run('refine.mjs', ['--step', 'consult', '--horde', 'm1', '--json'], dir);
    assert.equal(r.code, 0, r.stderr);
    const briefs = (r.json.spawns || []).map((s) => (s.brief ? s.brief : (s.file ? readFileSync(s.file, 'utf8') : ''))).join('\n');
    assert.match(briefs, /--evidence "<what a verifier reproduces to see it done> \(<E-id>\)"/);
    assert.match(briefs, /A bare id \(`--evidence E1`\) fills\nonly the field/);
    assert.match(briefs, /--no-new-tests "<why no test is needed>"/);
  });
});
