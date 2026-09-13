# 018 · nieznana polityka jakosci domyslnie autonomous

**Status:** open
**Kind:** bug
**Priority:** 2
**Model:** sonnet
**Tags:** zaplecze
**Files:** skills/horde/scripts/_lib.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/_lib.mjs qualityPolicy

## What
qualityPolicy() dla nieznanej wartości w charterze zwraca po cichu „autonomous”. charter edit odmawia nieznanej wartości, ale czytelnik jej nie.

## Why
Nieznana wartość ma być odmową, nie najbardziej liberalną z dwóch polityk.

## Acceptance
Nieznana wartość → odmowa z nazwaniem dwóch dopuszczalnych. Test.

Dowód, którego oczekuję: skills/horde/scripts/tests/lib.test.mjs.

## Evidence

