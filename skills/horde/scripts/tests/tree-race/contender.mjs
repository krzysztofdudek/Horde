// Test-only: one of the two processes that race a single horde's trunk worktree.
//
//   usage: contender.mjs <horde> [--after <file>]
//
// It resolves the trunk the way every tool does — the shipped `resolveTree`, imported from the
// shipped `_lib.mjs`, never a copy of it — and prints the one line the test reads:
//
//   {"ok":true,"pid":1234,"path":"…","branch":"…","sha":"…","pause":{"start":…,"end":…}}
//
// `pause` is the window the slowed node:fs held this process open for, inside the resolve. Two of
// those windows overlap exactly when two processes were inside the resolve at once, so the test
// asks one question of the two lines: do the windows overlap.
//
// `--after` holds this process at the door until that file appears, which is how the race is run
// on purpose instead of on luck: the other contender writes it at the instant it is paused
// mid-resolve, so this one starts from a known moment rather than from whenever a process happened
// to boot.

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

const horde = process.argv[2];
const after = flag('after');

if (Number(process.env.HORDE_TREE_RACE_DELAY_MS || 0) > 0) {
  register('./hooks.mjs', import.meta.url);
}

if (after) {
  const deadline = Date.now() + 60000;
  while (!existsSync(after)) {
    if (Date.now() > deadline) say({ ok: false, error: `never reached: ${after}` }, 1);
    sleepSync(5);
  }
}

try {
  const { resolveTree } = await import('../../_lib.mjs');
  const info = resolveTree({ horde });
  say({
    ok: true,
    pid: process.pid,
    path: info.path,
    branch: info.branch,
    sha: info.sha,
    kind: info.kind,
    pause: globalThis.__hordeTreeRacePause || null,
  }, 0);
} catch (e) {
  say({
    ok: false,
    pid: process.pid,
    error: String(e && e.message ? e.message : e),
    pause: globalThis.__hordeTreeRacePause || null,
  }, 1);
}
