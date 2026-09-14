# 095 · resolveHordeTrunk's doc comment still says land.mjs is a future script

**Status:** done
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/_lib.mjs
**Found by:** jarl
**Where:** skills/horde/scripts/_lib.mjs, doc comment above resolveHordeTrunk

## What
The comment above `resolveHordeTrunk` still describes `land.mjs` as "the future landing script" —
land.mjs has existed and been the sole trunk writer since well before this session.

## Why
Stale internal documentation; a reader trusting the comment gets a wrong mental model of what
already exists.

## Acceptance
Comment updated to describe land.mjs as the existing landing script, not a future one.

Dowód, którego oczekuję: none needed beyond the diff itself — pure comment wording, no behavior.


## Evidence

- **ran:** node --check _lib.mjs; node --test tests/lib.test.mjs · **saw:** syntax OK; 57/57 pass

