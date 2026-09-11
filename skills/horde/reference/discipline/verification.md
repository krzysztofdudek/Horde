# Evidence before the claim

**The law: no claim without the output of the command that proves it.**

No role reproduces evidence independently, ticket by ticket, any more — the merge checklist runs the
revert test and the gate itself, and that is where a ticket's own claim is checked. This text is held
by `retro`, at the end of a mission: reading what the gate actually refused, and what a worker
actually recorded, against what "reproduced" demands, is the same discipline one level up, over
everything nobody read twice. An agent applying it must run something and see a result before a
finding counts as reproduced. Reading the diff and concluding it works is not that; running it is.

## What reproduction demands

Every acceptance line on the ticket gets one row of its own, and the row carries the command run
and what it printed:

- **One row per acceptance line**, no more and no fewer. A line nobody ran is not reproduced,
  and the record is refused rather than written with a gap.
- An extra row for anything checked beyond the list is worth adding; the thing you looked at
  because it smelled wrong is worth recording.
- **A gate result at a given sha** is the only thing that counts as the gate. A sentence describing
  it is not a gate result. A green recorded at an older sha is not this branch's gate: the branch
  moved, so run it again.
- **A revert check** means taking the new tests, running them on the base, and watching them fail
  there — or, for a diff that adds none (a rename, a move, a settings change), a statement about
  the diff read, not assumed.
- A red gate is never reproduced, whatever the rest of the checklist showed.

## Claim and proof

| The claim | What proves it | What does not |
|---|---|---|
| The tests pass | This run's output, zero failures | An earlier run, "it should pass" |
| The gate is green | The gate command's exit, at this sha | The tests passing, the linter passing |
| The bug is fixed | The original symptom, retried, gone | The code changed |
| The new test is load-bearing | Run on the base: red. Run here: green | Reading the base and concluding it would fail |
| The change is in scope | The diff, read | The ticket saying so |
| An agent finished | Its branch, its commit, its log | Its report |

## Rationalisations

Seeded from obra/superpowers' published baselines; unverified on Horde briefs until a drill run says
otherwise.

| What you will think | What is true |
|---|---|
| "It should work now." | Run it. "Should" is the word that appears right before a red gate. |
| "I'm confident." | Confidence is not a command's output. |
| "The author says it passes." | The author's report is a hypothesis. That is what you are here to test. |
| "This item is slow, the others covered it." | The slow one is the one nobody has run in a week. |
| "The linter is green." | A linter is not a compiler and neither is a gate. |
| "I read the code and it clearly fails on the base." | Reading is not running. The record says `not-run` unless you ran it. |
| "It's a small change." | Then the commands are quick. |
| "I'd have to ask the author what they meant." | Then write "not reproducible without the author's explanation" and stop. That is a full result. |

## Red flags — stop

- The words "should", "probably", "looks right", "seems to".
- Satisfaction before the output — "great", "perfect", "done".
- About to sign with a result from before the last commit.
- Filling a row from the author's report instead of your own run.
- Wanting to fix what you found. You do not fix; you say what failed, not what to do.

Modelled on `verification-before-completion` from [obra/superpowers](https://github.com/obra/superpowers)
(MIT).
