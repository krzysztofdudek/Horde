# 015 · has evidence named dopasowanie

**Status:** open
**Kind:** bug
**Priority:** 2
**Model:** sonnet
**Tags:** kontrakt, pakiet
**Files:** packages/promises/has-evidence/check.mjs, evidence-matches-promise/companion.mjs
**Found by:** jarl, reading every file of Horde
**Where:** packages/promises/has-evidence/check.mjs checkNamed (`file.content.includes(name)`)

## What
Parowanie `plik#nazwa` sprawdza zwykłe wystąpienie napisu w pliku.

## Why
Dla testów e2e nazwa ma być tytułem przypadku, bo ten sam tytuł niesie raport runnera. Podłańcuch w komentarzu też dziś „pilnuje” obietnicy.

## Acceptance
Nazwa dopasowana jako tytuł przypadku w pozycji test(, it(, Scenario:, def test_, func Test (lista zamknięta per język, konfigurowalna). Drill violates-named-substring-only. companion namedTarget spójny z check.

Dowód, którego oczekuję: packages/promises/has-evidence/drills/*; yg aspects drill zielony.

## Evidence

