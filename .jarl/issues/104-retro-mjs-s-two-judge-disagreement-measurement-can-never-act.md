# 104 · retro.mjs's two-judge disagreement measurement can never actually fire against the real yg CLI

**Status:** open
**Kind:** bug
**Priority:** 1
**Tier:** strong
**Tags:** uczenie
**Files:** skills/horde/scripts/retro.mjs, skills/horde/scripts/tests/retro.test.mjs
**Found by:** jarl, researching issue 048
**Where:** skills/horde/scripts/retro.mjs `measureJudge()`, the `second = verdicts.find(...)` line searching the same `yg-verdicts/1` array `v` was drawn from; skills/horde/scripts/tests/retro.test.mjs's `recordingYg()` fixture, which fakes `yg verdict read --json` to return two entries for the same (aspect, unit) pair from two different judges at once.

## What
retro.mjs's whole "how far do two judges agree" measurement (`measureJudge`, `config.retro.judgeTier`, the `disagreements`/`pairs`/`interval` fields in the retro report) reads its "first judge's verdict" (`v`) and searches for a "second judge's verdict" (`second`) in the exact same `yg-verdicts/1` array, both filtered down to the same (aspect, unit) pair. But Yggdrasil's real lock file stores at most ONE verdict entry per (aspect, unit) pair, full stop — `(lock.verdicts[aspect.id] ??= {})[unitKey] = entry` in both `verdict.ts`'s `record` command and `fill-writer.ts`'s own writer unconditionally overwrite whatever was there before, regardless of which judge wrote it. `verdict read --json` (which retro.mjs calls) can therefore never return two rows for the same (aspect, unit) — recording a second judge's verdict on a pair destroys the first judge's verdict in the same write. Since `v` and any matching `second` are necessarily the same single array element, `second.judge === v.judge` is always true whenever `second` is found at all (they're the same object), so `measureJudge` can never reach its own disagreement-counting code (`const agrees = second.verdict === v.verdict; ...pairs.push(...)`) — every pair falls into `pending` and stays there, forever, no matter how many times `verdict record --by <tier>` is run on it.

The existing test proving `disagreements: 1` (`retro.test.mjs`, "two judges that disagree come back with the count and the interval at that sample size") passes only because its `recordingYg()` fixture directly injects a fabricated `verdicts` array containing two entries for the identical `{aspect: 'one-sentence', unit: {kind:'file', path:'src/auth/login.mjs'}}` pair — one `judge: 'tier-a'`, one `judge: 'tier-b'` — a shape the real `yg verdict read --json` can never produce. The test is green against a fake dependency that does not match the real one's actual behavior.

## Why
Judge-agreement measurement is one of retro.mjs's core "evidence over reports" numbers — it's meant to tell a mission whether its landing gate's own judgements can be trusted, by sampling a second, independent opinion. As built, it is structurally incapable of ever producing a real comparison: against the real Yggdrasil CLI, `pairs` will always be empty and `disagreements` will always be 0, and every sampled pair permanently reports the same "no second judgement to compare against yet" note, even after someone follows the exact command the tool itself suggests (`yg verdict record --by <tier> ...`) — because running that command overwrites the very verdict `v` it was supposed to be compared against. This is silent: nothing refuses, nothing warns that the mechanism cannot work, and the fully-green test suite gives false confidence that it does.

## Acceptance
Either (a) retro.mjs is changed to actually make the comparison possible — e.g. capturing/persisting the first judge's verdict itself (text, not just a later re-read of the mutable lock slot) before the second judge's verdict is recorded over it, so both sides of the comparison survive long enough to be diffed — with a test that drives this through something that behaves like the real one-slot-per-pair `yg verdict record`/`read` semantics, not a fixture free to return an impossible shape; or (b) if two independent judgements truly cannot coexist in Yggdrasil's current verdict model and this needs a change on that side too, that constraint is written down explicitly (in retro.mjs's own comments and in scripts/README.md) and the feature is either gated off or the CLI documents what to change first. Either way, `recordingYg()`'s fixture in retro.test.mjs needs to actually emulate "at most one recorded verdict per (aspect, unit), last write wins" rather than allow two simultaneous entries for the same pair, so this test suite can no longer go green against a shape the real `yg` cannot produce.

Dowód, którego oczekuję: read Yggdrasil's `source/cli/src/cli/verdict.ts` (`record` command, `(lock.verdicts[aspect.id] ??= {})[unitKey] = entry`) and `source/cli/src/core/fill-writer.ts` (same single-slot write) to confirm the one-verdict-per-pair invariant still holds; then either a real end-to-end drive through two sequential `yg verdict record --by <judge>` calls on the same pair (against a real or realistically-faked lock file) showing the second overwrites the first with no way to recover both, or the corrected design that avoids relying on that.

## Evidence

