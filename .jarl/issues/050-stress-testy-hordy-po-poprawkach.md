# 050 · stress testy hordy po poprawkach

**Status:** open
**Kind:** research
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze, proces
**Files:** skills/horde/scripts/tests/
**Found by:** klient, w trakcie fali pierwszej
**Where:** skills/horde/scripts/tests/family.e2e.test.mjs jako wzór fixture misji

## What
Po wylądowaniu poprawek: seria scenariuszy misji na repozytorium fixture, każdy grany przez workera na Sonnecie jako dyrektor i workerzy naraz, z opisem, co Horda zrobiła, a co powinna. Scenariusze startowe: worker pada w połowie biletu (reconcile); dwie sesje na jednej hordzie (kolejka, locki); bilet zmienia regułę i kod naraz (straż konfliktu); obietnica cofnięta na planned i test pominięty (straż niesłabnięcia, 021–023); pytanie bez odpowiedzi przez trzy ticki (028); archiwum misji sprzed 6.0.0 (blame, history); repozytorium bez Yggdrasila; repozytorium bez warstwy dowodów (031); runner external.

## Why
Poprawki dotykają pętli w wielu miejscach naraz; tylko pełne przebiegi pokażą, czy to gra razem.

## Acceptance
Każdy scenariusz kończy się wpisem: przebieg, co odbiegło od dokumentacji, nowe sprawy założone przez jarla. Scenariusze, które da się utrwalić, wchodzą do family.e2e jako testy. Uruchamiane dopiero, gdy sprawy P1 i P2 z kontraktu i zaplecza są done.

## Evidence

