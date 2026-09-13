# 005 · escalate liczy zamiast porownywac

**Status:** open
**Kind:** bug
**Priority:** 2
**Model:** sonnet
**Tags:** uczenie
**Files:** skills/horde/scripts/escalate.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/escalate.mjs:52–108 (byKey = kind + territory)

## What
`escalate recurring` grupuje odpowiedziane pytania po rodzaju i terytorium i pisze „answered the same way N times”, nie czytając treści odpowiedzi.

## Why
Propozycja reguły z trzech różnych odpowiedzi to reguła, której nikt nie udzielił. Narzędzie ma mówić to, co policzyło.

## Acceptance
Grupowanie po rodzaju, terytorium i znormalizowanej pierwszej linii odpowiedzi. Komunikat mówi, ile razy padła ta sama odpowiedź. Trzy różne odpowiedzi w jednym terytorium nie dają propozycji.

Dowód, którego oczekuję: skills/horde/scripts/tests/escalate.test.mjs (dwa nowe przypadki: te same odpowiedzi, różne odpowiedzi).

## Evidence

