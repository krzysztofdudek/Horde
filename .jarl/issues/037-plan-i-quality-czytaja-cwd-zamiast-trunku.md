# 037 · plan i quality czytaja cwd zamiast trunku

**Status:** open
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/queue.mjs
**Found by:** reader A, reading queue.mjs
**Where:** skills/horde/scripts/queue.mjs:378 (cmdQuality) i :1228 (cmdPlan): `resolveTree({ tree: flags.tree, horde: flags.horde })` zamiast rozwiązanego `horde`

## What
Obie komendy mają już rozwiązaną hordę z resolveHorde(flags), ale do resolveTree podają surowe flags.horde. Bez jawnego --horde (jedna horda w repo, ścieżka domyślna) czytają graf z cwd, a USAGE queue.mjs obiecuje, że `--horde` bez `--tree` znaczy trunk.

## Why
Plan liczony na cudzym checkout zamiast na trunku misji: porty i konsumenci z niewłaściwego drzewa.

## Acceptance
Obie komendy podają do resolveTree rozwiązaną hordę. Test: jedna horda, główny checkout na obcej gałęzi, `queue.mjs plan` bez flag czyta graf z trunku.

## Evidence

- **ran:** git log --oneline; node --test tests/plan.test.mjs · **saw:** merged as a4ef9f4
- **ran:** node --test tests/tree.test.mjs tests/plan.test.mjs (from skills/horde/scripts, after revert f551100) · **saw:** 40 pass, 0 fail — confirms the revert restored the pre-existing tree.test.mjs expectation without breaking plan.test.mjs's own case (which only exercises the explicit --horde path, unaffected either way)

