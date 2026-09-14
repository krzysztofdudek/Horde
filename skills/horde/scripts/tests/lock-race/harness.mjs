// Test-only: the two-process race a lock file has to survive, run on purpose rather than on luck.
//
// Two real processes, one real lock path, and the shipped lock function on both sides. One of
// them is paused mid-creation — after it has begun making its lock and before the lock is fully
// in place — and the other is held at the door until that pause begins. So the second process
// arrives inside the window every single run, where a scheduler would take thousands of tries to
// put it there once.
//
// What comes back is each process's [acquired, released] window. A lock that holds keeps them
// apart. A lock that does not lets both processes believe they have it, and the windows overlap.

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENDER = join(dirname(fileURLToPath(import.meta.url)), 'contender.mjs');

const LOCK_NAMES = { gate: 'gate.lock', retro: 'retro.lock' };

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// The unmodified contender must not pick any of this up from whoever started the test run.
function plainEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('HORDE_LOCK_RACE_')) delete env[k];
  return env;
}

function startContender(dir, kind, args, env) {
  return new Promise((done) => {
    const child = spawn('node', [CONTENDER, kind, ...args], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => done({
      code, out, err, window: safeJSON(out.trim().split('\n').pop() || ''),
    }));
  });
}

// raceOneLock(dir, 'gate' | 'retro') — the race, once. `paused` says the widening actually
// happened: without it a green result would mean nothing was ever injected.
export async function raceOneLock(dir, kind, {
  delayMs = 1200, pausedHold = 150, otherHold = 2500,
} = {}) {
  const marker = join(dir, '.lock-race-began');
  rmSync(marker, { force: true });

  const [slow, other] = await Promise.all([
    startContender(dir, kind, ['--hold', String(pausedHold)], {
      ...plainEnv(),
      HORDE_LOCK_RACE_NAME: LOCK_NAMES[kind],
      HORDE_LOCK_RACE_DELAY_MS: String(delayMs),
      HORDE_LOCK_RACE_MARKER: marker,
    }),
    startContender(dir, kind, ['--hold', String(otherHold), '--after', marker], plainEnv()),
  ]);

  return { slow, other, paused: existsSync(marker) };
}

// Two windows overlap when each begins before the other ends.
export function overlaps(a, b) {
  return a.acquired < b.released && b.acquired < a.released;
}

export function describeRace({ slow, other }) {
  const show = (label, r) => `${label}: exit ${r.code} ${r.out.trim() || '(nothing)'}${r.err ? `\n  stderr: ${r.err.trim()}` : ''}`;
  return `${show('paused contender', slow)}\n${show('unmodified contender', other)}`;
}
