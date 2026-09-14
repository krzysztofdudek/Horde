# 115 · The two-judge measurement can only ever sample a pair a judge refused, never one they passed

**Status:** in-progress
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/retro.mjs
**Found by:** issue 104 worker
**Where:** skills/horde/scripts/retro.mjs `measureJudge()`, the `yg verdict package` call that takes the first judgement's copy; Yggdrasil's `source/cli/src/cli/verdict.ts` `resolvePair()`, which refuses on a `verified` pair.

## What
Both halves of the two-judge measurement go through `yg verdict package`: retro.mjs runs it to take the first judgement's copy (and to read the two hashes that say whether the code moved afterwards), and the second judge has to run it to get the hash their own `verdict record` must be bound to. Yggdrasil's `resolvePair` — the one both `verdict package` and `verdict record` resolve a pair through — refuses outright whenever `verifyPairs` reports that pair as `verified`: "already holds a verdict for exactly these inputs." A recorded verdict that is IN FORCE reports `verified` when its word is a pass and `refused` when it is a refusal, and only `verified` is refused.

So a pair whose first judge PASSED it, and whose pass still holds, cannot be packaged and cannot be recorded over. retro.mjs skips it with the packaging refusal as its reason. Every pair the measurement can actually reach is one whose first judge refused it, or one whose verdict has already gone stale against changed code.

## Why
`judge.disagreements`, `judge.pairs` and the Wilson interval beside them are put in front of a client as "how far two judges agree on this repository". They are computed over pairs the first judge REFUSED, and over nothing else — a sub-population, not the sample the document says was drawn. Two judges arguing about a refusal is a different question from two judges agreeing about work that passed, and the second is both the commoner case and the one a mission's own bar rests on. Nothing on the document says which population the number came from, so it reads as the wider one.

This is not a regression from issue 104's fix; it is what that fix uncovered. Before it, no pair reached a comparison at all, so there was no number for the bias to be in.

## Acceptance
Either the document says plainly which pairs a comparison was possible on and which were out of reach — a skip that names the pass-in-force reason as its own kind, and a count of how many of the sample fell there, so the interval is read against the right denominator — or a way is found to put a passed pair to a second judge at all, which needs Yggdrasil's side, since `resolvePair` refuses it by design: "recording a second one over it would replace a judgement that still applies with no evidence that anything changed."

Dowód, którego oczekuję: a fixture where the first judge records a PASS that stays in force, driven through the same one-slot stand-in CLI `retro.test.mjs` now uses, showing the pair skipped and never compared; then either the document reporting that class of skip in its own right, or the Yggdrasil-side change that lets a second judge record on it.

## Evidence
