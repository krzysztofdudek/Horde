import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function mkTicket(dir, slug, opts = {}) {
  const {
    node = 'core', class: cls = 'standard', severity, files, depends, evidence = 'it works',
  } = opts;
  const flags = ['--node', node, '--class', cls];
  if (severity) flags.push('--severity', severity);
  if (files) flags.push('--files', files);
  if (depends) flags.push('--depends', depends);
  const r = run('tk.mjs', ['new', slug, '--title', slug, ...flags, '--evidence', evidence], dir);
  if (r.code !== 0) throw new Error(`tk new (${slug}) failed: ${r.stderr}`);
  return r.json.id;
}

function queuePath(dir, horde = 'mission1') {
  return join(dir, '.horde', 'hordes', horde, 'teams', 'trunk', 'queue.json');
}

function readQueue(dir, horde = 'mission1') {
  return JSON.parse(readFileSync(queuePath(dir, horde), 'utf8'));
}

function writeQueue(dir, doc, horde = 'mission1') {
  writeFileSync(queuePath(dir, horde), `${JSON.stringify(doc, null, 2)}\n`);
}

function itemOf(dir, ticket, horde = 'mission1') {
  return readQueue(dir, horde).items.find((i) => i.ticket === ticket);
}

// The landing gate's own result file, written by hand the way a real run writes it — tick's whole
// second step is a reader of these, including of the ones a killed run left half-finished.
function writeLandResult(dir, ticket, body, horde = 'mission1') {
  const path = join(dir, '.horde', 'hordes', horde, 'land', `${ticket}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

function ticketLogPath(dir, ticket, horde = 'mission1') {
  const issues = join(dir, '.horde', 'hordes', horde, 'teams', 'trunk', 'issues');
  const match = readdirSync(issues).find((n) => n.startsWith(`${ticket}-`));
  return join(issues, match, 'log.md');
}

// tk.mjs reads the rounds a ticket has already been through back out of its own log, so spending
// them is a matter of writing the lines a red gate would have written.
function spendFixRounds(dir, ticket, rounds = 5, horde = 'mission1') {
  const path = ticketLogPath(dir, ticket, horde);
  for (let i = 1; i <= rounds; i += 1) {
    appendFileSync(path, `- 2026-01-0${i} status: changes — tests fail (round ${i}/5 — resume same worker)\n`);
  }
}

// Tick starts the landing gate in the background for anything it finds at "landed", so a fixture
// that leaves one there still has a detached process writing into the temp repository when the test
// itself is over. Removing it out from under that process fails with ENOTEMPTY — so the removal
// waits for the writer to be done rather than the suite carrying a race it cannot see.
async function quietRm(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmRepo(dir);
      return;
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
  }
  rmRepo(dir);
}

function tick(dir, args = []) {
  return run('tick.mjs', args, dir);
}

// ---- 1. reconcile ---------------------------------------------------------------------------
//
// The same three cases queue.mjs reconcile has always had, asserted through tick, because tick is
// where they run now: an item is "running" because a call was made, and once that call has come
// back without landing a sha, the branch is the only thing that still knows what happened.

test('tick.mjs reconcile: a branch past the tip lands, a dirty tree is committed as wip, a clean one gives up its worktree, and nothing else is touched', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const past = mkTicket(dir, 'past-tip', { files: 'src/a.ts' });
  const clean = mkTicket(dir, 'clean-tree', { files: 'src/b.ts' });
  const dirty = mkTicket(dir, 'dirty-tree', { files: 'src/c.ts' });
  const untouched = mkTicket(dir, 'still-queued', { files: 'src/d.ts' });
  for (const id of [past, dirty, untouched]) run('queue.mjs', ['add', id], dir);
  // Held behind a dependency on purpose: reconcile and the dispatch list run in the same pass, so
  // an item reconcile puts back in the queue is handed straight out again and cuts itself a fresh
  // worktree. What reconcile did to the old one is only visible on something that cannot go out.
  run('queue.mjs', ['add', clean, '--depends', untouched], dir);

  const pastRun = run('queue.mjs', ['set', past, 'running', '--agent', 'w'], dir);
  run('queue.mjs', ['set', clean, 'running', '--agent', 'w'], dir);
  const dirtyRun = run('queue.mjs', ['set', dirty, 'running', '--agent', 'w'], dir);
  git(['-C', pastRun.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  writeFileSync(join(dirtyRun.json.worktree, 'scratch.txt'), 'dirty work\n');

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  const settled = Object.fromEntries(r.json.reconciled.map((x) => [x.ticket, x]));

  await t.test('a branch with a commit beyond the parent lands in one run', () => {
    assert.equal(settled[past].state, 'landed');
    assert.match(settled[past].note, /commit\(s\) beyond/);
  });

  await t.test('a dirty tree is committed as "wip: reclaimed", goes back to queued, and says so in the item log', () => {
    assert.equal(settled[dirty].state, 'queued');
    assert.equal(git(['-C', dirtyRun.json.worktree, 'log', '-1', '--format=%s'], dir), 'wip: reclaimed');
    assert.ok(itemOf(dir, dirty).notes.some((n) => /dirty/.test(n.text)), 'the item carries a note saying the tree was dirty');
  });

  await t.test('a clean tree with nothing committed goes back to queued and its worktree is gone', () => {
    assert.equal(settled[clean].state, 'queued');
    assert.equal(itemOf(dir, clean).worktree, null);
  });

  await t.test('an item that was not running is not touched', () => {
    assert.equal(settled[untouched], undefined);
  });

  await t.test('the item reconcile landed is the one the gate is asked about in the same run', () => {
    const gated = r.json.landed.find((l) => l.ticket === past);
    assert.ok(gated, 'the landed branch reaches step two in the same run');
    assert.equal(gated.action, 'gate');
  });
});

test('tick.mjs reconcile: a running item with no branch is skipped without an exception, and a worktree gone from disk says what was salvaged', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const noBranch = mkTicket(dir, 'no-branch', { files: 'src/a.ts' });
  const vanished = mkTicket(dir, 'gone-from-disk', { files: 'src/b.ts' });
  run('queue.mjs', ['add', noBranch], dir);
  run('queue.mjs', ['add', vanished], dir);
  run('queue.mjs', ['set', vanished, 'running', '--agent', 'w'], dir);

  // A running item that never got a branch is the shape a hand-edited or half-migrated queue
  // leaves behind; reconcile has to walk past it rather than throw on it.
  const doc = readQueue(dir);
  doc.items.find((i) => i.ticket === noBranch).state = 'running';
  writeQueue(dir, doc);

  const worktree = itemOf(dir, vanished).worktree;
  execFileSync('rm', ['-rf', worktree]);

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('the branchless running item is left exactly as it was', () => {
    assert.equal(itemOf(dir, noBranch).state, 'running');
    assert.ok(!r.json.reconciled.some((x) => x.ticket === noBranch));
  });

  await t.test('the item whose worktree vanished goes back to queued, and the message says what was salvaged', () => {
    const settled = r.json.reconciled.find((x) => x.ticket === vanished);
    assert.equal(settled.state, 'queued');
    assert.match(settled.note, /gone from disk/);
    assert.match(settled.note, /nothing to salvage/);
  });
});

// ---- 2. the dispatch list --------------------------------------------------------------------

test('tick.mjs dispatch: what goes on the list, in what order, and what never goes on it at all', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const ready = mkTicket(dir, 'ready-work', { files: 'src/ready.ts', class: 'heavy' });
  const blocked = mkTicket(dir, 'stopped-work', { files: 'src/stopped.ts' });
  const proposal = mkTicket(dir, 'a-proposal', { files: 'src/proposal.ts' });
  run('queue.mjs', ['add', ready], dir);
  run('queue.mjs', ['add', blocked], dir);
  run('queue.mjs', ['add', proposal, '--proposed'], dir);
  run('queue.mjs', ['set', blocked, 'blocked'], dir);

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('the output carries the tree it worked on, its branch and its sha', () => {
    assert.equal(r.json.tree, git(['rev-parse', '--show-toplevel'], dir));
    assert.equal(r.json.branch, git(['rev-parse', '--abbrev-ref', 'HEAD'], dir));
    assert.equal(r.json.sha, git(['rev-parse', 'HEAD'], dir));
  });

  await t.test('the model on every entry is the ticket\'s own class, never a default', () => {
    const entry = r.json.spawn.find((s) => s.ticket === ready);
    assert.ok(entry, 'the ready ticket is handed out');
    assert.equal(entry.model, 'heavy');
  });

  await t.test('the brief is a command that names the worktree the ticket was cut into', () => {
    const entry = r.json.spawn.find((s) => s.ticket === ready);
    assert.match(entry.brief, /brief\.mjs worker/);
    assert.match(entry.brief, new RegExp(`--tree ${entry.worktree}`));
    assert.ok(existsSync(entry.worktree), 'the worktree the brief names actually exists');
  });

  await t.test('a proposed ticket never reaches the list', () => {
    assert.ok(!r.json.spawn.some((s) => s.ticket === proposal));
  });

  await t.test('a blocked ticket never reaches the list, on this run or the next', () => {
    assert.ok(!r.json.spawn.some((s) => s.ticket === blocked));
    const again = tick(dir);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(!again.json.spawn.some((s) => s.ticket === blocked));
    assert.equal(itemOf(dir, blocked).state, 'blocked');
  });
});

// ---- the tree tick resolves to, with and without --horde written out -------------------------
//
// The same shared contract every other tool here reads (node.mjs main()'s own comment above its
// resolveTree call, and tree.test.mjs): an ordinary run with neither --tree nor --horde stays on
// cwd, whatever branch that happens to be — a resolvable horde is not by itself a second signal
// for "read trunk instead". --horde WRITTEN OUT is the one thing that does mean this horde's own
// trunk, exactly as queue.mjs plan/quality already read it (tree.test.mjs calls that "the one
// place" this reads trunk). Before this test existed, tick's own resolveTree call forwarded
// neither form of --horde at all, so the flag had no effect on the tree either way — this proves
// both halves: the ordinary default is unchanged, and the explicit flag now actually does
// something.
test('tick.mjs: no --horde stays on cwd; --horde written out resolves to that horde\'s own trunk instead', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  // Neither the mission's own base branch nor mission1/trunk — a shell that ended up here has
  // wandered somewhere tick was never told about, on purpose, matching the issue this is about.
  git(['checkout', 'develop'], dir);

  await t.test('no --horde at all: cwd, on whatever branch the main checkout is on', () => {
    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.tree, git(['rev-parse', '--show-toplevel'], dir));
    assert.equal(r.json.branch, 'develop');
    assert.equal(r.json.sha, git(['rev-parse', 'HEAD'], dir));
  });

  await t.test('--horde mission1 written out: this horde\'s own trunk, a different tree entirely', () => {
    const cwdRun = tick(dir);
    const r = tick(dir, ['--horde', 'mission1']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.branch, 'mission1/trunk');
    assert.notEqual(r.json.tree, cwdRun.json.tree);
    assert.match(r.json.tree, /worktrees[\\/]mission1[\\/]trunk$/);
    // Shared state, not part of either tree: the main checkout is left exactly where it was.
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), 'develop');
  });
});

// The parent is put at "landed" rather than left "running": reconcile runs first in the same pass,
// and a running branch with nothing on it goes straight back to the queue, which is not the state
// this is about. "landed" is what a parent a stack can be cut from actually looks like.
function stackFixture(t) {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  const parent = mkTicket(dir, 'the-parent', { files: 'src/parent.ts' });
  const child = mkTicket(dir, 'the-child', { files: 'src/child.ts', depends: parent });
  const plain = mkTicket(dir, 'plain-work', { files: 'src/plain.ts' });
  run('queue.mjs', ['add', parent], dir);
  run('queue.mjs', ['add', child, '--depends', parent], dir);
  run('queue.mjs', ['add', plain], dir);
  const running = run('queue.mjs', ['set', parent, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  run('queue.mjs', ['set', parent, 'landed'], dir);
  return {
    dir, parent, child, plain,
  };
}

test('tick.mjs dispatch: an unmerged dependency keeps a ticket off the list', async (t) => {
  const { dir, child, plain } = stackFixture(t);
  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.json.spawn.some((s) => s.ticket === child), 'the child waits on its parent');
  assert.ok(r.json.spawn.some((s) => s.ticket === plain), 'the ready ticket is handed out');
});

test('tick.mjs dispatch: --stack puts that same ticket back on the list, last, and marked', async (t) => {
  const { dir, parent, child } = stackFixture(t);
  const r = tick(dir, ['--stack']);
  assert.equal(r.code, 0, r.stderr);
  const entry = r.json.spawn.find((s) => s.ticket === child);
  assert.ok(entry, `the child is offered as a stack (${JSON.stringify(r.json.spawn.map((s) => s.ticket))})`);
  assert.equal(entry.stacked, `STACKED, parent t-${parent} unmerged`);
  assert.equal(r.json.spawn[r.json.spawn.length - 1].ticket, child, 'a stacked entry sorts last');
  assert.equal(itemOf(dir, child).stackedOn, parent, 'it was cut from the parent\'s branch');
});

test('tick.mjs dispatch: two tickets reaching for the same file never go out together, and the list never exceeds config.parallelism', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  await t.test('two tickets declaring the same file do not appear on one list', () => {
    const one = mkTicket(dir, 'same-file-one', { files: 'src/shared.ts' });
    const two = mkTicket(dir, 'same-file-two', { files: 'src/shared.ts' });
    run('queue.mjs', ['add', one], dir);
    run('queue.mjs', ['add', two], dir);
    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    const both = r.json.spawn.filter((s) => s.ticket === one || s.ticket === two);
    assert.equal(both.length, 1, 'exactly one of the two holders of src/shared.ts is handed out');
  });

  await t.test('the list stops at config.parallelism even when more are ready', () => {
    const fresh = makeRepo();
    t.after(() => quietRm(fresh));
    initHorde(fresh);
    run('horde.mjs', ['config', 'set', 'parallelism', '2'], fresh);
    for (const n of ['p-one', 'p-two', 'p-three', 'p-four']) {
      const id = mkTicket(fresh, n, { files: `src/${n}.ts` });
      run('queue.mjs', ['add', id], fresh);
    }
    const r = tick(fresh);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.spawn.length, 2);
  });
});

test('tick.mjs dispatch: the judge list is empty under judge "tier" and carries the pairs the gate handed back under "one-shot"', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const id = mkTicket(dir, 'left-pairs', { files: 'src/pairs.ts' });
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  const sha = git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir);
  // The item stays running here on purpose: tick's judge list reads the gate's own record, and the
  // record is about a branch, not about what the queue happens to say this minute.
  writeLandResult(dir, id, {
    ticket: id,
    branch: running.json.branch,
    sha,
    ok: false,
    checks: [{ name: 'judge', ok: false, note: 'one prose rule waits on a judge' }],
    pairs: [{ aspect: 'plain-language', unitKind: 'node', unit: 'core' }],
    brief: 'judge this pair',
    landed: null,
  });

  await t.test('under judge "one-shot" the pairs go on the list with their brief', () => {
    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = r.json.judge.find((j) => j.ticket === id);
    assert.ok(entry, 'the ticket the gate left pairs on is on the judge list');
    assert.equal(entry.pairs.length, 1);
    assert.equal(entry.brief, 'judge this pair');
  });

  await t.test('under judge "tier" the list is empty — an unjudged pair is a finding about the reviewer, not work to hand out', () => {
    run('horde.mjs', ['config', 'set', 'judge', 'tier'], dir);
    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.judge, []);
  });
});

test('tick.mjs close: an empty queue raises the flag and names the command; one queued item does not', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  await t.test('a queue with nothing in it is a wave that can close', () => {
    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.close, true);
    assert.match(r.json.closeCommand, /wave\.mjs close/);
  });

  await t.test('one queued item is not', () => {
    const id = mkTicket(dir, 'one-thing', { files: 'src/one.ts' });
    run('queue.mjs', ['add', id], dir);
    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.close, false);
    assert.equal(r.json.closeCommand, null);
  });

  await t.test('tick never runs the closing command itself — it only says what it is', () => {
    const before = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
    tick(dir);
    assert.equal(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8'), before);
  });
});

// ---- 4. broken states and races ---------------------------------------------------------------
//
// The real content of this tool: tick reads state after somebody else's crash, and every one of
// these is a state a crash actually leaves behind.

test('tick.mjs gate results: unparsable is absent, stale is ignored, and a green one whose branch is gone is a refusal', async (t) => {
  await t.test('a result truncated mid-write is read as absent and the gate runs again', () => {
    const dir = makeRepo();
    t.after(() => quietRm(dir));
    initHorde(dir);
    const id = mkTicket(dir, 'truncated-result', { files: 'src/t.ts' });
    run('queue.mjs', ['add', id], dir);
    const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
    git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
    run('queue.mjs', ['set', id, 'landed'], dir);
    writeLandResult(dir, id, '{"ticket": "001", "sha": "abc');

    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    const step = r.json.landed.find((l) => l.ticket === id);
    assert.equal(step.action, 'gate', 'the gate is asked again rather than the tool falling over');
    assert.equal(itemOf(dir, id).state, 'landed');
  });

  await t.test('a green result about a sha the branch has moved past is not mistaken for a fresh one', () => {
    const dir = makeRepo();
    t.after(() => quietRm(dir));
    initHorde(dir);
    const id = mkTicket(dir, 'stale-result', { files: 'src/s.ts' });
    run('queue.mjs', ['add', id], dir);
    const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
    git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'one'], dir);
    const old = git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir);
    git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'two'], dir);
    run('queue.mjs', ['set', id, 'landed'], dir);
    writeLandResult(dir, id, {
      ticket: id, branch: running.json.branch, sha: old, ok: true, checks: [], pairs: [], brief: null, landed: { ticket: id, sha: old },
    });

    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    const step = r.json.landed.find((l) => l.ticket === id);
    assert.equal(step.action, 'gate', 'a stale green is re-run, never taken at its word');
    assert.notEqual(itemOf(dir, id).state, 'merged');
  });

  await t.test('a green result whose branch has since vanished is refused by name, and the item is untouched', () => {
    const dir = makeRepo();
    t.after(() => quietRm(dir));
    initHorde(dir);
    const id = mkTicket(dir, 'vanished-branch', { files: 'src/v.ts' });
    run('queue.mjs', ['add', id], dir);
    const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
    git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
    const sha = git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir);
    run('queue.mjs', ['set', id, 'landed'], dir);
    writeLandResult(dir, id, {
      ticket: id, branch: running.json.branch, sha, ok: true, checks: [], pairs: [], brief: null, landed: { ticket: id, sha },
    });
    git(['worktree', 'remove', '--force', running.json.worktree], dir);
    git(['branch', '-D', running.json.branch], dir);

    const r = tick(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(running.json.branch.replace('/', '\\/')));
    assert.equal(itemOf(dir, id).state, 'landed', 'the item is exactly where it was');
  });
});

// ---- 080: one land.mjs call for the whole ready set, not one per ticket --------------------
//
// One real, passing node per ticket (never one shared node — see land.test.mjs's own
// setupBatchLandable for why), landed the way `queue.mjs set running` really cuts a worktree
// rather than a hand-cut branch, since this is the one tick.mjs test that has to prove something
// about the process boundary itself: that dispatch's own gate step is ONE call over the whole
// ready set, not N. land.test.mjs's own batch tests already cover the batching mechanic itself
// (the overlap exclusion, the red-gate fallback, the per-ticket attribution) in depth; this is the
// one place that proves tick.mjs actually hands land.mjs the ready set in one call to get there.
//
// Each node's own yg-node.yaml is written and committed on ITS ticket's own branch, beside the
// files it maps — never pre-committed to trunk ahead of them. Yggdrasil refuses a mapping whose
// path does not yet exist on the tree being checked ("mapping-path-missing"), and checking one
// ticket's own tree in isolation is exactly what land.mjs does for every ticket, batched or not —
// a node pre-declared on trunk for a file only ANOTHER, not-yet-merged ticket adds would refuse
// every one of them outright, for a reason that has nothing to do with what this test measures.
// Each ticket declares its own "**Files:**" too, for the same reason: the scope check's node-
// boundary fallback reads the node off trunk (this land.mjs run's own tree), and a brand-new node
// that only exists on the ticket's own branch is never going to be found there.
//
// The one thing committed to trunk before any ticket branch is cut is .yggdrasil/model/.gitkeep:
// git tracks files, never empty directories, so a model/ directory `yg init` merely left on disk
// would vanish the moment any branch without a node in it is checked out — trunk itself, until a
// ticket's own node lands on top of it — and Yggdrasil reads that missing directory as "no
// .yggdrasil/ project here at all" rather than the real answer, "no node by that name yet".
function setupTickBatchLandable(dir, n) {
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  run('horde.mjs', ['config', 'set', 'judge', 'one-shot'], dir);
  git(['checkout', 'mission1/trunk'], dir);
  mkdirSync(join(dir, '.yggdrasil', 'model'), { recursive: true });
  writeFileSync(join(dir, '.yggdrasil', 'model', '.gitkeep'), '');
  git(['add', '.yggdrasil'], dir);
  git(['commit', '-qm', 'graph: keep .yggdrasil/model/ a real, tracked path'], dir);

  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const slug = `batch-${i}`;
    const nodePath = `.yggdrasil/model/feature-${slug}/yg-node.yaml`;
    const ticketId = mkTicket(dir, slug, {
      node: `feature-${slug}`,
      files: [nodePath, `feature-${slug}.mjs`, `feature-${slug}.test.mjs`].join(','),
    });
    run('queue.mjs', ['add', ticketId], dir);
    const running = run('queue.mjs', ['set', ticketId, 'running', '--agent', 'w'], dir);
    const wt = running.json.worktree;
    const nodeDir = join(wt, '.yggdrasil', 'model', `feature-${slug}`);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, 'yg-node.yaml'), [
      `name: feature-${slug}`,
      'type: module',
      `description: Fixture component feature-${slug}.`,
      'mapping:',
      `  - "feature-${slug}.mjs"`,
      `  - "feature-${slug}.test.mjs"`,
      'relations: []',
      '',
    ].join('\n'));
    writeFileSync(join(wt, `feature-${slug}.mjs`), 'export function add(a, b) { return a + b; }\n');
    writeFileSync(join(wt, `feature-${slug}.test.mjs`), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      `import { add } from './feature-${slug}.mjs';`,
      "test('add', () => { assert.equal(add(1, 2), 3); });",
      '',
    ].join('\n'));
    git(['-C', wt, 'add', '--', `feature-${slug}.mjs`, `feature-${slug}.test.mjs`, '.yggdrasil'], dir);
    git(['-C', wt, 'commit', '-qm', `ticket ${ticketId}`], dir);
    appendFileSync(ticketLogPath(dir, ticketId), `- ${new Date().toISOString()} status: landed — ready to land\n`);
    run('queue.mjs', ['set', ticketId, 'landed'], dir);
    ids.push(ticketId);
  }
  return ids;
}

test('tick.mjs dispatch: two non-overlapping ready tickets share one gate run through land.mjs, not one each', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  const ids = setupTickBatchLandable(dir, 2);
  const gateLog = join(dir, 'gate-calls.log');
  run('horde.mjs', ['config', 'set', 'gates.team', `echo run >> "${gateLog}"`], dir);

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  for (const id of ids) {
    const step = r.json.landed.find((l) => l.ticket === id);
    assert.ok(step, `${id} was not put through the gate`);
    assert.equal(step.action, 'gate');
  }

  const deadline = Date.now() + 90000;
  let allMerged = false;
  while (Date.now() < deadline && !allMerged) {
    const items = readQueue(dir).items;
    allMerged = ids.every((id) => items.find((i) => i.ticket === id)?.state === 'merged');
    if (!allMerged) await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  assert.ok(allMerged, `both tickets landed (queue: ${JSON.stringify(readQueue(dir).items.map((i) => [i.ticket, i.state]))})`);

  const callCount = () => (existsSync(gateLog) ? readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  assert.equal(callCount(), 1, 'one land.mjs call for the whole ready set shared one run of the repository\'s own gate command');
});

test('tick.mjs: a queue.json caught half-written is refused by name and never written over', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  const id = mkTicket(dir, 'precious-state', { files: 'src/p.ts' });
  run('queue.mjs', ['add', id], dir);

  const whole = readFileSync(queuePath(dir), 'utf8');
  const truncated = whole.slice(0, 60);
  writeFileSync(queuePath(dir), truncated);

  const r = tick(dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid JSON/);
  assert.match(r.stderr, /queue\.json/);
  assert.equal(readFileSync(queuePath(dir), 'utf8'), truncated, 'the half-written file is exactly as it was — no empty queue written over it');
});

test('tick.mjs: a ticket whose fix rounds are spent stops, asks the client, and never comes back on the list', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const id = mkTicket(dir, 'going-nowhere', { files: 'src/n.ts' });
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  const sha = git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir);
  run('queue.mjs', ['set', id, 'landed'], dir);
  spendFixRounds(dir, id, 5);
  writeLandResult(dir, id, {
    ticket: id,
    branch: running.json.branch,
    sha,
    ok: false,
    checks: [{ name: 'tests', ok: false, note: 'the suite is still red' }],
    pairs: [],
    brief: null,
    landed: null,
  });

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('the item and the ticket both stop at blocked', () => {
    assert.equal(itemOf(dir, id).state, 'blocked');
    const status = run('tk.mjs', ['show', id], dir, { json: false });
    assert.match(status.stdout, /blocked/);
  });

  await t.test('an ask of kind "stuck" is filed with the gate\'s last words and the ticket\'s log', () => {
    const asks = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'asks.json'), 'utf8'));
    const ask = asks.items.find((a) => a.ticket === id);
    assert.equal(ask.kind, 'stuck');
    assert.equal(ask.state, 'open');
    assert.match(ask.why, /the suite is still red/);
    assert.match(ask.log, /log\.md$/);
  });

  await t.test('it is on the askClient list, and it never returns to spawn', () => {
    assert.ok(r.json.askClient.some((a) => a.kind === 'stuck'));
    const again = tick(dir);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(!again.json.spawn.some((s) => s.ticket === id));
    assert.equal(again.json.askClient.length, 1, 'and the same question is not asked twice');
  });
});

test('tick.mjs: a red gate with rounds left puts the ticket back in the queue rather than stopping it', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const id = mkTicket(dir, 'one-more-round', { files: 'src/r.ts' });
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  run('queue.mjs', ['set', id, 'landed'], dir);
  writeLandResult(dir, id, {
    ticket: id,
    branch: running.json.branch,
    sha: git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir),
    ok: false,
    checks: [{ name: 'tests', ok: false, note: 'two cases fail' }],
    pairs: [],
    brief: null,
    landed: null,
  });

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  const step = r.json.landed.find((l) => l.ticket === id);
  assert.equal(step.action, 'changes');
  assert.match(step.note, /two cases fail/);
  assert.equal(itemOf(dir, id).state, 'running', 'the fix round goes straight back out on this same run');
  assert.ok(r.json.spawn.some((s) => s.ticket === id), 'and it is on the dispatch list again');
  assert.ok(!existsSync(join(dir, '.horde', 'hordes', 'mission1', 'asks.json')), 'nothing is asked of the client while rounds remain');
});

// changesRoundInfo's own label ("resume same worker" for rounds 1..resume, "fresh worker, class
// up" beyond it) has always been real — the takeover flag on the brief command already followed
// it. What the dispatch list handed out did not: `model` was read straight off the ticket's own
// static Class field regardless of `takeover`, so the "class up" in the label never actually
// happened. Four red gates in a row (default resume=3, fresh=2) drives the ticket past the resume
// band and into the fresh one on the fourth, and the redispatch that follows each round is where
// the fix actually shows.
test('tick.mjs dispatch: past config.fixRounds.resume, the redispatched model is one class up — not the ticket\'s own class', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const id = mkTicket(dir, 'earns-a-heavier-worker', { files: 'src/hw.ts', class: 'standard' });
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  const sha = git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir);

  const spawns = [];
  for (let round = 1; round <= 4; round += 1) {
    assert.equal(run('queue.mjs', ['set', id, 'landed'], dir).code, 0);
    writeLandResult(dir, id, {
      ticket: id,
      branch: running.json.branch,
      sha,
      ok: false,
      checks: [{ name: 'tests', ok: false, note: `round ${round} still red` }],
      pairs: [],
      brief: null,
      landed: null,
    });
    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    spawns.push(r.json.spawn.find((s) => s.ticket === id));
    // tick.mjs's own gate-red handler logs a round only once per "changes" status (so reading the
    // same red result twice never double-counts) — so the ticket has to be moved off "changes"
    // before the next red gate counts as a new round, exactly as a real worker taking it back up
    // would leave it.
    if (round < 4) {
      assert.equal(run('tk.mjs', ['status', id, 'running', `resuming for round ${round + 1}`], dir).code, 0);
    }
  }

  await t.test('rounds 1-2 (still within resume) redispatch on the ticket\'s own class, same as before this fix', () => {
    for (const spawned of spawns.slice(0, 2)) {
      assert.ok(spawned, `redispatched (${JSON.stringify(spawns)})`);
      assert.doesNotMatch(spawned.brief, /--takeover/);
      assert.equal(spawned.model, 'standard');
    }
  });

  await t.test('rounds 3-4 (past resume) redispatch one class up, never the ticket\'s own "standard"', () => {
    for (const spawned of spawns.slice(2)) {
      assert.ok(spawned, `redispatched (${JSON.stringify(spawns)})`);
      assert.match(spawned.brief, /--takeover/);
      assert.equal(spawned.model, 'heavy', 'one rung up the default ladder from "standard"');
      assert.notEqual(spawned.model, 'standard');
    }
  });
});

// The test above proves dispatch() renders the right brief command once a ticket is past
// config.fixRounds.resume. Under --runner external, nobody reads that dispatch list — externalStart()
// runs the brief itself, and it used to reconstruct its own call to brief.mjs from scratch, one that
// carried neither --takeover nor the round-aware --name. Same four-red-gates drive as above; this
// time the proof is the brief file externalStart() actually wrote, read back off disk — the only
// artifact of which command rendered it.
test('tick.mjs --runner external: the round-4 (takeover) worker is briefed with --takeover and its round-aware name, not the flat one', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const marker = join(dir, 'the-cli-ran-external.txt');
  run('horde.mjs', ['config', 'set', 'runner.spawn', `touch ${marker}`], dir);

  const id = mkTicket(dir, 'earns-a-heavier-worker-external', { files: 'src/hwx.ts', class: 'standard' });
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  const sha = git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir);

  let lastRun;
  for (let round = 1; round <= 4; round += 1) {
    assert.equal(run('queue.mjs', ['set', id, 'landed'], dir).code, 0);
    writeLandResult(dir, id, {
      ticket: id,
      branch: running.json.branch,
      sha,
      ok: false,
      checks: [{ name: 'tests', ok: false, note: `round ${round} still red` }],
      pairs: [],
      brief: null,
      landed: null,
    });
    const r = tick(dir, ['--runner', 'external']);
    assert.equal(r.code, 0, r.stderr);
    lastRun = r;
    // Same reasoning as the dispatch-only test above: the ticket has to leave "changes" before the
    // next red gate counts as a new round.
    if (round < 4) {
      assert.equal(run('tk.mjs', ['status', id, 'running', `resuming for round ${round + 1}`], dir).code, 0);
    }
  }

  // Round 4 is past the default resume band (3), so dispatch() redispatches this ticket with a
  // --takeover brief command under a round-aware name — this is the setup the rest of the test needs,
  // already covered by the test above, checked here only to read the name it used back out.
  const spawned = lastRun.json.spawn.find((s) => s.ticket === id);
  assert.ok(spawned, `round 4 redispatched (${JSON.stringify(lastRun.json.spawn)})`);
  assert.match(spawned.brief, /--takeover/);
  const roundName = (spawned.brief.match(/--name (\S+)/) || [])[1];
  assert.ok(roundName && roundName !== `w-${id}` && roundName.startsWith(`w-${id}-r`), `dispatch named a round-aware worker (${roundName})`);

  // This is the part that was broken: externalStart() rendering its own brief, under its own name,
  // with no takeover section, no matter what dispatch() had already worked out.
  const started = lastRun.json.external.find((e) => e.ticket === id);
  assert.ok(started, `the external runner started round 4 (${JSON.stringify(lastRun.json.external)})`);
  assert.ok(started.started, `brief render did not fail (${JSON.stringify(started)})`);

  const briefText = readFileSync(started.brief, 'utf8');
  assert.match(briefText, /## Takeover/, 'the brief externalStart() rendered carries the takeover section');
  assert.ok(briefText.includes(`You are **${roundName}**,`), 'and opens under the round-numbered name dispatch() chose');
  assert.ok(!briefText.includes(`You are **w-${id}**,`), 'never the flat name once the ticket is in the takeover band');
});

// externalStart() used to run entry.brief as one string through a shell (execSync). Nothing
// validates a horde's name against a safe character set at creation — horde.mjs init takes
// whatever it is given — so a horde named with a shell metacharacter sequence that is still a
// valid git ref (branch names forbid spaces and a handful of others, but not ';', '|', '&', '`',
// '$(' ) would have let that name break out of its own --horde argument and run an arbitrary
// second command. Fixed by running the brief through the same argv array dispatch() already built
// (briefParts), never a shell. This proves the fix holds against the exact class of name that
// would have triggered it, not just that the happy path still works.
test('tick.mjs --runner external: a horde name is never handed to a shell, even one shaped like an injection', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  const horde = 'mission1;>INJECTED_MARKER';
  initHorde(dir, horde);

  const marker = join(dir, 'INJECTED_MARKER');
  run('horde.mjs', ['config', 'set', 'runner.spawn', 'true'], dir);
  const id = mkTicket(dir, 'runner-injection-check', { files: 'src/inj.ts' });
  run('queue.mjs', ['add', id], dir);
  run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);

  const r = tick(dir, ['--runner', 'external']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.external.length, 1, `one worker started (${JSON.stringify(r.json.external)})`);
  const started = r.json.external[0];
  assert.ok(started.started, `brief render did not fail on the weird name (${JSON.stringify(started)})`);
  assert.ok(!existsSync(marker), 'the ";>INJECTED_MARKER" tail of the horde name was never handed to a shell');

  // Not just "nothing bad happened" — the weird name reached brief.mjs as one literal argument, the
  // same as any other horde name would.
  const briefText = readFileSync(started.brief, 'utf8');
  assert.ok(briefText.includes(horde), 'the horde name reached the brief intact, as one literal value');
});

test('tick.mjs: asks.json that does not exist is an empty in-tray, not a refusal', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  assert.ok(!existsSync(join(dir, '.horde', 'hordes', 'mission1', 'asks.json')));
  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.askClient, []);
});

// ---- what an open question holds up ------------------------------------------------------------
//
// An open ask is a question the client has not answered yet, and a client away from their desk must
// not cost the mission the work that question has nothing to do with. Each kind holds exactly what
// depends on the answer — "stop" the whole dispatch list, "stuck" that one ticket, "charter" every
// ticket earning an evidence row it names, "lower" that one branch's landing — and tick hands out
// the rest.

function askOpen(dir, why, kind, extra = []) {
  const r = run('ask.mjs', ['add', why, '--kind', kind, ...extra], dir);
  if (r.code !== 0) throw new Error(`ask add (${kind}) failed: ${r.stderr}`);
  return r.json.id;
}

function charterEdit(dir, text) {
  return execFileSync('node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit', '--json'], { cwd: dir, input: text, encoding: 'utf8' });
}

function heldFor(r, ticket) {
  return r.json.held.find((h) => h.ticket === ticket);
}

test('tick.mjs holds: an open "stop" holds the whole dispatch list, and answering it releases it', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const one = mkTicket(dir, 'stop-one', { files: 'src/one.ts' });
  const two = mkTicket(dir, 'stop-two', { files: 'src/two.ts' });
  run('queue.mjs', ['add', one], dir);
  run('queue.mjs', ['add', two], dir);
  const ask = askOpen(dir, 'the spec runs out at the checkout boundary', 'stop', ['--ticket', one]);

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('nothing goes out at all while the question stands', () => {
    assert.deepEqual(r.json.spawn, []);
    const entry = r.json.held.find((h) => h.kind === 'stop');
    assert.ok(entry, `the stop is on the held list (${JSON.stringify(r.json.held)})`);
    assert.equal(entry.holds, 'dispatch');
    assert.equal(entry.ask, ask);
    assert.match(entry.note, /the spec runs out at the checkout boundary/);
  });

  await t.test('and nothing was cut for it — both items are exactly where they were', () => {
    assert.equal(itemOf(dir, one).state, 'queued');
    assert.equal(itemOf(dir, two).state, 'queued');
  });

  await t.test('the client answering it puts the whole list back out on the next run', () => {
    const answered = run('ask.mjs', ['answer', ask, 'build the narrow one'], dir);
    assert.equal(answered.code, 0, answered.stderr);
    const again = tick(dir);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.json.held, []);
    assert.deepEqual(again.json.spawn.map((s) => s.ticket).sort(), [one, two].sort());
  });
});

// "stop" is the widest kind on the list, and a landing is provably a holdable thing — "lower"
// holds one. So "stop" holds every landing too, or it would be narrower than "lower" on the one
// axis they share. It has to hold BEFORE the gate is started: the gate merges the branch into its
// parent itself, so a run that starts one has already landed it by the time a result exists.
test('tick.mjs holds: an open "stop" holds a ready branch at the gate, and answering it lands the same branch', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const id = mkTicket(dir, 'ready-to-land', { files: 'src/ready.ts' });
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  const sha = git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir);
  run('queue.mjs', ['set', id, 'landed'], dir);
  // The gate's own green record about exactly this tip: without a hold, tick merges it on sight.
  writeLandResult(dir, id, {
    ticket: id, branch: running.json.branch, sha, ok: true, checks: [], pairs: [], brief: null, landed: { ticket: id, sha },
  });
  const ask = askOpen(dir, 'the refund rule contradicts the spec — stop before this merges', 'stop');

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('nothing merges while the question stands, and the item is exactly where it was', () => {
    assert.ok(!r.json.landed.some((l) => l.ticket === id), `no gate step ran for it (${JSON.stringify(r.json.landed)})`);
    assert.equal(itemOf(dir, id).state, 'landed');
    const entry = heldFor(r, id);
    assert.ok(entry, `the branch says which question holds it (${JSON.stringify(r.json.held)})`);
    assert.equal(entry.kind, 'stop');
    assert.equal(entry.holds, 'landing');
    assert.equal(entry.ask, ask);
  });

  await t.test('and the wave does not close underneath it either', () => {
    assert.equal(r.json.close, false);
    assert.equal(r.json.closeCommand, null);
  });

  await t.test('the client answering it lands the same branch on the next run', () => {
    const answered = run('ask.mjs', ['answer', ask, 'the spec is right — land it'], dir);
    assert.equal(answered.code, 0, answered.stderr);
    const again = tick(dir);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.json.held, []);
    const step = again.json.landed.find((l) => l.ticket === id);
    assert.ok(step, `the gate's green record is acted on now (${JSON.stringify(again.json.landed)})`);
    assert.equal(step.action, 'merged');
    assert.equal(itemOf(dir, id).state, 'merged');
  });
});

test('tick.mjs holds: an open "stop" holds the close of a queue that holds nothing unmerged', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const id = mkTicket(dir, 'the-last-one', { files: 'src/last.ts' });
  run('queue.mjs', ['add', id], dir);
  const doc = readQueue(dir);
  doc.items.find((i) => i.ticket === id).state = 'merged';
  writeQueue(dir, doc);
  const ask = askOpen(dir, 'the migration may have to be reversed — hold everything', 'stop');

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.close, false, 'an unanswered stop is not a wave that can close');
  assert.equal(r.json.closeCommand, null);
  const entry = r.json.held.find((h) => h.holds === 'close');
  assert.ok(entry, `the close says which question holds it (${JSON.stringify(r.json.held)})`);
  assert.equal(entry.kind, 'stop');
  assert.equal(entry.ask, ask);

  await t.test('answering it raises the flag and names the command, on the very next run', () => {
    const answered = run('ask.mjs', ['answer', ask, 'no reversal needed'], dir);
    assert.equal(answered.code, 0, answered.stderr);
    const again = tick(dir);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.close, true);
    assert.match(again.json.closeCommand, /wave\.mjs close/);
    assert.deepEqual(again.json.held, []);
  });
});

test('tick.mjs holds: an open "stuck" holds that one ticket and the rest of the queue goes out', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const held = mkTicket(dir, 'going-nowhere', { files: 'src/held.ts' });
  const moving = mkTicket(dir, 'still-moving', { files: 'src/moving.ts' });
  run('queue.mjs', ['add', held], dir);
  run('queue.mjs', ['add', moving], dir);
  const ask = askOpen(dir, 'fix rounds spent. The gate\'s last words: two cases still fail', 'stuck', ['--ticket', held]);

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.json.spawn.some((s) => s.ticket === held), 'the ticket the question is about is not handed out');
  assert.ok(r.json.spawn.some((s) => s.ticket === moving), 'everything else is');
  const entry = heldFor(r, held);
  assert.ok(entry, `the held ticket says which question holds it (${JSON.stringify(r.json.held)})`);
  assert.equal(entry.kind, 'stuck');
  assert.equal(entry.ask, ask);
  assert.equal(entry.holds, 'dispatch');
  assert.equal(itemOf(dir, held).state, 'queued', 'and it was left exactly as it stood');
});

test('tick.mjs holds: an open "charter" holds the tickets earning the evidence rows it names, and no others', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  charterEdit(dir, [
    '# Mission · m', '', '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |', '|---|---|---|---|',
    '| E1 | the suite is green | core | |',
    '| E2 | the page renders | core | |', '',
  ].join('\n'));

  // "E1: …" is the documented shape: the id fills the ticket's Evidence field and the rest is the
  // acceptance line a verifier reproduces, so one flag says both.
  const onE1 = mkTicket(dir, 'earns-e1', { files: 'src/e1.ts', evidence: 'E1: the suite is green' });
  const onE2 = mkTicket(dir, 'earns-e2', { files: 'src/e2.ts', evidence: 'E2: the page renders' });
  const noRow = mkTicket(dir, 'earns-no-row', { files: 'src/plain.ts' });
  for (const id of [onE1, onE2, noRow]) run('queue.mjs', ['add', id], dir);
  const ask = askOpen(dir, 'is E2 still promised? nobody can reproduce that page', 'charter');

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('the ticket earning the named row waits', () => {
    assert.ok(!r.json.spawn.some((s) => s.ticket === onE2));
    const entry = heldFor(r, onE2);
    assert.ok(entry, `it says which question holds it (${JSON.stringify(r.json.held)})`);
    assert.equal(entry.kind, 'charter');
    assert.equal(entry.ask, ask);
  });

  await t.test('a ticket earning a row the question does not name goes out, and so does one earning no row at all', () => {
    assert.ok(r.json.spawn.some((s) => s.ticket === onE1));
    assert.ok(r.json.spawn.some((s) => s.ticket === noRow));
    assert.equal(r.json.held.length, 1, 'one question, one ticket held');
  });

  await t.test('a charter question naming no row at all holds nothing', () => {
    const fresh = makeRepo();
    t.after(() => quietRm(fresh));
    initHorde(fresh);
    const id = mkTicket(fresh, 'untouched', { files: 'src/u.ts' });
    run('queue.mjs', ['add', id], fresh);
    askOpen(fresh, 'should the goal paragraph say "checkout" or "basket"?', 'charter');
    const out = tick(fresh);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(out.json.held, []);
    assert.ok(out.json.spawn.some((s) => s.ticket === id));
  });
});

test('tick.mjs holds: an open "lower" holds that branch at the gate and nothing else', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const waiting = mkTicket(dir, 'weakens-a-rule', { files: 'src/w.ts' });
  const moving = mkTicket(dir, 'plain-work', { files: 'src/p.ts' });
  run('queue.mjs', ['add', waiting], dir);
  run('queue.mjs', ['add', moving], dir);
  const running = run('queue.mjs', ['set', waiting, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  run('queue.mjs', ['set', waiting, 'landed'], dir);
  const ask = askOpen(dir, 'this cannot pass without suppressing the rule — may we?', 'lower', ['--ticket', waiting, '--aspect', 'plain-language']);

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('the gate is never asked about that branch, and no round is counted against it', () => {
    assert.ok(!r.json.landed.some((l) => l.ticket === waiting), `nothing gated it (${JSON.stringify(r.json.landed)})`);
    assert.equal(itemOf(dir, waiting).state, 'landed', 'the item is exactly where it was');
    const entry = heldFor(r, waiting);
    assert.ok(entry, `it says which question holds it (${JSON.stringify(r.json.held)})`);
    assert.equal(entry.kind, 'lower');
    assert.equal(entry.ask, ask);
    assert.equal(entry.holds, 'landing', 'a "lower" holds the landing, never the queue');
  });

  await t.test('the queue keeps moving underneath it', () => {
    assert.ok(r.json.spawn.some((s) => s.ticket === moving));
  });
});

test('tick.mjs: two ticks racing on one repository bill one worker once and leave one branch behind', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  const id = mkTicket(dir, 'contested', { files: 'src/contested.ts' });
  run('queue.mjs', ['add', id], dir);

  const both = await Promise.all([0, 1].map(() => new Promise((resolve) => {
    const child = spawn('node', [join(SCRIPTS_DIR, 'tick.mjs'), '--json'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  })));

  await t.test('both runs came back — the gate lock made them wait for each other, it did not refuse either', () => {
    for (const one of both) assert.equal(one.code, 0, one.stderr);
  });

  await t.test('one item, one branch, one worktree — the ticket was never cut twice', () => {
    const items = readQueue(dir).items.filter((i) => i.ticket === id);
    assert.equal(items.length, 1);
    assert.equal(items[0].state, 'running');
    assert.equal(items[0].branch, 'mission1/t-001');
    const branches = git(['branch', '--list', '*t-001'], dir).split('\n').filter(Boolean);
    assert.equal(branches.length, 1);
  });
});

// ---- 5. the runners ----------------------------------------------------------------------------

test('tick.mjs runners: nothing but git and the configured CLI is ever started, and external without a command refuses', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  const id = mkTicket(dir, 'runner-work', { files: 'src/runner.ts' });
  run('queue.mjs', ['add', id], dir);

  const marker = join(dir, 'the-cli-ran.txt');

  await t.test('--runner external with no config.runner.spawn refuses, naming the key to set', () => {
    const r = tick(dir, ['--runner', 'external']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /config\.runner\.spawn/);
  });

  await t.test('under the session runner the configured command is never run', () => {
    run('horde.mjs', ['config', 'set', 'runner.spawn', `touch ${marker}`], dir);
    const r = tick(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json.spawn.length >= 1, 'something was handed out, so the run is a real one');
    assert.deepEqual(r.json.external, []);
    assert.ok(!existsSync(marker), 'the session runner starts nothing itself — the caller does');
  });

  await t.test('under the external runner it is', async () => {
    run('queue.mjs', ['set', id, 'queued'], dir);
    const r = tick(dir, ['--runner', 'external']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.external.length, 1);
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    assert.ok(existsSync(marker), 'the configured CLI is what starts a worker when nobody else can');
  });

  // There are two runners, not three: the one built on Claude Code's Agent Teams is gone, and gone
  // means refused by name rather than quietly read as "session" — a flag or a config key that names
  // it is describing a topology this no longer has, and reading it as the default would hide that.
  await t.test('--runner teammate is refused by name, and the refusal names the two that exist', () => {
    const r = tick(dir, ['--runner', 'teammate']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown runner: teammate/);
    assert.match(r.stderr, /session, external/);
  });
});

test('tick.mjs runners: a config seeded with the retired runner refuses rather than falling back to the session', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  const id = mkTicket(dir, 'stale-runner', { files: 'src/stale.ts' });
  run('queue.mjs', ['add', id], dir);

  // Written straight into the file, the way an older `config set` or a hand edit would have left it.
  const configPath = join(dir, '.horde', 'config.json');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  cfg.runner = { ...(cfg.runner || {}), kind: 'teammate' };
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);

  const r = tick(dir);
  assert.equal(r.code, 1, 'a broken config is a refusal, not a silent default');
  assert.match(r.stderr, /unknown runner: teammate/);
  assert.match(r.stderr, /session, external/);
  assert.equal(r.json, null, 'and nothing was handed out under the fallback');
});

test('tick.mjs --watch: a signal ends the loop without leaving the gate lock held', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'tick.interval', '60'], dir);
  const id = mkTicket(dir, 'watched', { files: 'src/w.ts' });
  run('queue.mjs', ['add', id], dir);

  const watcher = spawn('node', [join(SCRIPTS_DIR, 'tick.mjs'), '--watch', '--json'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  watcher.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => { watcher.on('close', (code) => resolve(code)); });
  await new Promise((resolve) => { setTimeout(resolve, 2500); });
  watcher.kill('SIGINT');
  const code = await exited;

  assert.equal(code, 0, 'an interrupted watch exits cleanly');
  assert.ok(out.includes('"spawn"'), 'it did at least one pass before the signal');
  assert.ok(!existsSync(join(dir, '.horde', 'gate.lock')), 'and it left no lock held');
  assert.ok(!readQueue(dir).items.some((i) => i.state === 'running' && !i.branch), 'and no running item without a branch');
});

test('tick.mjs --watch: a refusal in one pass is written down, not the end of the loop', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'tick.interval', '1'], dir);
  const id = mkTicket(dir, 'refused', { files: 'src/r.ts' });
  run('queue.mjs', ['add', id], dir);
  // A queue the loop cannot read: every pass refuses, for a reason a later pass could find gone.
  writeFileSync(queuePath(dir), '{ not json at all');

  const watcher = spawn('node', [join(SCRIPTS_DIR, 'tick.mjs'), '--watch'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  watcher.stderr.on('data', (d) => { err += d; });
  watcher.stdout.on('data', () => {});
  const exited = new Promise((resolve) => { watcher.on('close', (code) => resolve(code)); });
  await new Promise((resolve) => { setTimeout(resolve, 3500); });
  watcher.kill('SIGINT');
  const code = await exited;

  assert.equal(code, 0, 'the watcher outlived the refusal and ended on the signal, not on it');
  assert.match(err, /invalid JSON in/, 'and said why it refused');
  const journal = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
  const refusals = journal.split('\n').filter((l) => l.includes('tick refused:'));
  assert.ok(refusals.length >= 2, `the journal holds a line per refused pass (got ${refusals.length})`);
  assert.ok(!existsSync(join(dir, '.horde', 'gate.lock')), 'and no pass left the gate lock held');
});
