# 098 · acquireRetroLock/acquireGateLock: a lock file that exists but is not yet fully written is treated as dead and stolen

**Status:** open
**Kind:** bug
**Priority:** 2
**Tier:** strong
**Tags:** zaplecze
**Files:** skills/horde/scripts/retro.mjs, skills/horde/scripts/land.mjs
**Found by:** 090's investigation: a deterministic fault-injected repro (6/6) plus strace confirmation that writeFileSync(path, data, {flag:'wx'}) is openat+write+close as three separate syscalls, not one atomic operation
**Where:** skills/horde/scripts/retro.mjs, `acquireRetroLock`; the identical pattern in skills/horde/scripts/land.mjs, `acquireGateLock`.

## What
`writeFileSync(path, content, {flag: 'wx'})` is not one atomic step. `strace` on this exact call
shows three separate syscalls: `openat(..., O_CREAT|O_EXCL|O_WRONLY, ...)`, then `write(fd, ...)`,
then `close(fd)`. `O_EXCL` only makes the CREATE atomic — only one process's open can win — it says
nothing about when the content becomes readable. Between the open succeeding and the write landing,
the lock file exists on disk with 0 bytes.

Both `acquireRetroLock` and `acquireGateLock` handle "exists but `readFileSync` + `JSON.parse`
fails" the same way: `if (!held || !processAlive(held.pid)) { rmSync(path); continue; }`. An
unparseable file is treated exactly like a dead process's abandoned lock — deleted and the path
retaken — with no check for "a live process just created this and hasn't written it yet."

Demonstrated with a deterministic repro: a byte-for-byte port of the acquire/steal/release decision
logic (verified against the shipped function; only the write step is pluggable) run as two real
child processes sharing one lock path. One contender's write step is the same two syscalls
`writeFileSync` performs internally, with an explicit pause between them — widening, not creating,
the real gap. The other contender is the 100% unmodified logic. Result, 6 runs out of 6: the
unmodified contender hits `EEXIST`, reads the still-empty file, calls it stale, deletes it,
recreates it, and returns success within milliseconds. The delayed contender's write then lands in
the now-orphaned (unlinked) inode and also returns success. Both finish `attemptAcquire()` believing
they hold the same lock, with logged `[acquired, released]` windows that overlap in wall-clock time.
A control run of two unmodified contenders with no injected delay serialized correctly every time —
matching 090's reviewer's 220+161 clean runs. The natural window really is that narrow; it only has
to be crossed once.

Not a duplicate of 070 (done, merged as b6ac837): 070 made the "two retrospectives at once" TEST
stop depending on `spawn()` timing (it now waits for the first process's lock file to actually show
a parseable pid before starting the second), which happens to keep that one test from ever walking
into this window again — but 070 never touched `acquireRetroLock` itself (its Files field names only
`retro.test.mjs`), so the production code's window is exactly as open as before. 070's own reviewer
evidence records 0 reproductions in 220+161 runs on both sides of that test-only fix, which is
consistent with what this repro also found: the natural window is real but far too narrow to walk
into by chance in that many tries — it takes widening (here) or unusual scheduling luck (maybe
070's original single failure) to cross it.

## Why
Two processes racing this window both leave `acquireRetroLock`/`acquireGateLock` believing they
alone hold it. In retro.mjs that lets `logTaste` run twice for the same item on two processes that
each think they are the only writer — a duplicate line landing in a component's log through
`yg log add`. It also reaches `release()`, which applies the identical "unreadable ⇒ ours to clear"
assumption: a process that loses this race could, on a different interleaving, delete the winner's
still-live lock file out from under it. `acquireGateLock` guards the landing gate for a whole
repository with the same code, so the same defect reaches there too, unconfirmed by a dedicated
repro but not different in mechanism (files field lists both; fix and test both, or say why not).

## Acceptance
A fix must close the window without opening a new one — for example, write the lock's content to a
temp file in the same directory first and atomically rename it into place (POSIX rename never
exposes a partially-written target), rather than writing in place under `O_EXCL`. A regression test
must not depend on natural timing (a flaky stress loop proves nothing either way, as 090 found) — use
the same artificial-delay technique this ticket's repro used, or an equivalent deterministic
fault injection, so the fix is provable red-before/green-after on demand. Cover both
`acquireRetroLock` and `acquireGateLock` — they share the defect.

## Evidence

- **ran:** strace -f -e trace=openat,write,close node wxtest.mjs (wxtest.mjs: writeFileSync(path,'{}',{flag:'wx'})) · **saw:** openat(...O_CREAT|O_EXCL|O_WRONLY...)=20 then write(20,"{}",2)=2 then close(20)=0 -- three separate syscalls, confirming writeFileSync(...,{flag:'wx'}) has a create-then-populate gap, not one atomic step
- **ran:** node orchestrator.mjs 400 60 500, six times in a row (byte-for-byte port of acquireRetroLock's decision/write logic; one contender's write delayed 400ms after create, the other 100% unmodified, both racing the same lock path) · **saw:** 6/6 runs: DOUBLE-ACQUISITION CONFIRMED -- the unmodified contender read the still-empty file left by the delayed one, treated it as stale, deleted and retook it, and both contenders' logged [acquired,released] windows overlapped in wall-clock time (e.g. real 24.244-24.744Z fully containing slow 24.561-24.682Z)
- **ran:** same harness with 0 injected delay (control): two 100%-unmodified contenders racing normally, repeated · **saw:** lock serialized correctly every time -- one acquires and fully releases before the other's writeFileSync(wx) is even attempted; no overlap. Matches 090's reviewer's clean 220+161 runs: the natural window is real but far too narrow to hit without widening it

