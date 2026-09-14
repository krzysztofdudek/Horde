# 112 · withQueueLock takes the queue lock with a non-atomic write, the same flaw issue 098 fixed elsewhere

**Status:** open
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/_lib.mjs
**Found by:** issue 110 worker
**Where:** skills/horde/scripts/_lib.mjs, `withQueueLock()` — `writeFileSync(path, content, { flag: 'wx' })`.

## What
`withQueueLock()` takes the queue lock with `writeFileSync(path, content, { flag: 'wx' })` — the exact non-atomic create issue 098 already replaced in `land.mjs`'s `acquireGateLock` and `retro.mjs`'s `acquireRetroLock`. That call is three separate syscalls (open O_CREAT|O_EXCL, write, close), leaving the lock path existing as an empty file for a real window. `withQueueLock`'s own retry loop reads the file, finds no pid in it ("an unreadable or half-written lock file names no pid to wait on"), treats it as abandoned, deletes it, and takes the lock — while the first holder is still writing. Both callers then believe they hold the lock, and `queue.json`'s read-modify-write can run twice at once, which is the one thing this lock exists to prevent.

## Why
098's fix for this exact bug class already exists in this repo twice (`land.mjs`'s `createLockFile`, `retro.mjs`'s `createLockFile`, and now a third copy — `_lib.mjs`'s `createTreeLockFile`, added by issue 110): write the content whole to a unique temp name in the same directory, then `linkSync` it into place, which is atomic AND exclusive. `withQueueLock` is the one lock in this tool set still on the broken path, protecting the queue — arguably the single most contended piece of state in a running mission.

## Acceptance
`withQueueLock` creates its lock file the same atomic way the other three already do, with a test proving two racing callers cannot both believe they hold it (fault-injection, not a hopeful timing race — see the `lock-race/`/`tree-race/` fixtures already in this repo for the established pattern).

Related: issue 103 (centralizing the duplicated lock-file helper into `_lib.mjs`) now has THREE copies to fold into one, not two — `land.mjs`, `retro.mjs`, and `_lib.mjs`'s own `createTreeLockFile` (issue 110). Worth doing 103 and 112 together: centralize first, then point `withQueueLock` at the shared helper, rather than adding a FOURTH copy here and centralizing later.

## Evidence

withQueueLock() in skills/horde/scripts/_lib.mjs takes its lock with writeFileSync(path, content, {flag: 'wx'}) — the exact non-atomic create issue 098 replaced in land.mjs's acquireGateLock and retro.mjs's acquireRetroLock. That call is three syscalls (openat O_CREAT|O_EXCL, write, close), so the lock path exists as an empty file for a window. withQueueLock's own retry loop reads the file, gets no pid out of it ('an unreadable or half-written lock file names no pid to wait on'), treats it as abandoned, deletes it and takes the lock — while the first holder is still writing. Both then hold it, and queue.json's read-modify-write can be done twice at once, which is the one thing withQueueLock exists to prevent. 098's fix is already in this repo twice (land.mjs createLockFile, retro.mjs createLockFile): write the content whole to a unique temp name in the same directory, then linkSync it into place, which is atomic AND exclusive. Issue 103 covers moving that helper into _lib.mjs but does not say withQueueLock is still on the broken path. Not fixed under issue 110 (out of its scope: 110 is the worktree resolve race). Note that 110's fix added a correct atomic createTreeLockFile inside _lib.mjs, so 103's centralization now has three copies to fold into one.

