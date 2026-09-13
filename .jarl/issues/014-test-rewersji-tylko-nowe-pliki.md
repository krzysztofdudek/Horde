# 014 · test rewersji tylko nowe pliki

**Status:** in-progress
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** kontrakt
**Files:** skills/horde/scripts/land.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/land.mjs (item revert test)

## What
Punkt rewersji w lądowaniu sprawdza tylko NOWE pliki testowe. Zmiana, która nie dodaje pliku testowego, przechodzi z adnotacją „no new test files”, także gdy zmienia istniejący test.

## Why
Dyscyplina TDD mówi, że zmiana bez nowego testu ma to powiedzieć wprost. Lądowanie tego nie wymaga, więc punkt przechodzi cicho.

## Acceptance
Do czasu straży niesłabnięcia (issue 020): brak nowego pliku testowego jest ✗, chyba że bilet deklaruje `no-new-tests` z powodem w issue.md; zmieniony istniejący test jest sprawdzany na czerwień tak jak nowy. Test land.

Dowód, którego oczekuję: skills/horde/scripts/tests/land.test.mjs.

## Evidence

Merged as 46bee4b then reverted as 03155bb: breaks 15 of tests/law-guard.test.mjs's fixtures (they build synthetic land.mjs tickets with no test files and no `**No new tests:**` declaration). Isolated rerun: `node --test tests/law-guard.test.mjs` — 17/32 red on 46bee4b, 32/32 green after the revert. Needs 014 to also update law-guard.test.mjs's fixtures before it can land again.

