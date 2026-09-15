# 126 · 021's evidence guard does not read a repository's pinned evidence-pairing setting

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/land.mjs
**Found by:** merger, reviewing issue 021
**Where:** skills/horde/scripts/land.mjs, `pairingOf` (issue 021)

## What

`pairingOf` (built for issue 021's evidence guard) always derives a promise's pairing kind — mirror,
named, self, or artefact — from that promise's own frontmatter, the same way `adapterOf` in
`packages/promises/has-evidence/check.mjs` does when the aspect's setting is `auto` (the default).
But the real rule lets an adopting repository PIN one pairing for every promise instead, via the
`has-evidence` aspect's own `config.evidence` setting (`.yggdrasil/aspects/has-evidence/yg-aspect.yaml`
→ `config: {evidence: self}` or similar) — `check(ctx)` reads `ctx.config?.evidence`, and when it is
anything other than `auto`, every promise uses THAT pairing regardless of what its own frontmatter
says. `pairingOf` has no way to learn this setting: it reads two trees' worth of promise files and
`yg aspects --json --reach` (for the promises directory), never the aspect's own `config:` block.

## Why

A repository that pins a non-`auto` evidence setting, and writes a promise with no explicit
`evidence:` field of its own (relying on the pin, exactly as the real rule allows), gets read by
`pairingOf` as falling through every check to the `mirror` default. If no file matching
`<stem>.test` happens to exist, `keptBy` comes back `null` on the BASE tree already — and since
`promiseRefusals`'s "pairing gone" case only fires on `was.keptBy && !now.keptBy` (true → false), a
promise that is already (wrongly) read as unpaired on the base can never trigger it, on either tree,
ever. The guard silently protects nothing for these promises — not a crash, not a false refusal,
just a quiet gap in exactly the protection this feature exists to guarantee. Out of scope for 021
itself: nothing in its acceptance criteria named pinned-mode support, and the default (`auto`) path —
the only one any of 021's own fixtures exercise — is unaffected and fully correct.

## Acceptance

`pairingOf` (or its caller) reads the `has-evidence` aspect's own `config.evidence` setting off each
tree (`.yggdrasil/aspects/has-evidence/yg-aspect.yaml`'s `config:` block, read the same way `lawGuard`
already reads other aspects' YAML content off a tree) and, when it is set to something other than
`auto` (or absent), uses that pairing for every promise instead of deriving one per-promise. A test:
a repository with `config.evidence: self` pinned and a promise with no `evidence:` field of its own —
deleting the promise's file (its only real evidence under `self`) must refuse as `pairing gone` (today
it silently would not, since `keptBy` is already `null` on the base). A second test: the existing
`auto`-mode behavior (021's own fixtures) stays byte-for-byte unchanged.

## Evidence

Found while independently reviewing issue 021's diff before merging — confirmed by reading
`packages/promises/has-evidence/check.mjs`'s own `check(ctx)` (the `setting === 'auto' ? adapterOf(front) : setting`
line) against `land.mjs`'s `pairingOf`, and by confirming the package's own shipped
`has-evidence/yg-aspect.yaml` carries no `config:` block by default (so an adopting repository has to
deliberately customize it to hit this — the out-of-the-box `auto` path this issue's own six required
cases and nineteen new tests exercise is unaffected). Not blocking issue 021's own merge: recorded as
a Minor finding on its review, the branch merged, and this filed as the separate, scoped follow-up.
- **ran:** Reproduced the issue's literal scenario on UNPATCHED land.mjs: has-evidence pinned to self, a promise with no evidence: field, deleting the promise's own file · **saw:** land.mjs already refused, as 'promise gone' (not 'pairing gone' — that check is structurally dead for self-pairing, since keptBy==promiseRel==the promise's own existence, so 'promise gone' independently catches every way self-pairing's evidence can vanish, with or without this bug)
- **ran:** Reproduced a genuinely discriminating scenario on UNPATCHED land.mjs: has-evidence pinned to named, a promise carrying a stale complete artefact: block (auto mode's own first-checked branch) plus the required named evidence: <file>#<name> field pointing at a separate, non-test-glob-matching tracked file; branch deletes only that separate file, leaves the promise doc untouched · **saw:** land.mjs found ZERO refusals (evidence guard silent) and proceeded past the protection guards into the full checks pipeline, where it failed later only on an unrelated fixture-graph issue (aspect-adapt-config-key-unknown) — confirming the silent gap the issue describes, for a pin whose pairing genuinely differs from what auto-mode's frontmatter-only reading would derive
- **ran:** Ran the same discriminating scenario against the FIXED land.mjs (git stash verified: fails the same way on the pre-fix commit, passes on the fix) · **saw:** correctly refused early: 'evidence:named-target (pairing gone)' plus 'evidence:promises/checked-in-note.txt (test removed)' — both from the SAME real evidence file's deletion, now watched because keptBy resolves correctly under the pin
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 2400 node --test tests/law-guard.test.mjs tests/land.test.mjs (full suite, BEFORE adding new tests, i.e. only the pre-existing 139 top-level tests, run against the now-fixed land.mjs) · **saw:** tests 165, pass 165, fail 0, cancelled 0, skipped 0, todo 0 — zero change from before the fix, auto-mode behaviour byte-for-byte unchanged
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 2400 node --test tests/law-guard.test.mjs tests/land.test.mjs (final run, AFTER adding 16 new tests: 15 unit tests in land.test.mjs covering pairingAdapter/pairingOf/pairingKind/evidencePinAt/promisesIn across all four pins, 1 end-to-end CLI test in law-guard.test.mjs) · **saw:** tests 181, pass 181, fail 0, cancelled 0, skipped 0, todo 0 (181 = 165 pre-existing + 16 new, all green)
- **ran:** HORDE_TEST_YG=... node --test tests/law-guard.test.mjs tests/land.test.mjs, merger's own run on the merged tip · **saw:** 181 tests, 181 pass, 0 fail, 0 skip

