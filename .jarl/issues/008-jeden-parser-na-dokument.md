# 008 · jeden parser na dokument

**Status:** done
**Kind:** bug
**Priority:** 2
**Tier:** strong
**Tags:** zaplecze
**Files:** skills/horde/scripts/_lib.mjs, skills/horde/scripts/retro.mjs, skills/horde/scripts/brief.mjs, skills/horde/scripts/drill.mjs, skills/horde/scripts/blame.mjs, skills/horde/scripts/land.mjs, skills/horde/scripts/cost.mjs, skills/horde/scripts/wave.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/retro.mjs:111; skills/horde/scripts/brief.mjs:312; skills/horde/scripts/drill.mjs:335–357; skills/horde/scripts/blame.mjs:278–312; skills/horde/scripts/land.mjs parseAsks; skills/horde/scripts/_lib.mjs qualityPolicy

## What
Te same dokumenty markdown są parsowane regexami w wielu miejscach: linie stanu log.md (retro STATUS_LINE, brief latestChangesRound), blok werdyktu (drill, blame), wpisy decisions.md (decide parseEntries, land parseAsks), charter (qualityPolicy, wiersze dowodów, Limit).

## Why
Zmiana sformułowania w jednym miejscu psuje cicho pomiar w drugim.

## Acceptance
Każdy dokument ma jeden eksportowany parser (w _lib albo module dokumentu) używany wszędzie; parsery mają własne testy; format dokumentów bez zmian.

Dowód, którego oczekuję: skills/horde/scripts/tests/lib.test.mjs (parsery); grep po regexach na te dokumenty poza parserem daje zero.

## Evidence

- **ran:** node --test tests/*.test.mjs (full suite, rebased tip, twice — before and after fixing the tick.mjs/wave.mjs gaps found) · **saw:** first run: 49 fail (one root cause: tick.mjs's stale wave.mjs import); after fix: 1057 pass/0 fail/4 skip. Same result on the merged main checkout.

