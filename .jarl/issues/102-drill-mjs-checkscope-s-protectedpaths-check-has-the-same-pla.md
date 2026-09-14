# 102 · drill.mjs checkScope's protectedPaths check has the same plain-prefix-match bug as the fixed pathInBoundary

**Status:** open
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/drill.mjs
**Found by:** worker 094, while fixing issue 094
**Where:** skills/horde/scripts/drill.mjs, `checkScope`, ~line 492: `protectedPaths.some((p) => f === p || f.startsWith(p))`

## What
Found while fixing issue 094 (drill.mjs's own unimported, buggy copy of `pathInBoundary`). A few
lines below the fixed call site, `checkScope`'s protected-path check uses the identical
plain-prefix-match pattern issue 091 already fixed for `node.mjs`'s `pathInBoundary`: a protected
path of `src/a` would wrongly match a touched file under the sibling `src/ab/...`, since
`f.startsWith(p)` matches on raw string prefix, not whole path segments.

## Why
Same scope-leak class as 091 and 094: a protected-paths guard that can be silently bypassed by a
similarly-named sibling directory is a real gap, not a cosmetic one — `protectedPaths` exists
specifically to flag when a ticket touches something it shouldn't.

## Acceptance
Apply the same fix pattern as 091/094 (full path-segment match, not raw prefix) — reuse
`pathInBoundary` from `node.mjs` if its semantics fit this check's needs, or a similarly-corrected
helper otherwise. A test mirroring 091's/094's shape (a protected path `src/a` must not match a
touched file under `src/ab/...`), red before, green after.

## Evidence

