# 046 · product-language bez drilla dla url-path

**Status:** open
**Kind:** test
**Priority:** 3
**Tier:** standard
**Tags:** kontrakt, pakiet
**Files:** packages/promises/product-language/drills/
**Found by:** reader C, reading the product-language corpus
**Where:** packages/promises/product-language/check.mjs:62–66 (kategoria url-path) wobec drills/ (brak violates-url-path)

## What
Dziesięć kategorii, dziewięć ma przypadek violates; url-path nie ma żadnego.

## Why
Regex adresów nie jest nigdy ćwiczony; regresja przejdzie bez śladu.

## Acceptance
Przypadek violates-url-path w korpusie; yg aspects drill product-language zielony i liczy go.

## Evidence

