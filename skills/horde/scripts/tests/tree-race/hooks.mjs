// Test-only: the module hooks that hand a process the slowed-down node:fs.
//
// The point of doing it here rather than in a copy of the resolve's own code is that the process
// under test runs the shipped function, unedited — a hand-made copy of a concurrency fix is the
// one thing that can go green while the code it stands for stays broken.
//
// Only a process that registers these hooks is affected. Unlike the lock race next door, both
// contenders here register them: the question this race asks is whether the two ever sit inside
// the resolve at the same time, and that is only answerable when both of them are timed.

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
