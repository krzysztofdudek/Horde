# 099 · wave.mjs deriveRowState counts a prototype ticket as a claimant, so status.mjs reports its row as queued

**Status:** done
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/wave.mjs
**Found by:** jarl
**Where:** skills/horde/scripts/wave.mjs, deriveRowState

## What
`deriveRowState` counts a `prototype`-kind ticket (issue 026) as an ordinary claimant of the charter
row it names, so `status.mjs` reports that row as `queued` — the same state a real implementation
ticket in flight would show.

## Why
Harmless today (a prototype can never reach `reproduced`, since that needs a verdict it never gets),
but conflates two different things happening to a row: someone building toward the row's acceptance,
versus someone building something to show the client so they can describe what they meant. Worth its
own state so a reader of status.mjs isn't misled into thinking work toward the row is already
under way.

## Acceptance
Either give a prototype-claimed row its own distinct state (e.g. "prototyping") in status.mjs's
vocabulary, or explicitly document why "queued" is the right shared label if that turns out to be
correct on reflection. A test pinning whichever choice is made.


## Evidence

- **ran:** node --test tests/wave.test.mjs tests/status.test.mjs (rebased tip, then merged main) · **saw:** 34/34 pass both times

