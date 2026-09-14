// Test-only: node:fs with one call held open on purpose, so the window a lock has to survive is
// wide enough to walk through instead of narrow enough to need luck.
//
// Creating a lock file in place is three syscalls, not one: the path is created empty
// (openat O_CREAT|O_EXCL), the content is written, the file is closed. Anything that reads the
// path between the first and the second finds an empty file — a lock naming no holder. This
// module pauses the process at exactly that instant. It widens the window; it does not invent
// one.
//
// It knows the two shapes a lock file can be created in and pauses at the same instant in each:
//
//   in place   the single create-then-fill call, split into the two syscalls it performs
//              internally, with the pause between them — the path exists, empty, its holder yet
//              to write it.
//   beside     a file written next to the lock under a name of its own and put in place
//              afterwards — the pause goes after that content is on disk and before the lock's
//              own name exists at all.
//
// Either way the pause sits at the same moment: the holder has begun creating its lock and the
// lock is not yet fully in place. That is what makes the two shapes comparable.
//
// It pauses once per process. A lock retries while it waits, and pausing every attempt would
// measure the retry loop instead of the window.
//
// Read from the environment:
//   HORDE_LOCK_RACE_NAME       the lock file's own name (`gate.lock`, `retro.lock`)
//   HORDE_LOCK_RACE_DELAY_MS   how long the pause lasts
//   HORDE_LOCK_RACE_MARKER     a file written the instant the pause begins — the other process
//                              waits for it, and a test asserts it exists, so a run that paused
//                              nothing can never be read as a run that survived something.

import * as real from 'node:fs';
import { basename } from 'node:path';

export * from 'node:fs';
export { default } from 'node:fs';

const NAME = process.env.HORDE_LOCK_RACE_NAME || '';
const DELAY_MS = Number(process.env.HORDE_LOCK_RACE_DELAY_MS || 0);
const MARKER = process.env.HORDE_LOCK_RACE_MARKER || '';

let paused = false;

function pauseOnce() {
  if (paused || DELAY_MS <= 0) return;
  paused = true;
  if (MARKER) real.writeFileSync(MARKER, `${Date.now()}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAY_MS);
}

export function writeFileSync(file, data, options) {
  const name = typeof file === 'string' ? basename(file) : '';
  if (!NAME || !name) return real.writeFileSync(file, data, options);

  if (name === NAME && options && options.flag === 'wx') {
    const fd = real.openSync(file, 'wx'); // EEXIST leaves here exactly as it left the one call
    try {
      pauseOnce();
      real.writeSync(fd, data);
    } finally {
      real.closeSync(fd);
    }
    return undefined;
  }

  if (name.startsWith(`${NAME}.`)) {
    real.writeFileSync(file, data, options);
    pauseOnce();
    return undefined;
  }

  return real.writeFileSync(file, data, options);
}
