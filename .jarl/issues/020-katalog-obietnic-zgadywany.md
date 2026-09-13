# 020 · katalog obietnic zgadywany

**Status:** done
**Kind:** cleanup
**Priority:** 2
**Tier:** standard
**Tags:** kontrakt
**Files:** skills/horde/scripts/horde.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/horde.mjs:184 PROMISE_DIRS

## What
init szuka katalogu obietnic po zamkniętej liście ścieżek (promises, docs/promises, .promises, doc/promises), a pakiet promises mapuje obietnice przez graf.

## Why
Repozytorium, które trzyma obietnice gdzie indziej, jest czytane jako „suite” i traci parowanie.

## Acceptance
Gdy pakiet promises jest zainstalowany, init czyta zasięg reguły doc-shape z grafu (yg aspects --reach) i stamtąd bierze katalog; lista ścieżek zostaje jako fallback bez pakietu. Test.

Dowód, którego oczekuję: skills/horde/scripts/tests/horde.test.mjs.

## Evidence

- **ran:** git log --oneline 8d2fa42 -1 · **saw:** merge commit 8d2fa42 present on branch tip; reviewer already approved 19:46 — bookkeeping only, same interrupted-merger catch-up

