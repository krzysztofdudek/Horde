# 032 · granica srodowiska w skill

**Status:** done
**Kind:** docs
**Priority:** 2
**Tier:** standard
**Tags:** granice
**Files:** SKILL.md, reference/model.md, templates/charter.md
**Found by:** jarl, reading every file of Horde
**Where:** SKILL.md; reference/model.md; templates/charter.md sekcja Evidence

## What
Zdanie w SKILL.md i model.md: środowisko testowe jest dostarczane poza Hordą; Horda pracuje na tym, co zastanie, i nigdy go nie buduje; charter mówi, co zastała; frame mówi, czego brakuje.

## Why
Granica, której dokument nie nazywa, zostanie kiedyś przekroczona przez worker próbujący „naprawić” brak środowiska.

## Acceptance
Zdania są; test docs sprawdza obecność sekcji.

Dowód, którego oczekuję: skills/horde/scripts/tests/docs.test.mjs.

## Evidence

npm test in skills/horde/scripts (batch of 083+032+066): 919 tests, 914 pass, 4 skipped (3 root-only chmod skips, 1 optional RatatoskrSkill-checkout skip), 1 fail (land.test.mjs:978 'a branch tip that moved...', a load-timing flake unrelated to this issue — land.mjs/land.test.mjs untouched by 032's diff, reproduces green in isolation in 12.1s, same class as tracked issue 070). Merged d03e65f.

