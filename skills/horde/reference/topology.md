# Topology — lineage, branches, worktrees, state, gates, liveness

## Lineage — who spawns whom, and who can reach whom

```
director (the top-level session)
├── architect                teammate
└── worker · <ticket>        subagent
```

Interim shape: only these two roles exist right now (steward, owner, verifier, auditor and counsel
are being rebuilt one at a time in later releases, not kept alive behind a flag) — the director
spawns the architect as its one teammate and every worker as its own subagent, one per ticket.

- Two kinds of agent. A **teammate** is created by the top-level session alone: a teammate can spawn
  subagents, and those can spawn their own, but never another teammate. So every steward — the
  trunk's and each sub-team's — and the architect are the director's teammates, while owners,
  workers and verifiers are subagents of the steward that spawned them, and the auditor and counsel
  subagents of the director.
- A subagent is addressable and resumable by its parent and by nobody else. Contact that crosses a
  lineage goes through files plus a doorbell to the parent, who carries it: a worker that needs
  another node writes it into the ticket's log and rings its steward; an owner that needs another
  owner writes the contract proposal or the dissent and rings its steward, who reaches the other
  owner; a sub-team's steward reaches the parent team through the `team:<t>` item on its queue, and
  the director if it has to be woken.
- The roster records both facts on every entry — `kind` and `spawnedBy` — and a brief only ever
  names the agent's own parent as the address to report to.
- A sub-team is proposed by the steward that wants it (`escalate.mjs add … --kind structure --team
  <name> --parent <team>`) and raised by the director, because only the director can raise a
  teammate. The escalation carries the commands.

## Branches

```
<base>                        the repository's integration branch (config: base), e.g. develop
└── <horde>/trunk             the horde's branch; only the trunk steward merges here
    ├── <horde>/<team>        one branch per team; its steward merges worker branches here
    │   └── <horde>/t-<NNN>   one branch per ticket, worked in a worktree, merged up, then deleted
    └── <horde>/<team-2>      a sibling team, possibly with sub-teams (hierarchy in the roster, not in names)
```

- Team names are free (mythical creatures, stars — whatever the steward chooses); the hierarchy of
  teams is recorded in `.horde/hordes/<horde>/roster.json`, never encoded in branch names, because
  git refs cannot nest a branch under a branch.
- Several hordes may run on one repository at once, each on its own trunk, with different
  missions — but never on the same node at the same time; see "Node leases" below.
- Merging goes up only: ticket → team → trunk → (the user's pull request into base). Nobody merges
  down except to refresh a branch from its parent (`git merge <parent>`), which every worker does as
  its first action.
- Push: never, at any level, without the user's instruction. Starting a mission consents to local
  commits on the horde's branches, nothing more.

## Worktrees

- Every worker gets its own worktree on its ticket branch, cut from its team branch at the tip.
  First action, always: `git merge <team-branch>`, then `git status` must be clean — a worktree that
  is not clean after the merge is a stale base or somebody else's diff, and the worker stops and reports.
- The director works in the main checkout and touches no branch of the horde.

## The `.horde/` tree — uncommitted, one per repository

Lives at the repository root of the **main checkout**. Contains `.gitignore` with `*` so nothing in
it is ever committed and no other ignore rule is needed. Every worktree finds it through
`git rev-parse --git-common-dir` (the scripts do this), so all branches see one state and no state
file ever conflicts in a merge.

```
.horde/
  .gitignore                        "*"
  config.json                       base branch, gate commands per level, how to invoke the
                                    Yggdrasil and Grain CLIs, cost-class weights (`classes`),
                                    liveness thresholds, protected paths
  leases.json (+ .md)               node -> {horde, since}: shared across every horde on this
                                    repository, never per-horde (see "Node leases" below)
  hordes/<horde>/
    charter.md                      the mission: goal, non-goals, constraints, evidence catalogue,
                                    touched and new nodes, decision rights, quality policy, cost
                                    policy and limit
    roster.json (+ .md)             who is alive: role, name, model, team or node, lease, last trace
    graph.json                      the horde's own process state about the graph: port and
                                    graph-change proposals waiting on the architect, the status
                                    ladder's working per rule (rung, baseline, drill, one reading
                                    per closed wave, every move with its evidence), and which
                                    advisories have already become tickets
    plan.md                         wave journal: starts, merges, audits, closes, cost per wave
    decisions.md                    operational rulings and lessons (architectural ones go to Yggdrasil)
    escalations.json (+ .md)        the channel up
    dissents.json (+ .md)           the channel of disagreement
    handoff.json (+ .md)            state of intent between director sessions
    cost.json                       runs × class per ticket, wave, mission
    teams/<team>/
      queue.json (+ .md)            the DAG of tickets for this team
      issues/NNN-slug/issue.md      the ticket: node, class, spec, acceptance, keys
      issues/NNN-slug/log.md        the work log
      handoff.json (+ .md)          the steward's state of intent
      teams/<sub-team>/…            recursive
```

## Node leases — exclusive across live hordes

Two hordes binding the same node get two owners with contradictory decisions, and the conflict
surfaces only when their trunks meet the base — the most expensive moment to find it. So node
ownership is exclusive across every live horde on one repository, tracked in the one file every
horde shares: `.horde/leases.json`, node id -> `{horde, since}`.

- `node.mjs bind <node>` leases a free node to the calling horde (`--horde`); binding a node this
  horde already holds is a no-op. Binding a node another *live* horde holds is refused, naming
  that horde and its last activity — the same refusal `horde.mjs init --nodes` gives when a
  charter's touched node overlaps a live horde's lease, checked before the new horde's branch or
  any of its own state is created.
- `--take --escalation <id>` overrides the refusal, but only over an escalation on the taking
  horde that has actually been ruled (`escalate.mjs rule`) — an unruled or missing id is refused
  the same as no `--take` at all. A successful take-over is written to the node's own log (where
  one exists to write to) and to `leases.json`'s own append-only history, so a contested node's
  story survives past its current holder.
- `horde.mjs archive` releases every lease the archived horde held — the moment a horde is no
  longer live, its nodes are free for another to bind, no `--take` needed.
- `status.mjs` surfaces a lease another live horde holds on a node this horde's own tickets touch;
  `horde.mjs list` shows each horde's own leased nodes.

Leasing a node id never requires that a graph object for it already exists — a mission is free to
reserve the name of a node it is about to create before the architect ever files it.

## The graph is Yggdrasil's — there is no second one

The node map is the horde's memory of structure and must outlive the horde, so it is always
committed; and it is the graph a repository already has, never a copy of it:

| | where it lives |
|---|---|
| node ids and boundaries | `.yggdrasil/model/**/yg-node.yaml`, read through `yg node <path> --json`; never edited by the horde |
| the rules over a node | `yg context --node <path> --json` — the graph's own resolution, with the status word that says what a refusal costs |
| who consumes a port | `yg impact --node <path> --json` |
| contracts | ports on the node, each named and described — no version, in the graph or in Horde |
| the node's charter | `charter.md` beside `yg-node.yaml`, committed |
| the node's log | `yg log add --reason` (English) |
| is the code still what the graph describes | the lock: every verdict is bound to the hash of what it judged, and `yg check` re-proves it |
| enforcement loop down | `yg check` in the gate |
| graph changes | the architect files them with `yg` commands; `yg-architecture.yaml` and suppressions still need the user |

`horde init` on a repository with no `.yggdrasil/` creates the graph rather than working around it:
`yg init` from the repository root (never a subdirectory — Yggdrasil's own rule), and where a Grain
CLI is configured (`config.grainCommand`) or on PATH, a proposal mined from the repository's own code
accepted with `yg adopt`, which reports how much of the existing code the new rules already refuse.
With no graph and no Yggdrasil CLI to make one, `init` refuses and names the install step, before
creating any state of its own.

**There is no currency stamp.** The lock already binds every verdict to the hash of the code it
judged, so "is this node's verification current" has exactly one answer and `yg check` gives it. A
stamp the horde kept beside that could only ever be a second, weaker claim about the same thing —
and the one that goes stale in silence.

Yggdrasil keeps deterministic verdicts in a gitignored cache, so every fresh worktree starts with
every deterministic pair "unverified" and `yg check` red. Rebuilding that cache is free and involves no
judgement: `yg check --approve --only-deterministic` is always allowed, in any worktree, before a gate
is judged, and every worker and verifier runs it first. What that run leaves behind is the prose
rules — the ones a reader has to judge — and the ticket's **verifier** is that reader: it takes the
review package for each pending pair and records its judgement under its own name
(`yg verdict package` / `yg verdict record`), bound to the same hashes any verdict is, so CI
re-proves it without a key and the report says whose judgement it was. What stays forbidden for every
role is approving a nondeterministic pair through `yg check --approve`, writing a suppression, and
touching a lock file by hand.

Operational state never leaves `.horde/`; the only graph-shaped objects it holds are the horde's own
proposals — a port to add or change, a boundary to move — waiting on the architect.

## Gates per level

Configured in `config.json` under `gates`; the defaults for this repository:

| level | before | what must be green |
|---|---|---|
| ticket commit | every commit on a ticket branch | the repository's commit hook lanes (`yg check`, lint, build, typecheck, unit) |
| ticket → trunk | `land` merges it | all nine items of the landing gate |
| trunk → base | the user | full gate; evidence catalogue fully green; cost report written |

`land.mjs <ticket>` is the middle row, and it is not a checklist somebody reads and then acts on —
it merges the branch itself when every item is green, and refuses when one is not. There is no
steward to interpret a red item and nobody's signature to collect: a green run is the signature, and
the landed sha the only trace it leaves. It runs in a fresh detached tree at the branch's own tip,
never in the worker's, so what it measures cannot move under it.

The graph is one of its items, whatever the gate commands say — the graph is what says the code is
right there, and a repository whose gate command never calls `yg` would otherwise merge a tree the
graph refuses. That item runs the free half itself (`yg check --approve --only-deterministic`),
names every prose rule still waiting on a judgement, and is ✓ only when a full `yg check` is green.
Who judges those rules is `config.judge`: this repository's own Yggdrasil reviewer, or a judge the
gate hands the pairs to and waits for.

The full gate is expensive, and no recorded green run is accepted in its place — a claim about a
run this gate did not see is not a run. Instead, one landing happens at a time per repository
(`.horde/gate.lock`), so the cost is paid once rather than several times over each other.

## Liveness — by files, never by silence

- A **worker** is done when its branch carries a commit beyond its parent's tip and its worktree is
  clean; a report without a commit is not a report. The director checks branches every turn.
- A dead worker (its branch and its queue item both silent past its own turn) is replaced by the
  director from the queue and the ticket's own log; nothing is lost, because nothing was in its head.
- The **architect** is dead only when a graph proposal or a contract has waited for it longer than
  a turn with no trace since; with nothing open it is alive.
- Names of agents are unique per horde (`<horde>-<role>-<ticket|mission>-<N>`, N rising on
  respawn; `mission` for the roles that belong to no ticket: the architect) so
  that reports never land in a stranger's session. A name is an address only for the agent that
  spawned it; from anywhere else what carries is the Agent tool's own id.

## Cost

`cost.json` is a ledger of runs, shape `{name, role, class, ticket|null, wave, at}` — the
architect's own entries carry no ticket. `cost.mjs` sums runs ×
class weight per ticket, wave and mission, whatever the ledger holds. The account's
rate limits are invisible from a session; the chairman watches those. When the charter carries a limit
and it is reached, the horde stops after the running tickets land and reports; when it carries none,
nobody asks — the cost appears in every wave close.
