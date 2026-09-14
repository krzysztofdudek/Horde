# 094 · drill.mjs has its own unimported copy of pathInBoundary with the same prefix bug

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/drill.mjs
**Found by:** jarl
**Where:** skills/horde/scripts/drill.mjs:124

## What
`drill.mjs` defines its own local, unimported copy of `pathInBoundary` with the identical plain
prefix-check bug already fixed in `node.mjs` by issue 091 (`path.startsWith(pat)` matches a sibling
directory sharing the prefix).

## Why
Same scope-leak class as 091, in a second, independent copy — fixing 091 alone leaves drill.mjs's
own boundary checks silently wrong.

## Acceptance
Apply the same fix issue 091 applied to node.mjs's `pathInBoundary` (full path-segment match, not
raw prefix). Prefer importing the now-fixed helper from node.mjs (or a shared location) over a third
independent copy, if that's a clean fit; otherwise fix this copy in place with the same test shape
091 used.

Dowód, którego oczekuję: a test mirroring 091's (a `src/a` boundary must not match `src/ab/...`),
red before, green after.


## Evidence

- **ran:** node --test tests/drill.test.mjs (rebased tip, then merged main) · **saw:** 20/20 pass both times

