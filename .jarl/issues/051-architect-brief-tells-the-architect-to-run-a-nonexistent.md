# 051 · architect brief tells the architect to run a nonexistent

**Status:** open
**Kind:** docs
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/reference/roles/architect.md
**Found by:** workflow finder roles-vs-scripts, confirmed by two refuters
**Where:** skills/horde/reference/roles/architect.md:66

## What
architect brief tells the architect to run a nonexistent escalate.mjs add command

The architect brief says: "A port two consultants dispute goes to the director with your opinion attached (`escalate.mjs add … --by architect`)." This is the literal, rendered instruction the architect agent is told to run.

## Why
An architect following the brief literally would run a command that fails outright (`escalate.mjs` refuses any command other than `recurring`), with no working path to actually escalate a disputed port to the director as the brief promises.

## Acceptance
escalate.mjs's entire command surface is a single subcommand, `recurring` (`usage: escalate.mjs recurring [--min <n>] [--horde h]`) — there is no `add` subcommand. `ask.mjs` does have an `add` subcommand (`add "<why>" --kind <stop|stuck|lower|charter> [--ticket NNN] [--territory t] [--aspect a] [--horde h]`), but it takes no `--by` flag at all, and none of its four kinds represents a disputed port needing escalation to the director.

Dowód, którego oczekuję: Run `node skills/horde/scripts/escalate.mjs add "port dispute" --by architect` — it exits with `unknown command: add`.

Refuterzy: Confirmed exactly as stated. /home/user/Horde/skills/horde/reference/roles/architect.md:66 reads: \"A port two consultants dispute goes to the director with your opinion attached (`escalate.mjs add …  | Confirmed. /home/user/Horde/skills/horde/reference/roles/architect.md:66 literally says '(`escalate.mjs add … --by architect`)'. But /home/user/Horde/skills/horde/scripts/escalate.mjs's USAGE and code

## Evidence

