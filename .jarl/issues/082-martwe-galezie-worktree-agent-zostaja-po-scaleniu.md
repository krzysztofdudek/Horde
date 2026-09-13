# 082 · martwe galezie worktree agent zostaja po scaleniu

**Status:** dropped
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** proces
**Files:** 
**Found by:** reeve, przegladajac git branch --list po serii scaleń
**Where:** `git branch --list 'worktree-agent-*'` w /home/user/Horde po kilku falach scalania

## What
Po wielu falach mergerów `git branch --list` pokazuje kilkanaście gałęzi `worktree-agent-*` bez odpowiadającego worktree — pozostałości po scaleniu, gdzie merger usunął worktree, ale nie zawsze `git branch -D` oryginalną (czasem zmienioną nazwą, czasem nie) gałąź.

## Why
Nieszkodliwe dla działania pętli (jarl.mjs branches filtruje po wzorcu jarl/NNN-*, nie widzi ich), ale захламляет repozytorium i utrudnia ręczny przegląd `git branch --list`.

## Acceptance
To jest notatka dla JarlSkill (merger brief), nie zmiana kodu Hordy: krok 5 briefu mergera powinien zawsze kasować zarówno finalną, jak i (jeśli różna) oryginalną nazwę gałęzi po scaleniu. Nie do podjęcia przez workera Hordy.

## Evidence
Dropped: Out of scope for Horde: issue text itself says this is a note for JarlSkill's merger brief (always delete both branch names after merge), not a Horde code change; no worker to raise here.

