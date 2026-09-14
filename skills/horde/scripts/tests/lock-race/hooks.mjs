// Test-only: the module hooks that hand ONE process the slowed-down node:fs.
//
// The point of doing it here rather than in a copy of the lock's own code is that the process
// under test runs the shipped function, unedited — a hand-made copy of a concurrency fix is the
// one thing that can go green while the code it stands for stays broken.
//
// Only the process that registers these hooks is affected; the other contender in the race loads
// the real node:fs and is the shipped code, whole.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SHIM = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'slow-fs.mjs')).href;

export function resolve(specifier, context, next) {
  // The shim's own `export * from 'node:fs'` has to reach the real one, or it would import itself.
  if ((specifier === 'node:fs' || specifier === 'fs') && context.parentURL !== SHIM) {
    return { url: SHIM, shortCircuit: true };
  }
  return next(specifier, context);
}
