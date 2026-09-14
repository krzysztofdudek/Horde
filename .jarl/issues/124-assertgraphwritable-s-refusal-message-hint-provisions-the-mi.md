# 124 · assertGraphWritable's refusal-message hint provisions the mission's trunk worktree as a side effect

**Status:** in-progress
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/_lib.mjs
**Found by:** issue 114 worker
**Where:** `skills/horde/scripts/_lib.mjs`, `assertGraphWritable`, the `info.kind === 'cwd' && base && info.branch === base` branch: `const trunkPath = horde ? resolveTree({ horde }, { cwd: info.path }).path : null;`

## What
This line runs whenever a graph write (`node.mjs promote`/`demote`/`log --run`) is refused for being on the mission's own base branch, purely to compute a path to name in the refusal text ("the mission's tree is at X"). `resolveTree({ horde })` with no `tree` given resolves through `resolveHordeTrunk`, which is not a free read: on a mission whose trunk worktree has not been made yet, it runs `git worktree add` and provisions `.horde/worktrees/<horde>/trunk` on disk before the refusal is even printed. So a command that is refusing outright, and writing nothing, has the side effect of creating a new git worktree nobody asked for — found and left deliberately unfixed while auditing this exact line under issue 114 against ask a-002 (where it was confirmed correct on the *tree-resolution-target* question; this is a separate concern about *when that resolution runs*).

## Why
A refusal path is expected to be inexpensive and inert — read state, print a message, exit non-zero. This one instead does real, visible disk and git work (a new worktree directory, possibly a real `git worktree add` invocation) as a side effect of building a string for an error message that is about to be thrown away by `fail()` regardless of whether the suggested path could be computed. On a repository where provisioning that worktree is itself slow, or where the caller did not expect a new worktree directory to appear from a command that told them it wrote nothing, this is a small but real surprise.

## Acceptance
Not ruled on here — flagged as a candidate for one of: (a) leave as-is if a cheap disk-only path computation (no worktree creation, no `git reset --hard`) can be derived instead (e.g. a plain `<hordeRoot>/worktrees/<horde>/trunk` string composed by hand, without going through `resolveTree`/`provisionTree`, accepting that the suggested path may not exist as a real worktree yet); or (b) accept the provisioning as intentional (the suggested path becomes true the moment it's printed) and just say so in the comment/output. Either way this needs its own read of the tradeoff — not something to fold into a-002's own scope, which this issue is separate from.
