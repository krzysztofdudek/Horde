# 117 · retro.test.mjs's stand-in yg CLI never refuses package/record on a pass still in force, unlike the real CLI

**Status:** done
**Kind:** gap
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/tests/retro.test.mjs
**Found by:** issue 115 worker
**Where:** skills/horde/scripts/tests/retro.test.mjs `stubSource()`'s `verdict package`/`verdict record` handlers.

## What
Fixing issue 115 required knowing exactly when the real Yggdrasil CLI's `resolvePair` refuses to package or record a pair: only when the pair's currently recorded verdict is a PASS still in force (Yggdrasil's `source/cli/src/cli/verdict.ts`, the `kind === 'verified'` branch). `retro.test.mjs`'s own stand-in CLI (`stubSource()`) does not model this at all — its `verdict package` handler only fails when the test explicitly sets `packageFails: true` (a blanket failure regardless of the pair asked about), and `verdict record` never refuses based on what is already recorded. A test that packages or records over a pass still in force succeeds against the stub every time, which is exactly the shape three of `retro.test.mjs`'s own pre-existing tests turned out to be built on (fixed as part of 115, by starting those tests from a refusal instead of a pass).

## Why
retro.mjs's fix for issue 115 works around this by predicting the refusal from the inventory's own `verdict`/`inForce` fields before ever calling `verdict package`, so it never actually needs the stub to enforce the refusal — the new test proving the fix (`retro.test.mjs`, "a pair whose first judge passed it...") only needed `judgeRecords` to seed a fresh pass, not a stub that would refuse. But the gap stays latent: if a future change to retro.mjs's prediction went subtly wrong (checked the wrong field, or dropped the check while refactoring) and fell through to an actual `verdict package` call on a pass still in force, the stub would let it through silently, and the test suite would not catch a regression the real Yggdrasil CLI would refuse on. The stub is meant to stand in for the real CLI's contract; on this one axis it is more permissive than reality.

## Acceptance
`stubSource()`'s `verdict package` handler refuses (matching `resolvePair`'s shape: exit 1, a message naming the pair as already holding a verdict for these inputs) when the current `LOCK` entry for the requested (aspect, unit) key has `verdict: 'pass'` and its `hash` equals what `hashes(k).pass` currently computes — i.e. a pass still in force, using the stub's own existing content-hash tracking (`CONTENT`/`codeMoves`) rather than the static `inForce` flag alone. `verdict record` gets the same guard before it overwrites the slot. Every existing test that currently records a fresh pass and then packages or records over it in the same fixture (starting with `'the stand-in CLI cannot be made to hold two verdicts for one pair, because a graph cannot'`, which does exactly that) is updated to match what the real CLI would actually do.

## Evidence

- **ran:** cd /tmp/horde-worktrees/117-retro-test-stand-in-yg-cli-pass-in-force/skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 300 node --test tests/retro.test.mjs · **saw:** tests 56, pass 56, fail 0, cancelled 0, skipped 0, exit code 0 — includes 2 new tests (one with 4 sub-tests) proving the stand-in CLI's verdict package/record refuse a pair whose pass is still in force, and that retro.mjs's measureJudge() handles a real (unpredicted) refusal correctly; the pre-existing 'cannot be made to hold two verdicts for one pair' test was updated to start its two-judge sequence from a refusal since the old pass-then-overwrite sequence is now correctly refused
- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/retro.test.mjs · **saw:** 56/56 pass, 0 fail, on the merged tip

