# 044 · readme i skill pomijaja wymagane name w brief

**Status:** open
**Kind:** docs
**Priority:** 1
**Model:** sonnet
**Tags:** zaplecze
**Files:** skills/horde/scripts/README.md, skills/horde/SKILL.md
**Found by:** reader C, reading brief.mjs, README and SKILL.md
**Where:** skills/horde/scripts/brief.mjs:68 USAGE i :304–307 requireName wobec skills/horde/scripts/README.md:351–393 i SKILL.md:158–172

## What
`--name <n>` jest wymagane przy każdej roli, a README i SKILL.md pokazują przykłady bez niego (poza retro w SKILL.md:277). Skopiowany przykład kończy się odmową.

## Why
Pierwsza komenda, jaką dyrektor kopiuje ze skilla, nie działa.

## Acceptance
Każdy przykład brief.mjs w SKILL.md, README i rolach niesie --name; test docs sprawdza wymagane flagi z USAGE w przykładach.

## Evidence

