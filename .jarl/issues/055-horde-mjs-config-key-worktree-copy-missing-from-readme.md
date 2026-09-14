# 055 · horde mjs config key worktree copy missing from readme

**Status:** done
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/horde.mjs
**Found by:** workflow finder usage-vs-readme, confirmed by two refuters
**Where:** skills/horde/scripts/horde.mjs:64

## What
horde.mjs config key worktree.copy missing from README

USAGE's `config set` help documents a config key `"worktree.copy" (default: none)`: "a list of repository-root-relative paths copied into every ticket, trunk or scratch tree the moment it is made … a path git already tracks is refused."

## Why
An adopter reading only README (the documented "contract") would never learn this config key exists, even though it is a real, documented, behavior-changing setting.

## Acceptance
README's `horde.mjs` config bullet enumerates every config key (`base`, `gates.*`, `testGlobs[]`, `ygCommand`, `grainCommand`, `keyContext`, `protectedPaths[]`, `fixRounds.*`, `classes`, `parallelism`) but never mentions `worktree.copy` at all.

Dowód, którego oczekuję: grep -n "worktree.copy" skills/horde/scripts/README.md returns nothing; grep -n "worktree.copy" skills/horde/scripts/horde.mjs shows it defined and used.

Refuterzy: horde.mjs:64 documents "worktree.copy" (default: none) in USAGE as a real config key. grep of skills/horde/scripts/README.md for "worktree.copy" returns zero matches — the README's config-key bullet l | Confirmed exactly as claimed. horde.mjs:64 documents the config key `worktree.copy` (default: none) in its own USAGE string. README.md's `config get|set` bullet (lines 51-63) exhaustively lists config

## Evidence

- **ran:** grep -n 'worktree.copy' skills/horde/scripts/README.md · **saw:** worktree.copy[] now listed in the config-key bullet list with description matching horde.mjs's own USAGE wording

