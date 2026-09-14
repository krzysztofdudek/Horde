# 048 · retro drugi sedzia bierze pierwszy werdykt z listy

**Status:** done
**Kind:** research
**Priority:** 3
**Tier:** standard
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

Traced Yggdrasil's real lock model (source/cli/src/cli/verdict.ts's record command, source/cli/src/core/fill-writer.ts): lock.verdicts[aspectId][unitKey] is a single-slot object property, written unconditionally on every record — yg-verdicts/1 holds exactly one live verdict per (aspect, unit) pair, never a history. find() in measureJudge is therefore safe: there is nothing to pick the wrong entry from. While researching this I found a real, separate, more serious problem one level up (the single-slot model means a second judge's recorded verdict always overwrites the first's, so the disagreement comparison can never actually fire against the real yg CLI) — filed as issue 104 (P1, strong) rather than folded into this one, since it's a materially bigger claim than what 048 asked.
- **ran:** node --test tests/retro.test.mjs · **saw:** 42/42 pass — comment-only change, no behavior difference

