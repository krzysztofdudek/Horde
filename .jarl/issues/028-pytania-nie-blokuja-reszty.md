# 028 · pytania nie blokuja reszty

**Status:** open
**Kind:** gap
**Priority:** 2
**Model:** opus
**Tags:** front
**Files:** skills/horde/scripts/tick.mjs, skills/horde/scripts/ask.mjs, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/tick.mjs dispatch i askClient

## What
Otwarte pytanie blokuje tylko to, co od niego zależy: stuck ten bilet; charter bilety wierszy, których dotyczy; lower lądowanie tej gałęzi; stop wszystko. tick przydziela resztę.

## Why
Misja ma iść dalej, gdy klient jest niedostępny. Najpierw sprawdzić, co tick dziś robi z każdym rodzajem.

## Acceptance
Test tick z otwartym pytaniem każdego rodzaju: przydział reszty zgodny z tabelą powyżej; README opisuje tabelę.

Dowód, którego oczekuję: skills/horde/scripts/tests/tick.test.mjs.

## Evidence

