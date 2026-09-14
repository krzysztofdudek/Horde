# 022 · dowod wykonany na czubku

**Status:** open
**Kind:** gap
**Priority:** 1
**Tier:** strong
**Tags:** kontrakt
**Files:** skills/horde/scripts/land.mjs, skills/horde/scripts/horde.mjs, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/land.mjs (po punkcie gate); config.gates.report {path, format}

## What
Lądowanie czyta raport runnera z przebiegu bramki na sha czubka i wymaga, żeby sparowany przypadek każdej żywej obietnicy był w raporcie i przeszedł.

## Why
Obecność pliku testowego nie jest dowodem wykonania. Pominięty test przechodzi dziś każdą regułę i bramkę.

## Acceptance
Formaty: junit (xml), playwright-json, tap. Brak przypadku w raporcie albo status skipped/failed → odmowa z nazwą obietnicy. Brak skonfigurowanego raportu → punkt mówi „no report configured”, nie udaje zieleni. Test na fixture z raportem JUnit.

Dowód, którego oczekuję: skills/horde/scripts/tests/land.test.mjs.

Uwagi: Środowisko i runner są poza Hordą; Horda tylko czyta raport, który bramka zostawiła.

## Evidence

