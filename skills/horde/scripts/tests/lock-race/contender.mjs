// Test-only: one of the two processes that race a single lock file.
//
//   usage: contender.mjs <gate|retro|queue|decide> --hold <ms> [--after <file>] [--wait <ms>]
//
// It takes the real lock — the shipped function, imported from the shipped script, never a copy
// of it — holds it for `--hold`, releases it, and prints the one line the test reads:
//
//   {"ok":true,"pid":1234,"acquired":<ms>,"released":<ms>}
//
// Two of these hold the same lock at the same time exactly when the lock is broken, so the test
// asks one question of the two lines: do the windows overlap.
//
// `--after` holds this process at the door until that file appears, which is how the race is run
// on purpose instead of on luck: the slowed contender writes it at the instant it is paused
// mid-creation, so this one starts from a known moment rather than from whenever a process
// happened to boot.
//
// A delay in the environment (HORDE_LOCK_RACE_DELAY_MS) makes this the slowed contender: it
// registers the hooks below before loading the script under test. With no delay set, nothing is
// registered, nothing is wrapped, and the script loads the real node:fs.

import { register } from 'node:module';
import { existsSync } from 'node:fs';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function say(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(code);
}

const kind = process.argv[2];
const hold = Number(flag('hold', 200));
const waitMs = Number(flag('wait', 30000));
const after = flag('after');

if (Number(process.env.HORDE_LOCK_RACE_DELAY_MS || 0) > 0) {
  register('./hooks.mjs', import.meta.url);
}

// The gate and retro locks hand back a {release} handle: acquire now, release whenever told to.
// withQueueLock and withDecisionsLock each hold their lock only for the span of one synchronous
// callback, so the "queue" and "decide" cases below run the whole acquire/hold/release cycle
// inside that callback instead — `held: true` tells the code beneath this function the hold
// already happened, so it does not sleep or release a second time; the two shapes are otherwise
// read identically.
async function takeTheLock() {
  if (kind === 'gate') {
    const { acquireGateLock } = await import('../../land.mjs');
    return acquireGateLock('001', 'mission1/t-001', { waitMs });
  }
  if (kind === 'retro') {
    const { acquireRetroLock } = await import('../../retro.mjs');
    return acquireRetroLock('mission1', waitMs);
  }
  if (kind === 'queue') {
    const { withQueueLock } = await import('../../_lib.mjs');
    let acquired;
    withQueueLock('mission1', 'trunk', () => {
      acquired = Date.now();
      sleepSync(hold);
    }, { waitMs });
    return { ok: true, held: true, acquired, release: () => {} };
  }
  if (kind === 'decide') {
    const { withDecisionsLock } = await import('../../decide.mjs');
    let acquired;
    withDecisionsLock('mission1', () => {
      acquired = Date.now();
      sleepSync(hold);
    }, { waitMs });
    return { ok: true, held: true, acquired, release: () => {} };
  }
  throw new Error(`no such lock: ${kind}`);
}

if (after) {
  const deadline = Date.now() + 60000;
  while (!existsSync(after)) {
    if (Date.now() > deadline) say({ ok: false, error: `never reached: ${after}` }, 1);
    sleepSync(5);
  }
}

try {
  const lock = await takeTheLock();
  if (lock.ok === false) say({ ok: false, error: lock.note }, 1);
  const acquired = lock.held ? lock.acquired : Date.now();
  if (!lock.held) sleepSync(hold);
  lock.release();
  say({ ok: true, pid: process.pid, acquired, released: Date.now() }, 0);
} catch (e) {
  say({ ok: false, error: String(e && e.message ? e.message : e) }, 1);
}
