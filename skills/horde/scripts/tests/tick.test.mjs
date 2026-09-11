import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, writeCostRuns,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function mkTicket(dir, slug, opts = {}) {
  const {
    node = 'core', class: cls = 'sonnet', severity, files, depends,
  } = opts;
  const flags = ['--node', node, '--class', cls];
  if (severity) flags.push('--severity', severity);
  if (files) flags.push('--files', files);
  if (depends) flags.push('--depends', depends);
  const r = run('tk.mjs', ['new', slug, '--title', slug, ...flags, '--evidence', 'it works'], dir);
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

  const ready = mkTicket(dir, 'ready-work', { files: 'src/ready.ts', class: 'opus' });
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
    assert.equal(entry.model, 'opus');
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

// ---- 3. cost ----------------------------------------------------------------------------------

test('tick.mjs cost: one entry per thing handed out, keyed so two runs over one state cannot double-book it', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  run('wave.mjs', ['start'], dir);

  const id = mkTicket(dir, 'billed-work', { files: 'src/billed.ts', class: 'opus' });
  run('queue.mjs', ['add', id], dir);

  const first = tick(dir);
  assert.equal(first.code, 0, first.stderr);

  await t.test('the entry carries the ticket\'s class and the wave it was handed out in', () => {
    const runs = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'cost.json'), 'utf8')).runs;
    const entry = runs.find((x) => x.ticket === id);
    assert.ok(entry, 'the worker is booked');
    assert.equal(entry.role, 'worker');
    assert.equal(entry.class, 'opus');
    assert.equal(entry.wave, '1');
  });

  await t.test('a second run over the same state leaves the ledger exactly as it found it', () => {
    const before = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'cost.json'), 'utf8')).runs.length;
    const second = tick(dir);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(second.json.cost, [], 'the second run books nothing new');
    const after = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'cost.json'), 'utf8')).runs.length;
    assert.equal(after, before);
  });

  await t.test('cost.mjs report sums what tick wrote, with no change of its own', () => {
    const r = run('cost.mjs', ['report'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json.runs >= 1);
    assert.ok(r.json.weighted >= 10, 'an opus run weighs 10');
  });

  await t.test('an entry seeded before this run is recognised rather than written a second time', () => {
    const fresh = makeRepo();
    t.after(() => quietRm(fresh));
    initHorde(fresh);
    const seeded = mkTicket(fresh, 'already-billed', { files: 'src/seeded.ts' });
    run('queue.mjs', ['add', seeded], fresh);
    writeCostRuns(fresh, 'mission1', [{
      name: `w-${seeded}`, role: 'worker', class: 'sonnet', ticket: seeded, wave: null, at: '2026-01-01T00:00:00.000Z',
    }]);
    const r = tick(fresh);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json.spawn.some((s) => s.ticket === seeded), 'it is still handed out');
    assert.deepEqual(r.json.cost, [], 'and it is not billed twice');
  });
});

test('tick.mjs cost: a judge on the dispatch list leaves an entry of its own', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);

  const id = mkTicket(dir, 'judged-work', { files: 'src/judged.ts' });
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  writeLandResult(dir, id, {
    ticket: id,
    branch: running.json.branch,
    sha: git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir),
    ok: false,
    checks: [{ name: 'judge', ok: false, note: 'a prose rule waits' }],
    pairs: [{ aspect: 'plain-language', unitKind: 'node', unit: 'core' }],
    brief: 'judge it',
    landed: null,
  });

  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  const entry = r.json.cost.find((c) => c.role === 'judge');
  assert.ok(entry, 'the judge is booked too');
  assert.equal(entry.ticket, id);

  const again = tick(dir);
  assert.deepEqual(again.json.cost.filter((c) => c.role === 'judge'), [], 'and only once');
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

test('tick.mjs: asks.json that does not exist is an empty in-tray, not a refusal', async (t) => {
  const dir = makeRepo();
  t.after(() => quietRm(dir));
  initHorde(dir);
  assert.ok(!existsSync(join(dir, '.horde', 'hordes', 'mission1', 'asks.json')));
  const r = tick(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.askClient, []);
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

  await t.test('the worker is billed exactly once, however many runs handed the ticket out', () => {
    const runs = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'cost.json'), 'utf8')).runs;
    assert.equal(runs.filter((x) => x.ticket === id).length, 1);
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
