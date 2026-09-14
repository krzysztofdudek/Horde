# 041 · tick rozwiazuje drzewo bez hordy

**Status:** in-progress
**Kind:** research
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tick.mjs
**Found by:** reader A, reading tick.mjs (plausible, unconfirmed)
**Where:** skills/horde/scripts/tick.mjs:433 `resolveTree({ tree: flags.tree }, { cwd: process.cwd() })`

## What
tick bez --tree pracuje na cwd niezależnie od --horde. Żaden dokument nie mówi, jaki jest domyślny tree ticka.

## Why
Reconcile, dispatch i bramka na niewłaściwym drzewie, jeśli sesja stoi gdzie indziej.

## Acceptance
Ustalić i zapisać domyślne drzewo ticka w USAGE i README; jeśli ma być trunk, poprawić i dodać test.

## Evidence

