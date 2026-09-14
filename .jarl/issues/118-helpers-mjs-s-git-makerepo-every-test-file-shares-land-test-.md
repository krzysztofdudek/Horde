# 118 · helpers.mjs's git() (makeRepo, every test file) shares land.test.mjs's commit-signing 503 exposure

**Status:** in-progress
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/tests/helpers.mjs
**Found by:** issue 116 worker
**Where:**

## What


## Why


## Acceptance


## Evidence

helpers.mjs's own local git() (used by makeRepo(), which every *.test.mjs file in tests/ calls first) wraps 'git commit' the same way land.test.mjs's local git() did before issue 116's fix, through the same sandbox commit-signing service (global git config: commit.gpgsign=true, gpg.ssh.program) — so it carries the identical transient-503-under-load exposure, suite-wide, not just in land.test.mjs. It is also harder to diagnose today: it calls execFileSync with stdio:'ignore', so a failure there currently throws with no captured stderr at all, unlike land.test.mjs's version. Left unfixed here deliberately: issue 116's Files field named only skills/horde/scripts/tests/land.test.mjs, and changing helpers.mjs changes behavior for every test file in the suite, not just the two named tests.
- **ran:** scratch verification (not part of the committed suite): a fake git binary injected at the front of PATH scripted 3 scenarios against makeRepo()'s new git() via its 'commit' call — (A) 2 transient 503 signing failures then success, (B) 3 persistent transient 503 failures, (C) 1 non-transient git failure (bad pathspec) · **saw:** (A) makeRepo() succeeded after exactly 3 commit invocations, i.e. recovered; (B) makeRepo() threw after exactly 3 attempts with the '[git commit-signing] gave up after 3 attempts' diagnostic appended to the error message; (C) makeRepo() threw immediately after exactly 1 attempt, no retry on a non-transient failure — all 3 scenarios matched their expected outcome
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 500 node --test tests/helpers.test.mjs tests/tick.test.mjs tests/queue.test.mjs tests/wave.test.mjs · **saw:** tests/helpers.test.mjs does not exist in this suite (only helpers.mjs, no such .test. file) -- node --test silently matched 0 tests for that path and exited 0, no error; the other three files ran for real: 165/165 tests passed (# tests 165, # pass 165, # fail 0, # cancelled 0), duration_ms 89271, exit code 0
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 580 node --test tests/land.test.mjs tests/tree.test.mjs tests/mechanics.test.mjs tests/law-guard.test.mjs tests/node.test.mjs tests/drill.test.mjs tests/tk.test.mjs tests/blame.test.mjs · **saw:** broader sweep beyond the ticket's suggested list, covering (among others) land.test.mjs itself: 344/344 tests passed (# tests 344, # pass 344, # fail 0, # cancelled 0), duration_ms 392130, exit code 0

