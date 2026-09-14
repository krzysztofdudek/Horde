# 041 · tick rozwiazuje drzewo bez hordy

**Status:** done
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

- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/tick.test.mjs skills/horde/scripts/tests/tree.test.mjs skills/horde/scripts/tests/lib.test.mjs · **saw:** 153/153 pass on rebased branch tip and again on merged main; independently re-read the resolveTree wiring to confirm it uses flags.horde (the raw, explicitly-typed flag), never the function's own already-defaulted horde parameter

