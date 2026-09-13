# 011 · bramki z pierwszego ekosystemu

**Status:** open
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** kontrakt
**Files:** skills/horde/scripts/horde.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/horde.mjs (detekcja ekosystemów i domyślne gates)

## What
init ustawia gates.commit, gates.team i gates.trunk na komendę testową pierwszego wykrytego ekosystemu. Repozytorium z dwoma ekosystemami testuje tylko jeden.

## Why
Bramka, która nie uruchamia połowy testów, jest zieloną bramką na czerwonym kodzie.

## Acceptance
Wszystkie wykryte ekosystemy złożone w jedną komendę bramki, albo init pyta przy więcej niż jednym; charter mówi, co bramka uruchamia. Test init na fixture z dwoma ekosystemami.

Dowód, którego oczekuję: skills/horde/scripts/tests/horde.test.mjs (nowy przypadek).

## Evidence

