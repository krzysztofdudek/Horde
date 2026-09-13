# 052 · legislate brief passes the territory name not the agent

**Status:** in-progress
**Kind:** docs
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/reference/roles/legislate.md
**Found by:** workflow finder roles-vs-scripts, confirmed by two refuters
**Where:** skills/horde/reference/roles/legislate.md:73 (confirmed as stated, no correction needed)

## What
legislate brief passes the territory name, not the agent's own name, as --by on node.mjs promote

Step 5 of the brief renders: `node ${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/node.mjs promote <rule> --by {{territory}} --horde {{horde}}` — filled with the territory name (e.g. "billing"), not the legislator's own agent name.

## Why
The rule's own log ends up crediting the raise to the territory (a component-grouping label the mission itself picked) rather than to the legislator agent that actually did the evidence review, breaking the attribution the field exists to record and making it inconsistent with how --by is used everywhere else in the same brief set.

## Acceptance
`node.mjs promote <aspect> [--by <name>] …` records `by` as the identity of who raised the rule (`const by = flags.by || 'architect';`, written into the rule's own log as the raiser); every other role's `--by` usage in this same brief set (architect.md's `--by {{name}}` on approve/veto/contract, worker's, etc.) passes the agent's own {{name}}, and brief.mjs's cmdLegislate vars object even supplies `name` alongside `territory` for exactly this purpose.

Dowód, którego oczekuję: Render `brief.mjs legislate <territory> --name alice` and note the printed promote command carries `--by <territory>`, not `--by alice`; run it and read the resulting rule log entry, which will show `<territory>` as the raiser instead of `alice`.

Refuterzy: Verified against both sides. skills/horde/reference/roles/legislate.md line 73 reads: `node ... node.mjs promote <rule> --by {{territory}} --horde {{horde}}` — using the territory variable, not {{name | Confirmed exactly as stated. /home/user/Horde/skills/horde/reference/roles/legislate.md:73 renders `node.mjs promote <rule> --by {{territory}} --horde {{horde}}`, passing the territory name rather tha

## Evidence

