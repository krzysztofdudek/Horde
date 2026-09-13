# 073 · 036 sprzatanie po recenzji drobiazgi

**Status:** open
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tick.mjs, skills/horde/scripts/_lib.mjs, skills/horde/scripts/horde.mjs, skills/horde/scripts/audit.mjs, skills/horde/scripts/status.mjs, skills/horde/scripts/README.md
**Found by:** reviewer 036
**Where:** znaleziska recenzenta issue 036 (Minor, wszystkie akceptowalne bez cofania 036)

## What
Pięć drobiazgów po usunięciu kosztu (036): martwe importy `readJSON`/`writeJSON`/`readText` w tick.mjs (po usunięciu bookCost/waveNumber); `_lib.mjs:966` nadal cytuje nieistniejący placeholder `{{ of limit}}` jako przykład; postrzępione zawijanie linii w kilku edytowanych komentarzach (horde.mjs cmdDone, audit.mjs:50, status.mjs USAGE, trzy miejsca w scripts/README.md); odpowiedź FAQ w README nazywa `config.parallelism` wprost, co idzie wbrew zasadzie "nie pokazuj wewnętrznych nazw czytelnikowi"; dokumenty `horde-plan/1` i `horde-retro/1` zmieniły kształt (cost → weight, cost usunięty) bez podbicia id schematu.

## Why
Nic z tego nie psuje zachowania ani nie blokowało 036, ale zostawione, gromadzi się jako szum: martwy kod, przykład wskazujący na nieistniejącą rzecz, wewnętrzna nazwa w odpowiedzi dla czytelnika.

## Acceptance
Martwe importy usunięte z tick.mjs. `_lib.mjs:966` przykład zaktualizowany albo usunięty. Zawijanie linii poprawione w wymienionych miejscach. FAQ przeformułowane bez nazwy klucza konfiguracji. Rozważyć, czy horde-plan/1 i horde-retro/1 potrzebują nowego id schematu (decyzja może być "nie", jeśli nic poza tym repo tych dokumentów nie czyta).

## Evidence

