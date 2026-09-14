# 116 · land.test.mjs: two tests fail when the commit-signing service returns 503 under heavy concurrent load

**Status:** open
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/tests/land.test.mjs
**Found by:** issue 093 worker
**Where:** skills/horde/scripts/tests/land.test.mjs, a second, unrelated full-suite run under heavy load: `'a ticket that earned no evidence row...'` and `'--fate reverted: the undone merge...'`.

## What
On a second, independent full run of `tests/land.test.mjs` under heavy shared-machine load (found while validating issue 093's own fix, on a completely clean prior run), two unrelated tests failed — not the three issue 093 touched, and not from any timing/locking assumption. Both failures trace to the sandbox's git commit-signing service returning HTTP 503 under load, surfacing as a git commit failure inside the fixture setup those two tests share.

## Why
A test suite that can fail on infrastructure flakiness unrelated to the code under test costs time re-running and erodes trust the same way the timing races issue 093 fixed did — the same class of problem, a different cause (an external signing service under load, not a wall-clock guess).

## Acceptance
The two named tests (or whatever shared fixture helper commits on their behalf) either retries a transient signing failure a bounded number of times, or the failure is surfaced with a clear enough message that a 503 from the signing service is distinguishable from a real assertion failure at a glance. A repeated run under the same heavy load stays green.

## Evidence

