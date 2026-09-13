# 046 · product-language bez drilla dla url-path

**Status:** done
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

- **ran:** 3 targeted existing tests + a real 'yg drill --aspect .../product-language' run · **saw:** the drill case already exists and passes: 11 pass, 0 MISS, 0 FALSE-ALARM; git history shows it was added in e85062a (2026-09-11), two days before this issue was filed — stale from the start

