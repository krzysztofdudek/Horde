# 122 · Every other *.test.mjs's own local git() duplicates the commit-signing 503 exposure fixed in helpers.mjs and land.test.mjs

**Status:** in-progress
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/tests/mechanics.test.mjs, skills/horde/scripts/tests/tree.test.mjs, skills/horde/scripts/tests/wave.test.mjs, skills/horde/scripts/tests/drill.test.mjs, skills/horde/scripts/tests/law-guard.test.mjs, skills/horde/scripts/tests/quality.test.mjs, skills/horde/scripts/tests/blame.test.mjs, skills/horde/scripts/tests/law-diff.test.mjs, skills/horde/scripts/tests/law-audit.test.mjs, skills/horde/scripts/tests/family.e2e.test.mjs, skills/horde/scripts/tests/lifecycle.test.mjs, skills/horde/scripts/tests/tick.test.mjs, skills/horde/scripts/tests/queue.test.mjs, skills/horde/scripts/tests/ask.test.mjs, skills/horde/scripts/tests/refine.test.mjs, skills/horde/scripts/tests/retro.test.mjs, skills/horde/scripts/tests/plan-out.test.mjs
**Found by:** issue 118 worker
**Where:**

## What


## Why


## Acceptance


## Evidence

Filed while fixing issue 118 (helpers.mjs's own local git()). grep across skills/horde/scripts/tests/ for local 'function git(' definitions turns up 19 hits: land.test.mjs (fixed by issue 116) and helpers.mjs (fixed by issue 118) are the only two carrying the transient-commit-signing retry logic; the other 17 files each define their own separate, uncoordinated local git() that wraps 'git commit'/'merge'/'revert' through the same sandbox signing service (global git config: commit.gpgsign=true, gpg.ssh.program) with no retry at all, so each one still carries the identical transient-503-under-load exposure issue 116 and 118 were filed to close. Three of the seventeen (refine.test.mjs, retro.test.mjs, plan-out.test.mjs) additionally still call execFileSync with stdio:'ignore', so a failure there today throws with no captured stderr at all -- exactly the harder-to-diagnose state issue 118 described for the old helpers.mjs. The other fourteen (mechanics, tree, wave, drill, law-guard, quality, blame, law-diff, law-audit, family.e2e, lifecycle, tick, queue, ask) already capture stderr (either explicit stdio:['ignore','pipe','pipe'] or Node's own default 'pipe'), so a failure there is at least diagnosable, just not retried. Left unfixed here deliberately, matching the same discipline that separated 116 from 118: fixing 17 files in one pass is a wide blast radius across the whole suite that deserves its own careful, verified pass (and possibly its own design decision -- e.g. whether to finally consolidate all of these into one shared, exported retry-safe git() in helpers.mjs that every test file imports instead of each hand-copying the same fix again) rather than folding it into either 116 or 118, whose own Files fields never named these files.

Krzysztof approved: consolidate into one shared, exported retry-safe git() in helpers.mjs that all 17 files import, rather than patching each file's own copy separately (see .jarl/decisions.md, 122-consolidate-shared-git-helper). Ready for implementation dispatch. Held out of dispatch until the current wave lands — issue 121 (in progress) touches retro.test.mjs, one of the 17.

