# 076 · jarl evidence powinno przyjmowac strukturalne wiersze

**Status:** open
**Kind:** gap
**Priority:** 2
**Tier:** standard
**Tags:** proces
**Files:** 
**Found by:** jarl, po ocenie Opus, przegląd przenośności między skillami
**Where:** node /home/user/jarlskill/skills/jarl/scripts/jarl.mjs evidence <id> "…" (JarlSkill, nie Horda)

## What
Ruling jarla po ocenie Opus, przegląd przenośności między skillami — nie z czytania błędów Hordy: `jarl.mjs evidence <id> "…"` powinno móc opcjonalnie przyjąć strukturalne wiersze (komenda + co wypisała) zamiast jednego bloku wolnego tekstu, tak żeby `done` mogło kiedyś sprawdzić po jednym wierszu na linię akceptacji.

## Why
Dziś dowód to nieprzejrzysty tekst; nic mechanicznie nie sprawdza, że każda linia Acceptance faktycznie ma swój dowód.

## Acceptance
`evidence` przyjmuje opcjonalną strukturę (np. powtarzalne `--row "<komenda>" "<wynik>"` obok istniejącego trybu wolnego tekstu, wstecznie zgodne). Decyzja o dokładnym kształcie i o tym, czy `done` zacznie to sprawdzać, należy do przyszłej pracy nad JarlSkill, nie do tej gałęzi Hordy.

## Evidence
Otwarte — to jest bilet dla JarlSkill (narzędzia pętli), nie dla kodu Hordy; nie ma tu nic do zrobienia w tym repozytorium.

