# 035 · wip znika przed merge

**Status:** done
**Kind:** process
**Priority:** 3
**Tier:** standard
**Tags:** proces
**Files:** wip/
**Found by:** jarl, reading every file of Horde
**Where:** wip/

## What
Przed scaleniem gałęzi do main: issues done zamknięte wpisami w CHANGELOG, open zgłoszone klientowi, katalog wip/ usunięty ostatnim commitem.

## Why
Decyzja klienta: wip nie trafia do main ani do wydania.

## Acceptance
main nie zawiera wip/.

Dowód, którego oczekuję: git ls-tree main wip/ pusty.

## Evidence

- **ran:** grep -rIln jarl skills/horde/ (shipped skill has zero .jarl awareness); read .jarl/decisions.md · **saw:** the resolution is already the mechanism jarl.mjs close implements: .jarl/ lives only on the mission branch and is removed as the last commit before merge to main, refusing while anything is open — a one-time end-of-mission step, not a per-ticket code change; git ls-tree origin/main confirms no wip/ or .jarl/ there today

