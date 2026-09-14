// Test-only: node:fs with one call held open on purpose, so the window a worktree resolve has to
// survive is wide enough to walk through instead of narrow enough to need luck.
//
// Resolving a horde's trunk is a check-then-act: ask whether the tree is there, and depending on
// the answer either make it (`git worktree add`) or resync it (`git reset --hard`). The instant
// between the asking and the acting is the whole race — two processes that both get their answer
// before either has acted go on to act at the same time, and git refuses the second one. This
// module pauses the process at exactly that instant: after `existsSync` has its answer for the
// trunk path and before anything is done about it. It widens the window; it does not invent one.
//
// It pauses once per process. The resolve asks the same question more than once on its way
// through, and pausing every ask would measure the repetition instead of the window.
//
// Read from the environment:
//   HORDE_TREE_RACE_SUFFIX     the tail of the trunk worktree's path (.horde/worktrees/<h>/trunk)
//   HORDE_TREE_RACE_DELAY_MS   how long the pause lasts
//   HORDE_TREE_RACE_MARKER     a file written the instant the pause begins — the other process
//                              waits for it, so the race is run on purpose rather than on luck
//
// The pause's own window is left on `globalThis` for the contender to print. A run where nothing
// paused can then never be read as a run that survived something.

import * as real from 'node:fs';

export * from 'node:fs';
export { default } from 'node:fs';

const SUFFIX = process.env.HORDE_TREE_RACE_SUFFIX || '';
const DELAY_MS = Number(process.env.HORDE_TREE_RACE_DELAY_MS || 0);
const MARKER = process.env.HORDE_TREE_RACE_MARKER || '';

let paused = false;

function pauseOnce() {
  if (paused || DELAY_MS <= 0) return;
  paused = true;
  const start = Date.now();
  if (MARKER) real.writeFileSync(MARKER, `${start}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAY_MS);
  globalThis.__hordeTreeRacePause = { start, end: Date.now() };
}

export function existsSync(file) {
  const answer = real.existsSync(file);
  // Only the trunk path this race is about — every other existsSync on the way through (the
  // config file, a worktree.copy source) is left alone. Either answer pauses, because either
  // answer sends the caller straight on to act on it: no means make the tree, yes means resync it,
  // and both are refused by git when two processes do them at once.
  if (SUFFIX && typeof file === 'string' && file.endsWith(SUFFIX)) pauseOnce();
  return answer;
}
