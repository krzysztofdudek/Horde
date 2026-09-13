# 047 · land liczy wpis cache bramki i nigdy go nie zapisuje

**Status:** open
**Kind:** bug
**Priority:** 2
**Model:** sonnet
**Tags:** zaplecze
**Files:** skills/horde/scripts/land.mjs
**Found by:** reader B, reading land.mjs, horde.mjs and wave.mjs
**Where:** skills/horde/scripts/land.mjs:532–565 checkGate buduje cache {sha, result, count} w kształcie wpisu hordes/<h>/cache/last-gate.json; run()/finish() nigdy go nie zapisują. Piszą tylko horde.mjs:1038 (done) i wave.mjs:780 (close z --gate --sha). Komentarz land.mjs:521–522 zakłada, że done czyta cache z lądowania.

## What
Lądowanie na poziomie trunk mierzy bramkę na czubku i wylicza wpis cache, ale go nie zapisuje. done uruchamia bramkę od nowa na tym samym sha, a wave close bez --gate --sha raportuje gate: unrecorded tuż po zielonym lądowaniu.

## Why
Mechanizm cache istnieje dokładnie po to, żeby nie powtarzać bramki na sha, które land właśnie zmierzył; dziś nie działa.

## Acceptance
land zapisuje wpis last-gate.json dla swojego poziomu po każdym pomiarze bramki (pod lockiem bramki). Test: zielone lądowanie --level trunk, potem horde.mjs done bez innych komend; done akceptuje cache zamiast uruchamiać bramkę; wave close bez flag widzi gate zapisane.

## Evidence

