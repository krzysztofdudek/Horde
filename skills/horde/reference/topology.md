# Topology — branches, worktrees, state, gates, liveness

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
- Several hordes may run on one repository at once, each on its own trunk, with different missions.
- Merging goes up only: ticket → team → trunk → (the user's pull request into base). Nobody merges
  down except to refresh a branch from its parent (`git merge <parent>`), which every worker does as
  its first action.
- Push: never, at any level, without the user's instruction. Starting a mission consents to local
  commits on the horde's branches, nothing more.

## Worktrees

- Every worker gets its own worktree on its ticket branch, cut from its team branch at the tip.
  First action, always: `git merge <team-branch>`, then `git status` must be clean — a worktree that
  is not clean after the merge is a stale base or somebody else's diff, and the worker stops and reports.
- Stewards work in their own worktree on their team branch (the trunk steward on the trunk), created
  by `roster.mjs spawn steward` at `<hordeRoot>/worktrees/<horde>/<team>`. They never `git stash`,
  never check out another branch in their tree, never restore a file from a whole-file backup.
- A completion notice of a grandchild agent (an owner or worker spawned by a steward) can reach the
  director's session as well as the steward's. The director ignores it: the steward acts on files,
  and the director acts on escalations.
- The director works in the main checkout and touches no branch of the horde.

## The `.horde/` tree — uncommitted, one per repository

Lives at the repository root of the **main checkout**. Contains `.gitignore` with `*` so nothing in
it is ever committed and no other ignore rule is needed. Every worktree finds it through
`git rev-parse --git-common-dir` (the scripts do this), so all branches see one state and no state
file ever conflicts in a merge.

```
.horde/
  .gitignore                        "*"
  config.json                       base branch, gate commands per level, node source, cost-class
                                    weights (`classes`), liveness thresholds, protected paths
  hordes/<horde>/
    charter.md                      the mission: goal, non-goals, constraints, evidence catalogue,
                                    touched and new nodes, decision rights, cost policy and limit
    roster.json (+ .md)             who is alive: role, name, model, team or node, lease, last trace
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

## Two graph modes — the skill works with and without Yggdrasil

The node map is the horde's memory of structure and must outlive the horde, so it is always
committed; only where it lives depends on `config.nodeSource`:

| | `yggdrasil` | `manual` |
|---|---|---|
| node ids and boundaries | read from `.yggdrasil/model/**/yg-node.yaml`; never edited by the horde except through `yg` | `<graphDir>/nodes/<node>/node.json` (id, boundary paths, depends-on), written by `node.mjs` |
| charter and contracts | `charter.md`, `contracts.md` beside `yg-node.yaml` | `<graphDir>/nodes/<node>/charter.md`, `contracts.md` |
| the node's log | `yg log add --reason` (English) | `<graphDir>/nodes/<node>/log.md`, appended by `node.mjs log` |
| currency stamp | the graph's own verification status | `verifiedAt` in `node.json`, set by `node.mjs stamp` |
| enforcement loop down | `yg check` in the gate | the contract tests in the gate, nothing more |
| graph changes | the architect files them with `yg` commands; `yg-architecture.yaml` and suppressions still need the user | the architect files them with `node.mjs` after approval |

Yggdrasil keeps deterministic verdicts in a gitignored cache, so every fresh worktree starts with
every deterministic pair "unverified" and `yg check` red. Rebuilding that cache is free and involves no
judgement: `yg check --approve --only-deterministic` is always allowed, in any worktree, before a gate
is judged, and every worker and verifier runs it first. What stays forbidden for every role is
approving a nondeterministic (LLM) pair, writing a suppression, and touching a lock file by hand.

`graphDir` is chosen at `horde init` (default `architecture/`) and is a normal committed directory.
Both modes present the same commands to every role, so no brief and no rule differs between them;
`node.mjs` is the only file that knows which mode it is in. Operational state never leaves `.horde/`
in either mode.

## Gates per level

Configured in `config.json` under `gates`; the defaults for this repository:

| level | before | what must be green |
|---|---|---|
| ticket commit | every commit on a ticket branch | the repository's commit hook lanes (`yg check`, lint, build, typecheck, unit) |
| ticket → team | the team steward merges | full gate (`pnpm run gate`) in the worker's worktree; the ticket's evidence reproduced by a verifier; diff within the ticket's node(s); no protected path touched; branch rooted at the team tip |
| team → trunk | the trunk steward merges | full gate on the merged trunk; every contract test of the touched nodes green; the evidence catalogue delta in the right direction |
| trunk → base | the user | full gate; audit clean; evidence catalogue fully green; cost report written |

`premerge.mjs <branch>` automates the mechanical part for the two middle rows; the steward escalates
anything it cannot tick, and never interprets a red item. Where the nodes come from a Yggdrasil
graph, `premerge` also runs `yg check` on the branch's own tree as its own checklist item, whatever
the gate commands say — the graph is what says the code is right there, and a repository whose gate
command never calls `yg` would otherwise merge a tree the graph refuses. The full gate is expensive (this repository's
includes the browser suite), so it runs once per SHA: a verifier's `reproduced` verdict names the SHA
and the gate result it saw, `premerge` accepts that instead of rerunning, and the auditor's rerun is
the deliberate third opinion. Gate results are cached per level in `cache/last-gate.json`.

## Liveness — by files, never by silence

- A **worker** is done when its branch carries a commit beyond the team tip and its worktree is
  clean; a report without a commit is not a report. The steward checks branches every turn.
- Thresholds live in `config.liveness` as `stewardMinutes`/`ownerMinutes`; `stewardSeconds`/
  `ownerSeconds` win when present (tests and rehearsals set seconds).
- A **steward** is dead when its branch shows no commit and its queue no state change for longer
  than `liveness.stewardMinutes` while the queue is non-empty. The role that spawned it (the director
  for the trunk, the parent steward for a sub-team) reclaims the lease (`roster.mjs reclaim`) and
  spawns a successor under N+1 from the files; the old one is told to stand down.
- An **owner** is dead when it has not answered a review request within `liveness.ownerMinutes`
  (the request is a file in the ticket's log). Its steward reclaims and spawns a successor from the
  node's charter and log.
- The **architect** is dead only when a graph proposal or a contract has waited for it longer than
  `liveness.ownerMinutes` with no trace since; with nothing open it is alive. Auditor and counsel are
  one-shot and never judged by the roster. Every ruling a role records through a tool leaves a trace.
- A ticket's worktree path is recorded on its queue item when the steward sets it `running`; the
  steward uses that path when it has to commit a worker's uncommitted diff.
- Names of agents are unique per horde (`<horde>-<role>-<team|node|mission>-<N>`, N rising on
  respawn; `mission` for the roles that belong to no team or node: architect, auditor, counsel) so
  that reports never land in a stranger's session.

## Cost

Every spawn is booked once, by `roster.mjs spawn … --class [--ticket NNN]`, which is the only writer
of `cost.json`; stewards, owners and the architect are booked without a ticket. `cost.mjs` sums runs ×
class weight per ticket, wave and mission. The account's
rate limits are invisible from a session; the chairman watches those. When the charter carries a limit
and it is reached, the horde stops after the running tickets land and reports; when it carries none,
nobody asks — the cost appears in every wave close.
