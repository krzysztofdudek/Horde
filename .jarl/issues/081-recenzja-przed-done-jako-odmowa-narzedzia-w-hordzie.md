# 081 · recenzja przed done jako odmowa narzedzia w Hordzie

**Status:** open
**Kind:** research
**Priority:** 2
**Tier:** standard
**Tags:** kontrakt
**Files:** 
**Found by:** jarl, po ocenie Opus, przeglad przenosnosci miedzy skillami
**Where:** skills/horde/scripts/land.mjs (dziewięć punktów jako całość osądu); reference/model.md (świadome usunięcie stałego miejsca recenzenta per węzeł)

## What
Ruling jarla po ocenie Opus, przegląd przenośności między skillami: Horda nie ma recenzenta — dziewięć punktów land.mjs to cały osąd. Opus oznaczył to jako największą prawdziwą lukę, ale też najbardziej ryzykowną do naiwnego portowania: Horda świadomie usunęła stałe miejsce recenzenta per węzeł (reference/model.md); naiwny port ryzykuje przywrócenie tego miejsca zamiast dodania kontroli jednorazowej per bilet.

## Why
Brak recenzenta przed done oznacza, że jedynym sitem jest sam land.mjs — decyzja, czy i jak dodać recenzję, ma konsekwencje architektoniczne, które wykraczają poza tę pętlę poprawek.

## Acceptance
Nie podnosić workera. Zostawić otwarte do orzeczenia użytkownika — wspomnieć przy najbliższym naturalnym check-inie.

## Evidence
Otwarte — czeka na orzeczenie użytkownika, nie na kod.

