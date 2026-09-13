# 080 · land mjs moglby scalac paczke biletow pod jednym przebiegiem bramki

**Status:** open
**Kind:** research
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/land.mjs
**Found by:** jarl, po ocenie Opus, przeglad przenosnosci miedzy skillami
**Where:** skills/horde/scripts/land.mjs (blokada bramki, kolejność pozycji per bilet)

## What
Ruling jarla po ocenie Opus, przegląd przenośności między skillami: dziś każdy bilet ląduje z własnym świeżym przebiegiem bramki pod blokadą bramki, serializowane jeden po drugim. Ta pętla sama udowodniła dziś wzorzec wsadowy (merger łączy nienachodzące na siebie gałęzie i uruchamia suite raz na paczkę) — scalanie nienachodzących na siebie biletów pod jednym przebiegiem bramki skróciłoby czas bramki proporcjonalnie.

## Why
Przy wielu biletach czekających na lądowanie, powtarzanie całej bramki dla każdego z osobna jest kosztem, który wsad usuwa.

## Acceptance
To jest research: potrzebna notatka projektowa zanim powstanie kod — land.mjs's straże i kolejność pozycji per bilet to większa zmiana, nie prosta poprawka. Worker jeszcze nie podnoszony.

## Evidence
Otwarte — wymaga notatki projektowej przed kodem.

