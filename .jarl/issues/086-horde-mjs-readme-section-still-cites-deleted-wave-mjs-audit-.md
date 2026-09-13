# 086 · horde.mjs README section still cites deleted wave.mjs audit-plan

**Status:** open
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/README.md
**Found by:** worker 060, while fixing wave.mjs's own README section (issue 060)
**Where:** skills/horde/scripts/README.md:94-97 (## horde.mjs — hordes, the `done` bullet)

## What
README's `## horde.mjs — hordes` section, in its `done` bullet, still says `done` refuses when "no audit verdict (`wave.mjs audit`) was recorded" and cites `audit-plan`. Both commands were removed from `wave.mjs` by the seat-cassation migration (2c8ed09); `horde.mjs`'s own code has zero "audit" references left.

## Why
Same staleness class as issue 060 (already fixed), one section over: an adopter reading horde.mjs's `done` bullet is told about a gate/command that no longer exists.

## Acceptance
The `done` bullet no longer names `wave.mjs audit` or `audit-plan`; it describes whatever `horde.mjs`'s actual `done` refusal conditions are today. `skills/horde/scripts/tests/docs.test.mjs` covers it (extend the same live-USAGE-vs-README scan pattern issue 060 added, or a dedicated case).

Dowód, którego oczekuję: `node --test tests/docs.test.mjs` green; `grep -n "audit" skills/horde/scripts/horde.mjs` shows why the README's old wording no longer matches (or returns nothing).

## Evidence

