# 003 · resztki modelu podzespolow

**Status:** done
**Kind:** cleanup
**Priority:** 2
**Tier:** strong
**Tags:** zaplecze
**Files:** skills/horde/scripts/_lib.mjs, skills/horde/scripts/horde.mjs, skills/horde/scripts/tk.mjs, skills/horde/scripts/queue.mjs, skills/horde/scripts/brief.mjs, skills/horde/scripts/status.mjs, skills/horde/scripts/land.mjs, README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/horde.mjs USAGE; skills/horde/scripts/tk.mjs STATUSES; skills/horde/scripts/queue.mjs STATES; skills/horde/scripts/_lib.mjs teamPath; skills/horde/scripts/brief.mjs reportsToFor/stewardFor; skills/horde/scripts/land.mjs `flags.level || 'team'`; skills/horde/scripts/retro.mjs walkTeams

## What
Model podzespołów został usunięty w 6.0.0, ale kod i pomoc dalej go noszą: USAGE horde.mjs wspomina keyContext, owner i verifier; tk.mjs zna statusy `verified` i `escalated`, queue.mjs stan `escalated`; init pisze dissents.json; brief.mjs reportsTo szuka stewarda w roster.json; _lib teamPath rozwiązuje zagnieżdżone sub-teamy; walkTeams w retro/brief/node schodzi w `teams/*/teams`; status.mjs pokazuje tylko trunk; land ma domyślny `--level team` i config gates.team.

## Why
Pół usunięty model to dwa modele naraz. Każda z tych resztek to ścieżka, której nikt nie testuje i którą ktoś kiedyś wykona.

## Acceptance
Jedna decyzja per pozycja, zapisana w issue: usunięcie pisarzy i pomocy, a czytelnicy historii (blame nad archiwum sprzed 6.0.0) zostają i są nazwane „pre-6.0.0 history” w README skryptów. Po zmianie README skryptów nie zawiera słów owner, verifier, steward poza sekcją historii. Testy przechodzą; test na stary snapshot archiwum dalej czyta.

Dowód, którego oczekuję: npm test; grep po owner|verifier|steward|dissent w skryptach i README.

Uwagi: Przed usunięciem czytelników sprawdzić, czy klient ma archiwa misji sprzed 6.0.0. Jeśli tak, pytanie do klienta.

## Evidence

- **ran:** node --test tests/docs.test.mjs (28/28); full reviewer verification · **saw:** merged as c6faeb6

