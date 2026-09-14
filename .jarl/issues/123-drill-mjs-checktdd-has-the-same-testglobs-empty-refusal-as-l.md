# 123 · drill.mjs checkTdd has the same testGlobs-empty refusal as land.mjs's revert test had before issue 108, with no no-evidence-layer exemption

**Status:** done
**Kind:** gap
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/drill.mjs
**Found by:** issue 108 worker
**Where:** skills/horde/scripts/drill.mjs checkTdd, the `cfg.testGlobs` guard (around the "test patterns" check)

## What
`drill.mjs check tdd` (`checkTdd`) refuses unconditionally with a red "test patterns" item whenever
`cfg.testGlobs` is empty ("this repository's test patterns are unset, so \"no new tests\" would mean
\"did not look\""). This is the exact same shape issue 108 fixed in land.mjs's checkRevertTest, in a
different file: on a repository the charter has judged to have no evidence layer, `config.testGlobs`
is empty by construction, so this drill is red by construction on exactly those repositories too.
checkTdd has no reference anywhere to `noEvidenceLayerNote`/`noEvidenceLayerIn` from `_lib.mjs`.

## Why
The tdd discipline's own drill exists to audit whether a ticket could have shown a real failure
before the code that satisfies it. On a mission with nothing here to run a proof against, that
question does not apply any more than the landing gate's version of it did — and issue 108's ruling
(`.jarl/decisions.md`, 108-no-evidence-layer-exempts-revert-test) already answered the parallel
question for the landing gate. Left as is, this drill silently disagrees with the landing gate and
with the charter about a mission that has already made this judgement, the same disagreement issue
108 closed one file over.

Not part of issue 108's own scope (its Files field names only land.mjs) and not a regression from
that work — found by reading `checkRevertTest`'s sibling implementations for the same pattern while
fixing 108.

## Acceptance
Given the same ruling issue 108 already has, checkTdd checks the charter's no-evidence-layer
judgement first — before the testGlobs guard — the same way checkRevertTest now does, exempting the
"test patterns" item outright and citing the judgement, on a mission whose charter has made it. A
test on a fixture with no evidence layer proves a `drill.mjs check tdd` run goes green on this item
instead of refusing; a fixture with an evidence layer keeps today's refusal-on-empty-testGlobs
unchanged.

## Evidence
- **ran:** HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 400 node --test tests/drill.test.mjs (run from skills/horde/scripts) · **saw:** exit 0 — # tests 26, # pass 26, # fail 0, # cancelled 0 (includes 4 new tests for the no-evidence-layer exemption; all 22 pre-existing drill.test.mjs tests still pass unchanged)
- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/drill.test.mjs · **saw:** 26/26 pass, 0 fail, on the merged tip

