# 031 · warstwa none jest glosna

**Status:** open
**Kind:** gap
**Priority:** 2
**Model:** opus
**Tags:** kontrakt
**Files:** skills/horde/scripts/land.mjs, skills/horde/scripts/wave.mjs, skills/horde/scripts/retro.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/land.mjs item evidence; skills/horde/scripts/wave.mjs evidenceCoverage

## What
Gdy charter mówi „no evidence layer”, każde lądowanie mówi w punkcie evidence, że wiersz trzyma się na słowo (scenariusz, film, zrzut sprawdzony ręcznie), zamknięcie fali liczy wiersze bez wykonalnego dowodu, retro je flaguje.

## Why
Brak dowodów ma być widoczny na każdym kroku, nie tylko w charterze. Najpierw sprawdzić dzisiejsze zachowanie.

## Acceptance
Test na fixture bez warstwy dowodów: wynik lądowania i zamknięcie fali niosą to zdanie.

Dowód, którego oczekuję: skills/horde/scripts/tests/land.test.mjs, skills/horde/scripts/tests/wave.test.mjs.

## Evidence

