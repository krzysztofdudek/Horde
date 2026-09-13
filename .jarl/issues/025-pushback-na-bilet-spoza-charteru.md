# 025 · pushback na bilet spoza charteru

**Status:** open
**Kind:** gap
**Priority:** 2
**Tier:** strong
**Tags:** front
**Files:** skills/horde/scripts/tk.mjs, skills/horde/scripts/queue.mjs, skills/horde/scripts/ask.mjs
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/tk.mjs (walidacja Node/Evidence); skills/horde/scripts/queue.mjs add

## What
Bilet dyktowany przez klienta, którego węzły leżą poza terytoriami misji albo którego pole Evidence nie wskazuje wiersza chartera, nie wchodzi do kolejki. Narzędzie mówi, co się nie zgadza, i drukuje pytanie `charter`, które to zmienia; po odpowiedzi bilet wchodzi z `--ask <id>`.

## Why
Klient może dyktować, ale dostaje pushback, gdy bilet nie jest spójny z tym, co misja obiecała.

## Acceptance
Test: bilet poza terytorium odmówiony z nazwą terytoriów; z odpowiedzianym pytaniem charter przechodzi.

Dowód, którego oczekuję: skills/horde/scripts/tests/tk.test.mjs, skills/horde/scripts/tests/queue.test.mjs.

## Evidence

