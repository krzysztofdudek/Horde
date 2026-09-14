# 121 · retro.test.mjs's stand-in yg CLI hardcodes inForce: true, so a stale pass can never be told apart from one still in force

**Status:** open
**Kind:** gap
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/tests/retro.test.mjs
**Found by:** issue 117 worker
**Where:** skills/horde/scripts/tests/retro.test.mjs `stubSource()`'s `verdict record` handler, the line that writes `inForce: true` unconditionally.

## What

Every entry `verdict record` writes to the stand-in's LOCK carries a hardcoded `inForce: true`, whatever verdict it records and whatever the content tracking (`CONTENT`/`codeMoves`) says. The real Yggdrasil CLI's `verdict read --json` recomputes `inForce` live on every call — true only while the stored entry's hash still matches the current inputs (`kind === 'verified'` or `'refused'`), false once the content has moved past it (`kind === 'unverified'`, i.e. stale). The stub never re-derives it at all: once an entry is written, `inForce` stays `true` in every later `verdict read` forever, even after `codeMoves()` moves the tracked content out from under it.

## Why

`measureJudge()` in retro.mjs reads exactly one field off an inventory entry to predict whether a pair can reach a second judge at all: `v.verdict === 'pass' && v.inForce` (the `passInForce` shortcut fixed as part of issue 115, extended to refuse a real `verdict package` call on the same shape by issue 117). That prediction is only as honest as the inventory it reads. Because the stub's `inForce` never turns false, there is no fixture in this suite that can represent "a pass was recorded, then the code moved, and the pass is now stale" as `yg verdict read` would actually report it — every existing test that moves code (`codeMoves`) does so starting from a REFUSED first judgement, never a PASS, for exactly the reason issue 117's own comment block gives: a pass in force can never reach a second judge in the first place, so nothing in this file has ever needed to move code out from under one. A regression that made `measureJudge()`'s prediction trust a stale pass's stored `inForce: true` instead of re-deriving it (or a bug that read the wrong field, the mirror of what issue 117 guards against) would misclassify a stale, reachable pair as `passInForce` — permanently out of reach — and nothing here would catch it, because the stub can never produce the one input (`verdict: 'pass', inForce: false`) that scenario needs.

## Acceptance

The stub's `verdict record` handler computes `inForce` the same way it already computes `hashes(k)` for the guard issue 117 added — re-derived from `CONTENT`/`codeMoves` at read time, not frozen at write time. The cleanest shape: `verdict read`'s handler (not `record`) recomputes each entry's `inForce` live against the CURRENT `hashes(k)[entry.verdict]`, mirroring how the real CLI derives it in `verifyPairs`/`classifyWithGate`, rather than trusting whatever `record` wrote. A new test seeds a fresh pass (`judgeRecords`), asserts `yg verdict read`'s entry reports `inForce: true`, then calls `codeMoves()` and asserts the SAME entry now reports `inForce: false` on a fresh `verdict read` — with no new `verdict record` call in between. A second test drives this through retro.mjs itself: a pass recorded, code moved, then a `retro.mjs` run — the pair must NOT land in `passInForce` (the pass is stale, not in force, so `resolvePair` would not refuse it) and must instead reach a real `verdict package` call, landing on `pending` or in `skipped` depending on what that call returns. Every existing test's assertions about `inForce: true` on a freshly-recorded, unmoved pass must keep passing unchanged.

## Evidence

