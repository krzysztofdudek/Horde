# 056 · readme lists a nonexistent queue mjs move command

**Status:** open
**Kind:** docs
**Priority:** 3
**Model:** sonnet
**Tags:** zaplecze
**Files:** skills/horde/scripts/README.md
**Found by:** workflow finder usage-vs-readme, confirmed by two refuters
**Where:** skills/horde/scripts/README.md:223

## What
README lists a nonexistent queue.mjs "move" command

The `## queue.mjs — the DAG` section lists `rm NNN`, `move NNN --team t`, `render`, `reconcile` as if all four were queue.mjs commands.

## Why
A reader following README's queue.mjs section would try `queue.mjs move NNN --team t` and get "unknown command", since that command lives in a different tool entirely.

## Acceptance
queue.mjs's own USAGE (lines 40-121) lists only `list, add, set, dep, next, plan, quality, rm, render, reconcile` — no `move` — and the `main()` switch (lines 1362-1371) has no `case 'move'`. `move NNN --team t` is actually a `tk.mjs` command (tk.mjs implements `case 'move': return cmdMove(...)` at tk.mjs:858, and README correctly documents it at scripts/README.md:181 under tk.mjs).

Dowód, którego oczekuję: Run `node skills/horde/scripts/queue.mjs move 001 --team trunk` — it fails as an unknown command; `grep -n "case 'move'" skills/horde/scripts/queue.mjs` returns nothing.

Refuterzy: Verified against both sides. skills/horde/scripts/README.md:223 lists `move NNN --team t` in the queue.mjs command section alongside rm/render/reconcile. But skills/horde/scripts/queue.mjs's own USAGE | Verified against actual source: queue.mjs's USAGE string and main() switch (lines 1362-1371) implement only list, add, set, dep, next, plan, rm, render, reconcile, quality — no 'move'. tk.mjs implemen

## Evidence

