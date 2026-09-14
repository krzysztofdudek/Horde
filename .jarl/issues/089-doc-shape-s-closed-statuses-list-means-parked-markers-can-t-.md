# 089 · doc-shape's closed STATUSES list means parked_markers can't actually add a new parked status package-wide

**Status:** done
**Kind:** gap
**Priority:** 3
**Tier:** standard
**Tags:** kontrakt, pakiet
**Files:** packages/promises/doc-shape/check.mjs, packages/promises/yg-package.yaml, skills/horde/scripts/tests/promises-package.test.mjs
**Found by:** reviewer of 066
**Where:**

## What


## Why


## Acceptance


## Evidence

Filed with an empty What/Why/Acceptance body; researched directly before dispatch. Root cause: doc-shape/check.mjs exports a hardcoded STATUSES = ['planned','implemented','disabled'] and refuses any promise whose status is outside it — before has-evidence/evidence-is-live/evidence-matches-promise ever see the file. Those three aspects each declare their own configurable parked_markers key (yg-package.yaml, default 'planned, disabled') that a repository can widen to a genuinely new word (e.g. 'deferred') — confirmed by an existing passing test at promises-package.test.mjs:827 'the companion honors a repository-configured parked status, matching has-evidence', configured with parked_markers: 'planned, disabled, deferred'. But a promise actually declaring status: deferred would be refused by doc-shape itself first, in a real yg check run, since doc-shape has no parked_markers config key of its own and never reads one — so the other three rules' configurability is reachable only in isolated unit tests that call them directly, never through the real pipeline. This is the same bug class already fixed once in this package: issue 066 fixed evidence-matches-promise's companion.mjs for hardcoding its own separate parked-status set instead of reading the configurable one; 089 is the same gap one layer upstream, in doc-shape.
- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/promises-package.test.mjs · **saw:** 64/64 pass on rebased branch tip and again on merged main

