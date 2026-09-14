# 031 · warstwa none jest glosna

**Status:** done
**Kind:** gap
**Priority:** 2
**Tier:** strong
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

- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/land.test.mjs skills/horde/scripts/tests/wave.test.mjs skills/horde/scripts/tests/retro.test.mjs skills/horde/scripts/tests/lib.test.mjs skills/horde/scripts/tests/charter-template.test.mjs skills/horde/scripts/tests/docs.test.mjs skills/horde/scripts/tests/refine.test.mjs · **saw:** 326/326 pass on rebased branch tip, again on merged main after 041 also landed; independently re-read the _lib.mjs reader (noEvidenceLayerIn/noEvidenceLayerNote, anchored to the section start to avoid the charter template's own instructional text false-triggering) and its three integration points in land.mjs/wave.mjs/retro.mjs before merging

