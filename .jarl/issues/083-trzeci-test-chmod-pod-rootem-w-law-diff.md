# 083 · trzeci test chmod pod rootem w law-diff

**Status:** done
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tests/law-diff.test.mjs
**Found by:** reeve, po sprawdzeniu 069
**Where:** skills/horde/scripts/tests/law-diff.test.mjs:394 "an unwritable law/ directory: a refusal naming the path"

## What
Ta sama klasa co 069 (już naprawione: ask.test.mjs, horde.test.mjs), ale trzeci przypadek w law-diff.test.mjs pozostał — zakłada, że chmod wymusi odmowę zapisu, co root pomija.

## Why
Suita jest czerwona pod rootem z tego samego powodu, powtórzonego w trzecim miejscu.

## Acceptance
Test wykrywa uruchomienie jako root (`process.getuid && process.getuid() === 0`) i pomija się z nazwaną przyczyną, tak samo jak naprawione w 069, albo dowodzi odrzucenia inną metodą.

## Evidence

npm test in skills/horde/scripts (batch of 083+032+066): 919 tests, 914 pass, 4 skipped (3 root-only chmod skips incl. this issue's own fix, 1 optional RatatoskrSkill-checkout skip), 1 fail (land.test.mjs:978 'a branch tip that moved...', a load-timing flake unrelated to this issue — land.mjs/land.test.mjs untouched by 083's diff, reproduces green in isolation in 12.1s, same class as tracked issue 070). Merged b15dfba.

