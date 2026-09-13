# 043 · readme i escalate nazywaja nieistniejacy legislate mjs

**Status:** open
**Kind:** docs
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/escalate.mjs, skills/horde/scripts/README.md
**Found by:** reader C, reading escalate.mjs and README
**Where:** skills/horde/scripts/escalate.mjs:4–6 (komentarz) i skills/horde/scripts/README.md:640–645: „the third is legislate.mjs after a wave close”

## What
Nie ma pliku legislate.mjs. Trzecim wyzwalaczem jest audit.mjs sweepReviewDates z wave close, a legislate to brief renderowany przez brief.mjs.

## Why
Czytelnik próbuje uruchomić skrypt, którego nie ma.

## Acceptance
Oba miejsca opisują prawdziwy mechanizm; test docs sprawdza, że każda nazwa *.mjs w dokumentach istnieje na dysku.

## Evidence

