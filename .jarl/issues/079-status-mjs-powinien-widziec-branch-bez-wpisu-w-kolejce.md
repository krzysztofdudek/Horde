# 079 · status mjs powinien widziec branch bez wpisu w kolejce

**Status:** done
**Kind:** gap
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/status.mjs
**Found by:** jarl, po ocenie Opus, przeglad przenosnosci miedzy skillami
**Where:** skills/horde/scripts/status.mjs (lista gałęzi biletów z queue items niosących it.branch)

## What
Ruling jarla po ocenie Opus, przegląd przenośności między skillami: status.mjs buduje listę gałęzi biletów wyłącznie z wpisów w queue.json (`it.branch`). Gałąź, której wpis w kolejce zginął, jest niewidoczna — wbrew własnej zasadzie modelu Hordy, że żywotność ocenia się po gałęziach, nie po ciszy w kolejce.

## Why
Zgubiony wpis w kolejce chowa realnie istniejącą pracę zamiast ją pokazać jako sierotę wymagającą uwagi.

## Acceptance
status.mjs dodatkowo listuje gałęzie pod wzorcem `<horde>/t-*`, dla których queue.json nie ma wpisu, oznaczone jako osierocone (orphaned).

## Evidence
suite: 887 pass / 21 fail (chmod-permission tests + pre-existing law-guard/014 fixture issue, unrelated to this branch); merge sha cdbd5fe

