# 059 · queue mjs plan s out flag is undocumented in

**Status:** in-progress
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/queue.mjs
**Found by:** workflow finder usage-vs-readme, confirmed by two refuters
**Where:** skills/horde/scripts/queue.mjs:86 (USAGE line); README bullet at skills/horde/scripts/README.md:227

## What
queue.mjs plan's --out flag is undocumented in README

USAGE: `plan [--team t] [--apply-order] [--out <file>] [--horde h]` with the explanation "--out writes the plan (rendered, or JSON with --json) to a file instead of stdout, for a reader who must see it whole — the architect — rather than a summary relayed through a message".

## Why
The architect brief (refine.mjs --step review) relies on writing the plan whole to a file rather than a relayed summary — a reader of README alone would not know `--out` is how that's done, or that the flag exists.

## Acceptance
README's `plan` bullet (scripts/README.md:227) is `plan [--team t] [--apply-order]` — no `--out` flag, and no mention that plan output can be written to a file at all.

Dowód, którego oczekuję: Run `queue.mjs plan --out /tmp/plan.md` — succeeds and writes the file, a behavior README's plan bullet never mentions.

Refuterzy: Confirmed. queue.mjs USAGE at line 86 reads `plan [--team t] [--apply-order] [--out <file>] [--horde h]` with line 87 explaining --out writes the plan to a file for the architect reader. README.md's p | Verified against both files. queue.mjs lines 86-87 show the plan command's USAGE includes `--out <file>` with an explanation of its purpose (writing the whole plan to a file for the architect rather t

## Evidence

