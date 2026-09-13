# 026 · bilet prototyp

**Status:** open
**Kind:** gap
**Priority:** 2
**Tier:** strong
**Tags:** front
**Files:** skills/horde/scripts/tk.mjs, skills/horde/scripts/queue.mjs, skills/horde/scripts/land.mjs, skills/horde/scripts/refine.mjs, skills/horde/scripts/wave.mjs, templates/ticket.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/tk.mjs (pole Kind); skills/horde/scripts/land.mjs (odmowa merge do trunku); skills/horde/scripts/refine.mjs frame

## What
Rodzaj biletu `prototype`: coś, co wygląda jak docelowe, żeby klient mógł zobaczyć i powiedzieć. Ląduje tylko na gałęzi prototypu, nigdy na trunku; jego jedynym dowodem jest akceptacja klienta zapisana jako artefakt (sha256, accepted_by, at) na wierszu chartera. Dopiero wtedy wiersz dostaje bilety właściwe. `refine frame` proponuje prototyp dla wiersza, którego klient nie umie opisać.

## Why
Ludzie najlepiej rozumieją przykład, który da się zobaczyć. Zbieranie wymagań przez prototyp jest szybsze niż przez opis.

## Acceptance
Testy: prototyp nie merguje do trunku; akceptacja bez sha256 odmówiona; wiersz z zaakceptowanym prototypem widoczny w frame i w zamknięciu fali osobno.

Dowód, którego oczekuję: skills/horde/scripts/tests/tk.test.mjs, skills/horde/scripts/tests/land.test.mjs, skills/horde/scripts/tests/plan-out.test.mjs.

## Evidence

