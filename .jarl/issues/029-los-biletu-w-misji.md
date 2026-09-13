# 029 · los biletu w misji

**Status:** open
**Kind:** gap
**Priority:** 2
**Model:** opus
**Tags:** ksiega
**Files:** skills/horde/scripts/land.mjs, skills/horde/scripts/tk.mjs, skills/horde/scripts/wave.mjs, skills/horde/scripts/retro.mjs, templates/ticket.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/land.mjs recordMerged; skills/horde/scripts/wave.mjs close; skills/horde/scripts/retro.mjs collectRetroInput

## What
Los biletu po lądowaniu: `reverted` (merge cofnięty), `reopened` (ten sam wiersz dowodu znów czerwony; nowy bilet niesie `Reopens: t-NNN`). land zapisuje los w land/<t>.json i dzienniku; zamknięcie fali i retro liczą losy; retro dostaje powroty jako osobne źródło obok odmów bramki i uwag.

## Why
Dziś po lądowaniu nic nie jest dopisywane. Powrót to najprostszy sygnał, że dowód nie wystarczył.

## Acceptance
Testy: revert i reopen zapisane i policzone w zamknięciu fali; retro pokazuje powroty osobno.

Dowód, którego oczekuję: skills/horde/scripts/tests/land.test.mjs, skills/horde/scripts/tests/wave.test.mjs, skills/horde/scripts/tests/retro.test.mjs.

## Evidence

