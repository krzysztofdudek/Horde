# 049 · refine review buduje plan bez oslony na blad

**Status:** open
**Kind:** research
**Priority:** 3
**Model:** sonnet
**Tags:** zaplecze
**Files:** skills/horde/scripts/refine.mjs
**Found by:** reader B, reading refine.mjs and wave.mjs (plausible)
**Where:** skills/horde/scripts/refine.mjs:796 buildPlan bez try/catch; wave.mjs:129–140 planAtStart owija to samo wywołanie, bo plan, którego nie da się zbudować, nie może zatrzymać otwarcia fali

## What
W review tylko cykle są obsłużone; inny błąd buildPlan przechodzi surowo. Nie sprawdzono, czy buildPlan w ogóle rzuca poza fail().

## Why
Niespójna obsługa tego samego wywołania w dwóch miejscach.

## Acceptance
Przeczytać buildPlan w queue.mjs: jeśli rzuca, review dostaje tę samą osłonę i odmowę z powodem plus test; jeśli nie rzuca, zamknąć z notatką.

## Evidence

