# 103 · createLockFile is duplicated identically in land.mjs and retro.mjs

**Status:** done
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/land.mjs, skills/horde/scripts/retro.mjs, skills/horde/scripts/_lib.mjs
**Found by:** worker 098, while fixing issue 098
**Where:** skills/horde/scripts/land.mjs and skills/horde/scripts/retro.mjs, both `createLockFile(path, content)`

## What
Issue 098's fix (the atomic write-then-link lock creation) was applied as an identical, byte-for-byte
duplicated helper function in both `land.mjs` and `retro.mjs`, matching the existing convention in
exactly these two files (`processAlive`/`sleepSync` were already duplicated the same way before
098). Issue 008 centralized every other "same logic read/written in more than one tool" pattern into
`_lib.mjs` — this is the same shape of duplication, just not yet caught by that sweep since it was
written after 008 landed.

## Why
A future fix to the lock-creation logic (e.g. tightening the fallback path, or a bug found later)
has two places to apply, and the two are only in sync by discipline, not by construction — exactly
the class of drift 008 exists to prevent.

## Acceptance
Extract `createLockFile` (and, if it makes sense while in there, `processAlive`/`sleepSync` too) to
`_lib.mjs`, imported by both `land.mjs` and `retro.mjs`. No behavior change — existing tests for
both files (including 098's own lock-race regression tests) must still pass unchanged.

## Evidence

- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/lib.test.mjs skills/horde/scripts/tests/land.test.mjs skills/horde/scripts/tests/retro.test.mjs skills/horde/scripts/tests/queue.test.mjs skills/horde/scripts/tests/decide.test.mjs · **saw:** 262/262 pass, 0 fail, on the merged tip

