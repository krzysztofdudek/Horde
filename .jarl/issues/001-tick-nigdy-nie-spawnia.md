# 001 · tick nigdy nie spawnia

**Status:** open
**Kind:** cleanup
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tick.mjs, reference/model.md, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/tick.mjs:17–20 (nagłówek) wobec :405– (spawn pod external); reference/model.md sekcja Runner

## What
Nagłówek tick.mjs i sekcja Runner w model.md mówią, że tick nigdy nie spawnia. Ten sam plik pod runnerem `external` startuje workerów przez `config.runner.spawn`.

## Why
Dokumentacja i kod muszą mówić to samo. Czytelnik modelu podejmuje decyzje o runnerze na podstawie zdania, które nie jest prawdą.

## Acceptance
Jedno prawdziwe zdanie o tym, kto startuje workerów pod każdym runnerem, w trzech miejscach: nagłówek tick.mjs, model.md Runner, README skryptów. Test dokumentacji sprawdza, że oba runnery są opisane zgodnie z kodem.

Dowód, którego oczekuję: skills/horde/scripts/tests/docs.test.mjs (nowy przypadek) + grep po „never spawns”.

## Evidence

