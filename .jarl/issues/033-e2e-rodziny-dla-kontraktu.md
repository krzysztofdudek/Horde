# 033 · e2e rodziny dla kontraktu

**Status:** open
**Kind:** test
**Priority:** 2
**Model:** sonnet
**Tags:** kontrakt
**Files:** skills/horde/scripts/tests/family.e2e.test.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/tests/family.e2e.test.mjs

## What
Test e2e rodziny na repozytorium z pakietem promises i raportem runnera: init → refine → tick → land, z przypadkami dla issue 020, 021, 022: dodany skip odmawia, obietnica bez przypadku odmawia, obietnica cofnięta na planned odmawia bez pytania lower.

## Why
Kontrakt ma być udowodniony całym cyklem, nie testami jednostkowymi punktów.

## Acceptance
Test przechodzi w CI; każdy przypadek nazwany po obietnicy, którą sprawdza.

Dowód, którego oczekuję: skills/horde/scripts/tests/family.e2e.test.mjs.

## Evidence

