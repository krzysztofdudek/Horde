# 119 · decide.mjs's withDecisionsLock never recovers a lock left by a dead holder

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/decide.mjs
**Found by:** issue 103 worker
**Where:** skills/horde/scripts/decide.mjs, `withDecisionsLock()`

## What

`withDecisionsLock()` takes its lock with `writeFileSync(path, String(process.pid), { flag: 'wx' })`
and, on `EEXIST`, just retries until a fixed 10s deadline, then throws. Unlike every other lock in
this tool set (the gate, the retrospective, the worktree lock, and now the queue lock — see issues
098, 110 and 112), it never reads the lock file back to check whether the pid inside it is still
alive, so it has no stale-lock takeover at all. A holder that dies while holding this lock (killed
outright, machine going down — the same case the other locks' own comments call out) leaves
`decisions.md.lock` behind forever: every `decide.mjs` call on that horde from then on waits out the
10s deadline and refuses, permanently, until someone deletes the file by hand. The other locks
would take over a dead holder's lock immediately instead.

Noticed while centralizing the atomic lock-file-creation helper for issues 103/112 — `decide.mjs`
is not named in either issue's Files list, so left alone rather than folded in here.

## Why

A crashed `decide` call (a worker or the director killed mid-ruling, a container recycled) quietly
wedges every future decision on that horde — `ask.mjs answer`, `decide.mjs` itself, anything that
calls `withDecisionsLock` — with no recovery path short of a maintainer finding and removing the
stale lock file by hand. This is a different failure shape than issues 098/110/112 (which were
about two holders both believing they held the same lock at once): this one is about one holder
never being able to hand the lock back to anyone, ever, once it is gone.

## Acceptance

`withDecisionsLock` recovers a lock left by a pid that is no longer running, the same way
`acquireGateLock`, `acquireRetroLock`, `withTreeLock` and `withQueueLock` already do (write the pid
into the lock file, read it back on contention, take over when that pid is dead) — ideally reusing
the same shared `createLockFile`/`processAlive` helpers those four now import from `_lib.mjs`
instead of adding a fifth copy of the pattern. A test proves a lock left by a dead pid is taken
over rather than waited out to a hard refusal.

## Evidence

skills/horde/scripts/decide.mjs, lines 64-83:

```js
function withDecisionsLock(horde, fn) {
  const path = decisionsLockPath(horde);
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw new Error(`decisions.md is locked by another process — timed out waiting for ${path}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try { rmSync(path, { force: true }); } catch { /* already gone */ }
  }
}
```

No read of the lock's own content, no pid-liveness check, no takeover — contrast with
`_lib.mjs`'s `withQueueLock`/`withTreeLock` and `land.mjs`'s/`retro.mjs`'s own lock functions,
each of which reads `{pid, ...}` back out of a contended lock file and deletes+retakes it the
moment that pid is no longer alive.
- **ran:** cd /tmp/horde-worktrees/119-decide-mjs-withdecisionslock-stale-recovery/skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 300 node --test tests/decide.test.mjs (also re-run together with tests/queue.test.mjs to check the shared lock-race/ harness for regressions) · **saw:** decide.test.mjs alone: tests 11, pass 11, fail 0 (7 top-level: existing add/list/show/refusals + --node redirect, unchanged; plus 5 new: dead-pid lock taken over in <5s not waited 10s; half-written lock file taken over; live holder waited out (>=70% of a 500ms hold) then succeeds; live holder past its own short deadline is refused with "locked by another process", not silently taken over; a lock caught half-made via the slow-fs fault-injection harness (new "decide" kind) is never read as abandoned). Combined with queue.test.mjs: tests 72, pass 72, fail 0 -- no regression to the existing queue-lock race test after adding "decide" to the shared lock-race/ harness. Sanity check: reverted decide.mjs only (git stash) and reran the dead-pid and half-written-lock tests against the old code -- both failed as expected, each waiting the old fixed 10s deadline and then throwing the pre-fix message "decisions.md is locked by another process -- timed out waiting for ...", confirming the new tests actually catch the bug.
- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/decide.test.mjs skills/horde/scripts/tests/queue.test.mjs · **saw:** 72/72 pass, 0 fail, on the merged tip

