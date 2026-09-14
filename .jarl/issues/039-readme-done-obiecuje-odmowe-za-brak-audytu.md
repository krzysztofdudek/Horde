# 039 · readme done obiecuje odmowe za brak audytu

**Status:** done
**Kind:** docs
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/README.md, skills/horde/scripts/horde.mjs
**Found by:** reader A, reading README and horde.mjs
**Where:** skills/horde/scripts/README.md:87–100 (done: cztery powody) wobec skills/horde/scripts/horde.mjs:1001–1071 cmdDone

## What
README wymienia jako powód odmowy done „no audit verdict recorded in the last wave”; kod tego nie sprawdza (grep audit w horde.mjs pusty). Kod sprawdza za to świeże retro.json, którego ten akapit nie wymienia.

## Why
Dokumentacja obiecuje odmowę, której narzędzie nie daje, i pomija jedną, którą daje. Po usunięciu kosztu (036) lista powodów zmienia się jeszcze raz.

## Acceptance
Akapit done w README wymienia dokładnie te powody, które kod sprawdza po 036; test docs sprawdza zgodność listy z kodem, jeśli da się ją odczytać z USAGE.

## Evidence

- **ran:** grep -n 'no retrospective run\|retrospective on file is stale' skills/horde/scripts/README.md skills/horde/scripts/horde.mjs · **saw:** both retrospective refusal reasons are now documented in README, matching horde.mjs lines ~1314-1376's real cmdDone logic exactly

