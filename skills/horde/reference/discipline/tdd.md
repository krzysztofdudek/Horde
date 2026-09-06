# Tests that can fail

**The law: every change arrives with a test that fails without it.**

Not "a test exists". Not "the suite is green". A test that goes red when your change is taken away —
and that somebody who is not you has watched go red.

## Why this law, and not "test first"

The merge checklist takes the new test files out of your diff, drops them onto the branch you started
from, and runs them there. They must fail. A new test that passes on the base is not testing your
change, and the merge is refused with the file named.

So **test-first is not a rule here.** What is checked is whether the test can fail without the
change. Writing the test first is the cheapest way to get that, and the only way that also shapes the
design — it is simply not the thing the machine reads. Write the implementation first and you are
betting that a test written afterwards happens to be load-bearing. That bet is usually lost, and it
is lost at the merge, after all the work is done.

A change that adds no test at all — a rename, a move, a settings change — says so on its verdict
(`--revert no-new-tests`) and is verified on its evidence rows instead. That is a claim about the
diff, and the checklist reads the diff itself.

## The loop

1. Write one test for one behaviour. Name the break it catches.
2. Run it. It must fail, and fail for the reason you expect — the behaviour is missing, not a typo.
3. Write the smallest change that turns it green.
4. Run it again, and run the fast check. Both green, output clean.
5. Commit. Every few commits, one line to the ticket log, so a lost session resumes from the file.

## What makes a test worth its maintenance

- **Name the break.** Before the body: what change to the code should make this fail? If the answer
  is "a decision somebody made on purpose" — a constant's value, an exact message, a private shape —
  it fires on every redesign and sleeps through every bug. Test the behaviour that depends on the
  decision instead.
- **Derive the expected value by hand.** A value computed by the code under test passes whatever that
  code does.
- **Assert behaviour, not text.** Grepping a file for a line proves the file is the file. Run the
  thing and assert what it did.
- **Use the real thing.** Real fixtures, real files, real state. A double is for what is slow or
  outside the boundary; everything the test is actually about stays real. An assertion about a double
  is an assertion about your own setup.
- **One behaviour per test.** An "and" in the name is two tests.

## Rationalisations

Seeded from obra/superpowers' published baselines; unverified on Horde briefs until a drill run says
otherwise.

| What you will think | What is true |
|---|---|
| "I'll add the test after." | A test written after the change passes the first time it runs. It never showed it could fail, so it shows nothing. The checklist drops it on the base and refuses it. |
| "Too simple to break." | Simple code breaks. The test costs seconds; the refused merge costs a round trip. |
| "I already checked it by hand." | Nobody can re-run what you did by hand. The verifier will not take your word for it, and is told not to. |
| "Deleting hours of work is wasteful." | The hours are spent either way. What is left to choose is code you can trust or code you cannot. |
| "I'll keep it as a reference and write the tests around it." | Tests written around existing code record what it does, not what it should do. |
| "The gate is green." | Green with your change proves nothing. Red without it is the proof. |
| "This test is hard to write." | Hard to test is hard to use. That is the design talking, not the test. |
| "It's only a refactor." | Then record it as one and let the checklist read the diff. Do not claim it about a diff that adds behaviour. |
| "I'm being pragmatic, not dogmatic." | The pragmatic move is the one that lands. This one is checked by a machine. |

## Red flags — stop

- The new test passed the first time you ran it.
- You cannot say what would make it fail.
- The expected value comes out of the same function you are testing.
- The test asserts on a double, or on the text of a file.
- You are about to report "done" with an uncommitted diff, or with the test unrun.
- You are explaining why this change is the exception.

Modelled on `test-driven-development` and `writing-good-tests` from
[obra/superpowers](https://github.com/obra/superpowers) (MIT).
