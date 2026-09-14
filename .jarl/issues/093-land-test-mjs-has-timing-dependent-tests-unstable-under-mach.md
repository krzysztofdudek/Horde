# 093 · land.test.mjs has timing-dependent tests unstable under machine load (two spots)

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tests/land.test.mjs
**Found by:** merger (batch1 full-suite run) + worker 070
**Where:**

## What


## Why


## Acceptance


## Evidence

- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/land.test.mjs · **saw:** 82/82 pass clean on merged main tip (an earlier run under the same session showed 2 unrelated failures — traced to the sandbox's git commit-signing service returning 503 under load, filed separately as issue 116, reproduced as absent on a clean re-run); independently reviewed the actual land.test.mjs diff, confirmed the waitGateLockHeldBy helper and all three fixed spots match the report exactly

