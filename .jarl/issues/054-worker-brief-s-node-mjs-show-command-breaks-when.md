# 054 · worker brief s node mjs show command breaks when

**Status:** open
**Kind:** docs
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/reference/roles/worker.md
**Found by:** workflow finder roles-vs-scripts, confirmed by two refuters
**Where:** skills/horde/reference/roles/worker.md:37

## What
worker brief's node.mjs show command breaks when a ticket names two nodes

The brief renders `node ${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/node.mjs show {{node}}`. brief.mjs fills `node` with `nodes.join(', ') || null` (brief.mjs:396), and tk.mjs new explicitly allows a ticket to name up to two nodes (`--node is repeatable, up to two`, tk.mjs:68-73), so `{{node}}` can render as e.g. `billing, checkout`.

## Why
For any ticket that names two nodes (a case the ticket system explicitly supports), the rendered command becomes `node.mjs show billing, checkout`, which — once whitespace-split into shell args — passes `billing,` as the single node argument, a string `nodeExists` will reject, so the worker's very first `## Node` step fails on a case the rest of the system was built to allow.

## Acceptance
`node.mjs show <node>` (node.mjs cmdShow, node.mjs:1761-1763) reads only `positional[0]` as a single node id and calls `nodeExists`/`ygNode` on it; it has no support for more than one node in one call.

Dowód, którego oczekuję: Create a ticket with `tk.mjs new … --node billing --node checkout …`, then render its worker brief and run the exact `node.mjs show {{node}}` line printed — it fails with "no such node in the graph: billing," (or similar) rather than showing both nodes.

Refuterzy: Verified against both sides. worker.md:37 renders `node.mjs show {{node}}`. brief.mjs:396 sets the `node` template variable to `nodes.join(', ') || null` — a comma-joined string when a ticket has mult | Verified both sides: worker.md:37 (`node ${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/node.mjs show {{node}}`) is templated with brief.mjs:396's `node: nodes.join(', ') || null`, so a two-node 

## Evidence

