# 097 · land.mjs diffPaths turns a git failure into an empty diff, which can pass gates that should refuse

**Status:** done
**Kind:** bug
**Priority:** 2
**Tier:** strong
**Tags:** 
**Files:** skills/horde/scripts/land.mjs
**Found by:** jarl
**Where:** skills/horde/scripts/land.mjs, diffPaths() (~line 87)

## What
`diffPaths()` turns any `git diff`/`git ls-files` failure into an empty array `[]`, the same shape
as "genuinely nothing changed". The scope gate and the mapping gate both consume this list directly.

## Why
A real git failure (corrupted object, unreadable ref, disk error mid-diff) reads as "no files
changed" and every file-scope-dependent gate item passes — the landing gate can go green on a change
it never actually examined. This is the same class of bug issue 019 just fixed for `git()`'s general
null-swallowing, but here the empty-list shape is doing the swallowing at a higher, more consequential
layer (the gate pipeline itself, not just a refusal message).

## Acceptance
`diffPaths()` distinguishes a real git failure from a genuinely empty diff (reuse `gitError()` from
issue 019's fix in `_lib.mjs` if it fits) and the gate refuses on a real failure instead of silently
treating it as an empty, passing diff. A test: simulate a git diff failure (bad ref, or a repo state
that makes the underlying git command exit nonzero) and confirm the gate refuses rather than reports
success.

`parentBranchOf`'s similarly-ambiguous branch-existence check was checked by worker 019 and found to
be an intentional, documented fallback — leave that one alone, this issue is diffPaths only.


## Evidence

- **ran:** node --test tests/land.test.mjs (rebased tip, then merged main) · **saw:** 56/56 pass both times

