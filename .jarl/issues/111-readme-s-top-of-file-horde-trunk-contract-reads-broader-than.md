# 111 · README's top-of-file --horde/trunk contract reads broader than what's implemented

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/README.md
**Found by:** issue 041 worker
**Where:** skills/horde/scripts/README.md:6-8, the "the contract" section at the top of the file: "`--horde <name>` selects the horde; when only one exists it is the default. On its own (no `--tree`/`--ticket`/`--scratch`), `--horde` resolves to that horde's own trunk worktree…"

## What
Read on its own, this reads as a blanket rule for every tool in this set: no `--horde` typed, one horde in the repo → its trunk. That is not what is actually implemented or decided. The real rule (node.mjs main()'s own comment above its resolveTree call; `.jarl/decisions.md`'s `tk-boundary-cwd-is-intentional`; ask a-002, still open) is narrower on two axes at once — which commands get the exception (`queue.mjs plan`/`quality`, and now `tick.mjs` with `--horde` written out — everything else stays cwd), and, within those commands, that the flag must be typed by the caller, never the resolved-horde value a command already carries for other reasons (that broader reading is exactly what issue 037 tried, and what got reverted in f551100, pending a-002). This paragraph doesn't say either of those things, so read alone it overstates the mechanism — and this is not hypothetical: it is a plausible source of 037's original mistake, and this worker's own first draft of 041 misread it the same way before finding tree.test.mjs, decisions.md and a-002 and narrowing the fix.

## Why
A paragraph that overstates a mechanism which is actively disputed elsewhere in the same repository (a-002) is a standing invitation to repeat 037's mistake on the next tool that grows a `--horde` flag.

## Acceptance
Once a-002 is ruled (this issue is downstream of it, not a substitute for it — do not rule on a-002 to close this one): rewrite this paragraph to state the actual, decided scope precisely — name which commands the trunk-fallback applies to, and whether it requires the flag typed explicitly or also covers a horde resolved by default. If a-002 lands on "cwd always, 037 was invalid," this paragraph should say so plainly instead of describing a mechanism nothing implements as the general case.

## Evidence

- **ran:** read skills/horde/scripts/README.md:1-19, node.mjs:2058-2068, .jarl/decisions.md's `tk-boundary-cwd-is-intentional` entry, .jarl/asks.md's a-002, and skills/horde/scripts/tests/tree.test.mjs:1-56 side by side · **saw:** the top-of-file paragraph names no exception and no "typed explicitly" condition; every other source that states the rule states both, and a-002 records the exact ambiguity is still unruled
- **ran:** node --test skills/horde/scripts/tests/docs.test.mjs · **saw:** 34/34 pass — docs-only, comment-only reasoning change, no test asserted on the literal old wording

