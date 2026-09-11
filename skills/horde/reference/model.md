# The model — how a horde thinks

**Law is Yggdrasil's; mission is Horde's.** A territory is a unit of context and of lease, never of
approval — the architect still rules on what changes the graph, whoever holds the territory. A node
stays Yggdrasil's own unit and is never re-cut to fit an agent; the agent is sized to the node, not
the other way round. A worker holds exactly one worktree, and in the trunk checkout writes nothing
but the landing script's own commits. Any territory's own agent may raise a rule on its evidence;
only the client may lower one.

## Three planes, two loops

```
INTENT     charter · rulings · evidence catalogue          director + the user
   │ "what must become true"                    ▲ asks, wave closes
META       the graph: nodes · ports · rules · log          architect, consultants, legislate
   │ "how it must be built"                     ▲ drift: code the graph no longer describes
CODE       worktrees · branches · tests · scenarios         workers
```

The meta plane is the memory of the organisation, and it is Yggdrasil's:
`.yggdrasil/model/<node>/yg-node.yaml`, aspects with rules, `yg check` (the loop downwards: does the
code respect the graph?), the lock (the loop upwards: is each verdict still bound to the code it
judged?). The horde invents no meta level and keeps no second copy of one; it is the organisation
that keeps both loops closed when the work is too large for one agent. A repository without a graph
gets one at `horde init` — created through `yg`, and where a Grain CLI is available, proposed from
the repository's own code and accepted.

Versioning of the meta plane needs two axes, not one: git for content, and per verdict the hash of
what it judged. A rule is current only where the graph still verifies against the code — which is
the question `yg check` answers, and nothing else does.

## The node

A node is a bounded piece of the system — a module, a screen, a package, a cross-cutting concern —
that has:

- a **boundary**: paths, what it exposes, what it depends on;
- a **log**: decisions and history — why things are as they are;
- **ports**: what it promises its neighbours, named and described — the port is the contract, one
  object in the graph; there is no version, in the graph or in Horde;
- **evidence**: tests and scenarios that prove it does what it claims.

There is no charter at the node level any more — a node's rules, ports and log are the whole of what
it carries, all read through `node.mjs show`.

Why a node and not a team: a team is people who must know each other; a node is context that can be
loaded. An agent has no memory between sessions, but a node has a log.

**Right size.** A node is cut correctly when its rules, its ports and its code fit one Sonnet
context with room to work. Finer costs coordination; coarser overflows context. This is the only
cutting rule. The first cut of a graph is made with the user; every cut after that is the
architect's own, proposed when a ticket cannot be placed or a node has outgrown its size.

## Roles as functions of the graph

Two standing roles and three one-shots. Nothing else exists: the five-seat cast this release started
with — a per-branch coordinator, a per-node reviewer, a fresh-context reproducer, a periodic
re-checker and an on-demand opinion-only seat — was removed outright, rather than kept alive behind a
flag.

| role | model | kind | holds | decides | never |
|---|---|---|---|---|---|
| director | Fable or Opus (the user's session) | the top-level session | intent: charter, decision rights, boundary | what to ask the client; the charter; build decisions between tickets | reads worker output; merges; dispatches tickets by hand |
| architect | Opus, cross-cutting, no node | the director's one teammate | coherence of the whole graph | approves or vetoes graph changes; rules the whole plan once, before wave 1 | implementation |
| worker | cheapest capable (Haiku with a checker, Sonnet with a spec) | the director's subagent, one per ticket | one ticket, one worktree, one branch | implementation detail | contracts, decisions, other branches |
| consultant | the territory's own class | one-shot, one per territory, spawned by `refine.mjs` | one territory's own tickets and law proposals | what changes inside its territory | the boundary between territories |
| legislate | the territory's own class | one-shot, one per territory, after a wave closes | that territory's own rules | which pattern the code has already earned as law | lowering a rule |
| retro | Opus, once per mission | one-shot, at the very end | the whole mission's unread gate refusals and log remarks | rule / taste / inexpressible, for every one of them | writing the sentence the client reads |

Only the top-level session creates a teammate — the architect, and nobody else — and a teammate may
spawn subagents but never a second teammate. Depth does not exist below that: a worker is a subagent
of the director directly, one per ticket, and a one-shot answers to whoever spawned it and to nobody
else.

## Context is the currency

The hierarchy routes context, not authority. Each role has a declared reading set — a filter on the
graph — and reads nothing outside it:

- director: the mission node and its edges, asks, wave closes;
- architect: the whole graph, every open proposal, the plan as a whole at review time;
- worker: the ticket, the node's rules and ports, the evidence it must produce;
- consultant: its own territory alone — its nodes' rules, ports and logs, and the charter cut to
  the evidence rows that are its own;
- legislate: its own territory's gate refusals and ticket logs, and the rules that reach nothing
  there;
- retro: the whole mission's gate refusals and ticket-log remarks, on purpose — a refusal that hit
  three different territories is the single most useful thing on the page, and nobody working
  inside one territory can see it.

Briefs are rendered by `brief.mjs` from these sets (the consultant's own brief is rendered by
`refine.mjs` instead, since it carries no entry in `brief.mjs`'s own role table). Nobody gets the
whole conversation. The hierarchy also routes contact: a brief names one address, the agent's own
parent, and anything meant for someone else travels as a file with a doorbell to that parent.

## Trust is manufactured in one place

Agents are biased towards their own work, and no prompt fixes that. The structure routes around it:

- evidence over report: a ticket is done when its evidence exists and the merge checklist reproduces
  it itself — red-green proof, new tests fail before, pass after;
- contracts are tests: a port names the test that is its promise, so a contract change is a red test
  in the neighbour, which surfaces at the next landing rather than staying a claim;
- the merge checklist is the key: nine items, run fresh on the branch's own tip, and a change lands
  itself the moment every one is green — no second person's signature to collect;
- a rule may only be raised by whoever holds the territory it reaches, and only lowered by the
  client's own answered word — the landing gate refuses a branch that tries the other direction by
  itself;
- an architect rules the whole plan once, before dispatch, and every graph change on its own
  evidence — nobody else sees the whole of it.

Trust in an agent is a function of the evidence it left in files, not of the reports it sent.

## Flows

1. **Framing** — director and user; charter, node map, decision rights, evidence catalogue, cost
   policy, base branch. Linear, interactive, the only phase with the user in the loop.
2. **Refining** — `refine.mjs`'s four steps: cut the mission into territories; consult, one agent
   per territory, all at once, writing tickets and law as proposals; review, the architect ruling
   the whole plan once; frame, what the client is shown before the one "go".
3. **Ticking** — `tick.mjs`, one run: reconcile what came back since the last run, land what is
   ready, print the next dispatch list, and say when a wave is ready to close. Nothing lives between
   runs.
4. **Landing** — `land.mjs`, the nine-item checklist that merges a ticket branch itself the moment
   every item is green, or refuses naming the one that is not.
5. **Closing** — `wave.mjs close`: the evidence catalogue's coverage, the quality index and its
   trend, the raises the chairman may still veto, and the mission's own `horde-law/1` document. It
   is also where the law gets audited, because nobody here holds that as a seat: rules past their
   review date, attention items nobody has answered, what the repository says about its own
   territories, and the rules nothing has hit.
6. **The retrospective** — `retro.mjs`, the mission's last run: every gate refusal and every ticket
   log line nobody read twice, sorted into what the law could have said, what is worth one line in a
   component's own log, and what no rule will ever capture.
7. **Completion** — evidence catalogue green, full gate green on the trunk, cost report written;
   `horde.mjs done` is the gate itself, and it archives the horde the moment it passes.

## Invariants

- Every change belongs to exactly one ticket; a ticket names one node, or two when it carries a
  contract between them.
- Nothing lands without evidence and a green merge checklist.
- Every decision that changes structure is in the graph's log, not in a conversation.
- The truth about who works on what is in files. Liveness is judged by branches and state changes,
  never by silence.
- The model class of a task is the cheapest that passes verification, and is written on the ticket.
- The director's context holds intent, asks and wave closes — nothing else.
- Operational state is uncommitted and dies with the horde; durable knowledge is committed to the
  graph and outlives it.
- Enforcement only ever moves one way on its own. A rule climbs draft → advisory → enforced on
  evidence, without asking, and every climb is written into the graph's log and listed at the wave
  close. Anything that lowers enforcement — a status down, a waiver, a review date, a retirement —
  is the chairman's, under every setting; the horde has no command for it.

## Hard places, named

- Planning can loop: the architect's review caps what passes in one pass; a rejected ticket is
  rewritten and put back, not argued over.
- A port change propagates: know who consumes it before it lands (`node.mjs contracts`).
- Cost must be counted even roughly (runs × class), or "cheapest capable" is a wish.
- The first cut of the graph is a judgement the director makes with the user, not alone.

## Mechanics

### Branches

```
<base>                        the repository's integration branch (config: base), e.g. develop
└── <horde>/trunk             the horde's branch; land.mjs is the only thing that merges here
    └── <horde>/t-NNN         one branch per ticket, worked in a worktree, merged up, then deleted
```

- Several hordes may run on one repository at once, each on its own trunk, with different
  missions — but never on the same node at the same time; see "Node leases, kept as territories"
  below.
- Merging goes up only: ticket → trunk → (the user's pull request into base). Nobody merges down
  except to refresh a branch from its parent (`git merge <parent>`), which every worker does as its
  first action.
- Push: never, at any level, without the user's instruction. Starting a mission consents to local
  commits on the horde's branches, nothing more.

### Worktrees

- Every worker gets its own worktree on its ticket branch, cut from trunk's tip (or, while a ticket
  is stacked on a dependency that has not merged yet, from that dependency's own branch — see
  `queue.mjs set --on` in `scripts/README.md`). First action, always: `git merge <parent>`, then
  `git status` must be clean — a worktree that is not clean after the merge is a stale base or
  somebody else's diff, and the worker stops and reports.
- The director works in the main checkout and touches no branch of the horde; the trunk checkout
  itself is written only by `land.mjs`'s own merge commits.

### The `.horde/` tree — uncommitted, one per repository

Lives at the repository root of the **main checkout**. Contains `.gitignore` with `*` so nothing in
it is ever committed and no other ignore rule is needed. Every worktree finds it through
`git rev-parse --git-common-dir` (the scripts do this), so all branches see one state and no state
file ever conflicts in a merge.

```
.horde/
  .gitignore                        "*"
  config.json                       base branch, gate commands, how to invoke the Yggdrasil and
                                    Grain CLIs, cost-class weights (`classes`), fix-round caps,
                                    protected paths, territory size limit
  leases.json (+ .md)               subject -> {horde, since}: territories now, node ids from a
                                    pre-migration mission still read the same way — shared across
                                    every horde on this repository, never per-horde
  hordes/<horde>/
    charter.md                      the mission: goal, non-goals, constraints, evidence catalogue,
                                    touched and new nodes, decision rights, quality policy, cost
                                    policy and limit
    territories.json                the cut: {"<territory>": {nodes, class, why}}, written by the
                                    architect at `refine.mjs --step cut`
    review.json                     the architect's plan ruling, written at `refine.mjs --step review`
    counter.json                    the one shared counter every id in this horde comes out of
    plan.md                         wave journal: starts, merges, closes, cost per wave
    decisions.md                    build decisions and the answered asks recorded through them
    asks.json (+ .md)               the one channel to the client
    handoff.json (+ .md)            state of intent between director sessions
    cost.json                       runs × class per ticket, wave, mission
    land/<ticket>.json              the merge checklist's own result, one file per ticket
    retro-classes.json, retro.json  the retrospective's classification and its finished document
    teams/trunk/
      queue.json (+ .md)            the DAG of tickets
      issues/NNN-slug/issue.md      the ticket: node, class, spec, acceptance
      issues/NNN-slug/log.md        the work log
```

### Node leases, kept as territories

Two hordes binding the same node get two agents with contradictory decisions, and the conflict
surfaces only when their trunks meet the base — the most expensive moment to find it. So a
territory's nodes are exclusive across every live horde on one repository, tracked in the one file
every horde shares: `.horde/leases.json`.

- `refine.mjs --step cut`'s second run leases every territory the architect wrote, once the cut is
  checked; `node.mjs bind <node>` still leases a bare node the same way, for a pre-migration
  mission or a ticket filed before a cut exists.
- A conflict with another *live* horde is refused, naming that horde and its last activity.
  `--take --ask <id>` overrides it, but only over an **answered** ask on the taking horde — a
  missing or unanswered id is refused the same as no `--take` at all. A take-over is written to the
  affected node's own log (where one exists to write to) and to `leases.json`'s own append-only
  history.
- `horde.mjs archive` releases every lease the archived horde held — the moment a horde is no
  longer live, its territories are free for another to bind, no `--take` needed.

### Gates per level

Configured in `config.json` under `gates`; the defaults for this repository:

| level | before | what must be green |
|---|---|---|
| ticket commit | every commit on a ticket branch | the repository's commit hook lanes (`yg check`, lint, build, typecheck, unit) |
| ticket → trunk | `land` merges it | all nine items of the landing gate |
| trunk → base | the user | full gate; evidence catalogue fully green; cost report written |

`land.mjs <ticket>` is the middle row, and it is not a checklist somebody reads and then acts on —
it merges the branch itself when every item is green, and refuses when one is not. There is no
signature to collect: a green run is the signature, and the landed sha the only trace it leaves. It
runs in a fresh detached tree at the branch's own tip, never in the worker's, so what it measures
cannot move under it.

### The gate lock

`.horde/gate.lock`, one per repository — resolved through the git common directory, so every
worktree of one repository finds the same file, which is the point. It is held around the expensive
half of a landing only: the repository's own gate command and both `yg check` runs. Two landings on
one repository serialize instead of running each other's commands over each other's lock; the
second waits `config.gateLockWaitMs` (default two minutes) and then refuses, naming the pid holding
it. The file carries that pid, so a lock left behind by a process that died is **taken over with a
note** rather than waited on forever, and an unreadable (half-written) lock file is treated the same
way.

## Runner

`tick.mjs` is a script; something drives it. Under the default runner, that is the session itself —
your own turn calls `tick.mjs`, reads its dispatch list, and spawns the workers on it. When Claude
Code's Agent Teams are turned on, the very same loop may instead be driven by one long-lived Sonnet
teammate, freed to call `tick.mjs` on its own schedule rather than waiting on your next turn; nothing
about `tick.mjs`'s own four steps changes either way. `--runner external` drives the loop outside any
agent altogether — a cron job, a script, whatever starts one worker at a time from `config.runner.spawn`.
That is the whole of the difference these three make: **where the loop lives**, never whether a
mission can run at all. Agent Teams are an optional accelerant, not a requirement.
