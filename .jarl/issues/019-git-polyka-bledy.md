# 019 · git polyka bledy

**Status:** done
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/_lib.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/_lib.mjs git(); przegląd wywołań w status.mjs, cost.mjs, blame.mjs, land.mjs

## What
git() zwraca null przy każdym błędzie. Część miejsc wywołań traktuje null jak „brak” zamiast jak błąd i idzie dalej.

## Why
Błąd gita czytany jako „nic nie ma” daje fałszywe zero zamiast odmowy.

## Acceptance
Przegląd każdego wywołania: tam, gdzie null oznacza odmowę, odmowa niesie tekst błędu gita. Jeden test reprezentatywny.

Dowód, którego oczekuję: skills/horde/scripts/tests/lib.test.mjs.

## Evidence

- **ran:** node --test tests/lib.test.mjs tests/land.test.mjs tests/blame.test.mjs (rebased tip); then full suite tests/*.test.mjs after merge · **saw:** 98/98 pass on the three touched files; full suite 1032 pass/0 fail/4 skip (known env-conditional: root-bypass chmod x3, missing RatatoskrSkill checkout)
- **ran:** node --test tests/lib.test.mjs tests/land.test.mjs tests/blame.test.mjs (rebased tip); then full suite tests/*.test.mjs after merge · **saw:** 98/98 pass on the three touched files; full suite 1032 pass/0 fail/4 skip (known env-conditional: root-bypass chmod x3, missing RatatoskrSkill checkout)

