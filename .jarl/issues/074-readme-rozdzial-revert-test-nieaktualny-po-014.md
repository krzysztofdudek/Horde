# 074 · readme rozdzial revert test nieaktualny po 014

**Status:** done
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/README.md
**Found by:** worker 014
**Where:** skills/horde/scripts/README.md, sekcja "land.mjs's revert test" (worker 014, Found)

## What
README.md opisuje punkt rewersji w land.mjs jako sprawdzający tylko NOWY plik testowy po nazwie. Po 014 punkt sprawdza też zmieniony istniejący plik testowy, i przyjmuje deklarację `**No new tests:** <powód>` jako świadome zwolnienie.

## Why
Dokumentacja i kod znów mówią różne rzeczy — dokładnie ten sam rodzaj rozjazdu, który cała ta gałąź ma usunąć.

## Acceptance
README.md opisuje aktualne zachowanie: nowy LUB zmieniony plik testowy wymagany, chyba że bilet niesie `**No new tests:** <powód>`.

## Evidence

- **ran:** grep -n 'new OR changed\|No new tests' skills/horde/scripts/README.md · **saw:** the revert-test section now says 'new OR changed test file' throughout, matching checkRevertTest's (e.status === 'A' || e.status === 'M') logic, and documents the 'No new tests: <reason>' escape hatch that was previously undocumented

