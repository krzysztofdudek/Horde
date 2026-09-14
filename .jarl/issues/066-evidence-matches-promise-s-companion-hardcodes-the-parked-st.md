# 066 · evidence matches promise s companion hardcodes the parked status

**Status:** done
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** kontrakt, pakiet
**Files:** packages/promises/evidence-matches-promise/companion.mjs
**Found by:** workflow finder package-vs-docs, confirmed by two refuters
**Where:** packages/promises/evidence-matches-promise/companion.mjs:25

## What
evidence-matches-promise's companion hardcodes the parked-status list has-evidence lets a repository configure

companion.mjs declares `const PARKED = new Set(['planned', 'disabled']);` and uses it at line 36 (`if (PARKED.has(front.fields.status)) return [];`) to decide whether a promise has nothing to pair yet. has-evidence/check.mjs reads the equivalent decision from a repository-configurable setting instead: `const parked = new Set(splitList(ctx.config?.parked_markers ?? DEFAULT_PARKED));` (has-evidence/check.mjs:33), backed by yg-package.yaml's declared `has-evidence.parked_markers` config key (yg-package.yaml around line 49-52, default "planned, disabled", documented as "Statuses that mean nothing runs this yet, and that is fine"). evidence-matches-promise's own config block in yg-package.yaml (lines 54-72) declares `evidence`, `spec_suffix`, `max_depth` and `max_bytes` but no `parked_markers` key at all, and companion.mjs never reads `ctx.config?.parked_markers`.

## Why
A repository that customizes has-evidence's `parked_markers` (e.g. adds a status like `deferred` alongside planned/disabled) gets a promise with that status correctly skipped by has-evidence (no mirror/evidence required), but companion.mjs still treats it as live: it calls mirrorTarget/namedTarget for that promise, which throws ('Nothing keeps promise ... Write it, or set the promise's status to one that says nothing runs it yet.') for a promise the repository's own has-evidence settings just said was fine to leave unpaired — so the two rules of the same package disagree about which promises are parked.

## Acceptance
companion.mjs should read the same configurable parked-status set has-evidence uses (or the package should document why the two rules are allowed to disagree), so a repository's `parked_markers` setting has one consistent meaning across the whole package.

Dowód, którego oczekuję: Configure `has-evidence.parked_markers: "planned, disabled, deferred"`, add a promise with `status: deferred` and no mirror file, run `yg check`: has-evidence passes it (parked), but calling companion({subject:[{path, content}], config:{parked_markers:'planned, disabled, deferred'}, fs:...}) from evidence-matches-promise still throws 'Nothing keeps promise' because companion.mjs line 25 ignores the config value and only recognizes the literal strings 'planned' and 'disabled'.

Refuterzy: Verified directly against both files. companion.mjs:25 declares `const PARKED = new Set(['planned', 'disabled']);` and line 36 uses `if (PARKED.has(front.fields.status)) return [];` — a hardcoded lite | Verified against actual files: companion.mjs:25 declares const PARKED = new Set(['planned', 'disabled']) and uses it at line 36 to gate the parked-status check, with no reference to ctx.config anywher

## Evidence

npm test in skills/horde/scripts (batch of 083+032+066): 919 tests, 914 pass, 4 skipped (3 root-only chmod skips, 1 optional RatatoskrSkill-checkout skip), 1 fail (land.test.mjs:978 'a branch tip that moved...', a load-timing flake unrelated to this issue — land.mjs/land.test.mjs untouched by 066's diff, reproduces green in isolation in 12.1s, same class as tracked issue 070). Merged b6863fd.

