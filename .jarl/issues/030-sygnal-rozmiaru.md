# 030 · sygnal rozmiaru

**Status:** done
**Kind:** gap
**Priority:** 2
**Tier:** strong
**Tags:** zaplecze
**Files:** skills/horde/scripts/queue.mjs, skills/horde/scripts/land.mjs, skills/horde/scripts/wave.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/queue.mjs buildPlan; skills/horde/scripts/land.mjs (wiersz w wyniku); skills/horde/scripts/wave.mjs close

## What
Plan i lądowanie pokazują rangę biletu wśród biletów misji według rozmiaru zmiany (linie i pliki), bez progu. Bilet w górnej ćwiartce misji dostaje w planie propozycję podziału; architekt decyduje.

## Why
Rozmiar to jedyny sygnał, który przetrwał pomiar (laboratorium w Grain). Ranga w misji nie jest stałą.

## Acceptance
Test plan-out: ranga liczona i drukowana; brak jakiejkolwiek stałej progowej w kodzie.

Dowód, którego oczekuję: skills/horde/scripts/tests/plan-out.test.mjs.

## Evidence

- **ran:** node --test tests/plan-out.test.mjs tests/queue.test.mjs tests/wave.test.mjs tests/docs.test.mjs tests/land.test.mjs (rebased tip, then merged main) · **saw:** 130/130 and 71/71 pass, both runs

