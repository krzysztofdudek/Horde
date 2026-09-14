# 080 · land mjs moglby scalac paczke biletow pod jednym przebiegiem bramki

**Status:** done
**Kind:** research
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/land.mjs
**Found by:** jarl, po ocenie Opus, przeglad przenosnosci miedzy skillami
**Where:** skills/horde/scripts/land.mjs (blokada bramki, kolejność pozycji per bilet)

## What
Ruling jarla po ocenie Opus, przegląd przenośności między skillami: dziś każdy bilet ląduje z własnym świeżym przebiegiem bramki pod blokadą bramki, serializowane jeden po drugim. Ta pętla sama udowodniła dziś wzorzec wsadowy (merger łączy nienachodzące na siebie gałęzie i uruchamia suite raz na paczkę) — scalanie nienachodzących na siebie biletów pod jednym przebiegiem bramki skróciłoby czas bramki proporcjonalnie.

## Why
Przy wielu biletach czekających na lądowanie, powtarzanie całej bramki dla każdego z osobna jest kosztem, który wsad usuwa.

## Acceptance
To jest research: potrzebna notatka projektowa zanim powstanie kod — land.mjs's straże i kolejność pozycji per bilet to większa zmiana, nie prosta poprawka. Worker jeszcze nie podnoszony.

## Evidence
Design note (jarl, before any code — per this issue's own acceptance criteria):

CURRENT SHAPE (land.mjs's run(), confirmed against live code): per ticket, run() does cheap ticket-specific checks OUTSIDE the gate lock (base freshness, scope, revert-test, journal, graph-text, law/conflict guards), then takes acquireGateLock ONCE and runs the EXPENSIVE part under it (checkGate — the repository's own build/test command — plus checkGraph/checkMapping/checkJudge), then releases the lock and merges into parent if everything passed. Two landings today are fully serialized on that lock: N tickets landing costs N full gate runs, even when none of them touch the same files.

PROPOSED DESIGN:
1. Batching precondition: only tickets that (a) declare non-overlapping **Files** (disjoint changed-file sets, same comparison already used for scope checks) AND (b) share the same parentBranch at the same parentTip (nothing else makes 'non-overlapping' meaningful — two tickets against different bases aren't landing onto the same tree) are eligible to batch together.
2. Cheap checks (base freshness, scope, revert-test, journal, graph-text, law/conflict guards) still run per-ticket, individually, exactly as today — they're cheap and ticket-specific; nothing about batching changes them.
3. Combine: for the batch's eligible tickets, build ONE throwaway combined worktree by merging each ticket's branch into a copy of parentTip in sequence (same merge mechanism mergeIntoParent already uses) — this is expected to be conflict-free by construction, since the tickets were pre-filtered as non-overlapping; if a sequential merge unexpectedly conflicts anyway (declared files can lie, or two tickets can touch the same file for different declared components), that specific ticket drops out of the batch and falls back to landing alone.
4. Take acquireGateLock ONCE for the whole batch (this is a net simplification, not a complication — one hold instead of N sequential holds) and run checkGate/checkGraph/checkMapping/checkJudge ONCE against the combined tree.
5. On green: merge each batch member into the real parent individually (sequential git merges, one merge commit per ticket, exactly like today — the batching only changed how the GATE ran, not how each ticket's own merge commit and journal entry look) so per-ticket landing history, size reporting (issue 030's diffSize/sizeRanks) and journal bullets stay exactly as today, one per ticket.
6. On red: do NOT bisect. Fall back to landing the batch's tickets one at a time, in the same run, exactly as land.mjs does today — this makes the worst case identical to current behavior (N gate runs when something's actually wrong) and the best case (everything passes) 1 run instead of N. Deliberately simple over deliberately optimal: bisection would save some gate runs even on a red batch, but adds real complexity (which subset is guilty) for a benefit that only matters on the less common, already-being-investigated-by-a-human path.
7. CLI shape: land.mjs itself owns the batch mechanic (it already owns the lock, the gate and the merge) — grows a way to accept more than one ticket at once (e.g. a comma-separated list, or repeated positional args). tick.mjs's own dispatch loop, which already knows what's ready to land in one pass (plan.filter(s => s.action === 'merge')), hands land.mjs the whole ready set instead of calling it once per ticket; land.mjs does its own non-overlap/same-parent filtering and batching/fallback internally, so tick.mjs's own logic doesn't have to know about any of this.

TESTING: (a) fixture with 2-3 non-overlapping tickets ready to land — assert exactly ONE gate-command invocation for the whole batch, and that each still gets its own correct merge commit + journal bullet + size figure; (b) a fixture with one overlapping pair mixed into an otherwise-batchable set — assert the overlapping one is excluded from the batch (lands alone, before or after) while the rest still batch; (c) a fixture where the batch's shared gate is red — assert fallback to one-at-a-time within the same run, with the SAME per-ticket attribution correctness land.mjs already has today.

APPROVED: Krzysztof approved the design above exactly as proposed, no changes (see .jarl/decisions.md, 080-batch-landing-approved). Ready for implementation dispatch. Was held out of dispatch until issue 108 landed — both touch land.mjs (108: checkRevertTest; 080: run()'s gate-lock/merge flow), avoiding a self-inflicted merge conflict; 108 is now done, so this is unblocked.
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 900 node --test tests/land.test.mjs tests/tick.test.mjs · **saw:** 170 tests, 170 pass, 0 fail (162 pre-existing + 8 new: 7 in land.test.mjs covering non-overlapping batch/one gate call, overlap exclusion, red-gate fallback, --no-gate, single-ticket equivalence, --background batch, --background partial refusal; 1 in tick.test.mjs covering dispatch's one-call hand-off)
- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/land.test.mjs skills/horde/scripts/tests/tick.test.mjs · **saw:** 170/170 pass, 0 fail, on the merged tip
- **ran:** HORDE_TEST_YG='node /home/user/Yggdrasil/source/cli/dist/bin.js' node --test skills/horde/scripts/tests/queue.test.mjs skills/horde/scripts/tests/wave.test.mjs skills/horde/scripts/tests/horde.test.mjs skills/horde/scripts/tests/retro.test.mjs skills/horde/scripts/tests/drill.test.mjs · **saw:** 251/252 pass, 0 fail, 1 pre-existing unrelated root-permission skip — broader sweep for regressions given the scale of this change, on the merged tip

