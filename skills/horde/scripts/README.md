# scripts — the contract

Every tool: Node ESM, zero dependencies, `--help`, `--json`, exit non-zero on failure with one line on
stderr. All tools resolve the repository root by walking up to `.git`, then the shared state root as
`<git common dir>/../.horde` so a worktree and the main checkout see the same state. `--horde <name>`
selects the horde; when only one exists it is the default. `--team <name>` selects a team; default is
`trunk`. `<name>` is always a team's short LEAF name (`alfa`), unique per horde — while nested
sub-teams are still readable on disk (`teams/<parent>/teams/<child>/`), a fresh mission only ever
files tickets on `trunk`: nothing spawns a sub-team any more, since that needed a steward to run it,
and there is no such role now. `_lib.mjs`'s
`teamPath()` still resolves that nesting for a pre-migration mission that has one, by walking
`roster.json`'s own `parent` links back to `trunk`; a full slash path (`trunk/alfa`) is also accepted,
but only when it matches what that resolution independently finds — anything else, including the
literal segment `teams`, is
refused rather than silently landing in the wrong directory. JSON files are the source of truth; every
`.md` beside one is rendered on write and never parsed. No tool ever rewrites history in a journal;
journals append.

Shared internals live in `_lib.mjs` (root discovery, JSON read/write with rendering, arg parsing,
table printing, timestamps, git helpers). Tools import it; nothing else does.

## horde.mjs — hordes

- `init <name> --base <branch> [--title "…"] [--test-globs <glob>[,glob…]]
  [--nodes <node>[,node…]]` —
  **the graph first.** horde-requires-yggdrasil: on a repository with no `.yggdrasil/` it runs
  `<ygCommand> init` from the repository root (never a subdirectory — Yggdrasil's own rule) and then,
  when `config.grainCommand` names a Grain CLI or a bare `grain` resolves on PATH, `grain propose
  .yggdrasil-proposal` followed by `<ygCommand> adopt .yggdrasil-proposal --replace`, whose own report
  — components, rules by status, and how many sites in the code already here the new rules refuse —
  is printed verbatim. With no graph and no Yggdrasil CLI it refuses outright, naming the install
  step, **before** `.horde/` or anything else of this horde exists. With Grain absent the graph is
  created empty and the result says how to name a Grain command and what that would add.
  Then: creates `.horde/` if missing (with
  `.gitignore` = `*` and a default `config.json`), `hordes/<name>/` with `charter.md` from the template,
  empty journals, `teams/trunk/`, and the branch `<name>/trunk` off `<base>` (no checkout of the
  main tree). The result also says that
  `yg check` is now part of every merge check. It also reads the repository's build files for two
  things it must not invent — the command that proves the repository still works, and the patterns
  its tests are named under (`package.json`, `pom.xml`, `build.gradle`, `Cargo.toml`, `go.mod`, a
  Python project file, a `Makefile` with a `test:` target) — and says in its result what it worked
  out, or, when it worked out nothing, that it did not and what to set. `--test-globs` names the
  test patterns outright. Refuses an existing name. `--nodes` binds the charter's touched nodes at
  creation (node-lease-across-hordes): each is leased to this horde in `.horde/leases.json` — shared
  by every horde on the repository — and a node another *live* horde already leases refuses the
  whole command, naming that horde and its last activity, before the branch or any of this horde's
  own state is created. See `node.mjs bind` below for the same check made any time after init, and
  "Node leases, kept as territories" in `reference/model.md` for the full contract. `--quality autonomous|only-the-work`
  writes the charter's quality policy; the template's own default is `autonomous`.
- `list` — hordes with trunk, base, wave, open tickets, leased nodes, last activity.
- `config get|set <key> [value]` — `.horde/config.json`: `base`, `gates.commit|team|trunk` (commands),
  `testGlobs[]` (the patterns this repository's tests are named under — the merge checklist refuses
  rather than guess when it is empty), `ygCommand` (how this
  repository invokes the Yggdrasil CLI
  — default `yg` on PATH; set it to e.g. `node path/to/bin.js` for a local build), `grainCommand`
  (how it invokes Grain, when it has one — default none, and `init` says what naming one would add),
  `keyContext` (how many lines of surrounding code a review's key is bound to — default 3; see
  "keys are bound to the diff" below), `protectedPaths[]`, `fixRounds.resume|fresh` (the fix-loop
  breaker `tk.mjs status <ticket> changes` reads: rounds 1..`resume` resume the same worker, the
  next `fresh` rounds spawn a fresh one a class up, beyond that the command refuses — defaults 3
  and 2), `liveness.stewardMinutes|ownerMinutes`
  (also accepts `liveness.stewardSeconds|ownerSeconds` — a `*Seconds` key wins over its `*Minutes`
  counterpart when both are set; useful for tests and fast-loop tuning where a whole minute isn't
  practical), `classes` (weights: haiku 1, sonnet 3, opus 10, fable 30 — defaults), `parallelism`.
  A list-valued key (`testGlobs`, `protectedPaths`) takes either a comma-separated list or a JSON
  array and is stored as a list either way — never as the text of one.
- `charter show|edit [--ask id]` — the mission charter. `show` prints it; `edit` replaces it
  with what arrives on stdin, and reports how
  many evidence rows the new text carries and how many are recorded as reproduced — naming any row
  that was recorded and is no longer, since a rewrite that drops one loses work already done against
  it otherwise. This is how the goal, the non-goals, the evidence catalogue and every amendment are
  written: the charter is the one file where what the chairman asked for lands, and it is written
  through a tool like everything else. Dropping a row outright (present before, gone from the new
  text entirely) is free before the mission's wave 1 has started; once it has, the drop refuses
  unless `--ask <id>` names an answered ask of kind `charter` (`ask.mjs`) whose own text (its `why`
  and the client's answer together) names every row being dropped — the reason then lives in the
  ask's own answer (`decisions.md`'s `ask-<id>` entry), not only in this command's own output.
  The charter's `## Quality` section carries the one field of it a tool acts on rather than a person
  reads: `**Policy:** autonomous` (the default, and what a charter with no such section reads as) or
  `**Policy:** only-the-work`. Anything else is refused here rather than read as the default, since a
  word nothing recognises would quietly mean the opposite of what an operator writing it meant. Both
  `show` and `edit` report the resolved policy in their `--json`. `_lib.mjs`'s `qualityPolicy(horde)`
  is the one reader of it, scoped to that section so `## Cost`'s own policy line is never mistaken
  for it, and every tool that acts on the policy asks it rather than parsing the charter again.
- `archive <name>` — moves `hordes/<name>` to `hordes/_archive/<name>-<date>`; branches untouched.
  Also releases every node lease the horde held (`.horde/leases.json`) — the moment it is no longer
  live, another horde can bind its nodes with no `--take` needed.
- `done [--horde h]` — the mission's final gate (ruling `evidence-is-the-plan`: "the queue is empty"
  is never "done"). Refuses, listing every reason at once, when: any charter evidence row is not
  reproduced (first promoting whatever a merged ticket's own verdict already proved, mission-wide
  and regardless of wave, into the charter's "reproduced by" cell — the same reading `wave.mjs
  close` uses for one wave, stretched over the whole mission); the empty catalogue itself is also a
  reason (nothing to reproduce is not the same as done); `config.gates.trunk` is not green at the
  trunk branch's tip (a matching recorded green in `cache/last-gate.json` is accepted, anything else
  is run fresh in a scratch worktree); no audit verdict (`wave.mjs audit`) was recorded anywhere in
  the mission's last wave — "current" once that wave is closed means "the last one", not "none
  open", and a verdict recorded *after* that close counts toward it, since `audit-plan` draws its
  sample from the wave that has just closed; or no run has ever been recorded in `cost.json` (nothing has run, so there is nothing to
  report). Otherwise: the charter is already stamped (a side effect of the evidence check above),
  the completion block (`templates/mission-close.md`) is appended to the mission's `plan.md`, and
  the result says what to do next — push, a decision that stays the chairman's, never this tool's.

## status.mjs — the digest

One screen: hordes, for each: trunk sha and distance from base, its branch tip, ticket branches
beyond it (landed, unverified, unmerged, waiting), queue counts by state (including `waiting`), open
asks, the last recorded gate result per level, cost to date and limit, any lease another *live* horde
holds on a node this
horde's own tickets touch (node-lease-across-hordes — `.horde/leases.json`, shared by every horde
on the repository), and an **evidence** block: every row of the charter's evidence catalogue in one
of five states — `no-ticket` (nothing claims it), `queued` (a ticket names
it, not yet started), `running` (in flight), `merged` (a merged ticket already carries a reproduced
verdict naming it, but the charter has not been stamped yet — that happens at the next `wave.mjs
close`, a manual `wave.mjs evidence`, or `horde.mjs done`), and `reproduced` (the charter's own
"reproduced by" cell already names who). This is `wave.mjs`'s own `evidenceCoverage` — the same
reading `horde.mjs done` uses for its gate, read here without writing anything. `--horde`, `--team`
narrow it. `--json`.

## handoff.mjs — state of intent

`write --summary "…" [--next "…"]…`, `read`, `add-waiting <who> "<what>"`, `rm-waiting <who>` — one
handoff per horde, always at `hordes/<horde>/handoff.json` (+ `.md`). There is no `--by` or `--team`
any more: with only a director and one-shots left, a handoff scoped to a steward's own team has
nobody left to read it, and both flags are refused by name rather than silently accepted and
ignored, so a caller that still passes one finds out at once. `write` fills
`inFlight` from the queue's running items and `head` from git. `read` prints "fresh start — no
handoff recorded" when none exists yet.

## tk.mjs — tickets

Over `teams/<team>/issues/NNN-slug/{issue.md,log.md}`, NNN unique per horde (counter in
`hordes/<horde>/counter.json` — the one counter EVERYTHING the horde numbers comes out of, see
"Identifiers" below). A ticket reads as `t-NNN`; NNN alone is the same ticket, and stays the name of
its folder and of the `id:` its issue.md carries.
- `new <slug> --title "…" --node n --class haiku|sonnet|opus [--severity high|medium|low]
  [--kind work|quality] [--no-quality] [--depends NNN,…] [--files a,b] [--consumes <node>/<port>@<v>,…]
  [--produces <node>/<port>@<v>,…] [--evidence "…"]… [--revert-base <ref>] [--mutate "<command>"]` —
  from `templates/ticket.md`; status `proposed`. `--node` takes one node, or two when the ticket carries
  a contract between them; three or more is refused — no owner holds the whole of such a diff.
  `--revert-base` names the ref where the ticket's new tests must fail (a contract test
  is green on the team tip by design; its red base is e.g. `develop`); `land`'s revert-test item reads it, or
  a "red on <ref>" phrase in the acceptance lines. `--mutate` names a shell command that swaps the
  whole revert-to-base variant for a mutation one: `land`'s revert-test item runs it against a
  scratch copy of the branch's own tip instead of extracting the new tests onto a base tree, and
  requires them red there — for a ticket whose implementation is cheaper to break on purpose than
  to name a meaningfully failing base for. Refused together with `--revert-base` — only one variant
  ever runs, so declaring both would leave one of them silently unused. An
  `--evidence` value that is nothing but catalogue ids (`E2,E5`) fills the ticket's `**Evidence:**`
  field; any other value becomes its own `- [ ] …` line in the `## Acceptance — evidence`
  checklist, and any id cited inside it fills the field too. A catalogue id (`E1`, `E2`, …) must
  already be a row in the horde's `charter.md` evidence table — refuses otherwise, listing the
  unknown ids. `--kind` defaults to `work`; `quality` marks a self-filed improvement outside a
  wave's assigned scope (a better graph, normalization, tidy-up after green) — `queue.mjs next`
  always ranks a `quality` ticket after every `work` ticket, whatever its severity. `--no-quality`
  writes `**Quality:** only-the-work` on this one ticket — the single-ticket form of the charter's
  own policy, for a change delicate enough that nothing should ride along with it. Neither value ever
  permits the opposite: nothing at any setting makes a rule weaker.
  Ticket creation itself is one exported function (`createTicket`), so a ticket the quality pass
  files is the same object, validated the same way, as one an owner files by hand; `setTicketBody`
  is the same for a body, and `edit`'s own write goes through it.
- The four structural fields — `**Files:**`, `**Consumes:**`/`**Produces:**`, `**Evidence:**` — are
  what `queue.mjs plan` computes the mission's order from, and they are validated where they are
  written: every path in `--files` must lie inside the boundary of a node the ticket names (the same
  boundary reading `land`'s scope item uses — one function, in `node.mjs`, imported by both);
  `--consumes`/`--produces` must read `<node>/<port>` — there is no version, in the graph or in
  Horde; and a consumed port must be
  produced by some ticket of this horde (its own team or another's) or already exist on that node in
  the graph — refused by name otherwise. Port existence is read through `node.mjs`'s graph reading,
  in one place, so a later change of where the graph comes from changes one function.
- `list [--state s] [--node n] [--team t] [--review-pending] [--open]`, `show NNN [--log]`,
  `status NNN <state> ["note"]` (states: proposed queued running landed changes blocked verified merged
  escalated dropped — `blocked` is `tick.mjs`'s own, for a ticket whose fix rounds ran out) —
  `changes` is the fix-loop breaker: it counts the round in the ticket's log
  and prints it (`config.fixRounds`, defaults `resume` 3, `fresh` 2). Rounds 1..`resume`: resume
  the same worker with the findings. Rounds `resume`+1..`resume`+`fresh`: the result says "fresh
  worker, class up" — a new one, one class heavier (`config.classes`), briefed with `brief.mjs
  worker NNN --takeover`. Beyond that cap the command refuses outright — there is no next command
  to propose yet. `log NNN "text"`, `grep <re>`.
- `review-request NNN [--delta <path>]` — appends to the log with a timestamp; `--delta` names the
  file a scoped re-review was written to, so the log records which kind of review was asked for.
- `--node` on `new` is repeatable; two nodes mark a contract ticket.
- `move NNN --team t` — relocates the issue folder.
- `edit NNN --by <name>` — rewrites the body (everything from `## What` on) from stdin, leaving the
  header block (id/title, `**Status:**`, `**Node:**`/`**Class:**`/`**Severity:**`/`**Team:**`,
  `**Depends on:**`/`**Branch:**`, `**Files:**`, `**Consumes:**`/`**Produces:**`, `**Evidence:**`)
  untouched; appends "body edited by `<name>`" to the
  log. What owners use to write ticket bodies, instead of editing `issue.md` by hand.
- `edit NNN --by <name> [--files a,b] [--consumes …] [--produces …] [--evidence E1,…]` — changes
  those fields instead of the body (no stdin needed), each with its own log line naming who changed
  it, and validated exactly as `new` validates them. This is how a ticket is widened when the work
  turns out to touch a file it never declared — `land`'s scope item refuses that diff and names
  this command; a silent widening is what it exists to prevent.
- `edit NNN --by <name> --depends NNN,MMM` — adds dependencies, one per number, by calling
  `queue.mjs dep` rather than writing them itself. One writer owns the circle check, because a
  circle is only visible once the whole DAG is built (`buildPlan`), so a second path here would file
  a plan nothing can start and nobody would know until `plan` refused. The ticket has to be in the
  queue; the refusal says so.

## queue.mjs — the DAG

`teams/<team>/queue.json`: items `{ticket, state, class, branch, worktree, dependsOn[], stackedOn, agent, sha, notes[]}`.
States: `proposed queued waiting running landed blocked merged escalated dropped`. `proposed` is a ticket
nobody has ruled on: listed and counted like any other, and never a candidate for `next`. A
consultant files its own tickets and adds them with `add --proposed`; `refine.mjs --step review` is
the only thing that moves one to `queued`.
- `list [--state s]`, `add NNN [--depends dep,…] [--proposed]`, `set NNN <state> [--sha x] [--agent name] [--note "…"]`,
  `next [--class c] [--why] [--stack]` — ready = queued, every dependency merged, and clear of every
  `running` ticket's own lock: a ticket declaring `**Files:**` collides only on an overlapping
  path or glob; a ticket with none (or a `running` item whose ticket can no longer be read) locks
  every file of every node it names instead — the safe degradation for a ticket that never said
  which files it touches. Ranked: a `quality`-kind ticket (`tk.mjs new --kind quality`) always
  last, whatever its severity; then severity (read live from the ticket on every call, high
  first); then the longer remaining critical path through the ticket wins — `queue.mjs plan`'s own
  DAG, read straight off one in-process `buildPlan()` call, never a second, shelled-out `plan`;
  then a ticket whose nodes hold no `running` ticket; then FIFO by queue order. `--why` prints
  every `queued` item: its rank if it qualified, or the reason it didn't (an unmet dependency, the
  file lock naming the `running` ticket and the file(s) it shares, or the `--class` filter).
  `--stack` keeps in the ranking, below every ready ticket and in the same order among
  themselves, each queued item whose unmerged dependencies are all in this team, `running` or
  `landed`, and on a branch — returned as `stackReady: true` with `stackOn` naming them, since it
  can be started now on top of one. The lock holds there too: the ticket it would start from is
  often the one holding the file. Without `--stack`, such an item is skipped as before, and
  `--why` says which tip it could have started from.
  `rm NNN`, `move NNN --team t`, `render`, `reconcile` (every `running` item: a commit beyond its
  parent's tip → `landed`; a dirty worktree → `git add -A && git commit -m "wip: reclaimed"` on the
  ticket branch, then `queued` with a note; a clean worktree and no commit → `queued`, worktree
  removed. A `waiting` item is left untouched — it has nothing running to reconcile).
- `plan [--team t] [--apply-order]` — the team's DAG, derived from the tickets and printed, never
  dispatched. Two kinds of edge, added together and never overriding one another: a ticket that
  `**Consumes:** <node>/<port>` comes after the ticket that `**Produces:**` that same port — no
  version to compare, so the port name alone is the match (in its own team or another's — a
  cross-team producer is reported as what the ticket waits on outside the team); and whatever was
  written by hand, on the ticket's `**Depends on:**` field and on its queue item. It then reports:
  the layers (topological antichains), the critical path in tickets and in class weight, the
  connected components with the tickets that hang loose on their own, tickets with no order
  between them that claim the same file, files three or more tickets claim, the extra approvals a
  port change owes (who consumes it: `node.mjs`'s `consumersOf`), consumed ports nothing produces,
  the charter evidence rows no ticket names, the cost (Σ class weight × 2 runs per ticket) and the
  waves that many layers need at
  `config.parallelism`. Merged and dropped tickets are out of the plan — it is what remains to do.
  A circle of dependencies is a refusal, with the circle printed. `--json` is a `horde-plan/1`
  document carrying all of it. `--apply-order` records the order `plan` proposed for a file clash
  (fewer files first) as an ordinary dependency on the queue item, with a note saying why.
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
  and skip branch creation. `set NNN merged --sha x` also appends the merge's bullet to the team's
  wave journal, so a merge costs one write and not two: `wave.mjs close` reads that journal to work
  out which evidence rows the wave turned green, and the catalogue used to sit at zero whenever the
  second command was forgotten. `wave.mjs merged` remains, for a merge the queue never saw, and
  never records one twice.
- `set NNN running --on MMM` cuts the branch from `MMM`'s tip instead of the team's — a **stack**, so
  a chain of tickets does not cost one wave per link — and records `stackedOn: MMM` on the item.
  `MMM` must be a dependency of `NNN` (a stack follows the merge order, never crosses it), in the
  same team, `running` or `landed`, and on a branch that exists; each of those is a named refusal,
  as is `--on` on a ticket whose branch was already cut somewhere else (moving a base under work
  already done is a rebase this tool does not do). From then on the item's **parent branch** — the
  branch it is rooted on, measured against, and merged into — is `MMM`'s, everywhere: base
  freshness, the diff its keys bind to, the scope, the revert test, the range-diff of a moved diff,
  and the branch the worker's and verifier's briefs tell them to merge. `set MMM merged` clears
  `stackedOn` on everything stacked on it by the same write, and the parent is the team branch
  again — with the work now in it, the stacked ticket's own diff is unchanged, so its keys hold and
  only the gate re-runs.
- Refuses `set NNN merged` while any dependency of the ticket is unmerged (merge order is the
  dependency order, stack or no stack).
- `quality [--from <path>] [--class c] [--dry-run]` — **the quality pass** (ruling
  quality-always-authorised). Reads a `grain-advice/1` document — `config.grainCommand`'s own
  `advise --json` (its progress goes to stderr; the document is what it prints on stdout), or
  `--from` a file — and files one `--kind quality`, `--severity low` ticket per improvement it names,
  on the node the item names, with the
  advisory's text as the ticket's **Why** and "the architecture answered this, or [the node's log /
  the rule's own log] says why it stands" as its acceptance — a `rule`-kind advisory (the code already
  follows a pattern nothing enforces) points at the rule's own log once one is filed, since that is
  where its reasoning belongs (152/153); the other three kinds (relation, split, port) are genuinely
  about the node and keep pointing there. Each ticket is queued immediately: **no escalation, no
  ruling** —
  that is what the ruling means by autonomous. `next` already ranks them behind every work ticket.
  An item is filed once and never twice: what has been filed is remembered by what the item says
  (kind, nodes and the text itself), not by its position in a list Grain recomputes every run.
  It reports and files nothing, at exit 0, when the charter's policy is `only-the-work` or no Grain
  CLI is configured; a document that is not `grain-advice/1` is a refusal naming what was seen, never
  a guess. `--dry-run` reads and reports without filing.

## refine.mjs — the cut, the consultation, the review, the frame

`refine.mjs [--step cut|consult|review|frame] [--horde h] [--team t]`. The only phase that needs
judgment, and the only one where anything is negotiated. Like `tick`, it spawns nothing: it prints
the spawn lists and takes their results back off disk. Every step runs twice — once to print the
brief, once to read back the file that brief asked for — and a step with nothing to read yet never
guesses at an answer.

- `--step cut` — first run prints a one-shot architect's brief (the mission card, the `yg
  tree`/`structure`/`node`/`impact` reads, Grain's map where there is one, and what a territory is).
  The architect answers by writing `hordes/<horde>/territories.json`:
  `{"<territory>": {"nodes": ["<node>", …], "class": "<class>", "why": "<one sentence>"}}`. Second
  run checks it and leases every territory in it. Three rules are checked by the script, not asked
  for in prose: a territory is a set of WHOLE nodes (a name that resolves inside a node is refused,
  naming the node it would split — the node is Yggdrasil's own unit); any level counts, a whole
  subtree root included; and one node sits in at most one territory. The class is validated against
  `config.classes`, never against a literal here. Everything is checked before anything is claimed,
  so a refused cut leaves no lease behind.
- **The size.** `config.territory.maxBytes` (default 400000), one number for the whole horde: the
  bytes of the code a territory's nodes map, plus the text of every rule that reaches those files
  (counted once per rule), plus those nodes' own logs. Over it, refused with the count broken into
  code, rules and logs — which part is large says what to do about it. The boundary is closed:
  exactly the limit fits. One threshold and not a table of them per class, because the class decides
  what a territory COSTS, never what fits in one.
- **Leases.** `.horde/leases.json`, the same file and the same mechanism `node.mjs bind` uses, keyed
  by the territory instead of the node (the on-disk shape is unchanged; history's `node` field
  carries whichever subject the entry is about). A conflict with another live horde is refused,
  naming that horde and its last activity. A territory is never taken over: the refusal points at
  archiving the holder, or at the client, whose answer decides which mission gets the area.
  `horde.mjs archive` releases territories exactly as it releases nodes.
- `--step consult` — prints `[{territory, class, brief}]`, exactly one spawn per territory, all
  parallel, issued by the caller in one message. A brief carries only its own territory: `yg context
  --node --json` for each of its nodes (owner, rules with status and reviewer kind, paths), the node
  descriptions and logs, `grain where`/`how`/`obligation`, and the mission card cut to this
  territory's own evidence rows. Then the five questions, in order: what must change in me; is this
  a new module or a change inside one; does this break single responsibility; what pattern do I want
  and is it already law; what contract do I need from a neighbour. The consultant writes its own
  tickets (`tk.mjs new`, then `queue.mjs add --proposed`, with `tk.mjs edit --depends` for the
  edges) and its own law proposals (`node.mjs propose rule`). Nothing comes back as prose. It decides
  the inside of its territory; it does not decide the boundary. Grain is optional, so a brief without
  it still renders and says what is missing rather than falling over.
- `--step review` — first run writes the plan whole to `hordes/<horde>/plan-<team>.md` and prints a
  one-shot architect's brief carrying that file's own text (never a summary — a plan relayed as one
  has already lost the thing being looked at) and the five questions a plan is ruled by, quoted from
  `reference/roles/architect.md` rather than copied. A circle refuses the step outright and carries
  the circle in the refusal. The architect answers by writing `hordes/<horde>/review.json`:
  `{"<ticket>": {"verdict": "pass"|"reject", "why": "<one sentence>"}}`. Second run applies it: a
  pass moves the ticket and its queue item to `queued`; a rejection leaves both `proposed` and puts
  the reason on the ticket's own log; a ticket nobody ruled on stays `proposed` and is never
  dispatched, because silence is not a pass. This is the only way out of `proposed`.
- `--step frame [--json]` — the data a session renders to the client through Ratatoskr. Three
  sections and not one tool name: what will change and where (territory → nodes → tickets), what it
  will prove (the charter's evidence rows through `parseEvidenceRows`, with who is taking them and
  which nobody has), and what the law gains (the consultants' rule proposals, one sentence each). A
  cut of one territory with one ticket says so plainly rather than dressing it up. The client's "go"
  is the only approval in the whole mission run, and nothing is exposed before it.

## brief.mjs — rendered briefs

`brief.mjs <role> [args]` prints the brief for a role, filled from `reference/roles/<role>.md`. Four
roles, a closed list: `architect`, `worker NNN [--takeover]`, `legislate <territory>`, `retro`. Any
other name — including `steward`, `owner`, `verifier`, `auditor` or `counsel`, gone with the seat
cassation — is refused as unknown, naming these four and no others. `worker --takeover` renders a
takeover section — a prior
worker attempted this ticket N times, the ticket is yours, here is its log — for the fresh,
one-class-up worker `tk.mjs status NNN changes` hands a ticket to once its resume rounds
(`config.fixRounds`) are spent; N and the log come from the ticket's own log, the same "round
N/cap" line `tk.mjs` itself wrote.

Fills `{{…}}` from the charter, the config (`fastCheck` = `gates.commit`, `protectedPaths`), the
cache (`fastCheckCount` from `cache/last-gate.json`, or "unknown — report the count you get"), the
component (`node.mjs`: the ports on its border with their consumers — what the worker
must not break), the ticket (`worktree` and `branch` from the queue item), and `reportsTo` — the
agent's own parent, "main" (the director's own session name) whenever nothing more specific is on
file. Refuses to render with an unfilled placeholder. After the
role's own text it appends a `## Law` section: the disciplines that role is held to, inlined from
`reference/discipline/` — worker (tdd, debugging), architect (framing's checklist), legislate
(review), retro (review, verification). The
texts live there once, so an edit to a discipline reaches every brief that carries it. Records
nothing. The caller copies the output into the Agent tool's prompt verbatim.

`legislate <territory>` is the one-shot that writes a territory's law down. Everything in its brief is
scoped to that territory and to nothing else: the landing gate's refusals on ITS tickets (from
`land`'s own result files under `hordes/<horde>/land/`), those tickets' own logs, and the rules the
graph declares that reach nothing at all here. It writes rules in its own branch, attaches them to its
own components, and raises them on evidence with `node.mjs promote`; it never lowers one, and the
landing gate's law guard refuses a branch that tries. The territory comes from `territories.json`
(`refine.mjs --step cut`); without one the command refuses rather than write law for an area nobody
named.

`retro` is the one-shot that runs once, at the end of a mission: see `retro.mjs` below for the
gather/classify/write shape it fits into. Its brief carries the whole mission's gate refusals and
ticket-log remarks inline — never a summary — because the cross-territory repetitions are the reason
to read it in one place rather than once per area.

The consultant `refine.mjs --step consult` spawns is not one of these four — it is never rendered
through `brief.mjs`, has no entry in `reference/roles/` and no row in `ROLE_LAW`, and is spawned
straight off disk by `refine.mjs` itself (see `refine.mjs` below). It is still held to framing's
checklist, spliced into its own brief directly by that file, using `disciplineSection`/
`demoteHeadings` exported from here for exactly that.

## node.mjs — nodes and the graph

The only tool that speaks to the graph, and it speaks to it only through the Yggdrasil CLI's own
versioned machine documents: `yg node <path> --json` (`yg-node/1` — mapping, relations, ports, kin),
`yg context --node|--file <path> --json` (`yg-context/1` — the rules in force, with each one's
effective status and the channel it arrives by, plus, for a file, the component that owns it), and
`yg impact --node <path> --json` (`yg-impact/1` — who consumes each port, and what depends on the
node). Nothing here parses a file the layer below owns. A CLI that cannot be started, and one that
answers those calls with anything but the document, are both refusals that name what to do —
install the CLI, point `config.ygCommand` at a build, or upgrade to the same 6.x line as this
release of Horde. There is no second graph and no manual mode to fall back to.

The one thing read off disk is the list of node ids: the directory names under `.yggdrasil/model/`,
which is what node identity IS in all three layers. Every fact about a node still comes from the
documents.

It is also where the other tools read the graph from, so there is one reading of it and not four:
the boundary of a ticket's nodes and the glob matching over it (`tk.mjs`'s file validation and
`land`'s scope item), the ports a node publishes (`tk.mjs`'s refusal of a consumed port nothing
produces), and `consumersOf(node, port)` — every node that consumes one node's port, from
`yg impact`. `consumersOf` is what decides whose approval a port change requires — one derivation,
several users.

- `bind` (no node) — verifies the graph is readable **through the CLI** (it asks the documents about
  a real node, so "readable" is not merely "a directory exists") and lists nodes.
  `bind <node> [--horde h] [--take --ask <id>]` — node-lease-across-hordes: leases `<node>`
  to this horde in `.horde/leases.json` (node -> `{horde, since}`, shared across every horde on the
  repository, not per-horde). Binding a node this horde already holds is a no-op (`status: held`).
  Binding a free node claims it (`status: claimed`). Binding a node a *live* other horde holds
  refuses, naming that horde and its last activity, and names the take-over command; `--take`
  overrides the refusal but only with `--ask <id>` naming an **answered** ask on this horde
  (`ask.mjs`) — a missing or unanswered id is refused just like
  no `--take` (`status: taken` on success, with `from` and `ask` in the result). A take-over
  is written to the node's own log (`yg log add --reason`, run for real, not merely printed) as well
  as to `leases.json`'s own append-only history; `logged` in the result says whether the node log
  write happened (it is skipped, never refused, when the node's own graph object doesn't exist yet
  to log against). `horde.mjs archive` is the only place a lease is released outright.
- `map [--horde h]` — the mission's nodes with the ports each publishes (by name) and how many port
  proposals are open on it. The `owner` column is read from a pre-migration mission's `roster.json`
  only — nothing writes one any more, so a fresh mission always reads `-` there. There is no
  currency stamp: the lock binds every verdict
  to the hash of the code it judged, so `yg check` is the one answer to "is this current", and a
  second one kept here could only disagree.
- `show <node>` — boundary, **the rules in force on the node**, its ports, last log entries. There is
  no node charter any more (removed with the seat cassation) — a node's rules, ports and log are the
  whole of what it carries. The rules come from `yg context --node <n> --json`: every aspect the graph
  attaches to this node
  through any channel, each with the status word that says what a refusal costs (`enforced` blocks a
  merge, `advisory` warns, `draft` is inert) and the channel it arrives by.
- `log <node> "…" [--run]` (prints the `yg log add` command; `--run` runs it).
- **Ports are the contracts** (port-is-contract). `contract propose <node> <port> "<why>" --by
  <name> [--aspects a,b]` proposes adding a port, or changing one the node already publishes —
  there is no version, in the graph or in Horde, so a port is referenced by name alone. The result
  names every node that already consumes it. `contracts [--pending] [--node n]` lists the ports
  the mission's nodes declare — name, description, consumers — read from `yg-node/1`, plus this
  horde's own open proposals;
  `--pending` shows only the proposals. `contract approve|veto <id> ["why"] --by architect` rules on
  one, and an approval prints the filing the architect makes by hand: the `yg-node.yaml` edit, the
  `yg log add`, and the free run that records the contract baseline.
- `verdicts [--at <path>] [--by <name>]` — verifier-is-yggdrasil-reviewer: the prose rules over a
  tree that no judge has answered yet, each with the exact `yg verdict package` and
  `yg verdict record` commands that answer it. `--at` names the worktree to read (default: this
  one). Read-only. Which pending pairs are prose is the graph's own word — each unit's context
  document names the reviewer kind of every rule reaching it — never "whatever is left over", which
  would call a script rule a prose one on any tree where the free run had not happened and send a
  verifier off to judge what a command answers for nothing. Script rules still without a verdict are
  reported separately, with the free command that settles them.
- `propose <kind> "…" --by <name>` (kinds: new-node, move-boundary, rename, rule), `proposals
  [--open]`, `approve|veto <id> ["why"] --by architect`, `apply <id>`. Approval and apply record;
  filing into the graph is the architect's own `yg` calls, and `apply` prints the exact edit.
- **The status ladder** (ruling quality-always-authorised). A rule goes draft → advisory → enforced,
  and which rung it deserves is a question about evidence. `ladder` lists every rule the graph
  declares with its rung, the number of cases it is drilled against, what it refuses here, the
  baseline it was granted against and how many closed waves have seen nothing new; read-only.
  `promote <aspect> [--by <name>] [--node <path>] [--with-reviewer]` grants the next rung when the
  evidence carries it, and refuses naming exactly what is missing when it does not:
  - *draft → advisory* — `yg drill --aspect <id>` runs clean over a corpus that actually has cases
    (an empty corpus is never a pass: nothing has been run against that rule). The move records the
    **baseline** — the refusals `yg check --json` reports for that rule once the rung makes its pairs
    exist, after the free keyless fill — so a later reading above it is a new violation and a reading
    at or below it is not.
  - *advisory → enforced* — two closed waves whose reading saw nothing new **and** left nothing
    unjudged, plus a rule that refuses nothing at all right now. The second condition is not
    decoration: "enforced" means "blocks the merge", and granting it to a rule with outstanding
    refusals would redden the trunk on purpose, which is the fall this ruling exists to prevent.
  The move itself is what Yggdrasil prescribes and nothing more: the `status:` line of the rule's own
  `yg-aspect.yaml`, then the numbers in self-contained prose in the rule's own log — one entry per
  raise, `yg aspects log add --aspect <id> --reason "…" --status <rung> --evidence "…"` — never a
  courtesy copy on every node the rule reaches. Only *advisory → enforced* also leaves a one-line
  pointer on those nodes (found the same way: the units `yg check` reports pairs for, falling back for
  a draft rule — which has no pairs at all — to the mission's own nodes asked one by one; `--node
  <path>` names one outright, for a rule that reaches files rather than components), because that is
  the raise that changes what a node's own code is held to — a fact about the node, not only about the
  rule; *draft → advisory* touches no node at all. Never a lock, never a `yg-suppress`, never
  `review_by`. A rule a reader judges costs money to drill, so `promote` refuses it until
  `--with-reviewer` says to spend that. Under a charter set to `only-the-work`, `promote` refuses
  outright. An installed `yg` that predates the rule's own log ("yg aspects log add"/"yg aspects log
  read") is refused too, naming the release to upgrade to — the same shape 148's own refusal takes for
  `yg-check/1`.
- `demote <aspect> --to draft|advisory --by user --why "<what they said>"` — the one direction nobody
  in the horde may take alone. Without `--by user` it refuses, and `--by architect` is refused just as
  flatly — and either refusal still leaves a best-effort note in the rule's own log saying who reached
  for it and was told no, since that is itself worth a rule's history even though nothing moved;
  `--why` is required for an authorized demotion, and — as before — goes into the log of every node
  the rule reaches: a lowering is a fact about the node too, whichever rung it moves between. There
  is deliberately **no** command here for a suppression or a review date: both weaken a rule,
  Yggdrasil already asks the user for them, and the horde adds no way around that.
- The horde's own working for all of this lives in `hordes/<horde>/graph.json` beside the proposals:
  per rule, the rung it was last left on, when, the baseline, the drill that justified it, one
  observation per closed wave, and every move with its evidence. `wave.mjs close` is the only thing
  that records an observation — the two-wave test counts closed waves, so a rule cannot be promoted by
  running a command twice in one afternoon — and it marks each raise as shown to the chairman, so no
  raise is listed twice and none falls between one wave's close and the next one's start.

## law.mjs — what the mission did to the law

`law.mjs diff [--wave n]` writes one `horde-law/1` document to `hordes/<horde>/law/wave-<n>.json` and
prints its path. `wave.mjs close` and `horde.mjs done` both call it; running it by hand only looks.

The two trees it compares are the ones the mission's own config names: `config.base`, the branch the
mission was cut from, and the tip of `<horde>/trunk`. So the document is cumulative — what the law has
gained since this mission started, asked again at every close. What one wave did on its own is
`wave-<n>.json` minus `wave-<n-1>.json`, which needs no second mechanism to say.

```
{ schema: "horde-law/1", horde, base, trunk, at,
  added:    [ { aspect, description, status: {from, to}, nodes: [...], why } ],
  raised:   [ … ],
  attached: [ … ] }
```

`added` is a rule the base does not have at all; `raised` is a rule standing higher on the trunk than
on the base; `attached` is a rule at the same rung reaching units here it did not reach there (compared
only over units BOTH trees have, so a file the mission added is never mistaken for a rule that grew).
`description` is the rule's own; `nodes` are the components the gate verifies it over, read from
`yg check --json --full`'s pairs — one call per tree, the same reading the landing gate's law guard
takes (`yg impact --aspect` has no `--json` in any released CLI); `why` is the last entry of the rule's
own history (`yg aspects log read --json`), `null` for a rule nothing has been recorded about.

A rule that reaches nothing is in the document with `nodes: []`, not left out. A wave that did nothing
to the law leaves a document with three empty lists, not a missing file. A document that could only be
read off one of the two trees is not written at all: half a comparison is not a smaller answer than
none, so a missing base branch, a CLI too old for the documents, or an unwritable `law/` is a refusal
naming what could not be read. Writing the same wave twice replaces the document; nothing is appended
and nothing is written into the graph.

## audit.mjs — the law audit at a close

Not a command. Imported by `wave.mjs close`, which is the only thing that runs it: nobody in this
family guards the law from a seat of its own, and a close is the one moment already given over to
reading where things stand.

Three sweeps and one line.

- **Review dates.** Every rule the trunk declares whose `review_by` has passed gets a `t-` ticket on
  the territory of a component it reaches — "renew or retire", with what the rule's own history last
  recorded. The ticket's acceptance is a `g-` proposal carrying the reason, and an explicit refusal to
  touch the date: moving a review date is the same move as lowering a rule or waiving one, and all
  three are the client's alone. A rule reaching no component this mission holds is reported as such,
  never filed on somebody who cannot answer it.
- **The attention feed.** Every item in `yg advise --json` this horde has neither queued nor been told
  to leave alone gets a `t-` ticket carrying Yggdrasil's own what/why/next verbatim. An item a
  recorded decision hides comes back in the document's own `suppressed` list and is counted, never
  re-raised — a dismissal takes a human-signed `--reason`, which is what makes it a decision. Two
  classes are skipped by name: an overdue review date (the first sweep files it, with the rule's
  history beside it) and an `imported:` proposal (`queue.mjs quality` files those, from the
  producer's own document, against its own ledger).
- **What the repository says about itself.** `grain advise --json` from the trunk, down the same path
  `queue.mjs quality` walks — same command, same `grain-advice/1` schema, same lease filter. It
  **reports and files nothing**: one filer, one ledger. The close says how many advisories stand on
  this mission's own territories and names the command that files them.

Then the line the three are for: **rules nothing has hit** — a rule the horde has watched across
`QUIET_WAVES` (2) closed waves with nothing new against it, and, when `yg aspects --health` can be
read, Yggdrasil's own reading of that same silence. That reading is deliberately not "this rule is
useless": a rule that is never violated may be deterring the very violations it would catch. Horde
never coins a word for it — it prints Yggdrasil's `signal` cell and the plain-words line under the
table verbatim, or it prints nothing. (`--health` is refused alongside `--json` by Yggdrasil on
purpose, so there is no machine form to ask for; the alternative to parsing that table is inventing a
label, which is the one thing this line exists not to do.)

Both ledgers live in the horde's own `graph.json`, under `audits`, keyed by what the finding IS
(`review-by:<rule>`, or the attention item's own stable id) — a rule stays overdue until somebody
answers, so without the record the close would file the same ticket every wave.

**Every read it cannot make becomes a note, never a refusal.** A close is the wave's only record, and
a wave that cannot be closed has no record at all; holding that hostage to a courtesy sweep trades
something irreplaceable for something true again next wave. So a feed that refuses, a Grain CLI that
will not run, a health table that is not a health table — each is named in the report and in the
close's JSON, and the close goes on. The one thing never softened is a document that is not the
document: a wrong or missing schema is a failed read naming what was seen, never parsed leniently.
Two things sit outside this: `yg aspects --json` is read once, by the law diff the close runs first
(which hands its readings over, so there is one reading of one commit), and a CLI that cannot answer
it has already stopped the close there; and a repository with no Grain CLI configured is not a failed
read at all, it is a repository that does not use Grain.

Under a charter set to `only-the-work` none of it runs and the block says so.

## Identifiers

One counter per horde (`hordes/<horde>/counter.json`), three prefixes, no exceptions:

- `t-NNN` — a ticket
- `g-NNN` — anything the architect rules on: a graph change, a port proposal, a contract proposal, a
  rule proposal
- `a-NNN` — a question put to the client

There is no `e-` or `d-`: escalation and dissent folded into the client channel and have no kind of
their own. Because all three share one sequence, a ticket and a graph item never wear the same number,
so an id on its own is an unambiguous question. An id is rendered with its prefix and accepted either
way; a bare number still resolves for one release and says so when it does, for a mission started
before this. A `graph.json` from before the shared counter — where a port and a proposal can both call
themselves "1" — is read exactly as it stands, and every number issued from then on clears the highest
of both old sequences.

## ask.mjs — the one channel to the client

Everything that used to travel as an escalation or a dissent goes down one channel now, and only
four kinds travel down it: `stop` (a worker ran out of spec and wrote down the question instead of
guessing — the ticket stays put), `stuck` (`tick.mjs` filed this one, not an agent — a ticket
exhausted its fix rounds), `lower` (a request to weaken a rule: demote, an added `yg-suppress`
marker, a moved `review_by`, an aspect detached from a node — requires `--aspect`), and `charter`
(a mission-card change: the goal, an exclusion, an evidence-catalogue row).

- `add "<why>" --kind stop|stuck|lower|charter [--ticket NNN] [--territory t] [--aspect a] [--horde h]`
  — `--aspect` is required for `lower` and refused for the other three kinds.
- `list [--open]` — open first, newest first.
- `show <id>`.
- `answer <id> "<answer>" [--scope once|mission] [--horde h]` — the one place the client's word gets
  recorded: it appends the answer to `decisions.md` (slug `ask-<id>`) **before** marking the item
  answered, so a decision that failed to record — a duplicate slug, a read-only file — never leaves an
  item silently closed with nothing durable behind it. `--scope` is accepted only for kind `lower`:
  `once` (the default) spends the grant on the landing that uses it; `mission` stands until
  `horde.mjs done`. `land.mjs`'s law guard reads this answer, not the raw item, to decide whether a
  branch that weakens a rule may land; a `stuck` ticket returns to the queue or closes as not-done only
  through an answer here.

State: `hordes/<horde>/asks.json` (source of truth) + `asks.md` (rendered).

## escalate.mjs — the recurring-answer scan

Everything else the old escalation channel did — a build decision (a contract, a boundary, a
conflict between two tickets), ruled and routed by hand — is gone with the roles that filed it: that
is the director's own call now, recorded with `decide.mjs add`. What is left here is the one thing
worth automating: noticing that the client keeps being asked, and answering, the same question. This
is the second of the three triggers for legislation (the first is the consultant during `refine.mjs`,
the third is `legislate.mjs` after a wave close). No state of its own — it reads `ask.mjs`'s own
`asks.json` and only ever proposes, never files: filing a rule is the territory's own agent's move.

`recurring [--min <n>]` — the **answered** asks (`ask.mjs`) grouped by kind and by territory (an ask
with no territory groups under `(no territory)`). A group of `<n>` (default 3, minimum 2) or more is
an answer this horde keeps giving the client by hand, and the third time is not another answer — it is
a rule. Each such group prints as a proposal: the answers as evidence, one line of rule text quoting
the latest of them, and the steps that file it — where the group has a territory, filing the rule
itself (`.yggdrasil/aspects/<id>/yg-aspect.yaml`, attached to that territory's node — an edit this
tool makes no graph object for), then `<config.ygCommand> aspects log add --aspect <id> --reason "…"`,
since a rule's own reasoning belongs in its own log once it exists, not the node's; `decide.mjs add`
where the group has no territory to hang a rule on at all. It
prints those steps and never runs them — the agent that works that territory does the filing, in its
own branch, and raises the rule on its own evidence with `node.mjs promote`.

## decide.mjs — rulings and lessons

`add <slug> "<ruling>" [--ticket NNN] [--node n]`, `list [--grep re] [--node n]`, `show <slug>`.
Appends to `hordes/<horde>/decisions.md` (`## <date> · <slug> [· ticket NNN] [· node n]`); refuses a
duplicate slug. Architectural decisions belong in the graph's own log and are not stored here; the tool
says so whenever `--node` is given, and prints the `yg log add` command instead.

## wave.mjs — the journal

Appends to `hordes/<horde>/plan.md` (team waves to `teams/<team>/plan.md`): `start [n] [--team t]`,
`note "…"`, `merged NNN <sha>`, `audit NNN clean|findings "…"`, `audit-plan [--seed <n>] [--team t]`,
`close [--gate green|red] [--sha <tip>]
[--evidence E5,…] [--team t]` (renders `templates/wave-close.md` with counts from the queue, the
evidence catalogue and `cost`; `--gate` with `--sha` records the level's gate at that tip in
`cache/last-gate.json`; `--evidence` fills catalogue rows the green wave gate itself proves),
`evidence <id> --by "<who/what>"` (fills one row by hand, for rows no ticket verdict can fill),
`current [--team t]`. Every close also writes the mission's `horde-law/1` document (see `law.mjs`) and
prints its path, and runs the law audit off that same reading (see `audit.mjs`). Its one-team,
one-wave judgement of "does a ticket prove this row" is also
exported (`evidenceCoverage`, `stampMissionEvidence`) stretched mission-wide — every team, every
wave — for `status.mjs`'s five-state evidence digest and `horde.mjs done`'s gate, so the two never
re-derive it independently.

`start` also writes the wave's own plan bullet: the layer sizes `queue.mjs plan` derives from the
tickets at that moment (imported, never a second derivation of the DAG), the parallelism the first
layer allows within `config.parallelism`, and the instant the wave opened — the three things the
close reads back to say what the wave planned, and to know which rulings belong to it.

Beyond the counts it always carried, `close` states five figures the chairman reads:

- **parallelism** — planned (the bullet above) against achieved (the most tickets this wave landed
  on any one day; a journal bullet is dated, not stamped, so the day is the grain the record has);
- **keys transferred** — the reviews this wave did not have to buy twice, summed from the bullets
  a pre-migration checklist wrote when a ticket's keys survived a catch-up;
- **the audit** as a sample, not a ritual: `hordes/<horde>/audit.json` holds every audited ticket
  with its verdict plus the current rate. The close turns this wave's `audit` bullets into samples
  (once per wave and ticket, so re-closing never double-counts), then lets the samples set the
  rate: a refutation among the last five doubles it, up to auditing every merged ticket; fifty
  clean samples in a row halve it, never below one per wave. It publishes refutations over samples
  with a Wilson 95% interval — because "0 of 3 refuted" and "0 of 300 refuted" are the same
  percentage and nothing like the same evidence.
  `audit-plan` prints how many of the last wave's merged tickets to audit next and draws them from
  those merges at random; `--seed` makes the draw reproducible.
- **decisions per merged ticket** — the escalations ruled since this wave opened, over the tickets
  it merged, with the trend across the closes before it. It is meant to fall: a horde needing as
  many rulings per ticket in wave six as in wave one has learned nothing.
- **the quality index** — read from the graph's own CLI (`config.ygCommand`) on the tree the close
  runs on, through its two machine documents: `check --json` (`yg-check/1`, for `totals.errors`,
  `totals.warnings`, `coverage` and `judges`) and `aspects --json` (`yg-aspects/1`, for each rule's
  status). Five figures — enforced rules, advisory rules with nothing recorded against them,
  blocking violations, the standing noise floor, and file coverage — each print with their delta
  from the previous wave, plus a sixth, the number of distinct external judges a verdict in force
  rests on, shown for the record but never part of what "fell" means. A CLI that runs but does not
  answer with `schema: "yg-check/1"` (or `"yg-aspects/1"`) — too old, or answering something else
  — is refused with the release to install, never read as text: the exact fragility these
  documents exist to remove. A fall in any of the five opens a `quality` escalation by itself:
  raising enforcement is the horde's own call, lowering it is the chairman's.
  One exception, and it
  is arithmetic rather than mercy: a rule the horde raised out of advisory this wave leaves the
  "advisory rules with nothing against them" count by getting *stronger*, so a drop no larger than
  the number of such raises is accounted for and not escalated; anything beyond it still goes up.

`close` also carries the other half of that ruling, in a block of its own:

- it takes each watched rule's **reading for this wave** — what the rule refuses now against the
  baseline it was granted on — and records it on the horde's own ladder ledger. The close is the only
  thing that records one, which is what makes "two consecutive closed waves" mean two waves rather
  than two commands; it runs `yg check --approve --only-deterministic` first (free, keyless) so the
  reading is refusals and not "nobody has looked";
- it lists **every rung the horde raised** that no close has shown yet, each with the evidence from
  the graph's own log, and marks them shown, so a raise is never listed twice and never falls between
  one wave's close and the next one's start;
- it lists the **quality tickets merged** this wave;
- and it ends with the veto: what was raised can be undone by the chairman and by nobody else, since
  lowering a rule, waiving one or moving a review date is theirs alone. Under a charter set to
  `only-the-work` the block says none of it ran, and no reading is recorded at all.

## land.mjs — the gate a change lands through

`land.mjs <ticket|branch> [--level trunk] [--no-gate] [--background]`, for a ticket branch
(`<horde>/t-NNN`). This is the last command a worker runs. Nine items, ✓/✗ each; **every one green
means the branch is merged into its parent here and now**, and a single ✗ means it is not. Nobody
signs anything either way — a green run is the signature, and the landed sha is the only trace.

It runs in a **fresh detached worktree at the branch's own tip**, made for the run and removed on
every way out. It does not read whichever worktree happens to hold the branch: a gate that measures
a tree somebody is still typing into is measuring the wrong thing, and briefing a reader into
someone else's tree is how three separate mission failures started.

Its **parent branch** is trunk's own (`<horde>/trunk`), or — while the ticket is stacked on a
dependency that has not merged yet — that dependency's branch; one answer, reported as `parent` in
the JSON, and every item below is measured against it:

1. base freshness — the branch is rooted at its parent branch's tip;
2. judge — every prose rule on this tree carries a judgement. `config.judge` says who makes it:
   `tier` means this repository has a Yggdrasil reviewer, which fills the pairs during the graph
   item's own run, so the only thing left to check is that none came back unjudged; `one-shot` means
   it has none, and the pending pairs are handed back on the result (`pairs`, each with the exact
   `verdict package` / `verdict record` commands, plus a `brief`) with the landing reported not
   ready. There is no default — `horde init` works it out from the graph's own reviewer
   configuration, and a gate that guessed would either invent a reviewer or pay for one twice;
3. scope — the diff stays inside the files the ticket declared in `**Files:**`; a ticket that
   declared none falls back to the union of its node boundaries (from `node.mjs`). Either way it
   touches no protected path, and Yggdrasil's committed lock files (`.yggdrasil/yg-lock.*.json`) are
   reported as derived and left to `yg check` in the gate. A diff past a declared list is ✗
   "declared `<n>` files, touched `<path>` outside them" — the fix is `tk.mjs edit NNN --files …`,
   which records the widening in the log, never a quiet pass;
4. revert test — new test files in the diff, extracted onto the parent's tree, show at least one
   failure; or, when the ticket carries a `**Mutate:**` command, run against a scratch copy of the
   branch's own tip with that command applied, show at least one failure there instead. The variant
   is always the ticket's own choice, never a `land.mjs` flag. The result is derived by running
   them; nothing declares it to this gate, and no flag offers to say so, because a declaration
   about a test is not evidence about a test;
5. gate — `config.gates.<level>` run fresh on the branch's own tree. No recorded green run is
   accepted from anywhere: a "green at sha …" line in a ticket's log is a claim about a run this
   gate did not see. A command that hangs is stopped at `config.gateTimeoutMs` (default 15 minutes)
   and the limit is named, rather than a stuck process left behind a checklist that never finishes;
6. graph — the graph's own verdict on the branch's tree, on every run whatever `config.gates` holds:
   the graph is the node map, so it is what says the code is right there, and a repository whose own
   gate command never calls `yg` would otherwise show a green gate over a tree `yg check` exits 1
   on. Two halves. The free one runs here: `yg check --approve --only-deterministic` records every
   rule a script can decide, at no cost. What that leaves is the prose rules, which a reader has to
   judge — the item names each pending pair rather than approving it, and hands them to item 2. The
   item is ✓ only when a full `yg check` is green. A red graph is a red gate. When the CLI cannot be
   started the item is ✗ (never a quiet ✓) and names `config.ygCommand`; when the free run itself
   did not take — a judgement rule with no judge configured refuses it outright — the item hands
   over the CLI's own words rather than naming pairs it cannot classify;
7. mapping — every file the branch added is owned by a node on the branch's own tree; skipped with
   `--no-gate`;
8. journal — `tk log` has an entry newer than the last commit;
9. graph text — charters, logs and `graph:` commits touched by the branch carry no mission
   language.

A judgement has to be **committed on the branch** to count. The gate reads a fresh tree at the tip,
so a verdict sitting uncommitted in somebody's checkout is one this branch does not carry.

`--no-gate` skips items 2, 5, 6 and 7, and never merges. `--background` starts the run, prints the
path of the result file it will write (`.horde/hordes/<h>/land/<ticket>.json`, shape
`{ticket, branch, sha, ok, checks: [{name, ok, note}], at}` plus the tree it ran in) and returns at
once. A half-written result file reads as no file at all — the gate never trusts a recorded result,
its own or anyone's, and simply runs again.

### the two guards

Before any item is judged, two things are checked that no worker can fix by trying again. Both are
deterministic — no model is asked whether a change is a weakening; Yggdrasil's own machine documents
say so — and both refuse outright rather than reporting an item.

**The law guard.** A branch may not weaken the rules it is judged by. Six cases, each named
separately in the refusal because the fix differs for each: a rule present on the base and gone from
the branch; a `status:` demoted; a `review_by` moved; a **narrowed reach**; an added `yg-suppress`
marker; a rule detached from a node that carried it. Read from `yg aspects --json` (status,
`review_by`), `yg check --json --full` (whose `pairs` are exactly the set of units each rule
reaches) and `yg suppressions --json`, on the base tree and the branch tree. A CLI that cannot
answer the suppression inventory as a document **stops the run** rather than parsing a waiver
listing meant for a person: a suppression the guard failed to see is a rule silently switched off.

"Narrowed" is measured by reach, never by comparing predicate text — that would be guessing.
For a rule whose `when`/`scope` changed, the guard compares the set of units it reaches in each
tree, **restricted to units both trees have** (otherwise a file the branch adds reads as a widening
and one it deletes as a narrowing). A head set that is a strict subset of the base set is a
narrowing. A superset, or two sets neither of which contains the other, is not a lowering at all —
it is a change to what the rule says, and goes to the conflict guard instead. Identical reach with
changed text is editorial and stops nothing. The same lost pairs with the rule's text **unchanged**
are a rule unhooked from a node, reported as "detached". A rule that reaches nothing in either tree
is deletable with no signature: a rule that judges nothing weakens nothing when it goes.

The one thing that lets any of this through is the client's own word, in the mission's
`decisions.md`: an answered "ask" of kind `lower` naming that exact rule. `scope: once` is spent by
the landing that uses it — which writes a `**Consumed:**` line into the answer itself — and
`scope: mission` stands until the mission closes. An unanswered ask passes nothing.

**The conflict-of-interest guard.** A branch may not sharpen a rule and change the code that rule
refuses in the same landing: whichever way the rule now reads, it reads that way because the code
needed it to. Adding a new rule is not this — it judged nothing before. Raising an existing rule's
status is not this either — the text judging this code is the one that already judged it. Changing
what a rule *says* (`content.md`, `check.mjs`, `companion.mjs`, `when`, `scope`) while changing a
file it reaches is. The refusal names the rule, the file, and the way out: one ticket for the code,
one for the rule, landing separately so each is judged by a law it did not write. An answered ask of
kind `conflict` naming the rule lets it through.

### the lock

`.horde/gate.lock`, one per repository — `.horde/` is resolved through the git common directory, so
every worktree of one repository finds the same file, which is the point. It is held around the
expensive half only: the repository's own gate command and both `yg check` runs. Two landings on one
repository serialize instead of running each other's commands over each other's lock; the second
waits `config.gateLockWaitMs` (default two minutes) and then refuses, naming the pid holding it. The
file carries that pid, so a lock left behind by a process that died is **taken over with a note**
rather than waited on forever, and an unreadable (half-written) lock file is treated the same way.

### landing

Green means the branch is merged. `git merge --no-ff` into the parent, the worktree and the branch
removed, the wave journal written, and `{ticket, sha, at}` recorded in both the queue item and the
ticket's own log. The merge happens in the parent's own checkout when it has one and that checkout
has no uncommitted tracked changes; otherwise in a throwaway detached tree, with the parent's ref
moved by `git update-ref` naming the sha it started from — so a parent that moved under the run
refuses instead of overwriting what landed on it meanwhile. A branch tip that moved during the run
refuses too, naming both shas: the sha the items were measured against has to be the sha that lands.

A merge conflict is `git merge --abort`, the parent untouched, and a red item naming the conflicting
files. Red outside a conflict puts the ticket on `changes` with the gate's own words and ticks
`changesRoundInfo`'s round counter. Nothing is ever written to Yggdrasil's incident register: a red
gate is a rule doing its job, and an adopter's incident ledger is for rules that failed to.

## blame.mjs — chain of custody

Read-only: `blame.mjs <file>:<line> [--horde h] [--json]`. `git blame` finds the commit that
introduced the line, then every horde on the repository — live and archived (`horde.mjs archive`
moves a horde's directory but never touches its branches or tickets, so a closed mission's tickets
are searched exactly like an open one's) — is searched for the ticket whose recorded branch tip
contains that commit as an ancestor. Three places record a branch tip, from before this migration
and after: a pre-migration `**Keys:**` node approval (`<name>@<sha>+<patch-id>`), a pre-migration
verdict block's `**Gate:** … at sha <sha>` line, and the team journal's own `merged: NNN <sha>`
bullet. Several tickets' recorded shas can
all technically be ancestors of the same commit (trunk only ever moves forward, so every later
merge carries every earlier one in its history too) — the one actually reported is whichever
recorded sha sits closest to the commit (`git rev-list --count` between them, smallest wins).
Prints the commit, the ticket's id and title, its node(s), its class, the evidence rows the ticket
named and what its own verdict
recorded for each, and the rule
verdicts standing against the component the graph says owns the file. Which component that is, and
which rules reach it, comes from `yg context --file <path> --json` — the graph's own resolution,
which accounts for overlapping mappings and every cascade channel a glob match here would get wrong.
The verdicts themselves come from the lock's own entries
(`.yggdrasil/yg-lock.nondeterministic.json`, `.yggdrasil/.yg-lock.deterministic.json`), read
directly: the installed Yggdrasil CLI's `check` has neither `--json` nor any way to scope to one
file (verified against its own `--help` rather than assumed), so the lock — the same
content-addressed record `yg check` itself re-hashes against — is the honest source, not a flag
that does not exist. `--horde` narrows the search to one horde and its own archived copies. A line
no ticket's recorded shas reach is reported plainly as pre-horde code.

## drill.mjs — the disciplines, drilled

The disciplines live in `reference/discipline/*.md` and are rendered into the briefs by `brief.mjs`.
Four of them carry a drill: an assertion about real `.horde/` state and real branches, never about an
agent's prose.

- `list [--corpus <dir>]` — the five disciplines, the drill each carries (debugging carries none),
  and the cases recorded for it.
- `check <drill> --repo <dir> [--ticket NNN]` — runs the drill against that repository's live state.
  ✓/✗ per line, non-zero on any ✗. `--ticket` may be left out when the horde has exactly one ticket.
  - `tdd` — on the ticket's branch, a commit's newly added test files, extracted onto that commit's
    own parent and run there, fail; and the same files pass at the branch tip. A test that already
    passed on the tree it arrived on never showed it can fail. A branch that adds no test at all is
    ✗ here — such a change records `no-new-tests` on its verdict and is drilled on `verification`.
  - `verification` — the last verdict is `reproduced`, every evidence row carries both the command
    and what it printed, and the recorded green gate names the branch's current tip.
  - `review` — every change request names Critical, Important or Minor, and none of them carries
    Minor findings alone.
  - `scope` — the diff between the team branch and the ticket branch stays inside the files the
    ticket declared in `**Files:**`, or inside the boundaries of the nodes it names when it declared
    none, and touches no protected path. The same two-step bound `land`'s own scope item uses:
    a drill that judged scope by another rule would pass work the checklist refuses.
- `run <drill> [--corpus <dir>] [--yg <command>]` — restores every corpus case into a temporary
  repository and checks it: a `violates-` case must come out red, a `satisfies-` case green.
  Non-zero when any case says otherwise. A case carries no way of invoking the Yggdrasil CLI — that
  is a property of the machine running the drill, never of the recorded state, and a case that
  carried one would run nowhere but the laptop it was recorded on — so it is taken from `--yg`,
  else from this repository's own `config.ygCommand`, else the bare `yg` on `PATH`.
- `record <name> --discipline <d> --expect violates|satisfies [--ticket NNN] [--corpus <dir>]
  [--note "…"]` — snapshots this repository's `.horde/` state (minus the worktrees, the gate cache
  and this machine's own `ygCommand`) and bundles the ticket's branch, its team branch and the base into a new case
  `<corpus>/<drill>/<expect>-<name>/`. It runs the check first and refuses when the outcome
  contradicts `--expect`, so a recorded case is always one `run` accepts. This is how a real
  mission's hard moment becomes a fixture: record it while it is on disk.

The corpus is `tests/drills/<drill>/{violates-*,satisfies-*}/`, the same convention `yg drill` uses.
A case is a `case.json`, a `horde/` snapshot and a `repo.bundle`; nothing in it is written by hand.

`drill.mjs` reads history and never writes to the repository it checks. Its revert machinery is its
own rather than `land.mjs`'s: the gate asks whether a branch's new tests fail on the branch it
is about to merge into, which is a question about the merge; the `tdd` drill asks whether the commit
that introduced them could have failed at the moment it was written, which is a question about how
the work was done.

## cost.mjs — runs × class

`report [--wave n] [--ticket NNN]` (runs and weighted sums from `cost.json`, a ledger
some other tool writes, shape `{runs: [{name, role, class, ticket|null, wave, at}]}`;
against the charter's limit when set), `limit-reached` (exit 0 when reached, meant to be checked
before dispatching). Mission scope is the default and has no flag of its own; `--wave` and `--ticket`
narrow it. Reviewer calls are counted at mission scope only, since an event names a pair and not a
ticket.

## retro.mjs — what nobody read twice

`retro [--horde h] [--tree p] [--json]`, and it runs twice.

The first run gathers, and reads `.horde/` alone — no tree, no graph. Its input is everything the
mission wrote that nobody read a second time: every `checks[]` entry with `ok: false` in
`hordes/<h>/land/<ticket>.json`, and every line of a ticket's `log.md` that is NOT a state entry. The
distinction is mechanical and is the shape of the line, never its words: `transitionStatus` writes
`- <iso> status: <state>…` and `appendLog` writes everything else. Each item carries a key
(`gate:<ticket>:<n>` or `log:<ticket>:<n>`) stable across runs. Nothing that cannot be read stops the
run — an unparsable result file, a missing `log.md`, a ticket directory with no log at all — each
becomes a note on the document instead.

Between the two runs, one one-shot (`brief.mjs retro`) classifies every key into `rule`, `taste` or
`inexpressible` and writes `hordes/<h>/retro-classes.json`. One one-shot for the whole mission, never
one per territory: measured at real-mission scale (40 tickets, four waves) the input is ~70KB against
the 400000 a single territory is held to, and the repetitions across territories are the reason to
read it in one place.

The second run validates that file — every key classified exactly once, a `rule` carrying its
sentence, its component and `check`/`prose`, a `taste` carrying a component and no rule, an
`inexpressible` carrying neither — and writes `hordes/<h>/retro.json` (`horde-retro/1`) with
`retro.md` beside it: `{schema, horde, at, state, items, law, taste, inexpressible, logged, cost,
judge, threshold, notes}`. A `taste` item leaves one line in its component's own log through
`yg log add` and nowhere else; a key already on the previous document is never logged twice, and one
retrospective runs at a time (`hordes/<h>/retro.lock`, taken over when the pid holding it is gone).
Writing twice replaces the document; nothing is appended.

`law` is the rule proposals, ready for whoever works that area to write. `inexpressible` is structured
facts — ticket, source, the words that were written — and never a sentence for a client: the session
writes that, the same way it does for `ask`. `threshold` compares the `inexpressible` share against
`config.retro.inexpressibleThreshold` and prints both, so a bar set after the number is known is
visible as one.

`judge` is a measurement and never a gate. At `config.retro.judgeSampleRate` above 0 a sample of
LANDED tickets has the verdicts already recorded on its own files and components re-packaged through
`yg verdict package`, and a second judgement by `config.retro.judgeTier` is compared against the one
on file; the disagreement comes back with `wilson(k, n)` at that sample size. At a rate of 0 no
`yg verdict` command runs at all. A pair the CLI will not package is a skip with its reason, a pair
with no second judgement yet is `pending` with the command that takes one, and neither refuses
anything.

`horde.mjs done` requires this document, and requires it to have been taken over the mission's landed
tickets as they now stand — `state` is how it tells a current retrospective from one taken before the
last thing landed.

## tick.mjs — the loop, as one run

`tick [--runner session|teammate|external] [--watch] [--stack] [--tree p] [--horde h]`. Four things
in order, then it exits — nothing lives between runs, so there is no roster, no liveness threshold
and no minute count anywhere in it.

1. **Reconcile.** Every `running` item whose call has come back without landing a sha, settled from
   its branch: a commit beyond the parent goes to `landed`; a dirty worktree is committed as
   `wip: reclaimed` and goes back to `queued`, worktree kept; a clean one with nothing on it goes
   back to `queued` and gives up its worktree. A `running` item with no branch is skipped. Each
   answer says what was salvaged, because whoever reads it is usually reading it after a crash.
2. **Land what is ready.** Every `landed` item: the gate's own result file
   (`hordes/<h>/land/<ticket>.json`) is read, and when it is missing, unreadable, or about a sha the
   branch has moved past, `land --background` runs again — a record of a run is never a substitute
   for one. Green merges the item and writes the wave-journal bullet. Red puts the ticket back with
   the gate's own words and the round counted; when the rounds are spent the item and the ticket
   both go to `blocked` and one `stuck` ask is filed for the client, carrying those last words and
   the path of the ticket's log. A `landed` item whose branch has vanished is a refusal naming the
   branch, with nothing touched.
3. **The dispatch list.** `queue.mjs next`'s own order (stacked last, quality last, then severity,
   then the longer remaining critical path, then a node nothing is running on, then FIFO), with its
   file locks and its dependency rule, cut to `config.parallelism` minus what is already running.
   Every entry has had its branch and worktree cut, so the `brief` command on it renders against a
   tree that exists; `model` is the ticket's own class. A stacked entry carries the separate line
   `STACKED, parent t-NNN unmerged`. `judge` carries the prose pairs the gate handed back, and only
   under `config.judge: one-shot`. `askClient` is the open items of `asks.json` — an absent file is
   an empty in-tray, never a refusal.
4. **Close.** A queue holding nothing but `merged` items gives `close: true` and the command that
   closes the wave. Tick prints that command and never runs it.

**Tick never spawns.** The caller spawns. `--runner` only names who the caller is, and only
`external` changes what this script does: with nobody in front of it, it starts each worker itself
through `config.runner.spawn` (`<class>` and `<brief>` filled in). Under `session` (the default) and
`teammate` it starts nothing at all. `--watch` repeats the run every `config.tick.interval` seconds
until the queue empties or a signal arrives; a signal exits cleanly, holding no lock.

It holds the landing gate's own lock — `.horde/gate.lock`, not a second one — so two ticks on one
repository cannot bill one worker twice or cut one ticket's branch twice. Each list entry books one
`cost.json` row (`{name, role, class, ticket, wave, at}`), keyed by ticket, wave, role and fix
round, so two runs over a state nothing changed leave the ledger exactly as they found it. A
`queue.json` caught half-written is refused by name and never written over — that file is the
mission's own state, and an empty document written across a truncated one is the worst thing this
tool could do.

## Tests

`scripts/tests/*.test.mjs` with `node --test`: every tool's happy path and every refusal named above,
on a temporary git repository created by the test itself. `npm test` in `scripts/` runs them. The
scripts are not done until these pass. `scripts/tests/drills/` is not a test file but the drill
corpus: every case in it was written by `drill.mjs record` from a repository the tools built, and
the suite runs each drill over it.

Every fixture repository has a real graph, made by the real Yggdrasil CLI: `horde.mjs init` creates
one where there is none, and the suite tells it how to invoke that CLI the same way an adopter
would. The suite finds it in `HORDE_TEST_YG`, on `PATH` as `yg`, or as a sibling checkout's build,
and refuses to run with none of those — Horde requires Yggdrasil, and a suite measuring a stand-in
instead would be proving something no adopter ever runs. Rules, ports, refusals and the verdicts
that clear a prose rule are all the CLI's own; nothing about the graph is stood in for.

### the family's contract test — `tests/family.e2e.test.mjs`

Every other test drives one tool over a fixture another tool built. This one drives the layers, in
one walk, on the two real builds: **Grain** mines a graph out of a repository's own history,
**Yggdrasil** accepts and baselines it, and only then does a horde exist on top of it. In order:

1. a temporary repository is built with a handful of source files in two directories, tests beside
   them, a build file that says how it is tested, and four commits touching them — the evidence
   Grain reads;
2. `grain propose .yggdrasil-proposal` writes a `grain-proposal/1` staging tree; `yg adopt` accepts
   it, baselines it and records who accepted what; the test asserts the nodes that arrive under
   `.yggdrasil/model/` and that at least one mined rule arrived on the status ladder rather than
   enforced out of nowhere. The graph is committed, and the horde's base branch cut from it;
3. `horde.mjs init` keeps that graph (it made none), works the gate command and the test patterns
   out of the repository's own build file, and leases the node the mission works on; the charter is
   written through `charter edit` with two evidence rows; an owner files a ticket carrying `Files`,
   `Produces` and both evidence ids; `queue plan` derives one layer and no uncovered row; `queue set
   running` cuts the branch and the worktree; the worker lands a change with a test that really is
   red on the branch it merges into and green on its own; `land` passes all nine items — the graph
   one through a real `yg check` in a fresh tree at the branch tip — and **makes the merge commit
   itself**, removing the worktree and the branch and recording the landed sha; the wave close that
   turns both evidence rows green; `horde done`; and `blame` on one merged line printing the ticket,
   the evidence and the rules standing over the component the graph says owns the file.

It asserts on files, exit codes and recorded fields only — never on anything's prose. It is skipped,
with the reason printed, when either build is missing, and never silently: `YG_BIN` and `GRAIN_BIN`
name them, and both fall back to a sibling checkout on a machine that has the family out. Grain is
found by asking a candidate for its own usage text and requiring a `propose` command in it — its
engine module and its dispatcher sit next to each other under the same name, and only one of them
runs.

## land.mjs's revert test — how a new test file is found and run

The item detects a new test file generically by name, against `config.testGlobs` rather than by
inspecting file content — a repository's own test patterns aren't otherwise knowable from this tool
set. `horde init` fills that key from the repository's build files; when it is empty the item is ✗,
because a ✓ reading "no new test files in diff" over a repository whose tests this tool cannot
recognize is the strongest guarantee in the checklist passing without looking. A ✓ names the
patterns it did look for. A matched file whose extension `node --test`
can run directly is extracted and run that way; anything else falls back to running the whole
`config.gates.commit` command in the scratch worktree, treating any red as "this file's a failure" —
isolating just one file's test lane out of an arbitrary configured command isn't possible in general.

Two variants exist, chosen by the ticket itself — never by a `land.mjs` flag. The default is the
revert-to-base one above: new test files extracted onto the parent branch's tip (or another ref, via
`--revert-base`), where the ticket's own implementation doesn't yet exist and the tests must
therefore fail. When the ticket instead carries a `**Mutate:**` command (`tk.mjs new --mutate`),
`land.mjs` runs the mutation variant: it builds a scratch copy of the branch's own tip — which
already holds both the ticket's new tests and its implementation, so nothing needs extracting — runs
the ticket's command there to deliberately break that implementation, and requires the same new test
files to fail against the broken result. A ticket naming both `--revert-base` and `--mutate` is
refused outright, at `tk.mjs new` and again as a defense-in-depth check inside `land.mjs`: only one
variant ever runs, so the other would be silently unused, which is exactly the kind of ambiguity
this tool set refuses rather than resolves by guessing.

The gate item accepts no recorded green run from anywhere — not a cache, not a ticket's own log.
It runs `config.gates.<level>` fresh on the branch's tree, every time. (`horde.mjs done` still
accepts a matching cached green for the trunk gate; that is its own call, about a mission already
merged, and it stays there.)

## a ticket started from an unmerged dependency (a stack)

A chain of three tickets used to cost three waves of wall-clock: each waited for the one before it
to be merged before its branch could even be cut, however short the work was. `queue.mjs set NNN
running --on MMM` cuts it from `MMM`'s tip instead, so the second is written, reviewed and verified
while the first is still in flight. Only the merge order still waits: `set NNN merged` refuses while
a dependency of the ticket is unmerged, exactly as `dependsOn` always said.

`parentBranchOf` is what makes this safe: the stacked ticket's declared parent is the branch it was
actually cut from, not the team's, so scope and the revert test are measured against its parent's
tree, not against work underneath it that hasn't landed yet. When the parent merges, its work
arrives on the team branch, the stacked ticket catches up with `git merge <team branch>`, and item 1
goes green against the new parent — only the gate and the graph check re-run, on the merged tree, as
always. If the amendment overlaps the stacked ticket's own change outright, the catch-up conflicts
and the ticket goes back to its author, untouched.

One function answers "what is this branch's parent" for the whole tool set — the merge checklist,
the brief the worker is given, and `queue.mjs reconcile`'s count of what a branch actually carries
of its own. Two answers would be a ticket measured against one branch and checked against another.
