# 057 · node mjs propose s node boundary flags required for

**Status:** done
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/node.mjs
**Found by:** workflow finder usage-vs-readme, confirmed by two refuters
**Where:** skills/horde/scripts/README.md:462

## What
node.mjs propose's --node/--boundary flags (required for move-boundary) undocumented in README

USAGE: `propose <kind> "<text>" --by <name> [--node n] [--boundary <glob>[,glob…]] [--horde h]` — "move-boundary requires --node and --boundary so apply can name the exact edit later, not just record that it happened."

## Why
An agent filing a move-boundary proposal by following README alone would omit the required `--node`/`--boundary` flags and hit a refusal README never warned about.

## Acceptance
README's node.mjs section (line 462) documents `propose` as `propose <kind> "…" --by <name>` (kinds: new-node, move-boundary, rename, rule) with no mention of `--node`/`--boundary` at all, or that they are required for the `move-boundary` kind.

Dowód, którego oczekuję: Run `node.mjs propose move-boundary "…" --by architect` with no --node/--boundary per README's syntax — it refuses; USAGE documents why, README doesn't.

Refuterzy: Verified against both sides. skills/horde/scripts/node.mjs USAGE (line 65-66) requires --node/--boundary for move-boundary. skills/horde/scripts/README.md line 462 documents `propose <kind> \"…\" --by | Confirmed, but at a different location than cited. The repo-root README.md (233 lines total) has no node.mjs section and doesn't mention `propose` at all — line 462 there doesn't exist as described. H

## Evidence

Merged 5a14054 into claude/autonomous-self-evolving-system-oiveiz. Sub-batch A check (057+007+045+058): node --test tests/*.test.mjs from skills/horde/scripts, HORDE_TEST_RATATOSKR_DIR set — 923 tests, 920 pass, 0 fail, 3 skipped (root-bypass chmod, pre-existing/expected), 0 cancelled, exit 0.

