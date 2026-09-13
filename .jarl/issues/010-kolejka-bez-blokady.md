# 010 · kolejka bez blokady

**Status:** in-progress
**Kind:** bug
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/queue.mjs, skills/horde/scripts/_lib.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/queue.mjs save(); skills/horde/scripts/_lib.mjs acquireGateLock

## What
queue.json jest przepisywany w całości przez każdą komendę; jedyną blokadą jest lock bramki w tick i land.

## Why
Dwie sesje na jednej hordzie gubią sobie pozycje kolejki bez śladu.

## Acceptance
Każdy zapis kolejki pod jedną blokadą (jak withDecisionsLock), odczyt-modyfikacja-zapis w jednym krytycznym odcinku. Test równoległych zapisów nie gubi żadnej pozycji.

Dowód, którego oczekuję: skills/horde/scripts/tests/queue.test.mjs (nowy przypadek z dwoma procesami).

## Evidence

