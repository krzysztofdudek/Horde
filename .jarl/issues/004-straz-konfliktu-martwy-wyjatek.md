# 004 · straz konfliktu martwy wyjatek

**Status:** in-progress
**Kind:** bug
**Priority:** 1
**Tier:** standard
**Tags:** kontrakt
**Files:** skills/horde/scripts/land.mjs, skills/horde/scripts/ask.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/land.mjs:1116 `findAnswer(horde, 'conflict', id)`; skills/horde/scripts/ask.mjs:28 KINDS

## What
Straż konfliktu interesów przepuszcza lądowanie, gdy w decisions.md jest odpowiedź rodzaju `conflict`, ale ask.mjs zna tylko stop, stuck, lower, charter. Wyjątku nie da się uruchomić sankcjonowaną drogą.

## Why
Martwe wyjście w straży to albo dziura (gdy ktoś ręcznie dopisze decyzję), albo kod bez znaczenia. Komunikat odmowy i tak każe rozdzielić bilet, więc wyjątek jest zbędny.

## Acceptance
Wyjątek usunięty. Straż konfliktu odmawia zawsze, gdy ta sama gałąź zmienia regułę i kod, do którego reguła sięga. Test: ręcznie dopisana decyzja rodzaju conflict niczego nie przepuszcza.

Dowód, którego oczekuję: skills/horde/scripts/tests/law-guard.test.mjs (nowy przypadek).

## Evidence

