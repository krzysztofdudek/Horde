# 105 · architect.md's veto example still shows the why argument as required, not optional

**Status:** done
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/reference/roles/architect.md
**Found by:** issue 061 worker
**Where:** skills/horde/reference/roles/architect.md:36

## What
The architect brief's graph-change example still writes veto's reason unbracketed —
`node.mjs veto <id> "<why>" --by {{name}}` — right next to an approve example that omits the
reason placeholder entirely (`node.mjs approve <id> --by {{name}}`), so neither example shows the
`["why"]` optional-bracket notation that node.mjs's own USAGE and scripts/README.md now use
consistently for both verbs (fixed under issue 061).

## Why
Same underlying fact as issue 061: `cmdProposalRule`'s `p.ruling = why || null;` makes the reason
optional for both approve and veto. An architect reading this brief's own worked example would
still come away thinking veto needs a quoted reason where approve does not — the asymmetry issue
061 fixed in node.mjs USAGE and README persists here, one file over.

## Acceptance
Line 36 reads `node.mjs approve <id> ["why"] --by {{name}}` / `node.mjs veto <id> ["why"] --by
{{name}}` — both showing the reason as optional, consistent with node.mjs's own USAGE text.

## Evidence

- **ran:** grep -n 'approve.*veto\|<why>' skills/horde/reference/roles/architect.md · **saw:** line 36 now reads node.mjs approve <id> ["<why>"] --by {{name}} / node.mjs veto <id> ["<why>"] --by {{name}} — both optional, matching node.mjs's own USAGE and README (fixed under issue 061)

