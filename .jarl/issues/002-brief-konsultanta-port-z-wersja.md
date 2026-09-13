# 002 · brief konsultanta port z wersja

**Status:** in-progress
**Kind:** cleanup
**Priority:** 1
**Model:** sonnet
**Tags:** zaplecze
**Files:** skills/horde/scripts/refine.mjs, skills/horde/scripts/tk.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/refine.mjs (consultBrief, linia z `@<v>`); skills/horde/scripts/tk.mjs walidacja Consumes; skills/horde/scripts/node.mjs USAGE „There is no version”

## What
Brief konsultanta pokazuje składnię `--consumes <component>/<port>@<v>`, a tk.mjs odmawia portu z wersją. node.mjs USAGE mówi wprost, że wersji nie ma.

## Why
Konsultant, który wykona brief dosłownie, dostaje odmowę i traci przebieg.

## Acceptance
Brief pokazuje dokładnie tę składnię, którą tk.mjs przyjmuje. Test refine sprawdza, że przykładowa komenda z briefu przechodzi przez tk.mjs new bez odmowy.

Dowód, którego oczekuję: skills/horde/scripts/tests/refine.test.mjs (nowy przypadek).

## Evidence

