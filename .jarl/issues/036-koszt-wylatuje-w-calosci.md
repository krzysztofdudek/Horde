# 036 · koszt wylatuje w calosci

**Status:** open
**Kind:** cleanup
**Priority:** 1
**Model:** sonnet
**Tags:** granice
**Files:** skills/horde/scripts/cost.mjs, skills/horde/scripts/tick.mjs, skills/horde/scripts/wave.mjs, skills/horde/scripts/retro.mjs, skills/horde/scripts/status.mjs, skills/horde/scripts/horde.mjs, templates/charter.md, reference/model.md, skills/horde/scripts/README.md, SKILL.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/cost.mjs; skills/horde/scripts/tick.mjs bookCost; skills/horde/scripts/wave.mjs close (cost); skills/horde/scripts/retro.mjs measureCost; skills/horde/scripts/status.mjs cost; skills/horde/scripts/horde.mjs done (cost.json non-empty) i domyślny config.classes

## What
Cały aspekt kosztowy wylatuje z Hordy: cost.mjs i cost.json, wiersz Limit w charterze, klasy wagowe w config (classes), księgowanie kosztu w tick, sekcje kosztu w zamknięciu fali, retro, status i done, liczenie wywołań recenzenta z yg-events, komenda limit-reached, i każde zdanie o koszcie w dokumentacji.

## Why
Decyzja klienta: koszt nie jest tematem Hordy. Pół usunięty koszt to dwie prawdy.

## Acceptance
Żadne słowo cost, limit-reached, Limit:, classes ani reviewerCalls w skryptach, testach, szablonach i dokumentacji poza sekcją historii w CHANGELOG. done nie wymaga cost.json. Testy cost.test.mjs i cost-reviewers.test.mjs usunięte, reszta zielona. Klasa workera (light/standard/heavy/max) zostaje tylko jeśli coś poza kosztem jej używa; jeśli tylko koszt, wylatuje razem z nim.

Dowód, którego oczekuję: grep -ri "cost\|limit-reached\|reviewerCalls" skills/ packages/ daje zero; npm test zielone.

## Evidence

