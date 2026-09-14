# 107 · doc-shape's yg-aspect.yaml description still says 'the fixed three' statuses

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** kontrakt, pakiet
**Files:** packages/promises/doc-shape/yg-aspect.yaml
**Found by:** issue 089 worker
**Where:** packages/promises/doc-shape/yg-aspect.yaml, its `description:` field

## What
Issue 089 (fixed alongside this one being filed) changed doc-shape's status check from a fixed three-value list (`planned`/`implemented`/`disabled`) to `implemented` plus whatever a repository's own `parked_markers` config names. `yg-aspect.yaml`'s `description:` field still describes the old, now-inaccurate behavior — "a status from the fixed three" (or equivalent wording naming exactly three, closed, statuses).

## Why
An aspect's description is what a reader (or a tool listing aspects) is told the rule does; once doc-shape accepts a configurable set rather than a hardcoded three, a description still asserting "the fixed three" is stale documentation sitting right next to the code it describes — the same staleness class as several other issues fixed this session (060, 086, 073's dead references).

## Acceptance
`yg-aspect.yaml`'s `description:` accurately reflects doc-shape's real status-acceptance rule after issue 089: `implemented`, plus a repository's own configured `parked_markers` (default `planned, disabled`) — not "a fixed three."

## Evidence

- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/promises-package.test.mjs · **saw:** 64/64 pass — description-only change

