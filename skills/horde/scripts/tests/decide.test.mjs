import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';
import { raceOneLock, overlaps, describeRace } from './lock-race/harness.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// The lock whatever spends a client's answer holds (withDecisionsLock): Horde's own, beside the
// mission's loop, whose own lock guards each single write to decisions.md.
function decisionsLockFile(dir, horde = 'mission1') {
  return join(dir, '.horde', 'hordes', horde, 'decisions.lock');
}

// One real process taking the answers lock and letting it go at once — what a landing spending a
// "once" answer does around its merge.
function takeDecisionsLock(dir) {
  const decidePath = join(SCRIPTS_DIR, 'decide.mjs');
  const script = [
    `import { withDecisionsLock } from ${JSON.stringify(pathToFileURL(decidePath).href)};`,
    "withDecisionsLock('mission1', () => {});",
    "console.log(JSON.stringify({ ok: true }));",
  ].join('\n');
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, json: JSON.parse(out.trim().split('\n').pop()), stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, json: null, stderr: String(e.stderr || '') };
  }
}

test('decide.mjs: add, list, show, refusals', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const ticket = run('tk.mjs', ['new', 'freshness', '--title', 'Freshness', '--node', 'core', '--class', 'standard', '--evidence', 'it works'], dir).json.id;

  await t.test('add records an entry in the mission\'s loop and show returns it, with the ticket it settles', () => {
    const r = run('decide.mjs', ['add', 'lesson-1', 'Always check base freshness first.', '--ticket', ticket], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.slug, 'lesson-1');
    const shown = run('decide.mjs', ['show', 'lesson-1'], dir);
    assert.equal(shown.code, 0);
    assert.match(shown.json.body, /^Always check base freshness first\./);
    assert.equal(shown.json.ticket, ticket);
  });

  await t.test('a ticket this mission does not have is refused', () => {
    const r = run('decide.mjs', ['add', 'lesson-2', 'Anything.', '--ticket', '77'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such ticket: 077/);
  });

  await t.test('add refuses a duplicate slug', () => {
    const r = run('decide.mjs', ['add', 'lesson-1', 'anything'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /duplicate slug: lesson-1/);
  });

  await t.test('list supports --grep', () => {
    const byGrep = run('decide.mjs', ['list', '--grep', 'freshness'], dir);
    assert.equal(byGrep.json.length, 1);
    assert.equal(byGrep.json[0].slug, 'lesson-1');
  });

  await t.test('show refuses an unknown slug', () => {
    const r = run('decide.mjs', ['show', 'no-such-slug'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such decision/);
  });
});

// A ruling about one component is no longer refused here: it is recorded on the mission and written
// into that node's own log when the mission is done (graph-log.test.mjs).

// ---- a dead holder must not wedge decisions.md forever ------------------------------------------
//
// withDecisionsLock now shares _lib.mjs's createLockFile/processAlive/sleepSync with land.mjs's
// gate lock, retro.mjs's own lock and _lib.mjs's own tree and queue locks: the lock file names
// the pid that took it, and a pid no longer running is taken over rather than waited out to a
// hard refusal (issue 119) — the same fix land.test.mjs already proves for the gate lock and
// queue.test.mjs for the queue lock.

test('decide.mjs: an answers lock left by a dead process is taken over, not waited out', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const lock = decisionsLockFile(dir);
  mkdirSync(dirname(lock), { recursive: true });
  // A pid nothing on this machine is using. The lock must not be waited on for its full timeout.
  writeFileSync(lock, JSON.stringify({
    pid: 0x7ffffffe, horde: 'mission1', at: '2020-01-01T00:00:00.000Z',
  }, null, 2));

  const started = Date.now();
  const r = takeDecisionsLock(dir);
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(elapsed < 5000, `it did not wait out the lock timeout (${elapsed}ms)`);
  assert.equal(existsSync(lock), false, 'and released its own lock on the way out');
});

test('decide.mjs: a half-written lock file names no process to wait on, so it is taken over too', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const lock = decisionsLockFile(dir);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, '{"pid": 12');

  const r = takeDecisionsLock(dir);
  assert.equal(r.code, 0, r.stderr);
});

// A holder that is genuinely alive is a different case from one that is gone, and both matter: the
// fix above must not turn into a lock that never protects anything. This starts a real process,
// waits for the fact that it holds the lock (never a fixed sleep — see waitGateLockHeldBy's own
// comment in land.test.mjs for why), and asserts the second writer waited out most of the hold
// before it got its own turn.
test('decide.mjs: a second holder waits out a held answers lock rather than holding it alongside', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const HOLD_MS = 500;
  const markerPath = join(dir, '.lock-held-marker');
  const decidePath = join(SCRIPTS_DIR, 'decide.mjs');
  const holderScript = [
    `import { withDecisionsLock } from ${JSON.stringify(pathToFileURL(decidePath).href)};`,
    `import { writeFileSync } from 'node:fs';`,
    `withDecisionsLock('mission1', () => {`,
    `  writeFileSync(${JSON.stringify(markerPath)}, 'held');`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});`,
    `});`,
  ].join('\n');

  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let holderErr = '';
  holder.stderr.on('data', (d) => { holderErr += d; });
  const holderDone = new Promise((resolve) => holder.on('close', (code) => resolve(code)));

  const deadline = Date.now() + 5000;
  while (!existsSync(markerPath)) {
    if (Date.now() > deadline) throw new Error(`lock-holder never took the lock (stderr: ${holderErr})`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }

  const start = Date.now();
  const r = takeDecisionsLock(dir);
  const elapsedMs = Date.now() - start;
  const holderCode = await holderDone;

  assert.equal(holderCode, 0, `lock-holder process failed: ${holderErr}`);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(elapsedMs >= HOLD_MS * 0.7, `writer returned after ${elapsedMs}ms — expected it to wait out most of the ${HOLD_MS}ms held lock`);
});

// The case above shows a live holder is waited on, but never past the point of proving it: the
// hold is short and the CLI's own deadline (10s) never comes into play. This proves the other
// half — a holder that is still alive when the wait runs out is refused, never silently taken
// over — deterministically and fast, by calling withDecisionsLock directly with its own short
// {waitMs} rather than waiting out the CLI's real 10s deadline.
test('decide.mjs: a genuinely live holder past the wait deadline is refused, not taken over', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const HOLD_MS = 2000;
  const markerPath = join(dir, '.lock-held-marker');
  const decidePath = join(SCRIPTS_DIR, 'decide.mjs');
  const holderScript = [
    `import { withDecisionsLock } from ${JSON.stringify(pathToFileURL(decidePath).href)};`,
    `import { writeFileSync } from 'node:fs';`,
    `withDecisionsLock('mission1', () => {`,
    `  writeFileSync(${JSON.stringify(markerPath)}, 'held');`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});`,
    `});`,
  ].join('\n');

  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const holderDone = new Promise((resolve) => holder.on('close', (code) => resolve(code)));

  const deadline = Date.now() + 5000;
  while (!existsSync(markerPath)) {
    if (Date.now() > deadline) throw new Error('lock-holder never took the lock');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }

  const waiterScript = [
    `import { withDecisionsLock } from ${JSON.stringify(pathToFileURL(decidePath).href)};`,
    'const started = Date.now();',
    'try {',
    "  withDecisionsLock('mission1', () => {}, { waitMs: 300 });",
    '  console.log(JSON.stringify({ ok: true, elapsed: Date.now() - started }));',
    '} catch (e) {',
    '  console.log(JSON.stringify({ ok: false, elapsed: Date.now() - started, message: e.message }));',
    '}',
  ].join('\n');
  const waiterOut = execFileSync(process.execPath, ['--input-type=module', '-e', waiterScript], {
    cwd: dir, encoding: 'utf8',
  });
  const waiter = JSON.parse(waiterOut.trim().split('\n').pop());
  const holderCode = await holderDone;

  assert.equal(holderCode, 0, 'lock-holder process failed');
  assert.equal(waiter.ok, false, 'a live holder past the deadline must still refuse, not silently take over');
  assert.match(waiter.message, /locked by another process/);
  assert.ok(
    waiter.elapsed < HOLD_MS,
    `waited ${waiter.elapsed}ms — should have refused at its own ~300ms deadline, well before the ${HOLD_MS}ms hold ends`,
  );
});

// ---- the shared race harness: a lock caught half-made is waited for, never taken as abandoned ---
//
// The tests above use a lock file that already, fully, names a pid (dead or live) — none of them
// touch the one window createLockFile exists to close: a lock file caught between its content
// being written and its name existing at all. This proves that window directly, the same way
// land.mjs's gate lock, retro.mjs's own lock and _lib.mjs's queue lock already are (issues 098,
// 103, 112) — two real processes take the shipped decisions lock, one paused mid-creation and the
// other held at the door until that pause begins, putting the second process inside the window
// every run instead of once in thousands.
test('decide.mjs: a decisions lock caught half-made is waited for, never taken for an abandoned one', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const race = await raceOneLock(dir, 'decide');
  assert.ok(race.paused, `nothing was ever paused, so this run proves nothing:\n${describeRace(race)}`);
  assert.equal(race.slow.code, 0, describeRace(race));
  assert.equal(race.other.code, 0, describeRace(race));

  const paused = race.slow.window;
  const other = race.other.window;
  assert.ok(paused && paused.ok && other && other.ok, describeRace(race));
  assert.notEqual(paused.pid, other.pid, 'two processes, not one');
  assert.equal(overlaps(paused, other), false,
    'both processes held the decisions lock at the same time: the one paused mid-creation had its '
    + `lock file read as an abandoned one and taken.\n${describeRace(race)}`);
});
