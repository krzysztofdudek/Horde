# 077 · brief test mutuje prawdziwy plik roli, powodując losowe czerwone CI

**Status:** in-progress
**Kind:** bug
**Priority:** 1
**Tier:** standard
**Tags:** zaplecze, test
**Files:** skills/horde/scripts/tests/brief.test.mjs
**Found by:** jarl, diagnosing a red GitHub Actions run
**Where:** skills/horde/scripts/tests/brief.test.mjs:387 i :409, w obu miejscach `rolePath = join(SCRIPTS_DIR, '..', 'reference', 'roles', 'legislate.md')`, `rmSync(rolePath)` / `writeFileSync(rolePath, ...)`, przywracane dopiero w `t.after`

## What
Dwa testy w brief.test.mjs kasują i nadpisują prawdziwy plik `reference/roles/legislate.md` (nie kopię w tmpdir) i przywracają go dopiero po teście. Node test runner uruchamia pliki testowe równolegle, więc `docs.test.mjs` (test „reference/roles/ has exactly the role files named in brief.mjs's own ROLES") może w tym oknie zobaczyć katalog bez tego pliku i dostać czerwony wynik na commicie, który jest w pełni poprawny. Potwierdzone na uruchomieniu CI Hordy (node 24), run 34774275559: `docs.test.mjs:209` failed z `actual: [architect, retro, worker]`, choć plik jest w drzewie commita.

## Why
Czerwone CI bez przyczyny w kodzie podważa zaufanie do bramki i marnuje rundy mergera/recenzenta na powtórki.

## Acceptance
Oba testy operują na kopii pliku w katalogu tymczasowym (albo na atrapie, którą `brief.mjs` czyta przez wstrzykniętą ścieżkę), nigdy na `skills/horde/reference/roles/legislate.md` na dysku repo. `npm test` uruchomiony wielokrotnie równolegle z innym plikiem czytającym ten katalog nie pada. Test na to: uruchomić `node --test tests/brief.test.mjs tests/docs.test.mjs` kilkukrotnie i nie zobaczyć failure.

Dowód, którego oczekuję: kilka przebiegów `node --test tests/brief.test.mjs tests/docs.test.mjs` zielonych z rzędu; opis w CHANGELOG pod [6.0.0].

## Evidence

