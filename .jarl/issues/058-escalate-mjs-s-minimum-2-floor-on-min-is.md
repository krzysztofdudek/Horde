# 058 · escalate mjs s minimum 2 floor on min is

**Status:** open
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/escalate.mjs
**Found by:** workflow finder usage-vs-readme, confirmed by two refuters
**Where:** skills/horde/scripts/escalate.mjs:20

## What
escalate.mjs's minimum-2 floor on --min is undocumented in USAGE

USAGE's body text says only "a group of <n> (default 3) or more is an answer…" with no mention of a floor. The code (line 54) enforces `if (!Number.isFinite(min) || min < 2) fail('--min must be a whole number of at least 2')`.

## Why
Someone reading only `escalate.mjs --help` (USAGE) would not know `--min 1` or `--min 0` is refused; they'd have to hit the refusal to discover the real floor that README already states.

## Acceptance
README (scripts/README.md:649) documents it precisely: "A group of `<n>` (default 3, minimum 2) or more…" — the "minimum 2" fact exists in code and in README but is absent from USAGE.

Dowód, którego oczekuję: Run `escalate.mjs recurring --min 1` — refused with "--min must be a whole number of at least 2", a constraint stated in README but not in USAGE.

Refuterzy: Confirmed. USAGE in escalate.mjs (template literal starting line 20, body text at line 22) says only \"a group of <n> (default 3) or more is an answer...\" with no floor mentioned. The code at line 54 | Confirmed but at the wrong line. USAGE (lines 20-29 of escalate.mjs) says only "a group of <n> (default 3) or more is an answer..." with no mention of a floor. The enforcement `if (!Number.isFinite(mi

## Evidence

