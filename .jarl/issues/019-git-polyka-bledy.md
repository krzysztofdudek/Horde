# 019 · git polyka bledy

**Status:** open
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/_lib.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/_lib.mjs git(); przegląd wywołań w status.mjs, cost.mjs, blame.mjs, land.mjs

## What
git() zwraca null przy każdym błędzie. Część miejsc wywołań traktuje null jak „brak” zamiast jak błąd i idzie dalej.

## Why
Błąd gita czytany jako „nic nie ma” daje fałszywe zero zamiast odmowy.

## Acceptance
Przegląd każdego wywołania: tam, gdzie null oznacza odmowę, odmowa niesie tekst błędu gita. Jeden test reprezentatywny.

Dowód, którego oczekuję: skills/horde/scripts/tests/lib.test.mjs.

## Evidence

