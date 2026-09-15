# 033 · e2e rodziny dla kontraktu

**Status:** done
**Kind:** test
**Priority:** 2
**Tier:** standard
**Tags:** kontrakt
**Files:** skills/horde/scripts/tests/family.e2e.test.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/tests/family.e2e.test.mjs

## What
Test e2e rodziny na repozytorium z pakietem promises i raportem runnera: init → refine → tick → land, z przypadkami dla issue 020, 021, 022: dodany skip odmawia, obietnica bez przypadku odmawia, obietnica cofnięta na planned odmawia bez pytania lower.

## Why
Kontrakt ma być udowodniony całym cyklem, nie testami jednostkowymi punktów.

## Acceptance
Test przechodzi w CI; każdy przypadek nazwany po obietnicy, którą sprawdza.

Dowód, którego oczekuję: skills/horde/scripts/tests/family.e2e.test.mjs.

## Evidence

- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" GRAIN_BIN="node /home/user/Grain/plugins/grain/bin/grain.mjs" timeout 1800 node --test tests/family.e2e.test.mjs · **saw:** # tests 19 / # suites 0 / # pass 19 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0 — E18 (16 subtests, mined-graph seam, unchanged) plus the three new top-level cases E19/E20/E21 all pass; duration_ms 58690.6
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 1800 node --test tests/family.e2e.test.mjs   (the exact command this issue names, GRAIN_BIN unset) · **saw:** # tests 4 / # pass 3 / # fail 0 / # skipped 1 — E18 skips loudly (its own designed behaviour: no Grain reachable by siblingPath() walking up from a /tmp/horde-worktrees/* worktree, unrelated to this change since E18 itself was not edited); E19, E20, E21 all pass
- **ran:** read skills/horde/scripts/tests/family.e2e.test.mjs (E19/E20/E21, appended after E18) · **saw:** Three new top-level tests, each named after the "adds-two-numbers" promise it checks, each driving a fresh repo through real horde.mjs init -> refine.mjs (cut/consult/review/frame) -> wave.mjs start -> tick.mjs dispatch -> a worker commit in the real cut worktree -> land.mjs, no grain propose/yg adopt (graph built by hand via addNode/addAspect, matching land.test.mjs/law-guard.test.mjs). E19: a skip marker added to the promises paired test refuses (021 evidence guard, skip added). E20: a gate command configured to write a real junit report that never names the promises paired file refuses at the "gate" check item, naming the promise (022 report check) — not an early guard refusal. E21: the promise doc reverted to status planned refuses without an answered lower ask, then passes once ask.mjs add --kind lower --aspect evidence:adds-two-numbers + ask.mjs answer records one (021 evidence guard, promise parked, plus the ask.mjs escape hatch).
- **ran:** HORDE_TEST_YG=... GRAIN_BIN=... node --test tests/family.e2e.test.mjs, merger's own run on the merged tip · **saw:** 19 tests, 19 pass, 0 fail, 0 skip (E18's 16 own subtests plus E19/E20/E21)
- **ran:** same command with GRAIN_BIN unset (the exact command this issue names) · **saw:** 4 tests, 3 pass, 0 fail, 1 skip (E18 skips loudly with its own designed reason; E19/E20/E21 all pass)

