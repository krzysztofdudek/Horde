# 007 · retro dopasowanie jednostki przez includes

**Status:** done
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** uczenie
**Files:** skills/horde/scripts/retro.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/retro.mjs ticketDeclares

## What
ticketDeclares uzna werdykt za należący do biletu, gdy issue.md zawiera ścieżkę jednostki jako dowolny podłańcuch.

## Why
`src/a` pasuje do biletu, który deklaruje `src/ab`. Pomiar sędziów liczy pary z cudzych biletów.

## Acceptance
Dopasowanie po polach Files i Node biletu (ticketFiles/ticketNodes) i granicy węzła, nie po podłańcuchu. Test z fałszywym dopasowaniem przechodzi na czerwono przed zmianą i na zielono po.

Dowód, którego oczekuję: skills/horde/scripts/tests/retro.test.mjs.

## Evidence

Merged 13d258e into claude/autonomous-self-evolving-system-oiveiz. Sub-batch A check (057+007+045+058): node --test tests/*.test.mjs from skills/horde/scripts, HORDE_TEST_RATATOSKR_DIR set — 923 tests, 920 pass, 0 fail, 3 skipped (root-bypass chmod, pre-existing/expected), 0 cancelled, exit 0.

