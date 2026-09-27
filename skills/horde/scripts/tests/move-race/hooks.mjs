// Test-only: hands the process that registered it the node:fs shim in pause-rename.mjs.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SHIM = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'pause-rename.mjs')).href;

export function resolve(specifier, context, next) {
  if ((specifier === 'node:fs' || specifier === 'fs') && context.parentURL !== SHIM) {
    return { url: SHIM, shortCircuit: true };
  }
  return next(specifier, context);
}
