# 070 · retro podwojny bieg blokada niestabilna pod obciazeniem

**Status:** in-progress
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tests/retro.test.mjs
**Found by:** worker 036
**Where:** skills/horde/scripts/tests/retro.test.mjs "two retrospectives at once"

## What
Test blokady podwójnego uruchomienia retro opiera się na czasie (uruchamia dwa procesy i zakłada kolejność), i jest niestabilny pod dużym obciążeniem maszyny.

## Why
Losowe czerwone wyniki bez zmiany w kodzie kosztują czas na ponowne uruchamianie i podważają zaufanie do suity.

## Acceptance
Test nie zależy od czasu wykonania (np. synchronizacja przez plik blokady zamiast wyścigu procesów). `npm test` w `skills/horde/scripts/` zielone powtarzalnie pod obciążeniem.

## Evidence

