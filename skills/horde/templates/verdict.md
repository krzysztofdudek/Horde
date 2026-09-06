## Verdict · {{ticketId}} · {{date}} · by {{verifier}} ({{class}})

**Result:** {{reproduced | not-reproduced | stale | out-of-scope}}

**Flake:** {{flake | not flaky}}

**Base check:** rooted at `{{teamBranch}}` tip — {{yes | no}}

**Evidence reproduced:**

| item | command | saw |
|---|---|---|
{{rows}}

**Revert test:** new tests on the base — {{failed as expected | passed (proves nothing)}}

**Gate:** `{{gateCommand}}` — {{green | red: …}}

**Scope:** diff inside {{node}} — {{yes | no: …}} · protected paths — {{untouched | touched: …}}

**What failed, if anything** (what, not what to do):
