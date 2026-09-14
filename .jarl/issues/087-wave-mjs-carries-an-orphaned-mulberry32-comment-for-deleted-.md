# 087 · wave.mjs carries an orphaned mulberry32 comment for deleted seededRandom/cmdAuditPlan

**Status:** done
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/wave.mjs
**Found by:** worker 060, while fixing wave.mjs's own README section (issue 060)
**Where:** skills/horde/scripts/wave.mjs:933-935 (directly above `function main()`)

## What
A comment referencing `mulberry32` ("... used to pick which tickets to audit") dangles directly above `function main()`, describing the `seededRandom`/`cmdAuditPlan` functions it used to sit above — both already deleted by the seat-cassation migration.

## Why
Same staleness class as issues 060/086: a leftover comment describing code that no longer exists, sitting right above the file's entry point where the next reader will see it first.

## Acceptance
The orphaned comment is removed (or, if any of its content still applies to something in `main()`, rewritten to describe what's actually there). `node --test tests/wave.test.mjs` stays green (no behavior change expected — comment-only).

Dowód, którego oczekuję: `grep -n "mulberry32\|seededRandom\|cmdAuditPlan" skills/horde/scripts/wave.mjs` returns nothing.

## Evidence

- **ran:** grep -n 'mulberry32\|seededRandom\|cmdAuditPlan' skills/horde/scripts/wave.mjs · **saw:** no hits after removal (previously one hit: the orphaned 3-line comment above function main())
- **ran:** node --test tests/wave.test.mjs · **saw:** 23/23 pass, 0 fail — comment-only removal, no behavior change

