# 071 · worker worktree branch nie nazywa sie jarl NNN slug

**Status:** dropped
**Kind:** process
**Priority:** 3
**Tier:** standard
**Tags:** proces
**Files:** 
**Found by:** reeve, worker 053
**Where:** worker 053, worktree /home/user/Horde/.claude/worktrees/agent-a53bd9f7625d77cc3

## What
Worker 053 zameldował, że jego commit trafił na gałąź `worktree-agent-a53bd9f7625d77cc3`, mimo że brief każe `git checkout -b jarl/NNN-slug` jako pierwszą akcję. `jarl.mjs branches` (bez `--branch`) nie widzi takiej gałęzi wcale — filtruje po wzorcu `jarl/NNN-*`. Inni workerzy (042, 044, 051, 052) w tej samej fali poprawnie skończyli na `jarl/NNN-slug`.

## Why
Gdyby jarl (lub reeve) polegał wyłącznie na `jarl.mjs branches` bez ręcznej weryfikacji, commit gotowy do scalenia zostałby przeoczony — narzędzie milczy o pracy, która faktycznie istnieje.

## Acceptance
Zbadać, czy brief powinien kazać workerowi zweryfikować `git branch --show-current` po `checkout -b` i poprawić, jeśli się nie zgadza, albo czy `jarl.mjs branches`/`check` powinno też przyjmować dowolną nazwę gałęzi z commitami ponad bazę (nie tylko wzorzec `jarl/NNN-*`), żeby nic nie ginęło po cichu. Decyzja należy do jarla.

## Evidence
Dropped: naprawione w narzędziu Jarla, nie w Hordzie

