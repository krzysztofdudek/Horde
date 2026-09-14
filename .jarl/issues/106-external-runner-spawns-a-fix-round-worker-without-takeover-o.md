# 106 · external runner spawns a fix-round worker without --takeover or its round-aware name

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/tick.mjs
**Found by:** issue 062 worker
**Where:** skills/horde/scripts/tick.mjs, `externalStart()` (~line 496-518)

## What
`dispatch()` already renders each spawn entry's full `brief` command correctly — including
`--takeover` and the round-aware worker name `workerName(id, prior)` (e.g. `w-004-r3`) — and
`runOnce()` passes that same `spawn.out` array straight into `externalStart()` for `--runner
external`. But `externalStart()` never uses `entry.brief`: it reconstructs its own, separate call
to `brief.mjs worker <ticket> --name w-<ticket> --horde <horde> --tree <worktree>` from scratch,
which carries neither `--takeover` nor the round suffix on `--name` — every worker it spawns is
named plain `w-<ticket>` and briefed as if it were the first attempt, no matter which round it is.

## Why
Under `--runner external` (the one runner with nobody in a live session to read the dispatch list
and issue the calls itself), a ticket that has earned a fresh, one-class-up worker after enough
red rounds (see issue 062) is spawned with the right class but the wrong brief: no takeover
section, so the fresh worker never sees "this ticket is yours, a prior worker attempted it N
times, here is its log" — it gets the same brief a first attempt would. Two different runners are
only supposed to differ in WHO starts a worker, never in what that worker is told.

## Acceptance
`externalStart()` uses the `brief` command `dispatch()` already rendered on each entry (or passes
`takeover`/the round-aware name through to its own `brief.mjs` call) instead of reconstructing a
narrower one. A test drives a ticket into the takeover band (same pattern issue 062's own test in
`tests/tick.test.mjs` uses) under `--runner external` with `config.runner.spawn` set to a fixture
command, and asserts the spawned command line carries `--takeover` and the round-numbered worker
name, not the flat `w-<ticket>`.

## Evidence

Independent security review during merge found the worker's fix (execSync on entry.brief, a hand-joined string) opened a real command-injection surface: horde/worktree names are never validated at creation, and a horde name like 'mission1;>X' is a fully valid git ref — proved empirically (git check-ref-format accepts it, horde.mjs init accepts it) — while remaining a live shell payload with no spaces needed. Fixed by having dispatch() carry a briefParts argv array alongside the display-only brief string, and externalStart() run it via execFileSync(process.execPath, entry.briefParts, ...) — no shell. Added a dedicated test using exactly that payload shape; confirmed it fails against the reverted (execSync) code with the shell visibly splitting the command line on the injected ';', and passes clean after the fix.

