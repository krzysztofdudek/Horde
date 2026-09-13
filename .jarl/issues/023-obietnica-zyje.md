# 023 · obietnica zyje

**Status:** in-progress
**Kind:** gap
**Priority:** 2
**Tier:** strong
**Tags:** kontrakt, pakiet
**Files:** packages/promises/evidence-is-live/yg-aspect.yaml, packages/promises/evidence-is-live/check.mjs, packages/promises/evidence-is-live/drills
**Found by:** jarl, reading every file of Horde
**Where:** packages/promises/evidence-is-live/{yg-aspect.yaml, check.mjs, drills/}

## What
Reguła deterministyczna: sparowany przypadek żywej obietnicy nie nosi znacznika pominięcia ani wyłączności (test.skip, test.fixme, test.only, xit, xdescribe, @pytest.mark.skip, pytest.skip(, t.Skip(, [Ignore], Skip =).

## Why
Reguła jednego drzewa, którą Yggdrasil sprawdza za darmo; uzupełnia raport z issue 021 tam, gdzie raportu nie ma.

## Acceptance
Lista znaczników zamknięta i konfigurowalna, drills satisfies/violates per język, zero fałszywych alarmów na drillach, wpis w yg-package.yaml.

Dowód, którego oczekuję: yg aspects drill evidence-is-live zielony.

## Evidence

