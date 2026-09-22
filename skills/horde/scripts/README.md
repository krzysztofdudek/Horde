# scripts — the contract

Every tool: Node ESM, zero dependencies, `--help`, `--json`, exit non-zero on failure with one line on
stderr. All tools resolve the repository root by walking up to `.git`, then the shared state root as
`<git common dir>/../.horde` so a worktree and the main checkout see the same state. `--horde <name>`
selects the horde; when only one exists it is the default. That selection is a separate question from
which TREE a command reads: ordinarily that is cwd, whatever checkout the caller happens to be sitting
in, the same as any other read in this tool set — a horde being resolvable, on its own, is never a
second signal to read trunk instead. `--horde` WRITTEN OUT BY THE CALLER, with no `--tree`/`--ticket`/
`--scratch`, is what changes that, and only for the handful of commands built to read it that way —
`queue.mjs plan`/`quality`, `tick.mjs`, `land.mjs`, `horde.mjs done`, `brief.mjs` (architect,
legislate, retro, review), `wave.mjs start` and `retro.mjs` — never for a horde a command merely resolved on
its own by other means (the sole horde in the repository, with nothing typed at all). On those commands,
with the flag typed and no tree flag, it resolves to that horde's own trunk worktree — read-only for
everything but `land.mjs`'s merge commits, and resynced to the branch's tip (`git reset --hard`) on
every read. A dirty trunk tree still
gets reset, but not silently: the resync counts what it is about to discard first and, when that is not
zero, says so in one line on stderr before it runs. Making that tree and resyncing it both run one
process at a time per worktree path (`<path>.lock` beside it, the holder's pid inside, a dead holder
taken over): two commands asking for one horde's trunk at the same instant take turns instead of
colliding, since git refuses a second `worktree add` at a path, and a second `reset --hard` on one
worktree, outright. The same lock guards every worktree `provisionTree()` makes, a ticket's included.
`--team <name>` selects a team; default is `trunk`, and on anything filed at 6.0.0 or later that is the
only value there is: nothing spawns a sub-team any more. `<name>` is always a team's short LEAF name (`alfa`), unique per horde;
`_lib.mjs`'s `teamPath()` still resolves the nested layout (`teams/<parent>/teams/<child>/`) that a
mission started before 6.0.0 can carry on disk — see **pre-6.0.0 history** at the end. A full slash
path (`trunk/alfa`) is also accepted, but only when it matches what that resolution independently
finds — anything else, including the literal segment `teams`, is
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
  `gates.testFile` (a command that runs ONE test file, `{file}` standing for its path — for a test
  `node --test` cannot run and the commit gate does not run, such as an end-to-end spec under a runner
  of its own; the revert test asks it directly, before falling back to the whole `gates.commit`),
  `gates.report.path` and `gates.report.format` (`junit`, `tap` or `playwright-json` — the report the
  gate command's own runner leaves behind, which the landing reads back to confirm every live
  promise's paired case actually ran — and which the revert test also reads, only when
  `gates.commit` wrote that same file in its own run; unset means nothing reads one),
  `testGlobs[]` (the patterns this repository's tests are named under — the merge checklist refuses
  rather than guess when it is empty), `ygCommand` (how this
  repository invokes the Yggdrasil CLI
  — default `yg` on PATH; set it to e.g. `node path/to/bin.js` for a local build. Horde's trees — trunk,
  each ticket's worktree, the scratch trees the landing gate makes — have no tool install of their own,
  and the command runs with the tree it reads as its working directory, so a *relative* path resolves
  against that tree: to nothing, or to the install of a directory above it, which may be another version
  than the graph was written with. Give an absolute path to a CLI at the version of the trunk's graph. A
  refusal for an old CLI names the tree it ran in and the version the CLI reports from there), `grainCommand`
  (how it invokes Grain, when it has one — default none, and `init` says what naming one would add),
  `protectedPaths[]`, `fixRounds.resume|fresh` (the fix-loop
  breaker `tk.mjs status <ticket> changes` reads: rounds 1..`resume` resume the same worker, the
  next `fresh` rounds spawn a fresh one a class up, beyond that the command refuses — defaults 3
  and 2), `classes` (weights: light 1, standard 3, heavy 10, max 30 — defaults, host-neutral;
  an adopter maps each tier onto a real model, e.g. Claude Code: `light: haiku, standard: sonnet,
  heavy: opus`), `parallelism`, `worktree.copy[]` (repository-root-relative paths copied into
  every ticket, trunk or scratch tree the moment it is made — for whatever a worker's tools need
  that git itself does not check out, e.g. an untracked env file or a dependency cache; a path git
  already tracks is refused — default none). Horde runs nothing to prepare a fresh tree: every gate
  command has to work in one as it is checked out, so it either prepares the tree itself (e.g.
  `npm ci && npm test`) or relies on what `worktree.copy` carries in. A worker whose fast check fails
  before running a single test reports a missing environment, not a wrong base.
  A list-valued key (`testGlobs`, `protectedPaths`) takes either a comma-separated list or a JSON
  array and is stored as a list either way — never as the text of one.
- `charter show|edit [--ask id]` — the mission charter. `show` prints it; `edit` replaces it
  with what arrives on stdin, and reports how
  many evidence rows the new text carries and how many are recorded as reproduced — naming any row
  that was recorded and is no longer, since a rewrite that drops one loses work already done against
  it otherwise, and separately warning by id on a row that keeps its stamp but changes what it
  promises (its evidence text or its class) — a rewording a stamp survives silently otherwise, so the
  stamp is left claiming proof of a promise the text no longer makes; nothing refuses this, since the
  row and its stamp both still exist, and resolving the mismatch (revert the wording, or re-earn the
  stamp) is for whoever wrote the text to judge. This is how the goal, the non-goals, the evidence catalogue and every amendment are
  written: the charter is the one file where what the chairman asked for lands, and it is written
  through a tool like everything else. Dropping a row outright (present before, gone from the new
  text entirely) is free before the mission's wave 1 has started; once it has, the drop refuses
  unless `--ask <id>` names an answered ask of kind `charter` (`ask.mjs`) whose own text (its `why`
  and the client's answer together) names every row being dropped — the reason then lives in the
  ask's own answer (`decisions.md`'s `ask-<id>` entry), not only in this command's own output.
  The charter's `## Quality` section carries the one field of it a tool acts on rather than a
  person reads: `**Policy:** autonomous` (the default, and what a charter with no such section
  reads as) or `**Policy:** only-the-work`. Anything else is refused here rather than read as the
  default, since a word nothing recognises would quietly mean the opposite of what an operator
  writing it meant. Both `show` and `edit` report the resolved policy in their `--json`.
  `_lib.mjs`'s `qualityPolicy(horde)` is the one reader of it, scoped to that section so a loose
  search never mistakes another section's own line for it, and every tool that acts on the policy
  asks it rather than parsing the charter again.
- `archive <name>` — moves `hordes/<name>` to `hordes/_archive/<name>-<date>`; branches untouched.
  Also releases every node lease the horde held (`.horde/leases.json`) — the moment it is no longer
  live, another horde can bind its nodes with no `--take` needed.
- `history` — every mission that has closed on this repository, newest first, read straight off
  `hordes/_archive/`: the charter it closed on (title and goal), its evidence catalogue with how many
  rows were reproduced, its retrospective's rule proposals and what it found the law will not say,
  every question the client answered, and the law diff it handed over (`law/wave-<n>.json`, the
  highest wave on disk — the reading `done` takes at the trunk it hands over). Reads and writes
  nothing. A mission archived by an older release carries fewer of these files; what is missing reads
  as missing (`null`) and the rest is still read — half a book is worth more than none. The same
  reader scopes the archive into each consultant's brief (`refine.mjs --step consult`, below).
- `done [--tree p] [--horde h]` — the mission's final gate (ruling `evidence-is-the-plan`: "the queue
  is empty" is never "done"). The one place this reads a tree — the trunk gate's own fresh re-run,
  below, when no cached green already covers the tip — runs from `--tree`, or without one, cwd: the
  same ordinary default every read in this tool set takes, not this horde's trunk just because a
  horde was resolvable. `--horde h` written out (no `--tree`) is what changes that, exactly as
  `queue.mjs plan`/`quality`, `tick.mjs` and `land.mjs` already read it; what the gate actually tests
  is always the trunk branch's own tip either way, so this rarely shows. Refuses, listing every
  reason at once, when: the charter's evidence catalogue is
  empty (nothing to reproduce is not the same as done); any charter evidence row is not reproduced
  (first promoting whatever a merged ticket's own verdict already proved, mission-wide and
  regardless of wave, into the charter's "reproduced by" cell — the same reading `wave.mjs close`
  uses for one wave, stretched over the whole mission); the trunk branch does not exist, or
  `config.gates.trunk` is not configured, or it is not green at the trunk branch's tip (a matching
  recorded green in `cache/last-gate.json` is accepted, anything else is run fresh in a scratch
  worktree); no retrospective has been run on this mission at all, or the one on file was taken over
  a different set of landed tickets than the mission now has (run `retro.mjs --horde h` again).
  Otherwise: the charter is already stamped (a side effect of the evidence check above), the
  completion block (`templates/mission-close.md`) is appended to the mission's `plan.md`, and the
  result says what to do next — push, a decision that stays the chairman's, never this tool's.

## status.mjs — the digest

One screen: hordes, for each: trunk sha and distance from base, its branch tip, ticket branches
beyond it (landed, unverified, unmerged, waiting), queue counts by state (including `waiting`), the
**landing load** (see `tick.mjs` below), open asks, the last recorded gate result per level, any lease another *live* horde holds on a node this
horde's own tickets touch (node-lease-across-hordes — `.horde/leases.json`, shared by every horde
on the repository), and an **evidence** block: every row of the charter's evidence catalogue in one
of six states — `no-ticket` (nothing claims it), `prototyping` (every ticket naming it is a
prototype — shown to the client, not built, and not yet answered), `queued` (a real ticket names
it, not yet started), `running` (in flight), `merged` (a merged ticket already carries a reproduced
verdict naming it, but the charter has not been stamped yet — that happens at the next `wave.mjs
close`, a manual `wave.mjs evidence`, or `horde.mjs done`), and `reproduced` (the charter's own
"reproduced by" cell already names who). This is `wave.mjs`'s own `evidenceCoverage` — the same
reading `horde.mjs done` uses for its gate, read here without writing anything. `--horde` narrows
it to one horde. `--team` takes `trunk` and nothing else — every ticket is filed there, so any
other name is refused rather than answered with a horde that has no team in it at all. `--json`.

## handoff.mjs — state of intent

`write --summary "…" [--next "…"]…`, `read`, `add-waiting <who> "<what>"`, `rm-waiting <who>` — one
handoff per horde, always at `hordes/<horde>/handoff.json` (+ `.md`). There is no `--by` or `--team`
any more: with only a director and one-shots left, a handoff scoped to one team or one name has
nobody left to read it, and both flags are refused by name rather than silently accepted and
ignored, so a caller that still passes one finds out at once. `write` fills
`inFlight` from the queue's running items and `head` from git. `read` prints "fresh start — no
handoff recorded" when none exists yet.

## tk.mjs — tickets

Over `teams/<team>/issues/NNN-slug/{issue.md,log.md}`, NNN unique per horde (counter in
`hordes/<horde>/counter.json` — the one counter EVERYTHING the horde numbers comes out of, see
"Identifiers" below). A ticket reads as `t-NNN`; NNN alone is the same ticket, and stays the name of
its folder and of the `id:` its issue.md carries.
- `new <slug> --title "…" --node n --class light|standard|heavy|max [--severity high|medium|low]
  [--kind work|quality|prototype] [--no-quality] [--depends NNN,…] [--files a,b] [--consumes <node>/<port>,…]
  [--produces <node>/<port>,…] [--evidence "…"]… [--revert-base <ref>] [--mutate "<command>"]
  [--reopens NNN]` —
  from `templates/ticket.md`; status `proposed`. `--node` takes one node, or two when the ticket carries
  a contract between them; three or more is refused — nothing in the graph answers for the whole of
  such a diff.
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
  `--reopens NNN` writes `**Reopens:** t-NNN` — this ticket is the second attempt at NNN, whose
  evidence went red again after it landed. It refuses a number this horde never filed, and it is
  the claim `land.mjs <NNN> --fate reopened` checks before recording that fate against NNN's own
  landing; without it the reopening is a ticket like any other and nothing counts it as a return.
  Ticket creation itself is one exported function (`createTicket`), so a ticket the quality pass
  files is the same object, validated the same way, as one filed by hand; `setTicketBody`
  is the same for a body, and `edit`'s own write goes through it.
  `new` also asks Grain, when `config.grainCommand` names one, `grain obligation <file> --json` for
  every declared file: a specific obligation (a companion file Grain's own history certifies, never a
  glob) that lies outside the boundary of the ticket's own node(s) is a warning, never a refusal — the
  graph's boundary check above already refused an impossible declaration; this is a pattern from
  history, not a rule, and the ticket's `--node` may simply not cover it yet. The warning names the
  file, the companion, Grain's own k-of-n count and the companion's owning node (`yg context --file`).
  No Grain configured, or none of the declared files mapping to a node the graph knows, says "not
  checked" instead of guessing. `--json` carries the findings as `obligationWarnings`.
- The four structural fields — `**Files:**`, `**Consumes:**`/`**Produces:**`, `**Evidence:**` — are
  what `queue.mjs plan` computes the mission's order from, and they are validated where they are
  written: every path in `--files` must lie inside the boundary of a node the ticket names (the same
  boundary reading `land`'s scope item uses — one function, in `node.mjs`, imported by both);
  `--consumes`/`--produces` must read `<node>/<port>` — there is no version, in the graph or in
  Horde; and a consumed port must be
  produced by some ticket of this horde (its own team or another's) or already exist on that node in
  the graph — refused by name otherwise. Port existence is read through `node.mjs`'s graph reading,
  in one place, so a later change of where the graph comes from changes one function.
  Both checks read the graph in the tree `new`/`edit` is run from (cwd) — `--horde` on either is only
  the ticket-store disambiguator (which horde's `teams/` this ticket files under), never a tree
  switch, the same ordinary reading every `node.mjs` read takes (`queue.mjs plan`/`quality`,
  `tick.mjs` and `land.mjs` are where `--horde` written out alone also means the tip of trunk
  instead). A node the tree does not carry contributes
  no boundary and no port, so a ticket named against it is accepted uncontested rather than refused —
  run `new`/`edit` from the tree whose graph state should decide the check, or land the graph change
  there first.
- `list [--state s] [--node n] [--team t] [--open]`, `show NNN [--log]`,
  `status NNN <state> ["note"]` (states: proposed queued running landed changes blocked merged
  dropped — `blocked` is `tick.mjs`'s own, for a ticket whose fix rounds ran out; `verified` and
  `escalated` are pre-6.0.0 history and refused by name, saying what replaced each) —
  `changes` is the fix-loop breaker: it counts the round in the ticket's log
  and prints it (`config.fixRounds`, defaults `resume` 3, `fresh` 2). Rounds 1..`resume`: resume
  the same worker with the findings. Rounds `resume`+1..`resume`+`fresh`: the result says "fresh
  worker, class up" — a new one, one class heavier (`config.classes`), briefed with `brief.mjs
  worker NNN --name <n> --takeover`. Beyond that cap the command refuses outright — there is no next command
  to propose yet. `log NNN "text"`, `grep <re>`.
- `review-close NNN --by <name>` — the line a ticket's one review ends with, whatever it found:
  `review closed by <name> — Critical N · Important N · Minor N`, the findings logged since
  `tick.mjs` raised the review, counted off the log (`readReview`, the one reader `tick.mjs` uses
  too), never typed in. `tick.mjs` holds the ticket's gate until this line or a skip exists; the
  line carries no verdict. Refuses a ticket with no review raised on its queue item.
- `review-skip NNN "<reason>" --by <name>` — the director's call that a raised review will not
  close: `review skipped by <name> — <reason>`. Refused without a reason, and for a ticket with no
  review raised. The gate is asked on the next `tick.mjs` run, and nothing logged after the skip —
  a finding, or the review's own closing line arriving late — is acted on.
- `--node` on `new` is repeatable; two nodes mark a contract ticket.
- `move NNN --team t` — relocates the issue folder.
- `edit NNN --by <name>` — rewrites the body (everything from `## What` on) from stdin, leaving the
  header block (id/title, `**Status:**`, `**Node:**`/`**Class:**`/`**Severity:**`/`**Team:**`,
  `**Depends on:**`/`**Branch:**`, `**Files:**`, `**Consumes:**`/`**Produces:**`, `**Evidence:**`)
  untouched; appends "body edited by `<name>`" to the
  log. What the director uses to write ticket bodies, instead of editing `issue.md` by hand.
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
States `set` writes: `proposed queued waiting running landed blocked merged dropped`. `escalated` is
pre-6.0.0 history — refused by name, still grouped by the rendered `queue.md` so an old queue's own
items are not left out of it. `proposed` is a ticket
nobody has ruled on: listed and counted like any other, and never a candidate for `next`. A
consultant files its own tickets and adds them with `add --proposed`; `refine.mjs --step review` is
the only thing that moves one to `queued`.
Every command that changes `queue.json` — here, in `tick.mjs`, and in `audit.mjs`'s own ticket
filing — reads it, changes it and writes it back under one lock, `withQueueLock` (`_lib.mjs`), the
same exclusive-create trick `decide.mjs`'s own lock uses: `<queue.json>.lock`, one per
horde+team, held for exactly that read-modify-write and nothing longer, so two processes racing a
change to one team's queue (two sessions on one horde, a `tick` racing a hand-run `queue.mjs set`)
can no longer each read the same document and have one silently overwrite the other's write.
Same take-over rule as the gate lock below: the file names the pid that holds it, and a pid no
longer running — including one that just refused via `fail()`, which exits before its own `finally`
can release the lock — is taken over immediately rather than waited on.

`asks.json` (`ask.mjs`) and `graph.json` (`node.mjs`) carry the same hazard — every command that
changes either reads the whole document, mutates it and writes it back — and now carry the same
lock, generalized in `_lib.mjs` as `withFileLock` and instantiated per file as `withAsksLock` and
`withGraphLock` (`<file>.lock`, same exclusive-create and take-over rule as above). Lock order,
where two are ever held at once: the queue lock is outermost when it appears at all (`tick.mjs`'s
red-gate handling files a "stuck" ask from inside its own `withQueueLock` block), the asks lock is
outermost over the decisions lock (`answerAsk` calls into `decide.mjs`'s own lock while holding
this one), and nothing that holds the asks, graph, counter or decisions lock ever reaches back for
the queue lock — so the order is always queue → { asks → decisions, graph, counter } on whichever
edges exist, never the reverse, and never a cycle to deadlock two processes on.

`add` is the door a ticket is held at. Three things are checked there and nowhere else: a ticket with
no acceptance line has nothing anybody could reproduce; one earning an `**Evidence:**` row a
prototype is still waiting an answer on is built against the guess the prototype exists to replace,
until that answer is recorded (`tk.mjs accept <prototype> --sha256 <hex> --by "<who>"`); and a
ticket that is not what the mission promised — one naming a node outside every territory the cut
holds (`territories.json`), or earning a row the charter's evidence catalogue does not carry — is
not this mission's to do. The client may dictate a ticket; the mission card is what says it belongs,
so the third refusal names what does not fit and prints the `charter` question that would change it,
and `--ask <id>` naming an answered ask of that kind is the one way in. The queue item then records
which ask took it. A mission nobody has cut yet has no territory to be outside of, and a ticket
earning no row at all claims nothing — neither is a mismatch.
- `list [--state s]`, `add NNN [--depends dep,…] [--proposed] [--ask <id>]`, `set NNN <state> [--sha x] [--agent name] [--note "…"]`,
  `next [--class c] [--why] [--stack]` — ready = queued, every dependency merged, and clear of every
  `running` ticket's own lock. "Every dependency" is `plan`'s own derived set, read off one
  in-process `buildPlan()` call: a port the ticket `**Consumes:**` orders it after whoever
  `**Produces:**` that port exactly like a hand-written `**Depends on:**` or `dep`, so a consumer of
  a port whose producer has not merged yet is not ready even with no manual edge between the two,
  and `--why` names the producer and the port it is still waiting on. A ticket declaring
  `**Files:**` (a node's `log.md`, which `tk.mjs` writes into every declared list, is not counted — it would lock every ticket of a node against every other and make the node's log a "hub file") collides only on an overlapping path or glob; a ticket with none (or a `running` item whose ticket can no longer be read) locks
  every file of every node it names instead — the safe degradation for a ticket that never said
  which files it touches. Ranked: a `prototype`-kind ticket (`tk.mjs new --kind prototype`) always
  first and a `quality`-kind one (`tk.mjs new --kind quality`) always
  last, whatever either's severity; then severity (read live from the ticket on every call, high
  first); then the longer remaining critical path through the ticket wins — `queue.mjs plan`'s own
  DAG, read straight off one in-process `buildPlan()` call, never a second, shelled-out `plan`;
  then a ticket whose nodes hold no `running` ticket; then FIFO by queue order. `--why` prints
  every `queued` item: its rank if it qualified, or the reason it didn't (an unmet dependency —
  named with the port and its producer when the edge is a consumed port rather than a
  hand-written one — the file lock naming the `running` ticket and the file(s) it shares, or the
  `--class` filter).
  `--stack` keeps in the ranking, below every ready ticket and in the same order among
  themselves, each queued item whose unmerged dependencies (port edges included) are all in this
  team, `running` or `landed`, and on a branch — returned as `stackReady: true` with `stackOn`
  naming them, since it can be started now on top of one (`set NNN running --on <that ticket>`,
  the producer's own tip when the edge is a port). The lock holds there too: the ticket it would
  start from is often the one holding the file. Without `--stack`, such an item is skipped as
  before, and `--why` says which tip it could have started from.
  `rm NNN`, `render`, `reconcile` (every `running` item: a commit beyond its
  parent's tip → `landed`; a dirty worktree → `git add -A && git commit -m "wip: reclaimed"` on the
  ticket branch, then `queued` with a note; a clean worktree and no commit → `queued`, worktree
  removed. A `waiting` item is left untouched — it has nothing running to reconcile).
- `plan [--team t] [--apply-order] [--out <file>]` — the team's DAG, derived from the tickets and printed, never
  dispatched. Two kinds of edge, added together and never overriding one another: a ticket that
  `**Consumes:** <node>/<port>` comes after the ticket that `**Produces:**` that same port — no
  version to compare, so the port name alone is the match (in its own team or another's — a
  cross-team producer is reported as what the ticket waits on outside the team); and whatever was
  written by hand, on the ticket's `**Depends on:**` field and on its queue item. It then reports:
  the layers (topological antichains), the critical path in tickets and in class weight, the
  connected components with the tickets that hang loose on their own, tickets with no order
  between them that claim the same file, files three or more tickets claim, the tickets with no
  `**Files:**` (`filesBlockingNode` — legal, but no other ticket on their node runs beside them) and, among
  those, the ones whose nodes map no code at all (`noCodeToLandOn` — their scope is the node's graph
  files, so no source file can land until they declare Files or the node is mapped; a node the graph
  does not know is left out), the extra approvals a
  port change owes (who consumes it: `node.mjs`'s `consumersOf`), consumed ports nothing produces,
  the charter evidence rows no ticket names, how big each started ticket's change has grown (lines
  and files, against the branch it was cut from) with its rank among the others of this same plan
  and the biggest quarter of them offered as splits worth considering — a reading recomputed from
  the tickets in play every call, never a size written down anywhere, and nothing here acts on it;
  a ticket with no branch yet has nothing to measure and is reported as such. Then the weight
  estimate (Σ class weight × 2 runs per ticket) and the waves that many layers need at
  `config.parallelism`. Merged and dropped tickets are out of the plan — it is what remains to do.
  A circle of dependencies is a refusal, with the circle printed. `--json` is a `horde-plan/1`
  document carrying all of it. `--apply-order` records the order `plan` proposed for a file clash
  as an ordinary dependency on the queue item, with a note saying why — one edge per adjacent pair
  in the file's own order (fewer declared files first, ticket id breaking a tie), not every pair:
  a file N tickets share gets at most N-1 edges, never the N(N-1)/2 a full pairwise write would.
  That key is a property of each ticket, never of the pair, so a chain through it carries exactly
  the same order the full pairwise set did and never closes a loop by itself — only a port edge or
  a `**Depends on:**` edge running the other way can do that, together with it. Each edge is
  checked against the plan's own full DAG (ports and hand-written dependencies included, not just
  what is already in `queue.json`) before it is written; where writing it would close a loop, that
  one edge is skipped and the result names the cycle instead, and the rest of the file's chain is
  written as usual. `--out <file>` writes the plan (rendered, or JSON with `--json`) to a file instead of stdout,
  for a reader who must see it whole — the architect — rather than a summary relayed through a
  message.
- `undep NNN --on MMM [--note "…"]` takes a dependency back off `NNN`'s queue item — a note is
  always recorded, `--note`'s text appended to it where given. Only an edge the queue itself added
  (`add --depends`, `dep`, `tk.mjs edit --depends`, or `plan --apply-order`) is its to remove: it
  refuses one that also comes from `NNN`'s own `**Depends on:**` field (that field is written once,
  at `tk.mjs new`, and nothing today edits it back out — dropping the queue's copy would leave the
  ticket's own text still declaring it) or from a port `NNN` consumes that `MMM` produces (`plan`
  recomputes that edge fresh from `**Consumes:**`/`**Produces:**` every time, so the queue never
  actually held it), naming which and what to edit instead.
- A dependency (`add`'s `--depends`, `dep`'s and `undep`'s `--on`) is `NNN`, a bare ticket number
  in this same team — there is only ever one team (`trunk`), so a dependency has nowhere else to
  point. Refuses anything with a `:` in it, naming the dependency and saying so, and refuses an
  unknown ticket number; a cycle is refused, with the circle it would close.
- `set NNN waiting --note "<why>"` — for "the class this ticket needs is overloaded, no agent of that
  class can be spawned right now": just changes the state, keeping `class`, `branch` and `worktree`
  exactly as they were (so a ticket already `running` when its class gets overloaded can be waited
  without losing its worktree). `set NNN queued` brings it back onto the DAG.
- `set NNN running --agent <name>` creates the branch `<horde>/t-NNN` off the team tip and the worktree
  `<hordeRoot>/worktrees/<horde>/t-NNN` on it (per horde, so two hordes never collide on a ticket
  number), records the path as `worktree` on the item, and prints it. `set NNN merged --sha` removes
  the worktree first, then deletes the branch. `set NNN merged --sha x` also appends the merge's bullet to the team's
  wave journal, so a merge costs one write and not two: `wave.mjs close` reads that journal to work
  out which evidence rows the wave turned green, and the catalogue used to sit at zero whenever the
  second command was forgotten. `wave.mjs merged` remains, for a merge the queue never saw, and
  never records one twice.
- `set NNN running --adopt` is for an item whose record lost its branch (`branch: null`) while the branch
  `<horde>/t-NNN` itself still exists — a write that raced, or a record restored from before the branch
  was cut. Without it `set running` refuses to cut a second branch over the first; with it the existing
  branch is bound back as it is, its worktree is made again, and a note on the item says so. It refuses
  where there is no such branch to adopt, where the record still has its branch, with `--on` (a stack is
  chosen when a branch is cut) and with any state but `running`. Until then `next --why` names such an
  item an orphan — with the command that puts it right — instead of ranking it, and `tick` leaves it
  on its held list and hands out the rest: one ticket that cannot be started, for this or any other
  reason, is named there and skipped, never a reason to stop the run.
- `set NNN running --on MMM` cuts the branch from `MMM`'s tip instead of the team's — a **stack**, so
  a chain of tickets does not cost one wave per link — and records `stackedOn: MMM` on the item.
  `MMM` must be a dependency of `NNN` — `plan`'s own derived set, so a port `NNN` `**Consumes:**`
  that `MMM` `**Produces:**` counts exactly like a hand-written one (a stack follows the merge
  order, never crosses it), in the same team, `running` or `landed`, and on a branch that exists; each of those is a named refusal,
  as is `--on` on a ticket whose branch was already cut somewhere else (moving a base under work
  already done is a rebase this tool does not do). From then on the item's **parent branch** — the
  branch it is rooted on, measured against, and merged into — is `MMM`'s, everywhere: base
  freshness, the diff its keys bind to, the scope, the revert test, the range-diff of a moved diff,
  and the branch the worker's own brief tells them to merge. `set MMM merged` clears
  `stackedOn` on everything stacked on it by the same write, and the parent is the team branch
  again — with the work now in it, the stacked ticket's own diff is unchanged, so its keys hold and
  only the gate re-runs.
- Refuses `set NNN merged` while any dependency of the ticket is unmerged (merge order is the
  dependency order, stack or no stack) — the same derived set `plan` and `next` read, so a
  consumer of an unmerged producer's port cannot merge ahead of it just because nobody wrote that
  edge by hand, and the refusal names the producer and the port.
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
  (counted once per rule), plus those nodes' own logs. A mapped file the consultant does not read —
  one `.gitattributes` marks `linguist-generated=true` (the convention GitHub itself uses for a
  generated template or lockfile), or one git's own content heuristic treats as binary — never enters
  the code sum; no size threshold of its own decides this, only git's own attribute and its own
  binary detection. Over it, refused with the count broken into code, rules and logs, and the largest
  files actually counted named — which part is large, and which files in it, says what to do about
  it. The boundary is closed: exactly the limit fits. One threshold and not a table of them per class, because the class decides
  which model works a territory, never what fits in one.
- **Leases.** `.horde/leases.json`, the same file and the same mechanism `node.mjs bind` uses, keyed
  by the territory instead of the node (the on-disk shape is unchanged; history's `node` field
  carries whichever subject the entry is about). A conflict with another live horde is refused,
  naming that horde and its last activity. A territory is never taken over: the refusal points at
  archiving the holder, or at the client, whose answer decides which mission gets the area.
  `horde.mjs archive` releases territories exactly as it releases nodes.
- `--step consult` — prints `[{territory, class, brief}]`, exactly one spawn per territory, all
  parallel, issued by the caller in one message. A brief carries only its own territory: `yg context
  --node --json` for each of its nodes (its rules with status and reviewer kind, and the paths they
  reach), the node
  descriptions and logs, `grain where`/`how`/`obligation`, and the mission card cut to this
  territory's own evidence rows. Then the five questions, in order: what must change in me; is this
  a new module or a change inside one; does this break single responsibility; what pattern do I want
  and is it already law; what contract do I need from a neighbour. The consultant writes its own
  tickets (`tk.mjs new`, then `queue.mjs add --proposed`, with `tk.mjs edit --depends` for the
  edges) and its own law proposals (`node.mjs propose rule`). Nothing comes back as prose. It decides
  the inside of its territory; it does not decide the boundary. Grain is optional, so a brief without
  it still renders and says what is missing rather than falling over.
- **What closed missions already learned here.** The brief also carries the part of the archive
  (`horde.mjs history`, above) that belongs to this territory and to no other: the rule proposals
  past retrospectives made about its nodes, the things those missions found the law will not say
  there, and the client's own rulings over it. Each kind is placed by the only thing that honestly
  places it — a rule proposal by the node it names; an inexpressible item by the node its own ticket
  named, since nothing inexpressible attaches anywhere; an answer by the territory it was asked
  about or the ticket it was asked on. An entry that cannot be placed is left out rather than shown
  to everyone: handing one territory's evidence to another is the leak the cut exists to prevent.
  With nothing in the archive the brief says so outright instead of leaving the question open.
- `--step review` — first run writes the plan whole to `hordes/<horde>/plan-<team>.md` and prints a
  one-shot architect's brief carrying that file's own text (never a summary — a plan relayed as one
  has already lost the thing being looked at) and the five questions a plan is ruled by, quoted from
  `reference/roles/architect.md` rather than copied. A circle refuses the step outright and carries
  the circle in the refusal. The architect answers by writing `hordes/<horde>/review.json`:
  `{"<ticket>": {"verdict": "pass"|"reject", "why": "<one sentence>"}}`. Second run applies it: a
  pass moves the ticket and its queue item to `queued`; a rejection leaves both `proposed` and puts
  the reason on the ticket's own log; a ticket nobody ruled on stays `proposed` and is never
  dispatched, because silence is not a pass. This is the only way out of `proposed`. A ruling applies
  only to a ticket still waiting for one: a verdict for a ticket that has since queued, gone out on a
  branch, landed or merged is reported as `skipped` (`{ticket, verdict, status, why, skipped: true}`)
  and left exactly as it is, so applying a verdict file a second time mid-wave never resets what has
  moved on. Once applied, the verdict file is set aside as `review.applied-<time>.json`, so the next
  `--step review` issues a fresh brief instead of applying the old verdict again.
- `--step frame [--json]` — the data a session renders to the client through Ratatoskr. Three
  sections and not one tool name: what will change and where (territory → nodes → tickets), what it
  will prove (the charter's evidence rows through `parseEvidenceRows`, with who is taking them and
  which nobody has), and what the law gains (the consultants' rule proposals, one sentence each). A
  cut of one territory with one ticket says so plainly rather than dressing it up. The client's "go"
  is the only approval in the whole mission run, and nothing is exposed before it.

## brief.mjs — rendered briefs

`brief.mjs <role> [args]` prints the brief for a role, filled from `reference/roles/<role>.md`. Five
roles, a closed list: `architect`, `worker NNN [--takeover]`, `legislate <territory>`, `retro`,
`review NNN`. Any other name is refused as unknown, naming these five and no others — including every
seat the cassation removed, each of which is listed under **pre-6.0.0 history**.
`worker --takeover` renders a
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
(review), retro (review, verification), review (review). The
texts live there once, so an edit to a discipline reaches every brief that carries it. Records
nothing. The caller copies the output into the Agent tool's prompt verbatim.

Every role's own graph read runs against the tree `--tree` names; without it, cwd, the same
ordinary default every read in this tool set takes, not this horde's trunk just because a horde was
resolvable. `--horde h` written out (no `--tree`) is what changes that, exactly as `queue.mjs
plan`/`quality`, `tick.mjs`, `land.mjs` and `horde.mjs done` already read it — all five roles read
it the same way (issue 114 caught `architect`, `legislate` and `retro` up to `worker`'s own reading
of it, and `review` was written to it).

`review NNN` is the one-shot that reads one ticket's change, once, after its worker and before its
first landing — `tick.mjs` lists it (step 2 below) and nobody else raises one. Its brief carries the
diff to read (`git diff <parent>...<branch>`, against the parent `parentBranchOf` names, so a stacked
ticket's dependency is never read as its own work), the ticket's body and its nodes' `node.mjs show`
lines, and no command that approves: the role's only outputs are findings in the ticket's log, in
the change-request shape `reference/discipline/review.md` gives, and the closing line its brief ends
with (`tk.mjs review-close NNN --by <name>`), written whatever it found. It refuses a ticket that
has no branch yet, since there is no change to read.

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

The consultant `refine.mjs --step consult` spawns is not one of these five — it is never rendered
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
node). Nothing here parses a file the layer below owns. A CLI that cannot be started, one that
answers those calls with anything but the document, and one that exits 0 and prints nothing (the
refusal says it does not work in that tree, names the tree, and does not call it an old version) are
all refusals that name what to do —
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
  proposals are open on it. Its roster-derived column is pre-6.0.0 history (see the section at the
  end) — nothing writes a `roster.json` any more, so a fresh mission always reads `-` there. There
  is no currency stamp: the lock binds every verdict
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
- `verdicts [--at <path>] [--by <name>]` — the prose rules over a
  tree that no judge has answered yet, each with the exact `yg verdict package` and
  `yg verdict record` commands that answer it. `--at` names the worktree to read (default: this
  one). Read-only. Which pending pairs are prose is the graph's own word — each unit's context
  document names the reviewer kind of every rule reaching it — never "whatever is left over", which
  would call a script rule a prose one on any tree where the free run had not happened and send a
  reviewer off to judge what a command answers for nothing. Script rules still without a verdict are
  reported separately, with the free command that settles them.
- `propose <kind> "…" --by <name> [--node n] [--boundary <glob>[,glob…]]` (kinds: new-node,
  move-boundary, rename, rule; move-boundary requires --node and --boundary, so apply can name
  the exact edit later, not just record that it happened), `proposals [--open]`,
  `approve|veto <id> ["why"] --by architect`, `apply <id>`. Approval and apply record; filing
  into the graph is the architect's own `yg` calls, and `apply` prints the exact edit. An approved
  move-boundary is also how a node that maps no code yet gets its first files: a ticket on it names the
  proposal (`tk.mjs new|edit --boundary-proposal <id>`, written as `**Boundary proposal:**`), may declare
  files inside the proposal's globs, and the landing reads its scope from them when the ticket declares
  none. The proposal is read from the horde's own record, never from the branch, so a branch cannot widen
  the boundary it is judged by; an open, vetoed, wrong-kind or other-node proposal is refused at `tk`
  and widens nothing at the landing. Without one, both refusals stand.
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
`description` is the rule's own; `nodes` are the components the rule reaches, read from
`yg aspects --json --reach` — one call per tree, the same reading the landing gate's law guard takes;
`why` is the last entry of the rule's own history (`yg aspects log read --json`), `null` for a rule
nothing has been recorded about. Reach is read there rather than off `yg check --json --full`'s pairs
because the gate deliberately runs nothing for a rule at `draft`: read that way, every draft rule came
back reaching nothing, and the document described a rule with real subjects as one with none. A CLI
that does not know `--reach` is refused outright — the older document answers a narrower question, so
falling back to it would only restore the wrong answer quietly.

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
exhausted its fix rounds), `lower` (a request to weaken something that protects the work: a rule
— demote, an added `yg-suppress` marker, a moved `review_by`, an aspect detached from a node — or
the proof — a promise put back to planned, a test file or an assertion taken out, a skip marker
added — or a gate — the script a gate command runs, a commit or push hook, a CI workflow. Requires
`--aspect`), and `charter` (a mission-card change: the goal, an exclusion, an evidence-catalogue
row).

- `add "<why>" --kind stop|stuck|lower|charter [--ticket NNN] [--territory t] [--aspect a] [--horde h]`
  — `--aspect` is required for `lower` and refused for the other three kinds. It names the one thing
  being weakened, in whichever of three spellings says which — a rule's own id (`no-marker`), a
  promise or a test file (`evidence:adds-two-numbers`, `evidence:tests/second.test.mjs`), or a gate,
  hook or workflow file (`gate:scripts/gate.sh`, `gate:.husky/pre-commit`). The three cannot collide:
  a rule id is a bare directory name under `.yggdrasil/aspects/` and never carries the `:` the other
  two open with. One answer lets exactly that one thing through and never a category, so a mission
  meaning to lower three things files three questions.
- `list [--open]` — open first, newest first.
- `show <id>`.
- `answer <id> "<answer>" [--scope once|mission] [--horde h]` — the one place the client's word gets
  recorded: it appends the answer to `decisions.md` (slug `ask-<id>`) **before** marking the item
  answered, so a decision that failed to record — a duplicate slug, a read-only file — never leaves an
  item silently closed with nothing durable behind it. `--scope` is accepted only for kind `lower`:
  `once` (the default) spends the grant on the landing that uses it; `mission` stands until
  `horde.mjs done`. `land.mjs`'s guards read this answer, not the raw item, to decide whether a
  branch that weakens a rule, the proof or a gate may land; a `stuck` ticket returns to the queue or
  closes as not-done only through an answer here.

State: `hordes/<horde>/asks.json` (source of truth) + `asks.md` (rendered).

Filing one never touches the queue. What an open one holds up is `tick.mjs`'s ruling, and it holds
only what depends on the answer — `stop` everything, `stuck` that ticket, `charter` the tickets
earning the evidence rows it names, `lower` that branch's landing. The table is in the `tick.mjs`
section below.

## escalate.mjs — the recurring-answer scan

Everything else the old escalation channel did — a build decision (a contract, a boundary, a
conflict between two tickets), ruled and routed by hand — is gone with the roles that filed it: that
is the director's own call now, recorded with `decide.mjs add`. What is left here is the one thing
worth automating: noticing that the client keeps being asked, and answering, the same question. This
is the second of the three triggers for legislation (the first is the consultant during `refine.mjs`,
the third is `audit.mjs`'s review-date sweep at a wave close, described above — `legislate` itself
is a brief `brief.mjs` renders, not a script of that name). No state of its own — it reads
`ask.mjs`'s own `asks.json` and only ever proposes, never files: filing a rule is the territory's
own agent's move.

`recurring [--min <n>]` — the **answered** asks (`ask.mjs`) grouped by kind, by territory and by the
normalized text of the answer itself (lower-case, whitespace collapsed, trailing punctuation dropped),
so different answers to the same kind of question on one territory stay separate groups and never
propose a rule on their own (an ask with no territory groups under `(no territory)`). A group of `<n>`
(default 3, minimum 2) or more is the same answer this horde keeps giving the client by hand, and the
third time is not another answer — it is a rule. Each such group prints as a proposal: the answers as
evidence, one line of rule text quoting
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

Appends to `hordes/<horde>/plan.md` (team waves to `teams/<team>/plan.md`): `start [n] [--team t]
[--tree p] [--horde h]`,
`note "…"`, `merged NNN <sha>`,
`close [--gate green|red] [--sha <tip>]
[--evidence E5,…] [--team t]` (renders `templates/wave-close.md` with counts from the queue
and the evidence catalogue; `--gate` with `--sha` records the level's gate at that tip in
`cache/last-gate.json`; `--evidence` fills catalogue rows the green wave gate itself proves),
`evidence <id> --by "<who/what>"` (fills one row by hand, for rows no ticket verdict can fill),
`current [--team t]`. Every close also writes the mission's `horde-law/1` document (see `law.mjs`) and
prints its path, and runs the law audit off that same reading (see `audit.mjs`). Its one-team,
one-wave judgement of "does a ticket prove this row" is also
exported (`evidenceCoverage`, `stampMissionEvidence`) stretched mission-wide — every team, every
wave — for `status.mjs`'s six-state evidence digest and `horde.mjs done`'s gate, so the two never
re-derive it independently.

`start` also writes the wave's own plan bullet: the layer sizes `queue.mjs plan` derives from the
tickets at that moment (imported, never a second derivation of the DAG), the parallelism the first
layer allows within `config.parallelism`, and the instant the wave opened — the three things the
close reads back to say what the wave planned, and to know which rulings belong to it. That DAG is
built from the tree `--tree` names; without it, cwd, the same ordinary default every read in this
tool set takes, not this horde's trunk just because a horde was resolvable. `--horde h` written out
(no `--tree`) is what changes that, exactly as `queue.mjs plan`/`quality`, `tick.mjs`, `land.mjs`
and `horde.mjs done` already read it (issue 114 — before it, `start` read this horde's own trunk
unconditionally, the one `buildPlan` caller that never named its own tree).

Beyond the counts it always carried, `close` states seven figures the chairman reads:

- **the evidence catalogue by kind of proof** — the header line's own green/total count, sorted into
  the six kinds of proof issue 024 fixed for a promise's own `class` field (`EVIDENCE_CLASSES` in
  `_lib.mjs`, mirrored by hand from `packages/promises/doc-shape/check.mjs`'s own `CLASSES` — this
  skill never imports that package), plus `unstated` for a row whose fifth cell says nothing (every
  row written before that column existed included), plus a named-on-its-own list for a row whose
  fifth cell says something none of those six words are — never folded into `unstated`, which would
  hide it behind a word that means nobody has said anything yet. Never confused in anything this
  prints with `config.classes`' own light/standard/heavy/max cost ladder — a completely different
  `class`, reported nowhere near this block;
- **what came back after landing** — the merges reverted and the tickets reopened in this wave,
  counted beside the merges and never folded into them, off the same journal bullets `land.mjs
  --fate` writes while recording the fate. A wave that merged six tickets and had two of them come
  back did not merge six;
- **parallelism** — planned (the bullet above) against achieved (the most tickets this wave landed
  on any one day; a journal bullet is dated, not stamped, so the day is the grain the record has);
- **change size** — how big each of this wave's merges turned out (lines and files, read from the
  merge commit itself), ranked against the other merges of the same wave, with the biggest quarter
  of them named. The wave is where a cut that was too wide shows up as a fact rather than as a
  feeling, so the close records it and stops there: nothing is refused or reopened on account of
  it, and no size is written down anywhere for a merge to be over. A sha this repository can no
  longer read simply carries no position;
- **keys transferred** — the reviews this wave did not have to buy twice, summed from the bullets
  a pre-migration checklist wrote when a ticket's keys survived a catch-up;
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

`land.mjs <ticket|branch>[,<ticket|branch>...] [--level trunk] [--no-gate] [--background] [--tree p] [--horde h]`,
for a ticket branch (`<horde>/t-NNN`). This is the last command a worker runs. Nine items, ✓/✗ each;
**every one green means the branch is merged into its parent here and now**, and a single ✗ means
it is not. Nobody signs anything either way — a green run is the signature, and the landed sha is
the only trace.

A comma-separated list of two or more lands under one shared run of the three expensive items when
they are eligible to — see "batching" below; a single ticket (today's only shape) is entirely
unaffected.

It runs in a **fresh detached worktree at the branch's own tip**, made for the run and removed on
every way out. It does not read whichever worktree happens to hold the branch: a gate that measures
a tree somebody is still typing into is measuring the wrong thing, and briefing a reader into
someone else's tree is how three separate mission failures started.

That scratch tree is not where `land.mjs` itself runs *from*, though — that is `--tree`, or, without
one, cwd: the same ordinary default every read in this tool set takes, not this horde's trunk just
because a horde was resolvable. `--horde h` written out (no `--tree`) is what changes that, for a
gate run and for `--fate` alike: it resolves to that horde's own trunk worktree instead, exactly as
`queue.mjs plan`/`quality` and `tick.mjs` already read it. This tree is where the scope check's own
graph read happens (when a ticket declared no files of its own) and where a scratch merge tree is
provisioned from when nothing already holds the parent branch checked out — never where the gate's
own measurements run, which is always the scratch tree above regardless. In practice this rarely
shows: `tick.mjs` spawns every gate run it starts with cwd already pointed at the tree it resolved,
so the difference is invisible unless `land.mjs` is run directly, by hand, with `--horde` and no
`--tree`.

Its **parent branch** is trunk's own (`<horde>/trunk`), or — while the ticket is stacked on a
dependency that has not merged yet — that dependency's branch; one answer, reported as `parent` in
the JSON, and every item below is measured against it:

1. base freshness — the branch is rooted at its parent branch's tip. A branch the parent has moved
   past (a sibling landed first) is not wrong, only behind, so the parent is merged into it first:
   cleanly, the branch is brought up to date, the merge noted in the ticket's log, and this landing
   goes on with it, once; with a conflict the merge is aborted, the branch is left exactly as it
   was, and the landing stops here — `ok: false`, `stale: true`, base freshness the only item, no
   gate run and no fix round counted (`tick.mjs` sends the ticket back to be brought up to date).
   `--no-gate` never writes to a branch, so it reports the staleness as it stands;
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
   is always the ticket's own choice, never a `land.mjs` flag. A file `node --test` cannot run goes
   through the whole `config.gates.commit`, and its red counts only when that command is green on the
   same tree without the file — and, when that run wrote the file `config.gates.report` names, when
   that report names a failing case from the file; anything less is "no verdict", a ✗ that names the
   ways out of it (see
   [the revert test](#landmjss-revert-test--how-a-new-test-file-is-found-and-run) below). The result
   is derived by running them; nothing declares it to this gate, and no flag offers to say so,
   because a declaration about a test is not evidence about a test;
5. gate — `config.gates.<level>` run fresh on the branch's own tree, **and** the report that run
   left behind. No recorded green run is accepted from anywhere: a "green at sha …" line in a
   ticket's log is a claim about a run this gate did not see. A command that hangs is stopped at
   `config.gateTimeoutMs` (default 15 minutes) and the limit is named, rather than a stuck process
   left behind a checklist that never finishes — and a stopped command ends the item there, with
   nothing below it asked anything. Otherwise the exit code is only half the item: when
   `config.gates.report` names the report the command's own runner wrote, every live promise's own
   paired case has to be in it, passing, or the gate is red and names the promise. See
   [the gate's own report](#the-gates-own-report) below. Once the branch actually merges, what this
   measured is recorded in `cache/last-gate.json` at the sha the merge produced — the same file and
   the same matching-sha acceptance `horde.mjs done` and `wave.mjs close` already read, so either
   sees this landing's own result right away instead of finding nothing there and running the gate a
   second time over a tree it was just run on;
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
8. journal — `tk log` has an entry newer than the last commit a worker made (a merge of the parent
   into the branch, which the landing itself may have made, is not one);
9. graph text — charters, logs and `graph:` commits touched by the branch carry no mission
   language.

A judgement has to be **committed on the branch** to count. The gate reads a fresh tree at the tip,
so a verdict sitting uncommitted in somebody's checkout is one this branch does not carry.

Above the items, the result carries one line that judges nothing: **how big this change turned out**
— lines and files against the parent branch, and where that sits among the mission's other open
tickets. The rank comes off `queue.mjs plan`'s own ranking, so the landing and the plan the architect
read cannot give two answers to one question, and a plan that cannot be built right now costs the
landing nothing (the size is still measured, just without a position beside it). No item passes or
fails on it.

`--no-gate` skips items 2, 5, 6 and 7, and never merges — on two or more tickets it also skips the
batching mechanic entirely, since there is nothing expensive left to share, and lands each on its
own. `--background` starts the run, prints the path of the result file it will write
(`.horde/hordes/<h>/land/<ticket>.json`, shape `{ticket, branch, sha, ok, checks: [{name, ok, note}], at}`
plus the tree it ran in) and returns at once, for a single ticket; for two or more it prints one
`{tickets, items: [{ticket, branch, resultFile, started, note}], started}` instead — one detached
worker for the whole list, not one per ticket, with each ticket's own result file at the same path
it would carry landed on its own. A half-written result file reads as no file at all — the gate
never trusts a recorded result, its own or anyone's, and simply runs again.

### the gate's own report

A test file that exists and pairs with a promise is not proof that anything ran. It can be skipped,
or sit where the gate command's own runner never looks, and every rule in the `promises` package and
every guard below still reads it as proof — they all read source, and source cannot say what ran.
The only thing that can is the runner's own record of its own run.

So item 5 reads it back. Configure it and nothing else changes, with one exception: when
`gates.commit` writes that same file, the revert test reads it too, to tell whose red it saw (see
[the revert test](#landmjss-revert-test--how-a-new-test-file-is-found-and-run)). A `gates.commit`
that does not write it is judged exactly as if no report were configured.

```
horde.mjs config set gates.report.path   "<path, relative to the tree the gate ran in>"
horde.mjs config set gates.report.format junit|tap|playwright-json
```

The path is where the gate command's own runner leaves its report — resolved inside the fresh tree
the gate was just run in, because that is where the run that counts actually happened, and it has to
stay inside it: an absolute path, or one climbing out with `..`, would read a file some other run
wrote and is refused rather than read. Horde runs no runner and configures none: the environment and
the runner are the repository's, and all this does is read the file that run left behind. A format
outside those three is refused by name, and so is a file that does not read as the format it claims.

Reading it costs one look at the tree's own promises and one read of the report file, paid only where
a report is configured at all.

**What it requires.** Every **live** promise (`status: implemented`) whose pairing is something a
runner runs has to be in the report, passing. Missing, `skipped` or `failed` is a red gate that names
the promise, not just "gate failed" — the fix is a worker's to make: write the case, un-skip it, or
make it pass, and run again. That is why this is an item and not a guard: nothing here refuses
outright and no client answer waives it, because unlike a rewritten rule or a deleted test this is
something trying again can fix. The report is read whether the command exited green or red — a
command can exit 0 over a runner that quietly skipped something, which is the exact case this exists
to catch.

**File-level and case-level.** A promise's pairing is one of two shapes and they prove different
things, so they are matched differently:

- a **mirror** pairing (a test file named after the promise) and a **self** pairing (the promise
  document is itself what runs) prove "this whole file ran and everything in it passed". The report
  must carry at least one case attributed to that file, and every case attributed to it must have
  passed;
- a **named** pairing (`evidence: <file>#<case name>`) proves "this one case ran and passed", inside
  a file that may hold other cases the promise says nothing about. The report must carry a case of
  that name, under that file where the format can say so, and every such case must have passed.
  Another case failing in the same file is not that promise's business.

The fourth pairing, an **accepted artefact**, is never looked for and never refuses: nothing runs an
artefact, so no runner's report could say anything about it. A live promise with nothing paired to it
at all is not looked for either — "nothing keeps this promise" is the evidence layer's question and
the evidence guard's, not a question about whether a run happened. A repository with no promises, or
none live, has nothing here to require: the item says which of those it found and reads nothing.

**How a case is matched to a file.** Writers spell this field four different ways, so the comparison
is deliberately generous about depth and strict about everything else. Both the paired file's path
and whatever the report carries (`file` on the case, `file` on the suite, `classname`, or the suite's
`name`) are cut into segments on `/` **and** `.`, any trailing file extension and any trailing
`test`/`tests`/`spec`/`specs`/`e2e`/`it` segment dropped, and compared case-insensitively; one is
attributed to the other when either segment list **ends with** the other. So
`promises/adds-two-numbers.test.mjs`, `/build/checkout/promises/adds-two-numbers.test.mjs`,
`promises.adds-two-numbers.test` and a bare `adds-two-numbers` are all the same file — while
`tests/adds-two-numbers.test.mjs` is a different one, because neither list ends with the other.
A case **name** matches when it is the declared name exactly, or ends with it after a separator a
runner uses to join a suite path to a case (`>`, `›`, `»`, `:`, `|`, `·`, or plain whitespace) —
anchored at the end, never a substring found in the middle.

**The three formats, and what each can actually tell you.**

- **JUnit XML** — an optional `<testsuites>` wrapper, one or more `<testsuite>` (which may nest), and
  a `<testcase name= classname=>` per case: empty when it passed, carrying a `<failure>` or `<error>`
  when it failed, a `<skipped/>` when it never ran. A case with both a failure and a skip counts as
  failed. This is the format with the best file attribution, and the one the acceptance test for this
  is written on.
- **Playwright JSON** (`--reporter=json`) — `suites`, each with a `file` and `specs` (or nested
  `suites`, which inherit the file), each spec a `title` and a `tests` array, each test a `results`
  array carrying a `status`. One entry per test, taking the **last** result's status: the earlier
  ones are retries, and a spec that failed once and passed on the retry is what Playwright itself
  reports as passed. `skipped` is skipped; `timedOut` and `interrupted` are failures, which is what
  they are.
- **TAP** — a plan line, then `ok`/`not ok` lines with a description, an optional indented YAML block
  and an optional trailing `# SKIP` or `# TODO` directive. Both a nested subtest's lines and its
  parent's own line are read, so a skipped case inside a passing parent is visible. A `# TODO` counts
  as **skipped**: TAP says a failing TODO is not a failure, and that is the point — a TODO is not
  proof either way, exactly like a skip.

**TAP's real limit.** A TAP stream carries no file attribution at all, structurally: a line says what
ran, never where it lives. So under `tap` a file-level pairing is matched the only way the format
allows — by name, against the paired file's own stem, with `-`, `_` and `.` read as spaces and the
comparison case-insensitive, so `promises/adds-two-numbers.test.mjs` matches a case called
`adds two numbers`, `adds-two-numbers` or `Adds Two Numbers`. That is a convention, not an
attribution; it is the `promises` package's own mirror convention read back, and the refusal says so
in those words. A repository that wants this checked exactly should pair by `<file>#<case name>`,
where the name is declared instead of inferred, or have its gate write JUnit XML or Playwright's
JSON, which carry the file. The fallback is keyed to the parsed report rather than to the format
name, so a JUnit writer that emits neither `file` nor `classname` is in the same position and is told
so in the same words.

**No report configured is not the same as a report that should be there and is not.** With no
`config.gates.report` at all, nothing is read and nothing is refused — the landing is exactly as
strong as it was before any of this existed — and the item says `no report configured` rather than
reporting a green it never checked, so a chairman reading a wave close or a `horde.mjs done` can tell
"verified against a real run" from "nobody configured one". With a report configured and no such file
in the tree the gate ran in, that is a red gate of its own: the command either does not write the
report or writes it somewhere else, and the refusal says both.

### the guards

Before any item is judged, four things are checked that no worker can fix by trying again. Every one
is deterministic — no model is asked whether a change is a weakening; two trees and Yggdrasil's own
machine documents say so — and every one refuses outright rather than reporting an item.

**The law guard.** A branch may not weaken the rules it is judged by. Six cases, each named
separately in the refusal because the fix differs for each: a rule present on the base and gone from
the branch; a `status:` demoted; a `review_by` moved; a **narrowed reach**; an added `yg-suppress`
marker; a rule detached from a node that carried it. Read from `yg aspects --json` (status,
`review_by`), `yg aspects --json --reach` (every unit each rule reaches, at every rung) and
`yg suppressions --json`, on the base tree and the branch tree. A CLI that cannot answer the
suppression inventory as a document **stops the run** rather than parsing a waiver listing meant for
a person: a suppression the guard failed to see is a rule silently switched off. A CLI that does not
know `--reach`, or takes it and ignores it, stops the run for the same reason: reach is what every
case below is measured on, and an unread reach is not an empty one.

Reach comes from `--reach` rather than `yg check --json --full`'s pairs because a rule at `draft`
has no pairs at all — the rung exists to keep it inert. Read off the gate, every draft rule's reach
was the empty set on both trees, and an empty set is never a strict subset of an empty set: narrowing
a rule at the first rung walked straight through this guard, and deleting one read as tidying away a
rule that judged nothing. A rung says whether a rule bites; what this guard compares is where it
applies.

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

**The evidence guard.** A branch may not weaken the proof it is judged by. Five cases, each named
separately for the same reason: a promise that read `implemented` on the base and does not on the
branch (its own status changed, or the promise is gone); a promise whose **paired case** is gone —
the four pairings the `promises` package knows, read the same way it reads them (a mirror file, a
`<file>#<case name>` target whose case is actually there, the promise itself, a complete accepted
artefact); a **test file removed**; a test file carrying **fewer assertions** than it had; and a
test file carrying **more skip or exclusivity markers** than it had. The files it watches are
whatever `config.testGlobs` recognise, plus whatever keeps a live promise, whether or not the globs
would have recognised that. A repository whose `has-evidence` aspect **pins** one pairing for every
promise, instead of leaving it `auto`, is read the same way: the pin decides the pairing, not each
promise's own frontmatter.

Assertions and markers are each counted off a **closed list per language**, combined into one
pattern so nothing is counted twice, and compared **per file** — never in total, since assertions
moved from one file to another are a split, which is a thing to say out loud rather than a number
that happens to come out even. There is no threshold and nothing to configure: the only figure that
decides anything is the difference between two counts. The languages are the ones this tool already
recognises elsewhere — the six build systems `horde.mjs init` reads a repository with, plus .NET,
whose markers the package's own skip list already names — and a suite written in anything else
counts zero on both trees, which compares equal and refuses nothing. Two things are deliberately
not weakenings: a file whose exact bytes turn up under a new name is a **rename**, not a removal,
and a promise already parked on the base was keeping nothing, so nothing about it can have stopped.

**The gate guard.** A branch may not weaken the gates it is measured through. What it watches, on
the base tree: the file a `config.gates.*` command actually **runs** (every token of the command
that names a tracked file — a command made of shell builtins alone names none, which is the honest
answer, since nothing here can see inside `npm run gate`); the **commit and push hooks**
(`.husky/pre-commit`, `.husky/pre-push`, `lefthook.yml`, `.lefthook.yml`, `.pre-commit-config.yaml`
— the same list `horde.mjs init` reads, plus the two push paths); and every **CI workflow** file
(`.github/workflows/*.yml`, `*.yaml`). Any of them removed, or its content changed, refuses.
`config.gates.*` itself is not compared: it lives in `.horde/`, which is in neither tree, so there
is no earlier version of it to compare against. `config.protectedPaths` is not watched here either
— item 3 already refuses a branch that so much as touches one, with no way through at all, and a
second refusal naming a client answer that still could not land the change would be worse than
saying nothing.

Both read the branch's own three-dot diff against its parent and compare only paths in it — the same
reading item 3 and the conflict guard already take. Two trees differ for two reasons and only one of
them is this branch's doing: without that confinement a branch merely left behind by its parent would
read as having deleted every test the parent has added since. Both are let through by the same
`decisions.md` answer the law guard reads, of the same kind `lower`, with the same two scopes — what
differs is only the name on it: `evidence:<promise id>` or `evidence:<test file path>` for the first,
`gate:<path>` for the second. One answer lets one thing through, never a category.

**The conflict-of-interest guard.** A branch may not sharpen a rule and change the code that rule
refuses in the same landing: whichever way the rule now reads, it reads that way because the code
needed it to. Adding a new rule is not this — it judged nothing before. Raising an existing rule's
status is not this either — the text judging this code is the one that already judged it. Changing
what a rule *says* (`content.md`, `check.mjs`, `companion.mjs`, `when`, `scope`) while changing a
file it reaches is. The refusal names the rule, the file, and the way out: one ticket for the code,
one for the rule, landing separately so each is judged by a law it did not write. Nothing waives
this guard — no ask kind, no answer in `decisions.md` lets it through; the split is the only way
out.

### the lock

`.horde/gate.lock`, one per repository — `.horde/` is resolved through the git common directory, so
every worktree of one repository finds the same file, which is the point. It is held around the
expensive half only: the repository's own gate command and both `yg check` runs. Two landings on one
repository serialize instead of running each other's commands over each other's lock; the second
waits `config.gateLockWaitMs` (default two minutes) and then refuses, naming the pid holding it. The
file carries that pid, so a lock left behind by a process that died is **taken over with a note**
rather than waited on forever, and an unreadable (half-written) lock file is treated the same way.

### batching

Two or more tickets asked for in one call — a comma-separated list on the command line, or the
comma-joined ready set `tick.mjs` hands over (see its own step 2, below) — never simply run the nine
items once each in a loop: `land.mjs` works out which of them can share the lock above, and shares it.

**Eligible** means both of two things at once: the same parent branch at the same tip (nothing else
makes "non-overlapping" mean anything — two tickets against different bases are not landing onto the
same tree), and no changed file in common with another eligible ticket (the same comparison scope
already uses, read off each branch's own diff — Yggdrasil's own derived lock files never count
toward a collision). A ticket that fails either test is not excluded from the run, only from
**this** shared hold; it lands on its own instead, in the same call.

For an eligible group: items 1, 3, 4, 8 and 9, and every guard, still run per ticket, individually,
exactly as for one — nothing about batching changes what they measure or when. What changes is items
5-7 plus the judge item: a throwaway worktree at the group's own parent tip, each member's branch
merged onto it in sequence (`--no-ff`, discarded the moment the gate has run — never referenced by
any branch), and the gate lock taken **once**, around one run of the repository's own gate command,
`yg check`, and the mapping item, against that combined tree. A branch that unexpectedly conflicts
while combining — declared files can lie, or two tickets can touch the same file under different
declared components — drops out of the group right there and lands on its own instead; the rest keep
combining.

**Green** merges each surviving member into the real parent individually, in sequence, exactly as a
solo landing would — the batching only changed how the gate ran, never how a member's own merge
commit, size figure or journal bullet look. **Red is never bisected**: every member of the group
falls back to landing on its own instead, in the same call, one at a time — the worst case (something
is actually wrong) costs exactly what N separate landings cost today; the best case (everything
passes) costs one run instead of N.

"Lands on its own" always means the same thing land.mjs already does for a single ticket, run fresh,
with nothing about the batch attempt carried over — no consumed "once" answer, no already-computed
check. It can still refuse, for the same reasons a solo landing always could — most notably, base
freshness: two tickets that shared one parent tip and are landed one after another (whether as a
batch's own fallback, or as two ordinary solo landings racing today) will see the first one's own
merge move the tip out from under the second, which has never incorporated it. That is not something
batching introduces — a worker's own branch has to catch up with its parent before it can land,
batched or not — but a branch the parent merges into cleanly is brought up to date and landed in
that same run, and one it conflicts with is refused as stale before any gate: worth knowing before
reading a red "base freshness" on a ticket that looked, moments earlier, like it was about to land
clean.

`--no-gate` never batches — with items 5-7 skipped outright, there is nothing expensive left to
share, so every ticket in the list just lands on its own, exactly as `--no-gate` behaves for one.

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

### what became of a ticket after it landed

`land.mjs <ticket> --fate reverted --by <sha>` and `land.mjs <ticket> --fate reopened --by <ticket>`.
Neither runs a gate — the branch is gone by the time either is reached — and passing a gate flag
beside `--fate` is refused rather than ignored.

A landing was the end of the record and is not the end of the story. Two things happen to merged
work and used to leave no trace at all: the merge is **reverted**, or the evidence row the ticket
claimed to turn green goes red again and a new ticket is filed to earn it back — the ticket is
**reopened**. A return is the plainest signal a mission gives that its own evidence was not enough.

Both are written where the landing is written: the ticket's result file, in a `fates` array beside
the run's own items (`{fate, by, at}` — a ticket whose merge was recorded by hand and has no result
file gets a bare `{ticket, fates}` record instead), and the wave journal, as a
`- <date> reverted|reopened: <ticket> <by>` bullet. Idempotent in both: one fate carried by one
thing is one record however often it is reported. Nothing in the queue moves — the merge commit
still stands, and a reopening is its own ticket with its own landing ahead of it.

Both references are checkable by whoever reads the record later, and neither is taken on the
caller's word: a revert names a commit this repository actually has, and a reopening names a ticket
that says `**Reopens:** t-NNN` itself (`tk.mjs new … --reopens NNN` writes that field). `wave.mjs
close` counts both off the journal, and `retro.mjs` reads them as a source of their own.

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

## retro.mjs — what nobody read twice

`retro [--horde h] [--tree p] [--json]`, and it runs twice.

The first run gathers, and reads `.horde/` alone — no tree, no graph. Its input is everything the
mission wrote that nobody read a second time: every `checks[]` entry with `ok: false` in
`hordes/<h>/land/<ticket>.json`, every `fates[]` entry in the same file (what became of that ticket
after it landed), and every line of a ticket's `log.md` that is NOT a state entry. The
distinction is mechanical and is the shape of the line, never its words: `transitionStatus` writes
`- <iso> status: <state>…` and `appendLog` writes everything else. Each item carries a key
(`gate:<ticket>:<n>`, `reopen:<ticket>:<n>`, `revert:<ticket>:<n>` or `log:<ticket>:<n>`) stable
across runs. Nothing that cannot be read stops the
run — an unparsable result file, a missing `log.md`, a ticket directory with no log at all — each
becomes a note on the document instead.

A **return** is its own source and stays named as one, all the way to the document: a refusal is the
law catching something before it landed, and a return is the evidence failing after everyone had
agreed it was enough. Reading the second as more of the first would lose the only signal a mission
gives about whether its own bar was high enough. Returns are classified like every other item, and
the document lists them again under `returns` — so "what came back on this mission" is answerable
without filtering anything, whatever class each one was given.

Between the two runs, one one-shot (`brief.mjs retro`) classifies every key into `rule`, `taste` or
`inexpressible` and writes `hordes/<h>/retro-classes.json`. One one-shot for the whole mission, never
one per territory: measured at real-mission scale (40 tickets, four waves) the input is ~70KB against
the 400000 a single territory is held to, and the repetitions across territories are the reason to
read it in one place.

The second run validates that file — every key classified exactly once, a `rule` carrying its
sentence, its component and `check`/`prose`, a `taste` carrying a component and no rule, an
`inexpressible` carrying neither — and writes `hordes/<h>/retro.json` (`horde-retro/1`) with
`retro.md` beside it: `{schema, horde, at, state, items, law, returns, taste, inexpressible, logged,
judge, threshold, notes}`. A `taste` item leaves one line in its component's own log through
`yg log add` and nowhere else; a key already on the previous document is never logged twice, and one
retrospective runs at a time (`hordes/<h>/retro.lock`, taken over when the pid holding it is gone).
That `yg log add` write, and the judge measurement beside it, run against the tree `--tree` names;
without it, cwd, the same ordinary default every read in this tool set takes, not this horde's
trunk just because a horde was resolvable. `--horde h` written out (no `--tree`) is what changes
that, exactly as `queue.mjs plan`/`quality`, `tick.mjs`, `land.mjs` and `horde.mjs done` already
read it (issue 114 — before it, the second run read this horde's own trunk unconditionally).
Writing twice replaces the document; nothing is appended.

`law` is the rule proposals, ready for whoever works that area to write. `inexpressible` is structured
facts — ticket, source, the words that were written — and never a sentence for a client: the session
writes that, the same way it does for `ask`. `threshold` compares the `inexpressible` share against
`config.retro.inexpressibleThreshold` and prints both, so a bar set after the number is known is
visible as one.

`judge` is a measurement and never a gate. At `config.retro.judgeSampleRate` above 0 a sample of
LANDED tickets has the verdicts already recorded on its own files and components re-packaged through
`yg verdict package`, and a second judgement by `config.retro.judgeTier` is put beside the first; the
disagreement comes back with `wilson(k, n)` at that sample size. At a rate of 0 no `yg verdict`
command runs at all.

Reaching a comparison takes two runs, because a graph holds ONE verdict per (rule, unit) pair and
every write replaces it: recording the second judgement is what destroys the first, and no single
`yg verdict read` can ever answer with both. So the first run writes the first judgement down — who
judged, what they said, and the two hashes the package binds a pass and a refusal to, in
`hordes/<h>/cache/judge-samples.json` — and hands the pair back on `pending` with the command that
puts it to the second judge. The second run reads the slot again, now holding that judge's answer,
and puts the two side by side. Whether the code moved in between is answered by those two hashes and
never by the recorded verdict's own: a verdict binds to a hash with its verdict word folded in, so
two judges who disagree about code that never moved always record two different hashes, and reading
that as a change would drop every disagreement there is. A pair the CLI will not package is a skip
with its reason; so is one whose two judgements turn out to be about different code, and that one
counts neither way. None of it refuses anything.

A pair whose first judgement is a PASS that still holds is packaged like any other — Yggdrasil 6.1.0
and newer hands its package over marked `inForce: true` — but `yg verdict record` still refuses to
write a second verdict over it, because that would replace a judgement that still applies with no
evidence anything changed. So its `pending` entry carries a different command, `retro.mjs --second`,
which keeps the second judgement beside the first in `judge-samples.json`, bound to a hash that
pair's package named when the first was written down (a hash for other code, or for the other
verdict word, is refused), and the next run compares the two like any other pair. On a Yggdrasil
before 6.1.0, which refuses to package such a pair at all, it is out of reach, on `passInForce`
rather than `skipped`, and the document says how many fell there whenever there is a figure to read.

`horde.mjs done` requires this document, and requires it to have been taken over the mission's landed
tickets as they now stand — `state` is how it tells a current retrospective from one taken before the
last thing landed.

## tick.mjs — the loop, as one run

`tick [--runner session|external] [--watch] [--stack] [--tree p] [--horde h]`. Four things in order,
then it exits — nothing lives between runs, so there is no roster and no minute count anywhere in it.

The tree reconcile, the gate and the dispatch list all run in: `--tree` names it outright; short of
that, cwd — whatever the calling shell happens to be sitting on — the same ordinary reading every
`node.mjs` read takes, not this horde's trunk just because a horde was resolvable (see the top of
this file). `--horde h` written out is the one thing that changes that default instead of only
selecting which horde's queue, asks and charter this run reads: it resolves to that horde's own
trunk worktree, exactly as `queue.mjs plan`/`quality` already read it — now two places, not one.
A run launched from a shell on some other branch of the repository (or, in a multi-horde repository,
sitting in a different horde's own tree entirely) reconciles, gates and dispatches there unless
`--horde` says otherwise; the boot sequence's own bare `tick.mjs` call carries neither flag, so it
inherits whatever tree the session's shell is already in.

1. **Reconcile.** Every `running` item whose call has come back without landing a sha, settled from
   its branch: a commit beyond the parent goes to `landed`; a dirty worktree is committed as
   `wip: reclaimed` and goes back to `queued`, worktree kept; a clean one with nothing on it goes
   back to `queued` and gives up its worktree. A `running` item with no branch is skipped. Each
   answer says what was salvaged, because whoever reads it is usually reading it after a crash.
2. **Land what is ready.** Every `landed` item: the gate's own result file
   (`hordes/<h>/land/<ticket>.json`) is read, and when it is missing, unreadable, or about a sha the
   branch has moved past, it is added to the gate's own re-run list. Every item on that list, this
   whole run, goes out as **one** `land --background` call (comma-joined), not one call each — so any
   of them that turn out non-overlapping and on the same base share `land.mjs`'s own one run of its
   expensive items instead of each paying for one (see "batching" in `land.mjs`'s own section above);
   which of them actually can is entirely `land.mjs`'s own call, made once it has all of them in
   hand. Green merges the item and writes the wave-journal bullet. Red puts the ticket back with
   the gate's own words and the round counted; when the rounds are spent the item and the ticket
   both go to `blocked` and one `stuck` ask is filed for the client, carrying those last words and
   the path of the ticket's log. A `landed` item whose branch has vanished is a refusal naming the
   branch, with nothing touched.

   **The review, once per ticket, before its first gate.** The first time an item would go on the
   gate's re-run list, it goes on `review` instead — `{ticket, model, name, brief}`, `model` the
   ticket's own class, `name` `r-NNN`, `brief` the `brief.mjs review` command — and the gate is not
   asked about it in this run. The queue item records `review: {name, sha, raisedAt, closedAt}`.
   From then on the gate waits until the ticket's log, after `raisedAt`, carries the line that ends
   the review: its closing line (`tk.mjs review-close`) or the director's skip with a reason
   (`tk.mjs review-skip`). Until then every run puts `{ticket, action: "review-waiting", note}` on
   `landed`, naming both commands, and does nothing else about it — there is no timer, under either
   runner. Once the review has ended, the gate is asked whatever it found, with one exception: a
   finding it logged before that line — a change request `review: <node> changes by <who> — …`, or a
   line opening with its severity — naming `Critical:` or `Important:` puts the ticket back on
   `changes` the way a red gate does, round counted against the same cap (not a second time when the
   review wrote the status line itself, as the discipline has it do), and `blocked` with a `stuck`
   ask when the rounds are spent. `Minor:` alone never does. Whichever happens sets `closedAt`, and
   from then on nothing the review wrote is read again: a fix round goes to the gate with no second
   review, and a finding or closing line that arrives after the review ended stays in the log. The
   closing line only counts findings; what tick does never depends on it beyond its being there, so
   a closing line counting zero and one counting Minor findings reach the gate the same way, and a
   line claiming to approve is read by nothing. A hold on a branch's landing (`stop`, `lower`) holds
   its review too, since the review is the first half of that landing.

   **A gate that is still running is not asked for twice.** A landing does its slow half (the revert
   test, the guards) before it takes the gate lock and writes no result until it is done, so for that
   long nothing on disk says the branch is being landed. The run that starts a gate records
   `gate: {pid, sha, at}` on the queue item, the pid being the process `land --background` started.
   While that process lives and the branch still stands at `sha`, every later run puts
   `{ticket, action: "gate-running", note}` on `landed` and does not ask again; a pid that is gone
   with no result written is a landing that died, and the next run asks the gate again.
3. **The dispatch list.** `queue.mjs next`'s own order (stacked last, quality last, then severity,
   then the longer remaining critical path, then a node nothing is running on, then FIFO), with its
   file locks and its dependency rule, cut to the configured parallelism cap minus what is already
   running. Every entry has had its branch and worktree cut, so the `brief` command on it renders
   against a tree that exists — and that command carries `--horde`, never `--tree`: the brief reads the
   worktree off the ticket's queue item, and its graph reads (the node's ports) go to the horde's trunk,
   because nothing has run in a worktree that was just cut and a CLI that works from the trunk may
   not work from there; `model` is the ticket's own class. A stacked entry carries the
   separate line `STACKED, parent t-NNN unmerged`. `judge` carries the prose pairs the gate handed
   back, and only under `config.judge: one-shot`. `askClient` is the open items of `asks.json` — an
   absent file is an empty in-tray, never a refusal. `landing` is how loaded the landing gate is:
   `{ready, measured, lastMs, meanMs, maxMs, forecastMs}`. Landings are serial — one gate at a time
   whatever the number of workers — so this puts the branches waiting for it (`ready`, the queue
   items in `landed`) next to what a landing has cost, read from the `timing` each result file in
   `land/` records (`gateMs`, and `sharedBy`, the group size when a batch shared one gate run; a
   member's share is the gate time over that size). `forecastMs` is `ready` times the mean: how long
   the queue would take landed one after another. It measures and reports and holds nothing back —
   no threshold, no limit; what counts as too long is the director's call. Nothing measured yet
   gives nulls and the line says so. `status.mjs` prints the same line.
4. **Close.** A queue holding nothing but `merged` items gives `close: true` and the command that
   closes the wave. Tick prints that command and never runs it.

**An open question holds only what depends on its answer.** A client away from their desk does not
cost the mission the work their question has nothing to do with, so each kind of open ask holds one
thing and tick hands out the rest:

| open ask  | what it holds                                                                | what still moves |
|---|---|---|
| `stop`    | everything — the dispatch list, every branch's landing, and the close        | a call already in flight still comes back and reconciles |
| `stuck`   | that one ticket                                                              | every other ticket in the queue |
| `charter` | every ticket earning an evidence row the question names                      | tickets earning rows it does not name, and tickets earning none |
| `lower`   | that one branch's landing — the gate is not asked, no round counted          | the whole queue, that branch included once the answer comes |

`stop` is the widest kind and holds accordingly: it is the one a worker files when the spec has run
out under it, so nothing new goes out, nothing merges, and a queue holding nothing unmerged does not
raise the close flag (nor does `--watch` exit its loop on it) until the client has ruled. A `charter`
question names its rows by id (`E1`, `E2`) in its own text, read off the charter's catalogue exactly
the way `charter edit --ask` reads it; one naming no row holds nothing.

Holding a landing means not asking the gate at all, rather than declining to write the answer down
afterwards: the gate merges the branch into its parent itself the moment every item comes back
green, so by the time there is a result to read the merge has already happened. Not asking it is
also what spares the ticket its fix rounds — a `lower` question is exactly the case where a guard
comes back red on something only the client can agree to weaken, and a round spent on that is a
round spent on a question no worker can answer.

Nothing here writes: a hold is worked out fresh every run from what is open right now, so an
answered question releases what it held on the next tick with no state to unwind. `held` in the JSON
is one entry per thing held — `{ticket, ask, kind, holds, note}`, where `holds` is `dispatch`,
`landing` or `close`, and `ticket` is `null` where the thing held is not one ticket.

**Under `session` (the default), tick never spawns — the caller does.** `--runner` only names who
the caller is, and only `external` changes what this script does: with nobody in front of it,
tick.mjs spawns each worker itself, through `config.runner.spawn` (`<class>` and `<brief>` filled
in), and each review on the `review` list the same way, from its own brief file
(`hordes/<h>/briefs/NNN-review.md`, beside the worker's `NNN.md`); every `external` entry says which
with `role`. Under `session` it starts nothing at all. `--watch` repeats the run every `config.tick.interval` seconds until the
queue empties or a signal arrives — an open `stop` holds the close, so it keeps waiting rather than
exiting on an emptied queue the client still has a question about; a signal exits cleanly, holding no lock. A refused pass does not
end the loop, but only when the refusal is a `HordeError` — the deliberate, named kind every `fail()`
call raises, for something a later pass might well find gone (a lock another run holds, a file being
written as this one read it): stderr gets `error: <message>`, the mission journal (`plan.md`) gets one
`tick refused:` line, and under `--json` stdout also gets `{horde, refused, at}` — `refused` the
refusal's full message (not cut to the journal line's first line of text the way that line is), `at`
its own ISO timestamp — and then the next interval asks again. Anything thrown that is not a `HordeError`
is a bug in the loop itself, not a refusal one later pass could find resolved, and is left to
propagate uncaught: that pass, the loop and the process all end on it, rather than a real bug being
retried forever under a refusal it never was.

It holds the landing gate's own lock — `.horde/gate.lock`, not a second one — so two ticks on one
repository cannot hand the same ticket to two workers or cut one ticket's branch twice. A
`queue.json` caught half-written is refused by name and never written over — that file is the
mission's own state, and an empty document written across a truncated one is the worst thing this
tool could do.

## Constants and where they come from

A threshold has provenance, not a signature — a constant nobody can source can neither be defended
nor changed. `packages/promises/yg-package.yaml`'s `max_bytes` is the pattern: it closes with a real
transport measurement, not a design sentence. The rest of this table is the honest state of the
others — where a number has that kind of backing and where it does not.

| Constant | Value | Set in | Where it comes from |
| --- | --- | --- | --- |
| `parallelism` | 6 | `horde.mjs` `defaultConfig()` | Not recorded. No comment or history explains this count; it has carried the same value since the plugin's first release. |
| `fixRounds.resume` | 3 | `horde.mjs` `defaultConfig()`, read by `tk.mjs status` and `node.mjs` | Not recorded. The comment explains the two-phase mechanism — resume the same worker, then a fresh one a class up — never why three rounds of the first phase. |
| `fixRounds.fresh` | 2 | `horde.mjs` `defaultConfig()`, read by `tk.mjs status` and `node.mjs` | Not recorded, same comment as the resume count above — the fresh-worker round count is equally unexplained. |
| `tick.interval` | 300 (seconds) | `horde.mjs` `defaultConfig()`, read by `tick.mjs --watch` | Not recorded. The comment says what the setting is for (an unattended loop's own pace), not why five minutes rather than one or ten. |
| `territory.maxBytes` | 400000 (bytes) | `horde.mjs` `defaultConfig()`, read by `refine.mjs --step cut` | Not recorded. The comment lists what counts toward the budget — code, rule text, logs — never why 400000 specifically; unlike the promises reference row below, nothing ties it to a reviewer's own limit or any other measured ceiling. |
| `law.retireAfterWaves` | 2 (waves) | `horde.mjs` `defaultConfig()` | Not recorded. The comment explains the policy — a rule that judges nothing loses its place — not why two waves earn that judgment. |
| `law.qualityDropAsk` | 0.1 (fraction) | `horde.mjs` `defaultConfig()` | Not recorded, same comment block as the wave count above — nothing ties the tenth specifically to a measured or agreed tolerance. |
| `WAVES_CLEAN_FOR_ENFORCED` | 2 (waves) | `node.mjs:641` | Not recorded. The comment states the policy — a rule blocks the merge once it has held for two waves, not once it looks right — not why two rather than one or three. |
| `escalate.mjs recurring --min` (default) | 3 | `escalate.mjs:53` | A stated design heuristic, not a measurement: the comment argues three identical answers mark a pattern rather than coincidence. No measurement or client decision sets the number itself. |
| `max_bytes` (reference — already sourced) | 32000 (bytes) | `packages/promises/yg-package.yaml` | Transport constraint, measured: a reviewer tier naming no limit of its own is gated at 50,000 characters; this rule's own text runs about 2,450 of them and a promise adds a few hundred more; 32000 leaves the rest as headroom for the prompt's own framing. |

"Not recorded" is not a claim that a number is wrong — it may be exactly right — only that nobody
has yet written down the measurement, the transport ceiling, or the client's call that would let a
future change be judged against something. Where the maintainer makes that call, the row changes
from "not recorded" to whichever of the three actually applies; it does not get a fourth kind of
answer invented to fill the cell.

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
   written through `charter edit` with two evidence rows; a ticket is filed carrying `Files`,
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

The item detects a new OR changed test file generically by name, against `config.testGlobs` rather
than by inspecting file content — a repository's own test patterns aren't otherwise knowable from
this tool set. A modified existing test file is treated the same as a new one: its content on the
branch is extracted onto the revert base exactly like a new file's, and must show a failure there
too — a change to an existing test's assertions proves nothing about the code it now checks if it
already passed on the base unmodified. `horde init` fills `testGlobs` from the repository's build
files; when it is empty the item is ✗, because a ✓ reading "no new or changed test files in diff"
over a repository whose tests this tool cannot recognize is the strongest guarantee in the checklist
passing without looking. A ✓ names the patterns it did look for. A matched file whose extension
`node --test` can run directly is extracted and run that way. Anything else goes to
`config.gates.testFile` when one is set — a command with `{file}` standing for the file's path, run in
the scratch worktree, where red is proof and green is not; a command that never ran (the shell's 126
and 127) is "no verdict", not proof — and otherwise falls back to running the whole
`config.gates.commit` command in the scratch worktree, because isolating just one file's test lane
out of an arbitrary configured command isn't possible in general. Both revert-test variants take this
route.

A whole command's exit code is not one file's result, in either direction. It can be red before the
file is anywhere near it — a test nobody touched failing, an environment that isn't there — and a
runner can skip a file it cannot load and still exit 0. So the fallback never reads the exit code
alone:

- **The index goes with the tree.** Each of the ticket's test files is added to the scratch tree's index
  the moment it is written there and taken out of it the moment it is removed, so a runner that works
  off the index (a pre-commit hook, lint-staged, anything asking `git diff --cached`) finds the file
  instead of exiting 0 over an empty index. In the mutation variant the scratch tree is the branch's own
  tip, which is committed, so its HEAD is moved back to where the ticket began and the whole change
  sits in the index; the mutation itself stays in the working tree.
- **A control run first.** `gates.commit` runs once on the same tree holding none of the ticket's own
  test files: the base exactly as it stands (a changed file's base version included) for the
  revert-to-base variant, the mutated tree with them taken out for the mutation one. Red or stopped
  there, every fallback file is "no verdict", and the note says which of the two: its red with the
  file in place would say nothing about the file.
- **Each file on its own.** Each file is put in, run, and taken out again, so one file's red is never
  another file's proof.
- **Proof** is red with the file in place and green without it — the control-run rule.
- **The report, only when this run produced it.** `config.gates.report` names the report of the
  landing gate's own command, and `gates.commit` may or may not write the same file. The fallback
  clears that path before every run, so a file there afterwards is this run's own. When it is there,
  a red counts only if the report attributes at least one failing case to the file — by the same
  file-attribution rule the gate item reads it with — or the red came from somewhere else and is "no
  verdict"; a produced report that cannot be read (not the configured format, or a format nothing
  here reads) is "no verdict" too. When it is not there — or no report is configured, or the
  configured path is one nothing may look at — the control-run rule alone decides, and the result
  says "no report was available" and why. A report configured for the landing gate that `gates.commit`
  does not write therefore never refuses a run that the same repository without one would pass; only
  a report the run wrote can add a refusal, by showing that the red was not the file's own or by being
  unreadable.
- **Green is never proof.** "Not load-bearing" is said only when a produced report shows every case
  from the file ran and passed on that tree. Green with nothing from the file in that report is a file
  the runner never ran; any case from it skipped is a file that did not fully run; green with no
  report available cannot tell a skipped file from a test that proves nothing. All of those are "no
  verdict", never that verdict.

"No verdict" is a ✗ like any other: nothing lands without proof, and no flag or declaration waives it.
It says why the run showed nothing, and the item names the ways out once: make `gates.commit` green
on the base without the file; name a revert base where it is green (`**Revert base:** <ref>`); give
the ticket a `**Mutate:**` command that only this file catches; or run the file with a command for
that one file (`config.gates.testFile`, with `{file}` standing for its path). A ticket that carries no such file pays nothing for this;
one that does pays one extra `gates.commit` run per landing.

A diff with no new or changed test file is not automatically refused: a ticket can declare
`**No new tests:** <reason>` in its issue.md, and the item passes on that declared exemption
instead of running anything. Without that declaration, no new or changed test file is a refusal —
naming the patterns it looked for and the field that would explain the gap.

Two variants exist, chosen by the ticket itself — never by a `land.mjs` flag. The default is the
revert-to-base one above: the new or changed test files extracted onto the parent branch's tip (or
another ref, via `--revert-base`), where the ticket's own implementation doesn't yet exist and the
tests must therefore fail. When the ticket instead carries a `**Mutate:**` command (`tk.mjs new
--mutate`), `land.mjs` runs the mutation variant: it builds a scratch copy of the branch's own tip —
which already holds both the ticket's tests and its implementation, so nothing needs extracting —
runs the ticket's command there to deliberately break that implementation, and requires the same new
or changed test files to fail against the broken result. A ticket naming both `--revert-base` and
`--mutate` is refused outright, at `tk.mjs new` and again as a defense-in-depth check inside
`land.mjs`: only one variant ever runs, so the other would be silently unused, which is exactly the
kind of ambiguity this tool set refuses rather than resolves by guessing.

The gate item accepts no recorded green run from anywhere — not a cache, not a ticket's own log.
It runs `config.gates.<level>` fresh on the branch's tree, every time. (`horde.mjs done` still
accepts a matching cached green for the trunk gate; that is its own call, about a mission already
merged, and it stays there.)

## nothing a landing runs waits forever

Every blocking step of a landing carries a ceiling, and none of them is optional. The gate command,
the revert test's `node --test` run and its `config.gates.commit` fallback, and a ticket's own
`**Mutate:**` command all stop at `config.gateTimeoutMs` (default 15 minutes). Every call to the
Yggdrasil CLI — `check`, the free half, the document reads, `drill`, the log writes — stops at
`config.ygTimeoutMs` (default 10 minutes), under the gate's own limit so a landing wedged on the
graph still gives up in time to write its refusal. A step that reaches its ceiling is stopped, and
the item reports the stop and the setting to raise, never a quiet ✓.

This matters most for `land.mjs <ticket> --background`, which `tick.mjs` starts for every branch
ready to land: that run is detached and unreffed, so nothing waits on it and nothing reaps it. Under
the old unbounded reads, a `yg check` that wedged — a worktree removed under it, a slow disk — left a
process with no parent, no limit and nobody watching, and it stayed until the machine was rebooted.
The fix is the ceiling on the step, not a watchdog over the process: a reaper would have to identify
its own orphans from outside, by argv or by a pid file, and both can end up killing something that
was never this repository's to kill.

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

## pre-6.0.0 history

6.0.0 cassated the seats: `steward`, `owner`, `verifier`, `auditor` and `counsel` are gone, and so
are the two channels only they used — escalations and dissents, both folded into the client channel
(`ask.mjs`). Nothing in this tool set writes any of it any more. `horde.mjs init` no longer even
creates the empty `dissents.json` it used to.

What stays is the reading side, so a mission started before 6.0.0 — and every archive of one — still
opens. This is the whole of it; nothing outside this section is on that path:

- `_lib.mjs`'s `teamPath()` resolves a leaf team name through `roster.json`'s `steward` entries and
  their `parent` links, which is how the nested `teams/<parent>/teams/<child>/` layout on an old
  mission's disk is addressed at all. A fresh mission only ever has `trunk`, and takes the fast path.
- `walkTeams` in `brief.mjs`, `retro.mjs` and `node.mjs` descends that same `teams/*/teams` nesting,
  so a ticket, a log or a queue filed under an old sub-team is still found.
- `brief.mjs` reads `roster.json` for the agent that spawned the one being briefed — its `spawnedBy`,
  its Agent-tool id, and, for a worker, the live `steward` of its team. A fresh mission writes no
  roster, so every role's `reportsTo` falls back to the director, `main`.
- `brief.mjs` refuses each cassated seat by name as an unknown role, listing the five that remain.
- `node.mjs map`'s roster-derived column reads those same old `owner` entries; `-` on a fresh
  mission.
- `blame.mjs` reads an old ticket's `**Keys:**` line (author, verifier, node approvals) and its
  verdict blocks' `**Gate:** … at sha …`, which are two of the three places a branch tip was ever
  recorded — without them a line introduced before 6.0.0 could not be traced to the ticket that
  wrote it.
- `tk.mjs status` refuses `verified` and `escalated` by name, saying what replaced each; a ticket on
  disk in either state is still read and shown exactly as it stands.
- `queue.mjs set` refuses `escalated` the same way, while the rendered `queue.md` still groups it —
  dropping the word outright would leave an old queue's own items out of its rendering.
- `status.mjs` still buckets a queue item in the retired `verified` state under "unverified", and
  both it and `wave.mjs` still read a `team`-level entry in `cache/last-gate.json`.
- `wave.mjs` still counts a wave's `escalated` items for the wave-close document, which is how an
  old mission's close still adds up; a fresh mission's always reads 0.
- A stray `roster.json`, `dissents.json` or `escalations.json` left on disk is read by nothing and
  crashes nothing.

The ruling behind the verdicts command — that Yggdrasil's own reviewer is the verifier, so Horde
does not keep a second one — is `verifier-is-yggdrasil-reviewer`, named here because its slug
carries a seat that no longer exists.

`land.mjs`'s gate levels are not on this list. `config.gates.team` is the gate a ticket branch lands
through and `config.gates.trunk` the one for a branch landing straight on `<horde>/trunk`; both are
live, both run on every landing, and `team` there is the name of a config key every adopter already
has in `.horde/config.json`, not a team anybody can pass. `--level team` is refused outright.
