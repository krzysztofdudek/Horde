# 110 · resolveHordeTrunk races two concurrent callers onto one worktree path

**Status:** in-progress
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/_lib.mjs
**Found by:** issue 041 worker
**Where:** skills/horde/scripts/_lib.mjs, `resolveHordeTrunk()` (~line 260): `existsSync(path)` then, in the branch that is false, `provisionTree(path, tip, cfg)` — an unguarded check-then-act with no lock between the two.

## What
Two processes that both resolve `resolveHordeTrunk(horde, cwd)` for the same horde at the same moment, before that horde's trunk worktree has ever been provisioned, both see `existsSync(path)` as false and both call `provisionTree` → `git worktree add`. The second one loses with a hard `git` failure ("fatal: '<path>' already exists"), surfaced as a `fail()` rather than either process simply getting the tree the other just made. Every caller that can reach this path is exposed: `queue.mjs` (several commands), `brief.mjs`, `horde.mjs`, `refine.mjs`, `retro.mjs`, `node.mjs`'s graph-write path, and now `tick.mjs` (041, when `--horde` is written out). Only `tick.mjs` holds any lock before reaching this code (041 moved its own `resolveTree` call inside the gate lock it already takes for the unrelated "two ticks racing" reason) — every other caller has nothing serializing it against a sibling process doing the same resolve at the same time.
Likely also live, same shape, for the `git reset --hard` a *second* (non-provisioning) call makes on an already-existing trunk tree — two concurrent resets on one worktree can plausibly collide on `.git/index.lock` the same way, though this issue's own repro is specifically the provisioning race, not that one.

## Why
Any two of the tools above racing on one horde's first-ever trunk read (a common shape: a director's `--watch` loop plus a manual invocation, or two sessions on one horde) hard-fails one of them with a raw git error instead of both getting the tree.

## Acceptance
`provisionTree`/`resolveHordeTrunk` in `_lib.mjs` tolerate a concurrent provision of the same path — either a lock scoped to the worktree path, or treating "already exists" from `git worktree add` here as success rather than a refusal (it's exactly the state a first caller who got there first left behind) — with a test that starts two of these concurrently against one un-provisioned horde and asserts both come back with the same tree, no refusal from either.

## Evidence

- **ran (from a temp fixture, `HORDE_TEST_YG` set to a real Yggdrasil build; repo made with `makeRepo()`+`initHorde()`, mission1's trunk never yet read):** two `tick.mjs --horde mission1 --json` runs launched at once against the same repository (spawned back-to-back with no synchronization, both racing `resolveHordeTrunk`'s first-ever provision of `mission1/trunk`) · **saw:** one run failed with `error: could not create worktree at <path>/.horde/worktrees/mission1/trunk for <sha> — Preparing worktree (detached HEAD <short-sha>)\nfatal: '<path>/.horde/worktrees/mission1/trunk' already exists`, exit code 1 — reproduced this exactly while developing 041's own fix, before narrowing tick.mjs's change to the explicit-`--horde`-only form and moving its resolveTree call inside its own gate lock (which fixes tick.mjs's self-race but nothing else that calls resolveHordeTrunk)

