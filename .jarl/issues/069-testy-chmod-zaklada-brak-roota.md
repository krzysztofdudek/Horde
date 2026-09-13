# 069 · testy chmod zaklada brak roota

**Status:** in-progress
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tests/ask.test.mjs, skills/horde/scripts/tests/horde.test.mjs
**Found by:** worker 036
**Where:** skills/horde/scripts/tests/ask.test.mjs:341, archiwizacja w skills/horde/scripts/tests/horde.test.mjs

## What
Oba testy sprawdzają, że zapis do pliku bez uprawnień zostaje odrzucony przez system plików. Root pomija uprawnienia plików, więc gdy suita działa jako root, odrzucenie nie następuje i test pada mimo poprawnego kodu.

## Why
Suita jest czerwona w środowisku, gdzie testy uruchamia root, mimo że produkt działa poprawnie — fałszywy alarm blokuje lądowanie.

## Acceptance
Oba testy wykrywają uruchomienie jako root (np. `process.getuid && process.getuid() === 0`) i albo pomijają się z nazwaną przyczyną, albo dowodzą odrzucenia inną metodą niezależną od uid. `npm test` w `skills/horde/scripts/` zielone zarówno jako root, jak i jako zwykły użytkownik.

## Evidence

