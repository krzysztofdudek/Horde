# 068 · status mjs branchcategory tests queue item state for values

**Status:** open
**Kind:** bug
**Priority:** 2
**Model:** sonnet
**Tags:** zaplecze
**Files:** skills/horde/scripts/status.mjs
**Found by:** workflow finder cross-script-contracts, confirmed by two refuters
**Where:** skills/horde/scripts/status.mjs:38

## What
status.mjs branchCategory tests queue item 'state' for values queue.json can never hold

`branchCategory(state)` is called (in `teamDigest`, status.mjs:53-58) with `it.state` taken straight from a `teams/<team>/queue.json` item, and returns `'unverified'` when `state === 'verified' || state === 'changes'`.

## Why
Because `it.state` (queue.json) can never equal `'verified'` or `'changes'`, the `'unverified'` branch in `branchCategory` is dead code — status.mjs's session-start digest can never actually report a ticket branch as 'unverified' through this path. A ticket that just came back red from the gate (ticket Status → 'changes' via `transitionStatus`) still shows queue state `'landed'` until `queue.mjs set ... merged`/reconcile changes it, so status.mjs reports it under the generic 'unmerged' bucket instead of the intended 'unverified' bucket — the two fields (queue state vs. ticket status) were conflated when this function was written.

## Acceptance
`queue.mjs` — the sole writer of `queue.json` — defines the item state vocabulary as `const STATES = ['proposed', 'queued', 'waiting', 'running', 'landed', 'blocked', 'merged', 'escalated', 'dropped']` (queue.mjs:37) and its `set` command refuses any other value outright: `if (!STATES.includes(state)) fail('unknown state: ...')` (queue.mjs:587). 'verified' and 'changes' are never queue states — they are values of a *different* field, the ticket's own `Status:` line in `issue.md` (tk.mjs:49 `const STATUSES = ['proposed', 'queued', 'running', 'landed', 'changes', 'blocked', 'verified', 'merged', 'escalated', 'dropped']`, written by land.mjs/tick.mjs's `transitionStatus`).

Dowód, którego oczekuję: Run a mission where a ticket lands (`queue set NNN landed`) and the gate then sends it to `changes` (ticket Status becomes 'changes', per land.mjs's checkGate/transitionStatus) without the queue item's state changing. Then run `status.mjs --json` and see the ticket's branch categorized as 'unmerged', never 'unverified' — confirming the 'verified'/'changes' check in `branchCategory` never fires because `it.state` (from queue.json) is drawn from a disjoint vocabulary.

Refuterzy: Verified both sides exactly as claimed. status.mjs:38 checks state === 'verified' || state === 'changes', but it.state (status.mjs:53-58, from teamDigest) is read from queue.json items, whose state vo | Confirmed exactly as stated. queue.mjs:37 defines STATES=['proposed','queued','waiting','running','landed','blocked','merged','escalated','dropped'] as the only values queue.mjs:587's `set` command ac

## Evidence

