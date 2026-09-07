- 2026-09-06T20:37:05.687Z key: author set to worker1

## Verdict · 001 · 2026-09-06 · by verifier1 (sonnet)

**Result:** reproduced

**Flake:** not flaky

**Base check:** rooted at `m1/trunk` tip — yes

**Evidence reproduced:**

| item | command | saw |
|---|---|---|
| node --test src/retry.test.mjs prints 1 pass |  |  |

**Revert test:** new tests on the base — failed as expected

**Gate:** `(not configured)` — green at sha 9cf59fe

**Diff:** 36eafc7841ff41f1b6a6b19d6b86fcde5971d8b5

**Scope:** diff inside core — yes · protected paths — untouched

**What failed, if anything** (what, not what to do):

