# 009 · fail w bibliotece

**Status:** in-progress
**Kind:** bug
**Priority:** 1
**Tier:** strong
**Tags:** zaplecze
**Files:** skills/horde/scripts/_lib.mjs, skills/horde/scripts/node.mjs, skills/horde/scripts/tick.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/_lib.mjs fail(); skills/horde/scripts/tick.mjs runOnce pod --watch

## What
`fail()` kończy proces z wnętrza funkcji bibliotecznych (readLeases, teamPath, ygJson i inne). `tick --watch` umiera na pierwszej odmowie, także cudzej.

## Why
Pętla, która ma pracować bez nadzoru, nie może ginąć od odmowy, którą powinna zapisać i spróbować za interwał.

## Acceptance
Funkcje eksportowane rzucają błędy; `process.exit` tylko w main() każdego skryptu. `tick --watch` zapisuje odmowę w dzienniku i żyje do następnego interwału. Test: odmowa w jednym ticku nie kończy watchera.

Dowód, którego oczekuję: skills/horde/scripts/tests/tick.test.mjs (nowy przypadek).

## Evidence

