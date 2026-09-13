# 053 · worker brief s issuedir omits the hordes horde path

**Status:** open
**Kind:** docs
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/reference/roles/worker.md
**Found by:** workflow finder roles-vs-scripts, confirmed by two refuters
**Where:** skills/horde/reference/roles/worker.md:68

## What
worker brief's issueDir omits the hordes/<horde>/ path segment it needs under .horde/

The brief states: "Under `.horde/` you write only `{{issueDir}}/log.md`, and only through `tk.mjs log`." brief.mjs fills `issueDir` with `teams/${t.team}/issues/${t.issueDirName}` (brief.mjs:406) — no `hordes/<horde>/` prefix.

## Why
The rendered sentence "Under `.horde/` you write only `teams/<team>/issues/<dir>/log.md`" names a path that is missing the `hordes/<horde>/` segment and so does not point at the real file — a worker reading the brief literally, or scripting against the stated path, is given a location that doesn't exist.

## Acceptance
Every other path helper in this tool set (`hordePath` in _lib.mjs:382-384) resolves a horde-scoped path as `.horde/hordes/<horde>/…`, so the ticket's log actually lives at `.horde/hordes/<horde>/teams/<team>/issues/<dir>/log.md`.

Dowód, którego oczekuję: Render a worker brief and diff the stated `{{issueDir}}` path against the actual location `tk.mjs log` writes to (readable from `hordePath(horde,'teams',team,'issues',dir,'log.md')`); the two differ by the missing `hordes/<horde>/` prefix.

Refuterzy: Verified both sides: worker.md:68 states the log path as `{{issueDir}}/log.md`; brief.mjs:406 sets issueDir = `teams/${t.team}/issues/${t.issueDirName}` with no `hordes/<horde>/` prefix. The actual wr | Verified both sides. worker.md:68 states the worker writes only `{{issueDir}}/log.md` under `.horde/`. brief.mjs:406 sets `issueDir: \`teams/${t.team}/issues/${t.issueDirName}\`` with no `hordes/<hord

## Evidence

