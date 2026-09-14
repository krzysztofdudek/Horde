# 024 · pola klasa i wykonawca obietnicy

**Status:** done
**Kind:** gap
**Priority:** 2
**Tier:** strong
**Tags:** kontrakt, pakiet
**Files:** 
**Found by:** jarl, reading every file of Horde
**Where:** packages/promises/doc-shape/check.mjs, yg-package.yaml config

## What
Frontmatter obietnicy dostaje opcjonalne pola `class` i `executor` z zamkniętych list; nieznana wartość jest odmową.

## Why
Klasa dowodu (scenariusz e2e, test hermetyczny, mutacja, stub nagrany, artefakt, świadectwo klienta) i wykonawca (gate, guard, worker, client) mówią, kto i jak ten dowód odtwarza. Dziś obietnica ma tylko status i sposób parowania.

## Acceptance
Listy ustalone z klientem przed implementacją; drills na nieznaną wartość; zamknięcie fali raportuje wiersze per klasa.

Dowód, którego oczekuję: packages/promises/doc-shape/drills/*.

Uwagi: Listy do potwierdzenia z klientem.

## Evidence

- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/docs.test.mjs skills/horde/scripts/tests/promises-package.test.mjs · **saw:** 105/105 pass, 0 fail, on the rebased branch tip

