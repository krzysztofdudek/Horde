# 114 · several other resolveTree(..., horde) call sites may share 041/109's resolved-horde-not-flags.horde gap

**Status:** open
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/brief.mjs, skills/horde/scripts/wave.mjs
**Found by:** issue 109 worker
**Where:** `grep -n "resolveTree({[^}]*horde" skills/horde/scripts/*.mjs` turns up several call sites beyond 041 (tick.mjs), 109 (land.mjs) and 112 (horde.mjs done) that pass a `horde` variable into `resolveTree` rather than `flags.horde` — none independently verified past reading the enclosing function's own `horde` provenance once: `brief.mjs` `cmdArchitect`/`cmdLegislate`/`cmdRetro` (each takes `horde` as a parameter fed by `main()`'s own `const horde = resolveHorde(flags);`, so all three read as the resolved value, not the raw flag), and `wave.mjs`'s `planAtStart()` → `buildPlan(horde, team || 'trunk', cfg)` with no `tree` at all, so `buildPlan`'s own internal `resolveTree({ tree, horde })` (queue.mjs:1075) actually falls through to the `horde` branch here — unlike its other two known callers (`queue.mjs cmdPlan`, `land.mjs missionSize`), which always pass an explicit `tree` and so never reach that branch. `planAtStart`'s own `horde` parameter was not traced back to its caller in `wave.mjs`'s `cmdOpen` before filing this.

## What
This tool set's now-established convention (041, 109, `tk-boundary-cwd-is-intentional`, node.mjs main()'s own comment) is narrow on purpose: `--horde` changes tree resolution to trunk only when the caller TYPED it (`flags.horde`), never when a command merely resolved a default horde internally (`resolveHorde(flags)`, which defaults to the sole horde in a single-horde repository with nothing typed at all). The call sites named above were not built to that narrowing — each reaches `resolveTree({ ..., horde })` with an already-resolved `horde`, not the raw flag. NOT independently confirmed as bugs the way 109 and 112 were (each would need the same read-the-source pass 109 and 112 got); flagged here as a pattern worth a full, deliberate audit rather than left unnoticed.

## Why
`writeLawDiff` (law.mjs) was checked and excluded from this list on purpose: it is correct as designed — a law diff is inherently a comparison against trunk, always, not an "ordinary read" a `--horde` flag could redirect. The sites above have not been given that same scrutiny; some may turn out equally intentional, some may be genuine instances of 037's reverted reading (`--horde` unneeded, inferred from a single resolvable horde) living on unnoticed in shipped commands. Either way this is evidence for whoever rules ask a-002, and no worker should narrow or bless any of these on their own reading of it.

## Acceptance
Once ask a-002 is ruled: audit each site named above (and re-run the grep — this list was not asserted complete, only what one pass turned up) against the ruling, the way 041/109 did for tick.mjs/land.mjs and 040 did for tk.mjs's boundary check. Fix what the ruling says needs it; for each one that is already correct as designed (matching `writeLawDiff`'s own shape), record why in code/docs rather than leaving it silently unaudited. Do not rule on a-002 to close this issue — it is downstream of that ruling, not a substitute for it.

## Evidence

- **ran:** `grep -n "resolveTree({[^}]*horde" skills/horde/scripts/*.mjs` (from the state land.mjs's own two call sites were fixed, issue 109) · **saw:** matches in `_lib.mjs` (display-only, excluded), `brief.mjs` (four matches: one already `flags.horde` raw at line 400, three — `cmdArchitect`, `cmdLegislate`, `cmdRetro` — using the resolved `horde` parameter), `horde.mjs` (filed separately as 112), `law.mjs` (excluded — correct as designed), `queue.mjs` (`buildPlan`'s own internal fallback, reachable live only through `wave.mjs`'s `planAtStart`, since its other two known callers always pass an explicit `tree`), `retro.mjs` (one match, resolved `horde` parameter, same shape as brief.mjs's three)

