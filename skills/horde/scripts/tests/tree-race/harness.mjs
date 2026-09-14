// Test-only: the two-process race a horde's trunk worktree has to survive, run on purpose rather
// than on luck.
//
// Two real processes, one real horde, and the shipped `resolveTree` on both sides. Each is paused
// mid-resolve — after it has asked whether the trunk tree is there and before it acts on the
// answer — and the second is held at the door until the first's pause begins. So the second
// process arrives inside the window every single run, where a scheduler would take many tries to
// put it there once.
//
// What comes back is each process's [start, end] pause window, taken inside the resolve. Two
// processes that take turns have windows that do not overlap. Two that do not take turns have
// windows that do — and on a real machine that is the one being refused by git, either
// `fatal: '<path>' already exists` on the tree neither knew the other was making, or
// `Unable to create '<gitdir>/index.lock'` on the tree both are resyncing.

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENDER = join(dirname(fileURLToPath(import.meta.url)), 'contender.mjs');

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// The unmodified environment must not carry any of this in from whoever started the test run.
function plainEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('HORDE_TREE_RACE_')) delete env[k];
  return env;
}

function startContender(dir, horde, args, env) {
  return new Promise((done) => {
    const child = spawn('node', [CONTENDER, horde, ...args], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => done({
      code, out, err, answer: safeJSON(out.trim().split('\n').pop() || ''),
    }));
  });
}

// raceTrunk(dir, horde) — the race, once. `marked` says the widening actually happened: without it
// a green result would mean nothing was ever injected.
export async function raceTrunk(dir, horde, { delayMs = 1200 } = {}) {
  const marker = join(dir, '.tree-race-began');
  rmSync(marker, { force: true });
  const suffix = join('.horde', 'worktrees', horde, 'trunk');
  const slowed = {
    ...plainEnv(),
    HORDE_TREE_RACE_SUFFIX: suffix,
    HORDE_TREE_RACE_DELAY_MS: String(delayMs),
  };

  const [first, second] = await Promise.all([
    startContender(dir, horde, [], { ...slowed, HORDE_TREE_RACE_MARKER: marker }),
    startContender(dir, horde, ['--after', marker], slowed),
  ]);

  return { first, second, marked: existsSync(marker) };
}

// Two windows overlap when each begins before the other ends.
export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function describeRace({ first, second }) {
  const show = (label, r) => `${label}: exit ${r.code} ${r.out.trim() || '(nothing)'}${r.err ? `\n  stderr: ${r.err.trim()}` : ''}`;
  return `${show('first contender', first)}\n${show('second contender', second)}`;
}
