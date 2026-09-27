// Test-only: node:fs with one call paused on purpose. The rename of the directory named in
// HORDE_MOVE_RACE_DIR waits HORDE_MOVE_RACE_DELAY_MS first, and writes HORDE_MOVE_RACE_MARKER the
// instant the pause begins. The test looks at the ticket's lock during that pause: a move that
// renames under the lock holds it there; one that renames after letting go does not.
import * as real from 'node:fs';

export * from 'node:fs';
export { default } from 'node:fs';

const DIR = process.env.HORDE_MOVE_RACE_DIR || '';
const DELAY_MS = Number(process.env.HORDE_MOVE_RACE_DELAY_MS || 0);
const MARKER = process.env.HORDE_MOVE_RACE_MARKER || '';

export function renameSync(from, to) {
  if (DIR && String(from) === DIR) {
    if (MARKER) real.writeFileSync(MARKER, `${process.pid}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAY_MS);
  }
  return real.renameSync(from, to);
}
