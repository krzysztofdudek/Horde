# 078 · brief mjs powinien pisac brief do pliku zamiast tylko stdout

**Status:** in-progress
**Kind:** gap
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze, proces
**Files:** skills/horde/scripts/brief.mjs, skills/horde/scripts/refine.mjs
**Found by:** jarl, po ocenie Opus, przeglad przenosnosci miedzy skillami
**Where:** skills/horde/scripts/brief.mjs (renderRole, emit); wzor: reeve tej petli pisze kazdy brief do pliku pod scratchpad i wysyla jedna linie ze sciezka zamiast tresci

## What
Ruling jarla po ocenie Opus, przeglad przenosnosci miedzy skillami — nie z czytania bledow Hordy: brief.mjs drukuje rozgałęziony brief tylko na stdout; kazde wywolanie kosztuje dyrektora Hordy caly brief w kontekscie, a kazdy raport workera wraca w calosci. Dodac flage `--out <path>` do brief.mjs (i refine.mjs --step consult), ktora zapisuje brief do pliku i drukuje tylko jego sciezke; SKILL.md i model.md dostaja zdanie, ze dyrektor moze spawnowac z zapamietanej sciezki zamiast wklejac tresc.

## Why
reference/model.md nazywa kontekst dyrektora najbardziej deficytowym zasobem; ta petla dzis udowodnila ten wzorzec pod realnym ograniczeniem platformy (agent bez narzedzia spawn pisal briefy do plikow i wysylal jedna linie).

## Acceptance
`brief.mjs <role> ... --out <path>` zapisuje rendered brief do pliku i drukuje tylko sciezke (plus krotkie podsumowanie w --json); bez --out zachowanie bez zmian (stdout, jak dzis). Test: brief.mjs z --out tworzy plik o tresci identycznej z tym, co wypisałoby bez flagi.

Dowod, ktorego oczekuje: nowy test w tests/brief.test.mjs.

## Evidence

