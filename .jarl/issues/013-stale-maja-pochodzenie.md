# 013 · stale maja pochodzenie

**Status:** open
**Kind:** docs
**Priority:** 2
**Model:** sonnet
**Tags:** zaplecze, pakiet
**Files:** skills/horde/scripts/node.mjs, skills/horde/scripts/horde.mjs, skills/horde/scripts/refine.mjs, skills/horde/scripts/escalate.mjs, skills/horde/scripts/tk.mjs, packages/promises/yg-package.yaml, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/node.mjs:641 WAVES_CLEAN_FOR_ENFORCED; skills/horde/scripts/horde.mjs domyślny config; skills/horde/scripts/escalate.mjs --min; packages/promises/yg-package.yaml max_bytes

## What
Stałe bez zapisanego pochodzenia: dwie czyste fale do enforced, 400000 bajtów terytorium, dwie fale do emerytury reguły, rundy 3+2, minimum 3 powtórzeń w escalate, parallelism 6, interwał 300 s, qualityDropAsk 0.1. max_bytes 32000 w promises ma pochodzenie i jest wzorem.

## Why
Zasada rodziny: próg ma pochodzenie, nie sygnaturę. Stała bez pochodzenia nie da się ani obronić, ani zmienić.

## Acceptance
Tabela „constants and where they come from” w README skryptów; każda stała w config ma tam wiersz z pochodzeniem (pomiar, ograniczenie transportu, decyzja klienta) albo dostaje pochodzenie w komentarzu obok siebie. Żadnej nowej stałej.

Dowód, którego oczekuję: README skryptów; test docs sprawdza, że każda stała z config ma wiersz w tabeli.

## Evidence

