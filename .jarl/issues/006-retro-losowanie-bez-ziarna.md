# 006 · retro losowanie bez ziarna

**Status:** open
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** uczenie
**Files:** skills/horde/scripts/retro.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/retro.mjs measureJudge (pool/picked, Math.random)

## What
Pomiar dwóch sędziów losuje próbkę biletów przez Math.random, a komentarz obiecuje próbkę, którą da się odczytać i podważyć.

## Why
Pomiar, którego nie da się powtórzyć na tym samym stanie, nie jest pomiarem.

## Acceptance
Ziarno wyprowadzone deterministycznie ze stanu misji (missionState). Dwa uruchomienia na tym samym stanie dają tę samą próbkę; retro.json zapisuje ziarno i próbkę.

Dowód, którego oczekuję: skills/horde/scripts/tests/retro.test.mjs (nowy przypadek: dwa przebiegi, ta sama próbka).

## Evidence

