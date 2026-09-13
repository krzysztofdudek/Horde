# 062 · fresh worker class up is documented but never implemented

**Status:** open
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tk.mjs
**Found by:** workflow finder tests-vs-docs, confirmed by two refuters
**Where:** skills/horde/scripts/tests/tick.test.mjs (test file path corrected; core claim at tk.mjs:99/207-208/229 and tick.mjs:366 confirmed as stated)

## What
"fresh worker, class up" is documented but never implemented or tested — the class never actually increases

tk.mjs USAGE text says a ticket past `config.fixRounds.resume` gets "a fresh worker, one class heavier" (same wording repeated at tk.mjs:207 as a comment, and reflected in the `changesRoundInfo` label 'fresh worker, class up' at tk.mjs:229). SKILL.md:167 tells the director a worker is 'replaced one class up past config.fixRounds'. But `tick.mjs`'s `dispatch()` (tick.mjs:339-369) computes the dispatched `model` as `parseField(ticket.text, 'Class') || started.class`, i.e. straight from the ticket's static Class field, and `queue.mjs`'s `startRunning` (queue.mjs:215) sets `class: parseField(ticket.text, 'Class') || firstClass(readConfig())` — neither ever increments or otherwise changes the class based on `prior`/`info.label`. There is no function anywhere in scripts/*.mjs (grepped for classUp/bumpClass/classLadder/'class up') that raises a ticket's class on a fresh round.

## Why
This is exactly the landing/ladder area the task prioritises: the fix-round ladder is a named mechanism repeated in both the CLI's own usage text and SKILL.md's operating instructions to the director, yet the code path that would perform the escalation does not exist, so the documented behaviour is either wrong (code truth: class never changes) or a real gap (silently missing feature) — and no test would catch a regression or confirm intended behaviour either way.

## Acceptance
Given the docs, a test should dispatch a ticket through `resume` rounds of 'changes' into the 'fresh' band and assert the dispatch list's `model`/class for that ticket is one rung heavier than its ticket-declared Class. tick.test.mjs's only red-gate-with-rounds-left test (tick.test.mjs:597) stays within round 1 (never reaches the fresh band) and doesn't assert on `model` at all — the closest test, `tick.mjs dispatch: ... in what order` (tick.test.mjs:188), asserts model only from the ticket's own Class field for a fresh dispatch, never after a round bump.

Dowód, którego oczekuję: Add a test that drives a ticket to round `resume+1` (fixRounds.resume=3 default) via repeated queue.mjs set running / land failures as tick.test.mjs:597 does but past the resume cap, then assert the dispatch entry's `model` differs from (is heavier than) the ticket's declared Class — this assertion currently has nothing to pass or fail against, since inspecting tick.mjs's dispatch() shows `model` is always the ticket's static Class.

Refuterzy: Verified directly: tk.mjs:99 (and comment at 207-208, label at tk.mjs:229 "fresh worker, class up") documents that past config.fixRounds.resume a ticket gets a fresh worker "one class heavier." SKILL. | Verified directly against both sides of the claim. tick.mjs's dispatch() (line 366) sets `model` purely from `parseField(ticket.text, 'Class') || started.class`, and queue.mjs's startRunning (line 215

## Evidence

