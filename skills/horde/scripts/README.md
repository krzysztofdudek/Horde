# scripts — the contract

Every tool: Node ESM, zero dependencies, `--help`, `--json`, exit non-zero on failure with one line on
stderr. All tools resolve the repository root by walking up to `.git`, then the shared state root as
`<git common dir>/../.horde` so a worktree and the main checkout see the same state. `--horde <name>`
selects the horde; when only one exists it is the default. `--team <name>` selects a team; default is
`trunk`. `<name>` is always the team's short LEAF name (`alfa`), unique per horde — the same name a
brief renders and a steward is spawned with — while sub-teams nest on disk
(`teams/<parent>/teams/<child>/`) and the branch name also stays short (`<horde>/alfa`). `_lib.mjs`'s
`teamPath()` resolves that nesting itself, by walking `roster.json`'s steward entries' own `parent`
links back to `trunk`; a full slash path (`trunk/alfa`) is also accepted, but only when it matches what
that resolution independently finds — anything else, including the literal segment `teams`, is
refused rather than silently landing in the wrong directory. JSON files are the source of truth; every
`.md` beside one is rendered on write and never parsed. No tool ever rewrites history in a journal;
journals append.

Shared internals live in `_lib.mjs` (root discovery, JSON read/write with rendering, arg parsing,
table printing, timestamps, git helpers). Tools import it; nothing else does.

## horde.mjs — hordes

- `init <name> --base <branch> [--title "…"] [--graph-dir <dir>] [--test-globs <glob>[,glob…]]` —
  creates `.horde/` if missing (with
  `.gitignore` = `*` and a default `config.json`), `hordes/<name>/` with `charter.md` from the template,
  empty roster, journals, `teams/trunk/`, and the branch `<name>/trunk` off `<base>` (no checkout of the
  main tree). Sets `config.nodeSource` to `yggdrasil` when `.yggdrasil/` exists, else `manual` with
  `config.graphDir` = `--graph-dir` (default `architecture/`), creating `<graphDir>/nodes/` and a README
  that says what the directory is. On a repository with a Yggdrasil graph the result also says that
  `yg check` is now part of every merge check. It also reads the repository's build files for two
  things it must not invent — the command that proves the repository still works, and the patterns
  its tests are named under (`package.json`, `pom.xml`, `build.gradle`, `Cargo.toml`, `go.mod`, a
  Python project file, a `Makefile` with a `test:` target) — and says in its result what it worked
  out, or, when it worked out nothing, that it did not and what to set. `--test-globs` names the
  test patterns outright. Refuses an existing name.
- `list` — hordes with trunk, base, wave, open tickets, last activity.
- `config get|set <key> [value]` — `.horde/config.json`: `base`, `gates.commit|team|trunk` (commands),
  `testGlobs[]` (the patterns this repository's tests are named under — the merge checklist refuses
  rather than guess when it is empty), `nodeSource` (`yggdrasil` | `manual`), `ygCommand` (how this
  repository invokes the Yggdrasil CLI
  — default `yg` on PATH; set it to e.g. `node path/to/bin.js` for a local build),
  `protectedPaths[]`, `liveness.stewardMinutes|ownerMinutes`
  (also accepts `liveness.stewardSeconds|ownerSeconds` — a `*Seconds` key wins over its `*Minutes`
  counterpart when both are set; useful for tests and fast-loop tuning where a whole minute isn't
  practical), `classes` (weights: haiku 1, sonnet 3, opus 10, fable 30 — defaults), `parallelism`.
  A list-valued key (`testGlobs`, `protectedPaths`) takes either a comma-separated list or a JSON
  array and is stored as a list either way — never as the text of one.
- `charter show|edit` — the mission charter. `show` prints it; `edit` replaces it with what arrives
  on stdin, the same shape as `node.mjs charter edit` for a node, and reports how many evidence rows
  the new text carries and how many are recorded as reproduced — naming any row that was recorded
  and is no longer, since a rewrite that drops one loses a verifier's work otherwise. This is how
  the goal, the non-goals, the evidence catalogue and every amendment are written: the charter is
  the one file where what the chairman asked for lands, and it is written through a tool like
  everything else.
- `archive <name>` — moves `hordes/<name>` to `hordes/_archive/<name>-<date>`; branches untouched.

## status.mjs — the digest

One screen: hordes, for each: trunk sha and distance from base, teams with their branch tips, workers'
branches beyond their team tip (landed, unverified, unmerged, waiting), stewards' last trace and
liveness verdict, queue counts by state (including `waiting`), open escalations and dissents, last
gate result per level, cost to date and limit. `--horde`, `--team` narrow it. `--json`.

## handoff.mjs — state of intent

`write --summary "…" [--next "…"]… [--by director|steward] [--team t]`, `read [--by director|steward]
[--team t]`. `--by` decides the file: the director (the default) reads and writes the mission-level
`hordes/<horde>/handoff.json` and ignores `--team`; a steward reads and writes its team's
`teams/<team>/handoff.json`. `read` without `--by` prints both, mission first.
`add-waiting <who> "<what>"`, `rm-waiting <who>`. Writes `handoff.json` (+ `.md`); `write` fills
`inFlight` from the queue's running items and `head` from git. `read` prints "fresh start" when none.

## tk.mjs — tickets

Over `teams/<team>/issues/NNN-slug/{issue.md,log.md}`, NNN unique per horde (counter in
`hordes/<horde>/counter.json`).
- `new <slug> --title "…" --node n --class haiku|sonnet|opus [--severity high|medium|low]
  [--depends NNN,…] [--evidence "…"]… [--revert-base <ref>]` — from `templates/ticket.md`; status
  `proposed`. `--revert-base` names the ref where the ticket's new tests must fail (a contract test
  is green on the team tip by design; its red base is e.g. `develop`); `premerge` item 4 reads it, or
  a "red on <ref>" phrase in the acceptance lines. Each
  `--evidence` value becomes its own `- [ ] …` line in the ticket's `## Acceptance — evidence`
  checklist. A catalogue id (`E1`, `E2`, …) cited inside an `--evidence` value must already be a row
  in the horde's `charter.md` evidence table — refuses otherwise, listing the unknown ids.
- `list [--state s] [--node n] [--team t] [--review-pending] [--open]`, `show NNN [--log]`,
  `status NNN <state> ["note"]` (states: proposed queued running landed changes verified merged
  escalated dropped), `log NNN "text"`, `grep <re>`.
- `review-request NNN` (steward; appends to the log with a timestamp, starts the owner's liveness
  window), `review NNN approve|changes ["why"] --by <name>` (records the approval per node in the
  `**Keys:**` field; a ticket naming two nodes needs both owners; the architect's review counts for a
  node whose owner is the author; refuses `--by` equal to the author key). An `approve` also reads the
  ticket's own queue item's `branch` and appends its current tip sha to the recorded value
  (`<name>@<sha>`) — `premerge.mjs` item 2 uses it to refuse an approval that predates a later commit.
  No queue item or no branch yet (a ticket approved before ever being queued) records the name alone,
  same as before.
- `key NNN author --by <name>` — sets the author key in the `**Keys:**` field (the steward, when the
  branch lands). `key NNN author --from-queue` sets it instead from the ticket's own queue item's
  recorded `agent` — for a successor steward recovering a ticket `queue.mjs reconcile` marked
  `landed` after the original steward died before it could set the key by hand. The verifier key is
  set only by `verify.mjs`.
- The `**Keys:**` field holds one segment per role and per node, in the order of the `**Node:**`
  field: `**Keys:** author X · verifier Y · <nodeA> Z · <nodeB> W`. `review … --node <n>` targets one
  node of a two-node ticket; `review --by architect` without `--node` approves every node at once (the
  architect stands in where the owner is the author).
- `--node` on `new` is repeatable; two nodes mark a contract ticket.
- `move NNN --team t` — relocates the issue folder (used when a sub-team takes it over).
- `edit NNN --by <name>` — rewrites the body (everything from `## What` on) from stdin, leaving the
  header block (id/title, `**Status:**`, `**Node:**`/`**Class:**`/`**Severity:**`/`**Team:**`,
  `**Depends on:**`/`**Branch:**`, `**Keys:**`) untouched; appends "body edited by `<name>`" to the
  log. What owners use to write ticket bodies, instead of editing `issue.md` by hand.

## queue.mjs — the DAG

`teams/<team>/queue.json`: items `{ticket, state, class, branch, worktree, dependsOn[], agent, sha, notes[]}`.
States: `queued waiting running landed merged escalated dropped`.
- `list [--state s]`, `add NNN [--depends dep,…]`, `set NNN <state> [--sha x] [--agent name] [--note "…"]`,
  `next [--class c]` (ready = queued and every dependency merged; severity read from the ticket on
  every call, high first; FIFO within by array order; a `waiting` item is never a candidate),
  `rm NNN`, `move NNN --team t`, `render`, `reconcile` (every `running` item: a commit beyond the team
  tip → `landed`; a dirty worktree → `git add -A && git commit -m "wip: reclaimed"` on the ticket branch,
  then `queued` with a note; a clean worktree and no commit → `queued`, worktree removed. A `waiting`
  item is left untouched — it has nothing running to reconcile).
- A dependency (`add`'s `--depends`, `dep`'s `--on`) is `NNN` (same team), `<team>:NNN` (a ticket in
  another team's queue), or `<team>:team:<name>` (that team's own merge-up item, e.g.
  `trunk:team:allies`) — `next` checks a cross-team one against that team's own `queue.json`, read
  fresh every call, so a dependency between teams is enforced by the DAG rather than held only in
  prose. Refuses an unknown team or item; a same-team cycle is refused, a cross-team one is not
  checked (a merge-up DAG only ever points up or sideways).
- `set NNN waiting --note "<why>"` — for "the class this ticket needs is overloaded, no agent of that
  class can be spawned right now": just changes the state, keeping `class`, `branch` and `worktree`
  exactly as they were (so a ticket already `running` when its class gets overloaded can be waited
  without losing its worktree). `set NNN queued` brings it back onto the DAG.
- `set NNN running --agent <name>` creates the branch `<horde>/t-NNN` off the team tip and the worktree
  `<hordeRoot>/worktrees/<horde>/t-NNN` on it (per horde, so two hordes never collide on a ticket
  number), records the path as `worktree` on the item, and prints it. `set NNN merged --sha` removes
  the worktree first, then deletes the branch. Items named `team:<name>` stand for a sub-team's branch
  and skip branch creation.
- Refuses `set NNN merged` when the ticket's `**Keys:**` field lacks the author key, the verifier key
  (a `verify` record with verdict `reproduced`), or an approval for every node it names.

## roster.mjs — who is alive

`hordes/<horde>/roster.json`: entries `{name, role, class, team|node, parent, agentId, spawnedAt,
lastTrace, lease}`. `team` is always the short leaf name, unique per horde — `spawn` refuses a leaf
already claimed under a *different* parent (the same leaf under the *same* parent is an ordinary
respawn after a reclaim).
- `spawn <role> [--team t | --node n] [--parent team] --class c [--ticket NNN] [--agent-id id]` —
  reserves the next unique name `<horde>-<role>-<team|node|mission>-<N>`, books the run in `cost.json`
  (the only writer; shape `{runs: [{name, role, class, ticket|null, team|null, wave, at}]}`), and
  prints the name; the caller passes it to the Agent tool. A worker or verifier spawned with
  `--ticket` is refused below that ticket's class (`config.classes` weights order the classes). `--agent-id` records the Agent tool's own
  id when already known at spawn time — agents are addressable by name only from the spawning session,
  by this id from anywhere. For `steward --team t --parent p` it also creates the branch `<horde>/<t>`
  off the parent's tip, the team directory, and the item `team:<t>` in the parent's queue — or, if the
  branch and directory already exist (a respawn after a reclaim), re-registers onto them instead of
  failing; refuses only when the branch exists but the directory doesn't. `steward --team trunk` needs
  no `--parent` and creates no branch or directory — the trunk branch and directory already exist from
  `horde.mjs init`. Either way, for any `steward --team t`, a worktree for it at
  `<hordeRoot>/worktrees/<horde>/<t>` on the team branch is created when missing and its path printed
  in the result; `reclaim` leaves it in place for the successor.
- `reconcile [--only-team t]` — marks every active entry dead (used at cold boot: the session that
  spawned them is gone); `--only-team` limits this to one team's subtree (that team's own steward and
  everything nested under it), for reclaiming one branch of the mission without a full cold boot.
- `trace <name> [--agent-id id]` — updates `lastTrace` (called by tools acting on that agent's
  behalf, including on someone else's `--by`, and after a ruling on a proposal, contract or
  escalation/dissent), and revives a `dead` lease back to `active` — a trace is itself proof of life.
  A `reclaimed` or `retired` lease, being a deliberate decision, is left alone; `--agent-id` records
  the Agent tool's id once it's known, even if it wasn't yet at spawn time.
- `revive <name>` — the explicit form: restores any lease (`dead`, `reclaimed` or `retired`) because a
  human asked for this entry by name, on purpose.
- `list [--dead]` — liveness verdict per entry against `config.liveness`. A steward is dead once its
  team's queue is non-empty and the newest of its team branch's tip commit time, its `queue.json`'s
  own mtime, and `lastTrace` is older than `stewardMinutes`; an empty queue is always alive, and a
  `team:<t>` item never counts toward "non-empty" — a steward whose only running items are those is
  alive as long as any of those sub-teams' stewards is alive, and only falls back to its own signals
  once none of them are. An owner is dead when the most recent `review-request` on a ticket naming its
  node has gone unanswered (no `review` by that owner since) for longer than `ownerMinutes`, unless
  `lastTrace` is newer than that. An architect (mission-scoped) is judged the same way, against its
  open graph proposals/pending contracts (`hordes/<horde>/graph.json`) instead of a review window;
  with nothing open, it's always alive. Auditor and counsel (one-shot roles) are never dead.
  `stewardMinutes`/`ownerMinutes` also accept a `stewardSeconds`/`ownerSeconds` sibling key, which wins
  when set — for tests and fast-loop tuning, where a whole minute isn't practical to wait out.
- `reclaim <name> ["why"] [--lesson] [--by director]` — marks the lease reclaimed; the next `spawn` for
  the same team or node gets N+1. Appends to the horde's `decisions.md` as a lesson when `--lesson` is
  given. A mission-scoped entry (architect, or anything spawned with neither `--team` nor `--node`)
  requires `--by director`.
- `stand-down <name>` — marks the entry retired.

## brief.mjs — rendered briefs

`brief.mjs <role> [args]` prints the brief for a role, filled from `reference/roles/<role>.md`:
`steward <team>`, `owner <node>`, `architect`, `worker NNN`, `verifier NNN`, `auditor NNN --wave n`,
`counsel --question "…" [--attach file]…`. Fills `{{…}}` from the charter, the config (`fastCheck` =
`gates.commit`, `gateCommand` = the level's gate, `graphDir`, `protectedPaths`, `parallelism`), the
cache (`fastCheckCount` from `cache/last-gate.json`, or "unknown — report the count you get"), the
node (`node.mjs`), the ticket (`worktree` and `branch` from the queue item), and the roster
(`reportsTo`, `parentTeam`) — `reportsTo` renders as `"<name> (agent id <id>)"` once `roster.mjs` has
recorded that agent's id, so a report can reach it from outside the spawning session; refuses to
render with an unfilled placeholder. Records nothing —
the spawn is booked by `roster.mjs spawn`. The caller copies the output into the Agent tool's prompt
verbatim.

## node.mjs — nodes and the graph

The only tool that knows which graph mode is on. `nodeSource=yggdrasil`: node ids, boundaries and
descriptions are read from `.yggdrasil/model/**/yg-node.yaml`; `charter.md` and `contracts.md` live
beside it; log entries go through `yg log add --reason`; stamps come from the graph's verification
status. `nodeSource=manual`: everything lives committed under `<graphDir>/nodes/<node>/` —
`node.json` (id, boundary globs, dependsOn[], verifiedAt), `charter.md`, `contracts.md`, `log.md` —
and the tool is the only writer. Every command below behaves identically in both modes; `new <node>
--boundary <glob>… [--depends n…]` and `apply <proposal-id>` exist only in manual mode (in Yggdrasil
mode they print the `yg` commands the architect must run instead).
- `bind` — verifies the graph is readable and lists nodes; `map [--horde h]` — the mission's nodes with
  owners, stamps (verified against sha), open proposals.
- `show <node>` — boundary, **the rules in force on the node**, charter, contracts, last log entries,
  stamp. The rules are every aspect the graph attaches to this node — its own, those cascading from
  the nodes above it, and those on its type and its ancestors' types — each with the status word that
  says what a refusal costs (`enforced` blocks a merge, `advisory` warns, `draft` is inert). They come
  from `yg context --node` when the Yggdrasil CLI is installed (its machine-readable form when it has
  one, its text form otherwise); when it is not, they are read from the graph files directly, and the
  reading says so, since flows, ports and implied aspects are not resolved that way. The node
  charter's own "Rules inherited from above" section, when it has one, is reproduced under them.
  `nodeSource=manual` has no aspects at all, and says that instead of showing an empty list.
- `charter edit <node>` (opens from template if missing; the caller writes the content via stdin),
  `log <node> "…"`, `stamp <node> <sha>`.
- `boundary set <node> --boundary <glob>[,glob…]` replaces the boundary, `boundary add …` extends it
  (manual mode: rewrites `node.json` and logs; Yggdrasil mode: prints the `yg-node.yaml` edit to make).
- `contract propose <a> <b> --as <test-or-scenario-path> "…"`, `contracts [--pending] [--node n]`,
  `contract approve|veto <id> ["why"] --by architect`.
- `propose <kind> "…" --by <owner>` (kinds: new-node, move-boundary, rename, rule), `proposals
  [--open]`, `approve|veto <id> ["why"] --by architect`. Approval records; filing into Yggdrasil is the
  architect's own `yg` calls, and the tool prints the exact commands to run.

## verify.mjs — the second key

`record NNN --verdict reproduced|not-reproduced|stale|out-of-scope --by <name>
--item "<n>|<command>|<saw>"… [--ran "…" --saw "…"] [--gate green|red --sha <sha>] --revert
failed|passed|not-run` appends a verdict
block (template `verdict.md`) to the ticket's log and sets the verifier key in the `**Keys:**` field
when the verdict is `reproduced`. `<n>` is the 1-based line number of the ticket's own `## Acceptance —
evidence` checklist (`- [ ]`/`- [x]` lines) — one `--item` is required per acceptance line, no more, no
fewer; refuses otherwise, listing the missing or out-of-range indices. Each `--item` renders one table
row, in acceptance order, with the checklist line's own text in the first column. `--ran`/`--saw` are
optional and add one extra row labelled "other", for something checked beyond the acceptance list.
Refuses when `--by` equals the ticket's author. `--verdict reproduced` requires `--gate` (the gate
result is part of reproduction) and refuses `--gate red` — a red gate cannot be reproduced; record
`not-reproduced` instead. `show NNN`.

## escalate.mjs — the channel up

`add "<why>" --kind charter|contract|claim|conflict|boundary|cost|unverifiable|rules|structure
[--ticket NNN] [--by steward|architect|owner]`, `list [--open]`, `show <id>`, `rule <id> "<ruling>"
[--by <name>] [--to-user]` (`--by` leaves a roster trace for the ruler) (records the ruling as a decision, slug `esc-<id>`; `--to-user` marks it as forwarded to
the chairman and leaves it open until `rule` is called again with the answer).

## dissent.mjs — the channel of disagreement

`add "<why>" --ticket NNN --by <owner> [--against <decision-slug>]`, `list [--open]`, `answer <id>
"<answer>" --by <name>` (one answer, by whoever made the disputed ruling; the entry then closes; the
answer is also appended to `decisions.md`).

## decide.mjs — rulings and lessons

`add <slug> "<ruling>" [--ticket NNN] [--node n]`, `list [--grep re] [--node n]`, `show <slug>`.
Appends to `hordes/<horde>/decisions.md` (`## <date> · <slug> [· ticket NNN] [· node n]`); refuses a
duplicate slug. Architectural decisions belong in the graph's own log and are not stored here; the tool
says so when `--node` is given with `nodeSource=yggdrasil` and prints the `yg log add` command instead.

## wave.mjs — the journal

Appends to `hordes/<horde>/plan.md` (team waves to `teams/<team>/plan.md`): `start [n] [--team t]`,
`note "…"`, `merged NNN <sha>`, `audit NNN clean|findings "…"`, `close [--gate green|red] [--sha <tip>]
[--evidence E5,…] [--team t]` (renders `templates/wave-close.md` with counts from the queue, the
evidence catalogue and `cost`; `--gate` with `--sha` records the level's gate at that tip in
`cache/last-gate.json`; `--evidence` fills catalogue rows the green wave gate itself proves),
`evidence <id> --by "<who/what>"` (fills one row by hand, for rows no ticket verdict can fill),
`current [--team t]`.

## premerge.mjs — the mechanical checklist

`premerge.mjs <branch> [--level team|trunk] [--no-gate]`, for a ticket branch (`<horde>/t-NNN`):

1. base freshness — the branch is rooted at its parent branch's tip;
2. keys — the author key and the verifier key are set, the verify verdict is `reproduced`, every
   node the ticket names carries an approval, and every approval and the verdict itself are sha-bound
   to the branch's current tip (an approval or verdict recorded for an earlier commit is stale —
   ✗ "approval/verdict predates <sha> — re-review", not counted, even if a name is present);
3. scope — the diff stays inside the union of the ticket's node boundaries (from `node.mjs`), each
   node's own graph files included, and touches no protected path; Yggdrasil's committed lock files
   (`.yggdrasil/yg-lock.*.json`) are reported as derived and left to `yg check` in the gate;
4. revert test — new test files in the diff, extracted onto the parent's tree, show at least one failure;
5. gate — green at the branch's SHA: taken from the verifier's verdict when it names this SHA with a
   green gate, otherwise the level's gate command from `config.gates` run in the branch's worktree;
6. graph — `yg check` green on the branch's own worktree. Only when `nodeSource` is `yggdrasil`, and
   then on every run whatever `config.gates` holds: where the graph is the node map, the graph is what
   says the code is right, and a repository whose own gate command never calls `yg` would otherwise
   show a green gate over a tree `yg check` exits 1 on. A red graph is a red gate. When the CLI cannot
   be started at all the item is ✗ (never a quiet ✓) and names `config.ygCommand`;
7. journal — `tk log` has an entry newer than the last commit.

For a team branch (`<horde>/<team>`, the item `team:<name>` in the parent's queue) the same items
read differently: 1 rooted at the parent's tip; 2 every ticket of that team is `merged` with its
keys; 3 the diff stays inside the union of the team's tickets' nodes; 4 skipped; 5 the level's gate
at the branch SHA; 6 the graph, exactly as for a ticket; 7 the team's `plan.md` has a wave close
newer than the last commit.

`--no-gate` skips items 5 and 6. Prints ✓/✗ per item; exits non-zero on any ✗. Never modifies the parent's tracked files; writes the gate
result under its level's key in `hordes/<horde>/cache/last-gate.json` (`{commit, team, trunk}`, each
with sha, result, count, at).

## cost.mjs — runs × class

`report [--wave n] [--ticket NNN] [--mission]` (runs and weighted sums from `cost.json`, which only
`roster.mjs spawn` writes, shape `{runs: [{name, role, class, ticket|null, team|null, wave, at}]}`;
against the charter's limit when set), `limit-reached` (exit 0 when reached, used by the steward before
dispatching).

## Tests

`scripts/tests/*.test.mjs` with `node --test`: every tool's happy path and every refusal named above,
on a temporary git repository created by the test itself. `npm test` in `scripts/` runs them. The
scripts are not done until these pass.

## premerge.mjs's revert test — how a new test file is found and run

Item 4 detects a new test file generically by name, against `config.testGlobs` rather than by
inspecting file content — a repository's own test patterns aren't otherwise knowable from this tool
set. `horde init` fills that key from the repository's build files; when it is empty the item is ✗,
because a ✓ reading "no new test files in diff" over a repository whose tests this tool cannot
recognize is the strongest guarantee in the checklist passing without looking. A ✓ names the
patterns it did look for. A matched file whose extension `node --test`
can run directly is extracted and run that way; anything else falls back to running the whole
`config.gates.commit` command in the scratch worktree, treating any red as "this file's a failure" —
isolating just one file's test lane out of an arbitrary configured command isn't possible in general.

Also worth knowing: `reproduced` requires `--revert failed` (the tool never infers the revert line
from the verdict), and `verify.mjs record --gate green|red` requires `--sha <sha>` and writes it on the
Gate line for either result ("green at sha …" / "red at sha …"). Premerge's gate check (item 5)
accepts a verifier's recorded green gate only when that sha equals the branch's current tip —
otherwise it runs the level's gate fresh. A team merge-up (no single ticket, so no verifier verdict
can name its branch) always runs the gate fresh.
