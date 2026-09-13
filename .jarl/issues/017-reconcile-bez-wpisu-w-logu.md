# 017 · reconcile bez wpisu w logu

**Status:** open
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** ksiega
**Files:** skills/horde/scripts/queue.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/queue.mjs reconcile

## What
reconcile commituje „wip: reclaimed” w brudnym worktree i cofa bilet do kolejki, zostawiając notatkę tylko w queue.json, bez linii w log.md biletu.

## Why
Log biletu ma być pełną historią biletu. Odzyskanie po padzie workera to zdarzenie, które retro i blame muszą widzieć.

## Acceptance
log.md dostaje wpis stanu z powodem i sha commita odzyskania. Test.

Dowód, którego oczekuję: skills/horde/scripts/tests/queue.test.mjs.

## Evidence

