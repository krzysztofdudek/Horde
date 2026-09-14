# 113 · horde.mjs done's own resolveTree call uses the resolved horde, not flags.horde raw

**Status:** in-progress
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/horde.mjs
**Found by:** issue 109 worker
**Where:** skills/horde/scripts/horde.mjs, `cmdDone()`: `const horde = resolveHorde(flags);` then `const root = resolveTree({ tree: flags.tree, horde }).path;` — `horde` here is `resolveHorde(flags)`'s own return, not `flags.horde`.

## What
`horde.mjs done`'s own tree resolution passes the RESOLVED horde into `resolveTree`, not the raw `--horde` flag — the exact shape issue 041 fixed in tick.mjs and issue 109 fixed in land.mjs, both narrowed specifically to `flags.horde` because `resolveHorde(flags)` defaults to the sole horde in a single-horde repository even when nobody typed `--horde` at all. `cmdDone` does not carry that narrowing: in a single-horde repository, a bare `horde.mjs done` (no `--horde`, no `--tree`) run from ANY cwd resolves to that horde's own trunk unconditionally, never cwd — the exact "no --horde needed at all, infer from context" reading that issue 037 tried elsewhere and got reverted for (f551100), and that ask a-002 is still open on.

## Why
Unlike 041/109, this is not a silent-wrong-tree risk (the tree really is this horde's trunk either way, since done's own evidence check is inherently about the mission's own trunk state) — it is live evidence that the broader a-002 question is not hypothetical: a shipped command already resolves "no --horde typed, one horde exists" to trunk today, the same reading 037 was reverted for elsewhere. Left unexamined, this command's own precedent could be read either as "an oversight to narrow like 041/109" or as "proof (b) is already how part of this tool set works" — which is exactly the client's call, not a worker's.

## Acceptance
Once ask a-002 is ruled: if the ruling is "no --horde always means cwd, full stop," narrow `cmdDone`'s resolveTree call to `flags.horde` the same way 041/109 did, and document the change. If the ruling allows "no --horde, one horde exists → trunk," leave `cmdDone` as it is and record here why it was already correct (mirroring how `tk-boundary-cwd-is-intentional` closed out issue 040 as docs-only once the design intent was confirmed). Either way, do not change this on a worker's own reading of a-002.

## Evidence

- **ran:** read skills/horde/scripts/horde.mjs's `cmdDone()` (the `--horde`/`--tree`/`resolveTree` lines) alongside `resolveHorde`'s own doc comment in `_lib.mjs` ("the sole existing horde is the default") · **saw:** `resolveHorde(flags)`'s return value, not `flags.horde`, is what reaches `resolveTree({ tree: flags.tree, horde })` — confirmed by reading the source directly, not by a failing test (no test in this suite currently pins `horde.mjs done`'s tree default either way)

