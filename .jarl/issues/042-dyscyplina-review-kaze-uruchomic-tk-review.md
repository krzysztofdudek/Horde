# 042 · dyscyplina review kaze uruchomic tk review

**Status:** in-progress
**Kind:** docs
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/reference/discipline/review.md
**Found by:** reader C, reading discipline/review.md and tk.mjs
**Where:** skills/horde/reference/discipline/review.md:20–22 wobec skills/horde/scripts/tk.mjs:851–859 (brak case review); skills/horde/scripts/tests/drill.test.mjs:242 mówi, że tk review nie istnieje

## What
review.md każe uruchomić `tk.mjs review NNN changes "…" --by <name>`; tk.mjs nie ma takiej komendy. Tekst trafia dosłownie do briefu legislate i retro pod „## Law”.

## Why
Agent wykonujący dyscyplinę dosłownie dostaje unknown command.

## Acceptance
review.md pokazuje działającą składnię (tk.mjs log z linią recenzji w formacie, który drill review czyta). Test docs (016) łapie tę klasę; do tego czasu jeden przypadek w docs.test.mjs uruchamia komendę z review.md na fixture.

## Evidence

