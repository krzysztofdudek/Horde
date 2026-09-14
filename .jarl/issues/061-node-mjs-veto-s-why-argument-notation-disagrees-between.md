# 061 · node mjs veto s why argument notation disagrees between

**Status:** open
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/node.mjs
**Found by:** workflow finder usage-vs-readme, confirmed by two refuters
**Where:** skills/horde/scripts/node.mjs:70 (plain veto) and :55 (contract veto)

## What
node.mjs veto's "why" argument notation disagrees between USAGE and README

USAGE writes `approve <id> ["why"] --by <name>` (bracketed/optional) on line 69 but `veto <id> "why" --by <name>` (unbracketed/required-looking) on line 70 — the same asymmetry repeats for `contract approve <id> ["why"]...` vs `contract veto <id> "why"...` (lines 54-55).

## Why
The two documents disagree on whether veto's reason string is required; code (cmdProposalRule, node.mjs:1999-2008: `p.ruling = why || null;`) shows it is in fact optional for both, so USAGE's unbracketed veto syntax is the one that misleads — but per this comparison it is a real USAGE-vs-README textual disagreement, not just a docs nuance.

## Acceptance
README documents both uniformly as optional: `approve|veto <id> ["why"] --by architect` (scripts/README.md:451 for contract, :463 for the plain form) — treating veto's reason as bracketed/optional exactly like approve's.

Dowód, którego oczekuję: Run `node.mjs veto g-001 --by architect` with no reason string — succeeds per the code, contradicting USAGE's `veto <id> "why"` (unbracketed) notation that README does not carry over.

Refuterzy: Verified directly in both files. node.mjs USAGE text (lines 54-55 and 69-70) writes veto's reason unbracketed: `contract veto <id> "why" --by <name>` and `veto <id> "why" --by <name>`, while approve's | Verified directly: /home/user/Horde/skills/horde/scripts/node.mjs line 70 reads `veto <id> \"why\" --by <name> [--horde h]` (unbracketed reason), while line 69 reads `approve <id> [\"why\"] --by <name

## Evidence

