# 075 · worker brief hordy powinien kazac uruchamiac tylko dotkniete testy

**Status:** done
**Kind:** gap
**Priority:** 1
**Tier:** standard
**Tags:** proces
**Files:** 
**Found by:** jarl, po ocenie Opus, przegląd przenośności między skillami
**Where:** skills/horde/reference/roles/worker.md; wzór: skills/jarl/SKILL.md (brief workera Jarla)

## What
Ruling jarla po ocenie Opus, przegląd przenośności między skillami — nie z czytania błędów Hordy: brief workera Hordy (reference/roles/worker.md) powinien kazać workerowi uruchamiać testy w foreground z ustawionym timeoutem narzędzia powłoki, dotykając tylko plików testowych, na które wpływa jego własna zmiana — nie całej bramki. Dziennik tej pętli (mergerzy wielokrotnie widzieli workerów stających na pełnej suicie pod obciążeniem) pokazuje, że Horda też tego potrzebuje.

## Why
Bez tego workerzy Hordy powtarzają dokładnie ten sam wzorzec zawieszania się na pełnym `npm test`, który ta pętla musiała naprawiać u siebie w trakcie pracy.

## Acceptance
reference/roles/worker.md każe workerowi uruchomić tylko test(y) dotknięte jego zmianą, w foreground, z timeoutem narzędzia powłoki ustawionym jawnie — nie całą bramkę/suite. Pełna suita zostaje zadaniem lądowania/mergera, tak jak w Jarlu.

## Evidence
Merge commit de33d4c: worker brief scopes test runs to touched files, foreground, explicit timeout; merged

