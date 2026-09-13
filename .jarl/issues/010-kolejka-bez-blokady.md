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

Reviewer verified withQueueLock covers every queue.json read-modify-write site (queue.mjs, tick.mjs, audit.mjs), red on f60e3c3^1 (import of withQueueLock fails) / green on f60e3c3, 51/51 in queue.test.mjs. Merge commit f60e3c3 also carries stray .jarl/ bookkeeping (issue 071 + log lines) from an unrelated shared-checkout race — see decision stray-jarl-state-in-merges; not a defect in this diff, and .jarl/ never reaches main.

