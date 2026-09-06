# discipline — the law each role is held to

Five texts. Each lives here once and is rendered into the briefs of the roles it binds, under a
`## Law` heading, by `scripts/brief.mjs`. A role's own `.md` names its disciplines; it never repeats
them.

| discipline | rendered into | held by |
|---|---|---|
| `tdd.md` | worker | the merge checklist's revert test — new tests are run on the base and must fail there |
| `debugging.md` | worker | three failed fixes are a dissent, not a fourth fix |
| `verification.md` | verifier | a verdict is refused without one recorded row per acceptance line, and a gate result tied to a sha |
| `review.md` | verifier, owner | findings carry a severity; a Minor finding goes to the ticket log, not back to the worker |
| `framing.md` | architect (its checklist), and the director's own section of `SKILL.md` | the charter's evidence catalogue; the ticket's files are its scope |

Four of them carry a drill — an assertion about real `.horde/` state and real branches, not about
what an agent said. `scripts/drill.mjs` runs them; `scripts/tests/drills/` is the corpus.

| drill | discipline | what it asserts |
|---|---|---|
| `tdd` | tdd | on the ticket's branch, a commit's new tests fail when run on that commit's parent |
| `verification` | verification | the verdict is `reproduced`, every row carries a command and what it printed, and the gate's sha is the branch tip |
| `review` | review | every change request names a severity, and none of them is Minor alone |
| `scope` | framing | the diff stays inside the files the ticket declared — or its nodes, when it declared none — and touches no protected path |

## The model

These texts are modelled on [obra/superpowers](https://github.com/obra/superpowers) (MIT), by Jesse
Vincent — its `test-driven-development` (with `writing-good-tests`), `systematic-debugging` (with
`root-cause-tracing`), `verification-before-completion`, `requesting-code-review` and
`receiving-code-review`, `brainstorming`, and the method in `writing-skills` for testing a document
by the behaviour of the agent that reads it. The wording here is Horde's own; the rationalisation
tables are seeded from that project's published baselines and are marked unverified until a drill run
on Horde's own briefs says otherwise.

Three of its rules about how such a text is written are followed here:

- **Match the form to the failure.** A rule broken under pressure gets a prohibition, a
  rationalisation table and red flags. Output of the wrong shape gets a recipe — the parts, in order.
  A missing element gets a slot in the template. Behaviour that depends on a condition gets a
  conditional on something observable.
- **No nuance clauses.** "Do not do X unless it matters" reopens the negotiation. A real exception is
  its own conditional.
- **A discipline is only as good as the failure it was watched preventing.** A drill asserts state,
  never prose.

## What was deliberately dropped

- **Everything as a skill.** Ported as skills these would be a second system claiming the first move
  against `SKILL.md`. Here they are role law: the brief is the channel, the merge checklist is the
  enforcement, and there is no hook.
- **`executing-plans` and `subagent-driven-development`.** They assume one controller in one session.
  The steward and the roles replace them.
- **`dispatching-parallel-agents`.** That is the queue.
- **`using-git-worktrees`.** The horde makes its own worktrees.
- **`finishing-a-development-branch`.** It offers to push. The horde never pushes; the user does.
- **The visual companion, and the `SessionStart` hook.**
- **"No production code without a failing test first"** as a rule. The revert test proves the same
  thing mechanically and proves it about the diff rather than about the order somebody typed in.
  `tdd.md` says so outright instead of leaving the contradiction standing.
