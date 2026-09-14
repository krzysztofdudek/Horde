# 091 · pathInBoundary is a prefix check, not a path-boundary check

**Status:** in-progress
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/node.mjs
**Found by:** reviewer of 007
**Where:** skills/horde/scripts/node.mjs, `pathInBoundary`

## What
`pathInBoundary` decides whether a file path sits inside a node's declared boundary using a plain
string prefix check (`f.startsWith(boundary)`), not a path-segment boundary check. A boundary of
`src/a` matches `src/ab/file.js` even though `ab` is a sibling directory, not a child of `a`.

## Why
A node's boundary is meant to be an exclusive claim on a directory subtree; a sibling directory
whose name happens to share the prefix currently reads as inside it, which is a real (if narrow)
scope leak in every place this function gates a write or a read.

## Acceptance
`pathInBoundary` matches only on a full path-segment boundary (`f === boundary || f.startsWith(boundary + '/')`,
mirroring the same fix already applied to jarl.mjs's own `check` command's path matching this
session for the identical class of bug). A test with a `src/a` boundary and a `src/ab/file.js` path
proves the fix (false before, false after — currently true). No existing caller's legitimate boundary
match regresses.

Dowód, którego oczekuję: skills/horde/scripts/tests/node.test.mjs (or wherever pathInBoundary's
existing tests live).


## Evidence

