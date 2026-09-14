# 090 · acquireRetroLock race: worker reproduced it once, reviewer could not in 220 runs and code reading says it should be safe

**Status:** in-progress
**Kind:** research
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/retro.mjs
**Found by:** worker 070's stress run + 070's reviewer's independent code reading and 220-run non-reproduction
**Where:** skills/horde/scripts/retro.mjs, `acquireRetroLock`

## What
Investigate a discrepancy, don't assume a fix. Worker 070 reproduced a duplicate-write race once in
60 stress runs, and theorized `acquireRetroLock` treats a lock file that exists-but-isn't-parseable
yet as stale and steals it. Worker 070's own reviewer read the actual code and found the lock is a
single atomic `writeFileSync(..., {flag:'wx'})` with no such window, then ran 220+161 stress
executions (up to 40 concurrent) and reproduced nothing. The two accounts conflict.

## Why
Either there's a real, rare race nobody has actually pinned down yet, or the one observed failure
had a different, unrelated cause (a flaky assertion, a shared-fixture collision from another
concurrent test file, machine noise) and the lock itself is fine. Filing a P2 bug on an unconfirmed
mechanism would be guessing; leaving it uninvestigated risks a real bug hiding under "probably a
fluke".

## Acceptance
Read `acquireRetroLock` and every caller/releaser around it line by line. Either (a) find and
demonstrate a real race with a reliable repro (not 1-in-60), and file it as a proper P2 bug with the
actual mechanism named, or (b) conclude the lock is sound and identify what worker 070's single
failure actually was (a different test, a fixture cleanup race, environment noise), recording that
finding here and closing this as research-concluded. Either outcome is a valid, complete answer —
do not leave this open-ended.

Dowód, którego oczekuję: either a reliably-reproducing repro script plus a new bug ticket, or a
concrete alternative explanation for worker 070's one observed failure.


## Evidence

- **ran:** read acquireRetroLock and its release() line by line, read the identical pattern in land.mjs's acquireGateLock, straced writeFileSync(path,data,{flag:'wx'}) to see its actual syscalls, then built a deterministic fault-injected repro (lock-lib.mjs port of the exact decision logic + contender.mjs/orchestrator.mjs) racing a delayed writer against the 100%-unmodified acquire logic, 6 runs · **saw:** outcome (a): the race is real. strace shows writeFileSync(wx) is openat+write+close, not one atomic step; O_EXCL only makes the create exclusive. The shipped 'unparseable == stale, steal it' branch (no processAlive check reached, since held is null) double-acquires when that gap is crossed: 6/6 fault-injected runs produced two contenders with overlapping [acquired,released] windows on the same lock path, using retro.mjs's real, unmodified decision logic on one side. A control run with no injected delay serialized correctly every time, matching the reviewer's 220+161 -- the natural window is real, just typically sub-microsecond, which is why it takes heavy load to hit it naturally and widening to hit it on demand. Filed as bug 098 (P2, strong) with the mechanism, both call sites (retro.mjs and land.mjs share the pattern), and a suggested fix (temp-file + atomic rename).

