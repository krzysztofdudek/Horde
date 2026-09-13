# 060 · readme documents wave mjs audit audit plan commands that

**Status:** open
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/wave.mjs
**Found by:** workflow finder usage-vs-readme, confirmed by two refuters
**Where:** skills/horde/scripts/wave.mjs:38-84 (USAGE) and :959-965 (main switch)

## What
README documents wave.mjs audit / audit-plan commands that do not exist

wave.mjs's USAGE (lines 38-84) lists exactly six commands — start, note, merged, close, evidence, current — and the `main()` switch (lines 960-965) has cases for exactly those six and nothing else.

## Why
Neither `audit` nor `audit-plan` is a real wave.mjs command — running `wave.mjs audit 001 clean` or `wave.mjs audit-plan` fails as unknown, contradicting README's explicit documentation of their syntax and semantics.

## Acceptance
README's `## wave.mjs — the journal` section (scripts/README.md:670) opens with: "`start [n] [--team t]`, `note "…"`, `merged NNN <sha>`, `audit NNN clean|findings "…"`, `audit-plan [--seed <n>] [--team t]`, `close […]` …" — documenting `audit` and `audit-plan` as wave.mjs commands, and later (line 701-702) describing `audit-plan`'s behavior in detail ("draws them from those merges at random; --seed makes the draw reproducible").

Dowód, którego oczekuję: Run `node skills/horde/scripts/wave.mjs audit-plan` — unknown command; grep -n "case 'audit" skills/horde/scripts/wave.mjs returns nothing.

Refuterzy: wave.mjs USAGE (lines 38-84) documents exactly six commands: start, note, merged, close, evidence, current. main()'s switch (lines 959-965) has cases for exactly those six, with default failing as unk | Verified directly. wave.mjs USAGE block (lines 38-84) documents exactly six commands: start, note, merged, close, evidence, current. The main() switch (lines 960-965) has cases for exactly those six a

## Evidence

