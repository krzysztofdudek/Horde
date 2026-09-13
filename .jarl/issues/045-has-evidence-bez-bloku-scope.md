# 045 · has-evidence bez bloku scope

**Status:** open
**Kind:** research
**Priority:** 2
**Tier:** standard
**Tags:** kontrakt, pakiet
**Files:** packages/promises/has-evidence/yg-aspect.yaml
**Found by:** reader C, reading packages/promises (plausible)
**Where:** packages/promises/has-evidence/yg-aspect.yaml (5 linii, bez scope) wobec doc-shape i product-language (scope per node, **/*.md)

## What
has-evidence czyta ctx.files jak siostry, ale nie deklaruje scope. Nie wiadomo, jaki zbiór plików dostaje pod domyślnym scope Yggdrasila.

## Why
Reguła może cicho widzieć inny zbiór plików niż siostry, albo dostawać ctx.files w innym kształcie.

## Acceptance
Sprawdzić przez yg schemas/knowledge, co znaczy brak scope; jeśli has-evidence potrzebuje tego samego zbioru co siostry (a musi widzieć też pliki testów, więc być może celowo szerszego), zapisać to jawnie w yaml z komentarzem i przepuścić drills przez prawdziwą instalację pakietu, nie tylko check().

## Evidence

