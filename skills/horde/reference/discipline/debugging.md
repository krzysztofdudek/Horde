# Finding the cause before the fix

**The law: no fix before the cause is found. Three fixes that did not work is not a fourth fix.**

A fix aimed at a symptom moves the symptom. You will find it again, in another file, at a worse
moment, and by then three other things depend on the shape you gave it.

## The four phases, in order

**1. Read what happened.** The whole error, the whole stack, the line numbers, the exit code. Most of
the time the answer is in there and was scrolled past. Reproduce it: exact steps, every time. If it
only happens sometimes, that is the finding — say so before you touch anything.

**2. Find the difference.** What changed: the diff since it last worked, a dependency, the base you
merged. Find something nearby that does work and list every difference between the two, including the
ones that "can't matter".

**3. One hypothesis, stated out loud.** "I think X because Y." Test it with the smallest possible
change, one variable at a time. It held or it did not; if it did not, you have a new hypothesis, not
an extra fix on top of the last one.

**4. Fix the cause, with a test.** The test reproduces the bug and fails without the fix. One change.
No "while I'm here". Then run the whole fast check, not just your test.

Where the failure crosses a boundary — a script calling a script, a branch state read by a tool —
instrument the boundary first: print what goes in and what comes out at each hop, run it once, and
read which hop is wrong. Guessing which hop is wrong costs more than measuring it.

## Three failed fixes, and what happens then

Count them. After the third fix that did not work, you are not looking at a failed hypothesis. You
are looking at a structure that cannot be made right from where you are standing — every fix reveals
a new coupling somewhere else, or each one needs a change that is really a redesign.

**Do not attempt a fourth.** Write it down instead:

```
node ${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/dissent.mjs add \
  "<the three fixes, what each one revealed, and what you now think is wrong>" \
  --ticket NNN --by <your name>
```

A dissent is recorded, answered once, and blocks nothing. It is how the horde learns something from
inside the node that nobody above the node could see. "I cannot, because …" in one line is a good
report; a fourth fix is not.

## Rationalisations

Seeded from obra/superpowers' published baselines; unverified on Horde briefs until a drill run says
otherwise.

| What you will think | What is true |
|---|---|
| "This one is simple, I don't need the process." | Simple bugs have causes too, and the process is fast on them. It is slow only when the cause is not what you assumed. |
| "There's no time for this." | Guess-and-check is slower than looking. It just feels faster, because each guess is short. |
| "I'll try this first, then investigate if it fails." | The first fix sets the shape of every fix after it. |
| "It's probably X." | Then it costs one command to show that it is X. Run it. |
| "I'll write the test once the fix works." | A fix without a test comes back. The test is what makes it stay fixed. |
| "Let me change three things and see." | Then you will not know which one worked, and you will keep all three. |
| "The reference is long, I'll adapt the pattern." | Partial understanding of a pattern is where the next bug comes from. Read it through. |
| "One more attempt." (after two) | Three is the count. The next thing you write is a dissent, not a patch. |
| "The test is flaky, re-run it." | A test with two different results on the same tree is a finding. Report it; do not re-roll it. |

## Red flags — stop

- You are proposing a fix and you have not read the whole error.
- You cannot reproduce it but you are fixing it anyway.
- Each fix moved the failure somewhere else.
- You are on your third attempt and reaching for a fourth.
- You are about to change something you do not understand, to see what happens.
- You caught yourself writing "should be fine now".

Modelled on `systematic-debugging` (with `root-cause-tracing`) from
[obra/superpowers](https://github.com/obra/superpowers) (MIT).
