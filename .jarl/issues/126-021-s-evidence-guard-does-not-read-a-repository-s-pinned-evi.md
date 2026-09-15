# 126 · 021's evidence guard does not read a repository's pinned evidence-pairing setting

**Status:** in-progress
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

