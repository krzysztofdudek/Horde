# 027 · ksiega misji czytelna dla nastepnej

**Status:** open
**Kind:** gap
**Priority:** 2
**Tier:** strong
**Tags:** ksiega
**Files:** skills/horde/scripts/horde.mjs, skills/horde/scripts/refine.mjs, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/horde.mjs (_archive); skills/horde/scripts/refine.mjs consultBrief

## What
`horde.mjs history [--json]` listuje zarchiwizowane misje z charterem, pokryciem dowodów, propozycjami retro, odpowiedziami klienta i dyffem prawa. Brief konsultanta dostaje z archiwum wpisy dotyczące jego terytorium: propozycje reguł, rzeczy niewyrażalne, odpowiedzi klienta.

## Why
Archiwum czyta dziś tylko blame. To, co misja zostawiła, ma być przeczytane przez następną.

## Acceptance
Test na fixture z dwiema misjami w _archive; brief konsultanta zawiera wpisy z archiwum dla swojego terytorium i żadne z cudzego.

Dowód, którego oczekuję: skills/horde/scripts/tests/horde.test.mjs, skills/horde/scripts/tests/refine.test.mjs.

## Evidence

