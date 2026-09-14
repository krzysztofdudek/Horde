# 084 · resztki po 009 fail w bibliotece

**Status:** open
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tick.mjs, skills/horde/scripts/drill.mjs, skills/horde/scripts/land.mjs, skills/horde/scripts/tests/lib.test.mjs, skills/horde/scripts/tests/refine.test.mjs, skills/horde/scripts/tests/retro.test.mjs, skills/horde/scripts/tests/tree.test.mjs, skills/horde/scripts/README.md
**Found by:** reviewer 009
**Where:** znaleziska recenzenta issue 009 (Minor, wszystkie akceptowalne bez cofania 009)

## What
Cztery drobiazgi po 009: `watch()` w tick.mjs łapie każdy wyjątek jako odmowę (nie tylko HordeError), więc prawdziwy błąd wewnątrz `runOnce` zostałby zapisany jako "tick refused:" i powtarzany w nieskończoność zamiast głośno się wywrócić — zawęzić catch do HordeError, resztę przerzucać dalej. `recordRefusal` pod `--json` emituje kształt `{horde, refused, at}` nieudokumentowany w README/CHANGELOG. Kilka plików testowych (tests/lib.test.mjs, tests/refine.test.mjs, tests/retro.test.mjs, tests/tree.test.mjs) nadal tłumaczy się komentarzem "fail() calls process.exit()", co już nieprawda po 009. `drill.mjs` i `land.mjs` nadal wołają `process.exit(1)` spoza `main()` (helper frames), co pomija otaczające finally — sprzeczne z literą (nie duchem) zasady "process.exit tylko w main()".

## Why
Żadne z tych nie psuje zachowania dziś, ale mylący komentarz i niedokumentowany kształt JSON kosztują czas następnego czytelnika, a process.exit poza main() to dokładnie ta klasa błędu, którą 009 miało zamknąć.

## Acceptance
watch()'s catch zawężony do HordeError. recordRefusal --json udokumentowany. Stare komentarze poprawione. drill.mjs/land.mjs: process.exit(1) przeniesiony do main() albo osobny bilet, jeśli inwariant ma być dosłowny.

## Evidence
Otwarte — porządkowe, niepilne.

