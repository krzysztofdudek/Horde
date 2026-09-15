# 084 · resztki po 009 fail w bibliotece

**Status:** done
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
- **ran:** grep -n process.exit( skills/horde/scripts/drill.mjs; grep -an process.exit( skills/horde/scripts/land.mjs (before any fix, against the pre-084 tip) · **saw:** drill.mjs: line 634 inside cmdRun() (a helper, outside main()) -- fixed, now returns ok, main()'s 'run' case exits; line 748 (--help) and line 757 (the 'check' case) both already inside main() -- left alone. land.mjs: line 229 inside makeCleaner()'s SIGINT/SIGTERM handler -- left alone (signal callback, not main()'s call chain, already backed by its own documented three-hook cleanup design); line 2996 inside finishMany() -- fixed, now returns summary, main() exits on summary.ok; line 3352 inside finish() -- fixed, now returns full, main() exits on result.ok; line 3391 (--help) already inside main() -- left alone. No follow-up ticket filed: every call site outside main() got a plain, low-risk fix; none needed a larger restructuring.
- **ran:** read recordRefusal() in skills/horde/scripts/tick.mjs (around line 686) before writing anything about its --json shape · **saw:** confirmed exact shape: JSON.stringify({horde, refused, at}, null, 2) -- horde is the horde name, refused is e.message in full (not truncated), at is nowIso() at record time (a separate call from the journal line's own timestamp, so the two can differ by a few ms). The journal line (plan.md) truncates to message.split('\n')[0] (first line only); stderr's 'error: <message>' does not truncate. Documented this in README.md's --watch paragraph, matching its existing depth.
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 1200 node --test tests/tick.test.mjs tests/drill.test.mjs tests/land.test.mjs tests/law-guard.test.mjs tests/lib.test.mjs tests/refine.test.mjs tests/retro.test.mjs tests/tree.test.mjs · **saw:** 509 tests, 509 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo (286 top-level test() blocks, 509 counting nested subtests). Both existing tick.mjs --watch tests pass unmodified: 'a signal ends the loop without leaving the gate lock held' and 'a refusal in one pass is written down, not the end of the loop' -- the latter's malformed-queue.json scenario already threw a HordeError (via tick.mjs's own readQueue() wrapper calling fail()) before this fix, so narrowing watch()'s catch to HordeError did not change its outcome; no test was found pinned to the swallow-everything bug this ticket fixes.
- **ran:** HORDE_TEST_YG=... node --test tests/tick.test.mjs tests/drill.test.mjs tests/land.test.mjs tests/law-guard.test.mjs tests/lib.test.mjs tests/refine.test.mjs tests/retro.test.mjs tests/tree.test.mjs, merger's own run on the merged tip · **saw:** 509 tests, 509 pass, 0 fail, 0 skip

