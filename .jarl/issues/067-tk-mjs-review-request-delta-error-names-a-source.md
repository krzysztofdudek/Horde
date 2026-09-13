# 067 · tk mjs review request delta error names a source

**Status:** open
**Kind:** bug
**Priority:** 2
**Model:** sonnet
**Tags:** zaplecze
**Files:** skills/horde/scripts/tk.mjs
**Found by:** workflow finder error-messages, confirmed by two refuters
**Where:** skills/horde/scripts/tk.mjs:699

## What
tk.mjs review-request --delta error names a source ("the merge checklist prints it") that never exists

`if (flags.delta === true) fail('--delta requires the path of the file to re-review (the merge checklist prints it)');` tells the caller to get the `--delta <path>` value from output the merge checklist (land.mjs) prints. The same claim is made in the command's own usage text at tk.mjs:104-106 ("the merge checklist writes it and prints its path") and repeated in scripts/README.md:178.

## Why
grep across every .mjs script for 'rereview', 're-review', or any diff-file write in land.mjs turns up nothing: land.mjs never constructs, writes, or prints any such file or path. The only place the exact filename shape appears is the test, which fabricates the path by hand rather than reading it from a real land.mjs run. So an agent that hits this refusal and goes looking for "the file the merge checklist prints" has no such output to find — the next step named in the error does not exist.

## Acceptance
land.mjs (the merge checklist) should write a re-review diff file (something like `rereview-<sha>..<sha>.diff`, per the test at tests/tk.test.mjs:496) and print its path, so an agent told to supply `--delta <path>` has an actual place to get that path from.

Dowód, którego oczekuję: Run `land.mjs <ticket>` (or read through land.mjs end to end) and grep its output/writes for any file matching `rereview-*.diff` or any diff artifact tied to review-request — none is written or printed anywhere in land.mjs. Then run `tk.mjs review-request <ticket> --delta` (bare boolean) and follow the printed refusal: there is no command or output in the tool set that produces the path it asks for.

Refuterzy: Confirmed as stated. tk.mjs:699 (and the usage text at 104-106) tells the caller that "the merge checklist" writes/prints the --delta path. The merge checklist is land.mjs (per reference/discipline/RE | Confirmed exactly as stated. tk.mjs:699 (and the usage text at ~104-106, and scripts/README.md:178) all claim `--delta <path>` is obtained from output "the merge checklist writes it and prints its pat

## Evidence

