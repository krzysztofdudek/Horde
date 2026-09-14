# 096 · horde.mjs defaultConfig's keyContext constant has no provenance row

**Status:** open
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/horde.mjs, skills/horde/scripts/README.md
**Found by:** jarl
**Where:** skills/horde/scripts/horde.mjs, defaultConfig(), `keyContext: 3`

## What
`keyContext` defaults to `3` with no recorded provenance, missed by issue 013's own list (which the
new "Constants and where they come from" table in scripts/README.md now covers for every OTHER
unsourced constant). `retro.judgeSampleRate` was checked too and already carries adequate inline
provenance — this issue is `keyContext` only.

## Why
Same family rule 013 enforced: a threshold has provenance, not a signature.

## Acceptance
Either find and record `keyContext`'s real origin, or add it to the README's provenance table as
"Not recorded" like the other honestly-unsourced constants 013 already listed. The docs.test.mjs
scan 013 added should be extended to cover this constant too, so it can't go stale silently.


## Evidence

