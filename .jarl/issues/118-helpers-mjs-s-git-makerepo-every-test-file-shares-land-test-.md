# 118 · helpers.mjs's git() (makeRepo, every test file) shares land.test.mjs's commit-signing 503 exposure

**Status:** open
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

