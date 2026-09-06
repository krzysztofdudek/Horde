# Framing before anything runs

**The law: nothing is built before the frame is agreed, and the frame is a list of things a verifier
can reproduce.**

Everything downstream is cheap or expensive depending on this one conversation. A vague frame is paid
for later, in review rounds, by agents who cannot ask.

## Asking

- **One question per message.** Two questions get one answer, usually to the easier one.
- Prefer a question with named options over an open one. "A, B or C, and why" is answerable in a
  line; "what do you think about the shape of this" is not.
- Ask about purpose, constraint and what counts as success. Do not ask about anything you can read
  from the repository yourself.
- Say what kind of thing you think this is before the first question — a small change inside
  something that exists, or a new structure — so it can be corrected in one word.

## Approaching

Two or three approaches, never one. Each with what it costs and what it forecloses, and your
recommendation first with the reason. One approach presented as the answer is a decision taken
without the person who is allowed to take it.

Cut ruthlessly. Anything nobody asked for comes out of every approach before you present them.

## The frame itself

- **Acceptance is a catalogue of evidence.** Every row is a thing somebody who was not there can run
  or look at: a test, a scenario, a recording, a screenshot, a number. Never an adjective, never
  "works correctly", never "is fast".
- **What is out of scope is written down**, next to what is in.
- **A ticket names at most two nodes** and the files it may touch. That is the frame the work is
  judged against: a diff outside it is not a bigger ticket, it is a different one, and it comes back
  as a report while the ticket lands as written.
- **A frame nobody can meet is a finding, not a ticket.** Say so before the work is dispatched.

## Checklist

Read the frame once more, cold, before anything is dispatched. Flag only what would send the work in
the wrong direction — wording and polish are not findings here.

- **Complete** — no placeholder, no "TBD", no section that stops mid-thought.
- **Consistent** — no two parts that contradict each other; the structure described matches the
  behaviour described.
- **Clear** — nothing that two competent readers would read two ways. Where there are two readings,
  pick one and write it down.
- **Scoped** — one frame, not three independent ones stacked. Independent pieces get their own
  frames, in order.
- **Evidence** — every acceptance row is reproducible by somebody who never spoke to the author.
- **YAGNI** — anything present that nobody asked for comes out.

Approve unless a gap would produce the wrong plan.

## Rationalisations

Seeded from obra/superpowers' published baselines; unverified on Horde briefs until a drill run says
otherwise.

| What you will think | What is true |
|---|---|
| "This is too simple to need a frame." | Then the frame is two sentences. It is still agreed before anything runs. |
| "The design is obvious, I'll start while they read it." | The gate is the agreement, not the length of the design. |
| "I know this kind of system, so this is a small change." | Small is measured on this repository, not on your familiarity with the kind. |
| "It grew, but I'm nearly done — no need to re-frame." | Hidden size upgrades the frame the moment it appears. Stop and say so. |
| "I'll ask everything at once to save turns." | You will get one answer and guess the rest. |
| "'It works well' is good enough acceptance." | Nobody can reproduce an adjective. Name the command and the result. |
| "I'll add the extra option while we're in there." | Nothing calls it. It is scope somebody must review, test and maintain. |
| "They approved the last one, so this follow-up is approved." | Each frame gets its own agreement. |

## Red flags — stop

- Two questions in one message.
- One approach, presented as the plan.
- An acceptance row that is an adjective.
- Work dispatched while the frame is still being read.
- A ticket whose files were never written down.
- "We'll work out the details as we go."

Modelled on `brainstorming` (with its spec reviewer prompt) from
[obra/superpowers](https://github.com/obra/superpowers) (MIT).
