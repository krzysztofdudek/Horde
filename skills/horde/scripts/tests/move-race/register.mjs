// Test-only: loaded with `node --import` into one `tk.mjs move` process, so its node:fs is the
// shim beside this file. Nothing else is changed; the process runs the shipped script.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
