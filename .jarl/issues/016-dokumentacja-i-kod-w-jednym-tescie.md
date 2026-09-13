# 016 · dokumentacja i kod w jednym tescie

**Status:** in-progress
**Kind:** test
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tests/docs.test.mjs, SKILL.md, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/tests/docs.test.mjs

## What
Nie ma testu, który sprawdza, że każda składnia komendy wymieniona w SKILL.md, rolach, model.md i README skryptów istnieje w USAGE odpowiedniego skryptu.

## Why
Issue 001 i 002 to jedna klasa błędu. Test zamyka klasę, nie pojedynczy przypadek.

## Acceptance
Test wyciąga z dokumentów każde `<skrypt>.mjs <podkomenda> --flag` i sprawdza w USAGE skryptu; martwa składnia = czerwony test.

Dowód, którego oczekuję: skills/horde/scripts/tests/docs.test.mjs.

## Evidence

