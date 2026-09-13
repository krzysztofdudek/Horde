# 048 · retro drugi sedzia bierze pierwszy werdykt z listy

**Status:** open
**Kind:** research
**Priority:** 3
**Model:** sonnet
**Tags:** uczenie
**Files:** skills/horde/scripts/retro.mjs
**Found by:** reader B, reading retro.mjs (plausible)
**Where:** skills/horde/scripts/retro.mjs:371–374 measureJudge: verdicts.find(...) bierze pierwszy pasujący werdykt (judge, aspect, unit)

## What
Jeśli dokument yg-verdicts/1 niesie więcej niż jeden werdykt per (sędzia, reguła, jednostka), find() nie gwarantuje najnowszego; niezgodności liczone wobec przedawnionego werdyktu.

## Why
Pomiar dwóch sędziów na złym werdykcie.

## Acceptance
Sprawdzić w yg schemas, czy yg-verdicts/1 trzyma jeden żywy werdykt per trójkę czy historię; jeśli historię, wybierać najnowszy po znaczniku czasu i dodać test; jeśli jeden, zapisać to w komentarzu i zamknąć.

## Evidence

