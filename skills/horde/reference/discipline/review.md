# Findings with a severity

**The law: every finding carries a severity, and a Minor finding never sends the ticket back.**

A review with no severities is a list somebody has to re-judge. A review that returns a ticket over a
variable name costs a full round trip — a fresh worker, a fresh verifier, a fresh gate — for
something a later ticket would have swept up for free.

## The three words

- **Critical** — it is broken. A wrong result, data lost, a security hole, a contract on the border
  turned red, the acceptance not met.
- **Important** — it will break, or it misses the ticket. A boundary crossed, error handling that
  drops the error, a missing evidence item, a test that cannot fail.
- **Minor** — taste. Naming, ordering, a comment, an optimisation nobody measured.

Critical and Important are recorded as a change request and the ticket goes back:

```
node ${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/tk.mjs review NNN changes \
  "Critical: <file:line> — <what is wrong> — <why it matters>" --by <your name>
```

Minor goes to the ticket's log and nowhere else (`tk.mjs log NNN "Minor: …"`), where the next ticket
in that node reads it. A ticket held for Minor findings alone is a review that cost more than it
found.

## What a finding looks like

File and line. What is wrong. Why it matters. How to fix it only when that is not obvious from the
first two. No verdict without having read the diff; no "looks good" over a diff you skimmed.

Say what was done well before the list, specifically. A reviewer who never names a strength is a
reviewer whose Critical is read as a mood.

## When the finding is yours to receive

- Read all of it before you touch anything. Items relate; fixing three of five and asking about the
  other two produces the wrong three.
- Anything unclear: ask, and change nothing until the answer comes.
- Check it against the code before you agree. A reviewer without your context can be wrong, and
  agreeing with a wrong finding costs a round trip too.
- Push back with the command that shows it, not with an opinion. If you cannot check it, say exactly
  what you would need.
- No "you're absolutely right", no thanks, no praise for the review. Fix it and say what changed, in
  one line.
- You were wrong after pushing back: say so in one line and move on. No apology, no explanation of
  why you pushed back.

## Rationalisations

Seeded from obra/superpowers' published baselines; unverified on Horde briefs until a drill run says
otherwise.

| What you will think | What is true |
|---|---|
| "Everything here matters, I'll mark it all Critical." | Then nothing is Critical and the next reader ranks it for you, badly. |
| "It's a small thing but it will bother me later." | That is the definition of Minor. It goes in the log. |
| "While the ticket is open anyway, they may as well fix it." | The ticket is not open. Sending it back re-runs the worker, the verifier and the gate. |
| "The diff is long; I'll trust the tests." | The tests were written by the author, against their own understanding. |
| "The reviewer is more senior, I'll just do it." | You hold the context they lack. Check it first; then do it or say why not. |
| "I'll implement the clear items now and ask about the rest." | Partial understanding produces a wrong partial fix and a second review. |
| "Being agreeable keeps this moving." | It moves it in a circle. Technical correctness first, comfort never. |
| "This suggestion adds something we might need." | Nothing calls it. Say so and leave it out. |

## Red flags — stop

- A finding with no severity word on it.
- A change request whose findings are all Minor.
- "Looks good" without a command, a file or a line.
- Agreement before verification, in either direction.
- A reviewer proposing the fix instead of naming the fault.
- Reviewing your own work. That key is not yours to sign.

Modelled on `requesting-code-review` (with its reviewer template) and `receiving-code-review` from
[obra/superpowers](https://github.com/obra/superpowers) (MIT).
