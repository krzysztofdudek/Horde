# 109 · land.mjs's own resolveTree calls omit horde too, same gap as 041's

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/land.mjs
**Found by:** issue 041 worker
**Where:** skills/horde/scripts/land.mjs:1829 (the `--fate` path) and :1843 (`main()`'s own gate-run path): both call `resolveTree({ tree: flags.tree }, { cwd: process.cwd() })`, never threading `horde` through even when `--horde` is given explicitly.

## What
Both of land.mjs's own top-level `resolveTree` calls omit `horde` unconditionally — not even the narrower, explicit-`--horde`-only form 041 gave tick.mjs. `land.mjs` is the script every doc in this tool set calls out as the one thing allowed to write trunk (`resolveHordeTrunk`'s own doc comment in `_lib.mjs`, `assertGraphWritable`'s message), so its own tree default is worth the same scrutiny 041 gave tick.mjs's — not a mechanical copy-paste of 041's fix, since land.mjs is usually spawned by tick with `cwd` already pointed where tick resolved it, and land.mjs's own `resolveCwd` fallback then just re-derives that same path — but land.mjs can also be run directly (a maintainer running `land.mjs <ticket>` by hand), where this gap is live exactly as tick's was.

## Why
A direct `land.mjs <ticket> --horde X` run (no `--tree`) ignores `--horde` for tree purposes today, same risk 041's own "Why" named for tick: the wrong checkout by accident, not by name.

## Acceptance
Read both call sites against current code (line numbers may have shifted), work out whether land.mjs should mirror tick.mjs's now-narrow convention (`flags.horde` only, never `resolveHorde(flags)`'s output) or has its own reason to differ, then fix and document accordingly — or record why cwd is actually correct there. Do not extend this to "no --horde at all" without the same care 041 took: ask a-002 is still open and unruled.

## Evidence

- **ran:** grep -n "resolveTree(" skills/horde/scripts/land.mjs (from a checkout at the state 041 landed on) · **saw:** two call sites, both `resolveTree({ tree: flags.tree }, { cwd: process.cwd() })`, at lines 1829 and 1843, `horde` absent from either
- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/land.test.mjs skills/horde/scripts/tests/docs.test.mjs · **saw:** 116/116 pass on rebased branch tip and again on merged main; independently re-read both resolveTree call sites' diffs before merging, confirmed flags.horde used consistently at both, matching 041's established convention

