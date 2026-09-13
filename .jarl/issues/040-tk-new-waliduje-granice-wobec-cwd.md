# 040 · tk new waliduje granice wobec cwd

**Status:** open
**Kind:** research
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tk.mjs
**Found by:** reader A, reading tk.mjs (plausible, unconfirmed)
**Where:** skills/horde/scripts/tk.mjs:399 checkFilesInBoundary i :446 checkConsumesHaveProducers: `resolveTree({}).path`

## What
Walidacja Files wobec granicy węzła i Consumes wobec portów czyta drzewo z cwd, nie z trunku hordy. Nie wiadomo, czy to zamierzone (tk new uruchamiane z własnego drzewa operatora).

## Why
Bilet zwalidowany wobec cudzego checkoutu.

## Acceptance
Ustalić w README, wobec którego drzewa tk new waliduje; jeśli trunk, poprawić jak w issue 037 i dodać test; jeśli cwd, zapisać to w USAGE i README. Wynik: decyzja w decisions.md i ewentualne nowe issue.

## Evidence

