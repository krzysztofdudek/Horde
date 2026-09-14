# 100 · patchIdOf appears to have no production call site — keyContext may configure dead code

**Status:** open
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/_lib.mjs
**Found by:** worker 096, tracing keyContext's provenance
**Where:** skills/horde/scripts/_lib.mjs, `patchIdOf()`; `horde.mjs` `defaultConfig()`'s `keyContext`

## What
While tracing issue 096 (`keyContext`'s missing provenance row), the worker found that `patchIdOf()`
— the function `keyContext` configures — appears to have no call site anywhere in the production
script set. Only its own definition and its own tests reference it. The commit that introduced it
(`d6f9687`, "Bind a ticket's review keys to its diff, not to the branch tip") also introduced
`verify.mjs`/`premerge.mjs`, both since removed — superseded by `land.mjs`, likely during the later
seat-cassation change that removed the standing verifier/owner roles.

## Why
If `patchIdOf()` genuinely has no live caller, `keyContext` is a config knob that configures
nothing — a maintainer could change it and observe no effect anywhere, which is worse than a
constant with no provenance: it is a constant with no purpose. Worth confirming before deciding
whether to remove the function, remove the config knob, or wire it back into whatever now needs it.

## Acceptance
Confirm with a repo-wide search (not just the scripts directory — check tests, templates, docs)
whether `patchIdOf()` is genuinely unreferenced outside its own definition and tests. If dead:
remove `patchIdOf()` and the `keyContext` config knob together (and its README provenance row from
096), or explain in a comment why it's kept despite no current caller (e.g. a documented future use).
If it turns out to have a live caller this search missed, say so and close as not-a-bug.

## Evidence

