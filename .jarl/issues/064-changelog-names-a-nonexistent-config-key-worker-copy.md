# 064 · changelog names a nonexistent config key worker copy

**Status:** open
**Kind:** docs
**Priority:** 3
**Model:** sonnet
**Tags:** proces
**Files:** CHANGELOG.md
**Found by:** workflow finder changelog-vs-code, confirmed by two refuters
**Where:** CHANGELOG.md:17

## What
CHANGELOG names a nonexistent config key `worker.copy`

The Added section states: "`land --background` returns immediately and writes its result to a file. `worker.copy`/`worktree.copy` copies files into every new worktree." This presents `worker.copy` and `worktree.copy` as two equivalent/alias config keys that both do this. Only `worktree.copy` exists anywhere in the codebase: skills/horde/scripts/_lib.mjs reads `cfg.worktree.copy` (line 291: `const copyList = cfg && cfg.worktree && Array.isArray(cfg.worktree.copy) ? cfg.worktree.copy : [];`) and refers to it throughout (lines 272, 273, 281, 283, 294, 303). skills/horde/scripts/horde.mjs's own config documentation (line 64) also only names `"worktree.copy"`. A repository-wide search for `worker.copy` (excluding this changelog line) returns zero matches in the entire codebase.

## Why
An adopter reading the changelog would try setting `horde.mjs config set worker.copy ...` per this entry's literal text and find it silently does nothing (it isn't read by any script), since the real key is `worktree.copy`.

## Acceptance
The config key that copies files into every new worktree is `worktree.copy` only; there is no `worker.copy` key, alias, or documentation of one anywhere in skills/horde/scripts or the docs.

Dowód, którego oczekuję: grep -rn "worker\.copy" across the repository: the only hit is this changelog line itself. grep -rn "worktree\.copy" shows it as the sole real key, read in skills/horde/scripts/_lib.mjs:291 and documented in skills/horde/scripts/horde.mjs:64.

Refuterzy: Confirmed. CHANGELOG.md:17 reads "worker.copy`/`worktree.copy` copies files into every new worktree", implying two equivalent keys. A repo-wide grep (excluding worktrees/scratch copies) shows worker.c | Verified: CHANGELOG.md line 17 literally reads "`worker.copy`/`worktree.copy` copies files into every new worktree." A grep across skills/horde/scripts/ (_lib.mjs, horde.mjs, tests/) shows only `workt

## Evidence

