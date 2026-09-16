# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `land --background` returns immediately and writes its result to a file. `worktree.copy` copies files into every new worktree.
- That same approval is now required for weakening the proof or the checks. A change is refused until you have said it is right if it puts a promise back to "planned" or leaves it with nothing keeping it, deletes a test file, leaves a test file with fewer assertions than it had, switches a case off, or removes or rewrites what a gate command runs, a commit or push hook, or a CI workflow. The approval names the one thing being weakened, so it never covers anything else. Adding tests, adding assertions and renaming a test file are unaffected.
- A test file that exists is not a test that ran. Point the mission at the report your own test run leaves behind — JUnit XML, TAP, or Playwright's JSON — and every landing reads it back: a promise counts as kept only when the case that keeps it is in that report and passed. One missing, skipped or failed turns the landing down and names the promise, so you know which one to fix. A mission that names no report is unchanged, except that the landing now says so out loud instead of reporting a green nobody confirmed.
- Every brief — worker, architect, legislate, retro, and each consultant — can be written to a file with `--out <path>` instead of printed in full.
- `retro` closes a piece of work with three lists: what belongs in a standing rule, what's worth saying once, and what no rule will ever capture.
- Evidence detection: the mission works out what counts as proof in your repository (test suites, a promises directory, a scenario runner) at the start and uses it; a repository with nothing at all is offered a ready-made `promises` package (five rules, four self-proving for free, the fifth advisory).
- A mission with nothing in the repository to prove anything with says so every time it matters — on every landing, in every wave report and in the end-of-mission review — instead of only once on the mission card. Everything that mission promised to prove rests on what it names itself, and somebody has to go and look at that to know it holds.
- What becomes of a ticket after it lands is part of the record: a merge that was undone, and evidence that went red again with a new ticket filed to earn it back. A wave report counts both beside what merged, and the end-of-mission review reads them as a finding of their own, apart from refused checks and workers' notes.
- The evidence package refuses a promise whose proof has been switched off: a promise counts as kept only while the case that keeps it actually runs. A case that is skipped, crossed out, or left behind another one marked as the only case to run is refused — unless the promise says nothing runs it yet. It knows the markers JavaScript, Python, Go and .NET suites use, and a repository can narrow that list to the ones its own suite uses.
- A ticket that does not match what the mission agreed to no longer joins the work. One that touches an area outside the mission's scope, or that claims a proof the mission never promised, is turned back with the mismatch named and the question to put to you. Answer it and the ticket goes in.
- A promise nobody can yet describe can be built as a prototype first: something that looks like the real thing, so the client can see it and say what they meant. It is worked ahead of everything else, it never reaches the main line of work, and its only proof is the client's own acceptance — what they were shown, who accepted it, and when. Until that answer is recorded, nothing else is planned against that promise. Once it is, the promise reads as answered on its own, both in what the client is shown and in the wave report, and it is never counted as something delivered.
- A promise still waiting on the client's answer to a prototype now shows on the status screen as its own state — prototyping — instead of looking identical to one real work has already started on.
- The plan shows how big each piece of work has grown — lines and files — and ranks it against the rest of the mission. The biggest quarter comes with a suggestion to split; taking it is the architect's call, nothing happens on its own. There is no size limit to tune: the ranking is against the work in play, so the same change reads differently in a mission of small pieces than in a mission of large ones.
- Landing a change and closing a wave both report the same size figure, so what a piece of work cost is visible where it lands and again when the wave is counted up.
- `history` lists every mission that has finished on this repository, newest first: what it set out to do, how much of what it promised was proved, the rules it proposed and the things it found no rule will ever capture, the questions you answered, and what it changed about the rules.
- Each agent planning an area is now handed what earlier missions already learned about that same area — and only about that area: the rules they proposed for it, what they found no rule holds there, and the answers you already gave about it. Nothing from anybody else's area reaches them.
- A promise in the evidence package can now say what kind of proof keeps it — an e2e scenario, a hermetic test, a mutation, a recorded stub, an artifact or client testimony — and who reproduces that proof: a gate, a guard, a worker or the client. Both are optional; a promise that says neither is unaffected. Anything outside those two lists is refused, so the words mean the same thing in every repository.
- The mission card's evidence catalogue can now say the same thing about each row of proof it lists — the same six words a promise can. Wave close counts the catalogue by that word, beside the existing green/total figure; a row that names none is counted as unstated, including every row written before this existed, and a row naming something outside the six words is called out on its own rather than counted as either.
- Before a ticket lands, a reviewer now reads its change once. The reviewer has no way to approve anything: it writes down what is wrong, if anything, and ends with one line saying the review happened and how many findings of each kind it wrote. The ticket waits for that line before the landing checks run, and every pass of the loop reports it as waiting. If a reviewer never finishes, the director can skip the review, and has to write down why. A Critical or Important finding sends the ticket back to its worker before the landing checks run, and costs one round, like a failed check. A Minor finding stays in the ticket's notes and never sends it back. The landing checks run in full whatever the reviewer wrote, so a reviewer who skimmed cannot make a change look safer than it is.

### Changed

- The conflict-of-interest guard can no longer be waived. A change that sharpens a rule and changes the code that rule judges, in one landing, is refused every time; splitting it into two landings is the only way through.
- A consultant's brief shows the port syntax the ticket tool actually accepts, with no version suffix, instead of a form that gets refused.
- Every write to the queue now goes through a single lock, so two sessions changing the same horde's queue at once can no longer silently drop one another's item.
- A worker proves its own change by running only the test(s) it touched, not the whole suite — the full suite runs once, at landing.
- `tick --watch` no longer stops on a refusal. It records what was refused in the mission journal, prints it, and tries again at the next interval.
- `tick --horde` now points the run at that horde's own trunk when no `--tree` is given, instead of whatever the current checkout happened to be on.
- `land --horde` does the same when run directly with no `--tree`: it now points at that horde's own trunk instead of whatever the current checkout happened to be on.
- `horde done` no longer switches to the mission's own trunk on its own just because only one mission is running — like `tick` and `land`, a bare run stays on whatever checkout you are already in; name `--horde <mission>` to point it at that mission's trunk instead.
- The architect, legislate and retro briefs no longer switch to the mission's own trunk on their own just because only one mission is running — a bare run now stays on whatever checkout you are already in; name `--horde <mission>` to point it at that mission's trunk instead.
- `wave start` no longer reads the mission's own trunk on its own, just because only one mission is running, when it records the wave's planned parallelism — a bare run now reads whatever checkout you are already in; name `--horde <mission>` to point it at that mission's trunk instead.
- `retro` no longer switches to the mission's own trunk on its own just because only one mission is running, for its taste-item logging and its judge measurement — a bare run now stays on whatever checkout you are already in; name `--horde <mission>` to point it at that mission's trunk instead.
- When two or more tickets are ready to land at once and touch none of the same files, they now share one run of the landing gate's expensive checks instead of each paying for its own — landing several ready tickets at the same time is faster. Each still gets its own merge commit, its own journal entry and its own size figure, exactly as before. A ticket that does not fit for sharing — a different base, a file another ready ticket also touches, or a shared run that comes back red — lands on its own instead, automatically, in the same pass.

### Removed

- Cost tracking and the charter's cost limit are gone: no cost report, no per-run ledger, and nothing stops a mission on a budget. Watch your own account the way you would for any other agent work.

### Fixed

- A rule proposal is only raised when the same answer has actually been given repeatedly. Three different answers to the same kind of question in one place no longer get treated as one recurring answer.
- The architect's instructions no longer point it at a step that always failed when a disputed port needed the director's attention.
- The example a reviewer is shown for sending work back with findings now runs, instead of naming a command that no longer exists.
- Raising a rule now credits the person who did the review, not the area of the codebase it covers.
- The worker brief now states the ticket log's actual location, including the horde-scoped path segment it was missing before.
- Copied straight from the documentation, the first commands for raising an architect, a worker or a territory's own rule-writer used to be refused. Every example in the docs now runs as shown.
- Setting up a repository built with more than one language or build tool now runs every one of their test suites at every gate, instead of only the first one found.
- A worker whose ticket names two components used to be handed a first step that always failed. It now works for one component or two, the same as everywhere else the ticket system allows both.
- The rule against code-shaped writing in a promise now names every kind of writing it actually refuses, table and field names included, instead of leaving two of them unexplained.
- Asking a ticket owner for a scoped re-review no longer points at a place that never had the file it asked for; it now says how to produce that file yourself.
- The evidence package's named pairing now requires the name to land on a real test case's title, not just appear anywhere in the file — a comment or a piece of prose mentioning the same words no longer counts as proof.
- A test suite that used to occasionally fail for no reason, when its tests ran alongside others touching the same files, now runs clean every time.
- A `tick --watch` loop that hit a genuine internal problem used to write it down as a refusal and keep going forever. It now stops and exits with an error instead, so the problem is noticed rather than retried silently.
- The documentation on who starts a worker under each runner now says the same thing as the mission loop actually does.
- The sample drawn for the two-judges measurement is now reproducible: run the retrospective twice over the same landed work and it draws the same tickets both times, and the retrospective document records what drew it.
- The two-judges measurement no longer credits a ticket with verdicts that actually belong to a different ticket, just because one ticket's declared files or component happened to be a text fragment of the other's name.
- The two-judges measurement now actually compares two judges. It used to report every sampled piece of work as still waiting for a second opinion, however many times you gave one, and the agreement figure was always zero out of zero. It now takes two passes: run the end-of-mission review, give the second opinion it asks for, run it again, and the figure and its margin are real. Two opinions on work that changed in between are left out of the count rather than read as a disagreement.
- The two-judges measurement now says when its agreement figure only covers part of the sample. A piece of work whose first opinion already passed, and still stands, can never be sent for a second opinion — that used to be counted as an ordinary gap in the sample, so the figure read as if it covered everything. It is now called out on its own, with how many of the sample landed there, so the figure is read against what it actually measures.
- Recovering a crashed worker's dirty, uncommitted work now writes a line to that ticket's own log, with the reason and the commit it saved — not only to the internal queue record.
- Status now also shows a ticket's work branch when its queue entry has been lost, labelled as needing attention, instead of hiding it.
- Landing a change that edits an existing test without adding a new one used to pass silently. It is now refused unless the change says plainly that it adds no test, with a reason — and an edited test is checked the same way a new one is.
- A mission with nothing in the repository to prove anything with used to have every ticket refused at landing anyway, by the check that looks for a new test in the change. That check is now skipped there too — nothing in such a mission is proved by running it.
- A mission with nothing in the repository to prove anything with used to fail the same way when its test-writing discipline was drilled directly, instead of only at landing. That check is now skipped there too — nothing in such a mission is proved by running it.
- A repository keeping its promises directory somewhere other than one of the usual four spots is now found correctly, once the evidence package is installed, instead of being read as having no evidence at all.
- Three permission-based tests no longer fail with a false alarm when the test suite runs as an administrator account, which ignores file permissions by design.
- The plan review now refuses with a plain reason when the plan itself can't be built, instead of crashing with a raw error.
- Two states a ticket could still be moved to — one for a separate verification step, one for an escalation — belonged to the roles that are gone. Setting either is now refused, and the refusal says what replaced it. Old work already sitting in either state still reads and still shows up everywhere it used to.
- Narrowing the status screen to a team other than the mission's own used to print a mission with nothing in it, reading as "nothing is happening here". It now says plainly that there is no such team.
- An unanswered question now holds back exactly what depends on the answer and nothing else: a stalled ticket holds itself; a question about the mission card holds the tickets earning the proofs it names; a request to weaken a rule holds that one change at the door. A worker who ran out of spec holds everything — nothing starts, nothing merges even when it is finished and passing, and the mission does not close — until you answer. An open question used to hold nothing at all, and a change waiting on your word could be sent back to a worker round after round for failing a rule only you could lift.
- The status screen now flags a ticket the gate has sent back for changes as unverified, instead of still showing it as landed or unmerged.
- Refusals that trace back to a git problem — a missing branch, a worktree that could not be made — now show what git itself reported, not just that something went wrong.
- A ticket whose acceptance items are ticked with a capital X now counts as having them. It used to read as a ticket with no acceptance at all, and could not be queued.
- A charter's quality policy that is not `autonomous` or `only-the-work` is now refused, instead of quietly running as the more permissive of the two.
- A check meant to catch a ticket touching files outside its allowed area now compares whole folder names, instead of just their starting letters — so a different, similarly named folder is no longer mistaken for being inside that area.
- A git failure partway through reading what a change touched used to be read as an empty change, letting the checks that depend on it pass without ever looking. They now refuse instead.
- Landings and mission closes run one at a time even when two of them start at the very same instant: two changes never land together, and the same closing line never reaches a component's history twice.
- A change that has just landed is no longer re-checked from scratch when the mission's final check runs right after it — it reuses that landing's own result. Closing a round of work straight after a landing now correctly shows that landing as checked, instead of showing it as not yet checked.
- A check meant to catch a ticket touching a path it must not is no longer fooled by a similarly named neighbour — a path you protect from `src/a` no longer lets `src/ab` through.
- A promise whose status a repository's own settings say means nothing runs it yet is now accepted throughout the evidence package, instead of being refused before that setting could take effect.
- A ticket that needed a fresh worker after enough rounds of changes now actually gets a heavier one, as already documented — not just a repeat of the same class as before.
- Under `--runner external`, a worker started automatically after a ticket has gone through enough rounds of changes is now briefed the same way a worker you start yourself would be — told a prior worker already tried this ticket, and given its own fresh identity — instead of being started as if it were a first attempt.
- Two commands reading one mission's trunk at the same moment — a running loop and one you type yourself, or two sessions side by side — no longer fail one of them with a raw git error. They take turns, and both get the trunk.
- Two commands changing one mission's queue at the same moment — a running loop and one you type yourself, or two sessions side by side — could rarely both believe they held the lock protecting it and overwrite each other's change. They now always take turns.
- Recording a decision or answering a question, interrupted partway through — killed outright, a container recycled — used to block every one after it until someone cleared it by hand. The next one now recovers on its own.
- A graph write refused for sitting on the mission's own base branch no longer creates the mission's trunk tree — or discards uncommitted work already sitting in it — just to name that tree in the refusal message.

## [6.0.0] - 2026-09-12

Needs Yggdrasil 6.0.0 or newer; an older one is refused with the release to install.

### Added

- Landing is automatic: a change that passes every check merges immediately; a failing one is refused with the reason. Only one change lands at a time; a crash mid-landing no longer blocks the next.
- `land --background` returns immediately and writes its result to a file. `worker.copy`/`worktree.copy` copies files into every new worktree.
- Weakening a rule (deleting, lowering, moving its review date, narrowing scope, unhooking, disabling for a file) requires the client's written approval — once per landing or for the whole mission.
- A change cannot both alter a rule and alter the code that rule judges in one landing; both are refused together.
- Every landing runs the full test suite against a real Yggdrasil build; the architecture check runs on the branch itself and must be fully green.
- `queue plan --out <file>` writes the whole plan to a file for the architect.
- The cost report now counts reviewer calls spent during landing, not just agent runs.
- A merge is refused when a file belongs to no component, or when a component's log or a graph-changing commit names a wave, ticket, mission or horde instead of describing the component itself.
- A request is split into components before anything is built; one agent per component, no two write the same files; a component too large is refused, with its size named.
- Nothing starts until the whole plan is reviewed once by someone who sees all of it.
- The mission is stateless between runs: `tick` reads the mission's state, advances what it can, and exits. `tick --runner external` runs it from any external scheduler, not only a live session.
- Work sent back past a set number of rounds stops and asks you one question instead of looping.
- `legislate` writes a component's own rules from what its work has been refused for.
- `retro` closes a piece of work with three lists: what belongs in a standing rule, what's worth saying once, and what no rule will ever capture — plus its cost.
- Evidence detection: the mission works out what counts as proof in your repository (test suites, a promises directory, a scenario runner) at the start and uses it; a repository with nothing at all is offered a ready-made `promises` package (four rules, three self-proving for free, the fourth advisory).
- Every merge commit records what it landed, what it proved, and what it did to the rules.
- A finished mission archives its own working directory automatically.
- `wave close` audits the rules: overdue `review_by` rules become renew-or-retire tickets, unhandled `yg advise`/`grain advise` items are picked up, and rules nothing has hit in two waves are named.
- One channel reaches you: a stalled worker, work sent back too many times, a request to weaken a rule, or a change to the mission card. Each answer is recorded in the mission's decision log.

### Changed

- No check accepts a recorded result; tests and rules are re-run, never taken on trust. Every step now stops at a time limit and refuses (naming what was stopped and the setting that raises it) instead of running forever — closing a leak that left dozens of orphaned processes on a machine running these checks all night.
- A port-change approval is required only from neighbours who actually named that port, not every neighbour of the shared component.
- A ticket with no acceptance line cannot be queued.
- Quality advisories file tickets only for nodes this horde leases; `--all` overrides.
- Mission-wide numbering (work, architect decisions, questions for you) now comes from one sequence instead of three, so a bare number is never ambiguous.

### Removed

- Ports carry no version. `<node>/<port>@<version>` is refused; `contract propose` no longer takes `--version`/`--as`.
- No standing cast: a mission runs on two roles, a worker per ticket and one architect — no steward, owner, verifier, auditor, counsel, or sub-teams.
- No signatures on a ticket: merging needs no author/verifier key or per-node approval.
- No charter file at a node; its rules, ports and log show through `node show`.
- No audit sample.
- No escalation/dissent mechanism — superseded by the one channel above.
- Claude Code's experimental Agent Teams feature is not used anywhere in this skill.

### Migrating a mission already in flight

Finish a mission started on an earlier release the old way — it still reads its own state and files itself away. Start fresh from the same mission card afterward; the new run rebuilds its work from the evidence the old one left, at the cost of one conversation per component touched.

## [0.4.0] - 2026-09-08

Experimental. Needs Yggdrasil 5.9.0 or newer; an older one is refused with the release to install.

### Fixed
- Reading the architecture's verdict on a large repository no longer fails with a buffer error. The report can run to several megabytes and is now read whole.

### Changed
- A node's charter no longer records who owns it or under which lease. That is the horde's working state and lives with the roster, so the charter stays true from one mission to the next.

## [0.3.0] - 2026-09-07

Experimental. Needs Yggdrasil 5.9.0 or newer; an older one is refused with the release to install.

### Changed
- Raising a rule now records why in that rule's own history, not on every part of the system it touches; only a raise that starts blocking merges leaves a note on the parts it now holds. A refused attempt to weaken a rule is recorded too. Needs Yggdrasil 5.9.0; an older one is refused with the release to install.

### Fixed
- A mission that grows a second team no longer ends up with one nobody can reach. Your own session raises every long-lived agent; a team's manager that wants a second team asks for it instead, and you are handed the exact steps to start it. Everyone answers to whoever raised them, and anything meant for someone further away is written down and passed up, so nothing is sent to an address that cannot answer.

## [0.2.0] - 2026-09-07

Experimental. This version needs a Yggdrasil newer than 5.8.0 — the first one that answers with the documents Horde now reads the graph through. Until that release is out, point the horde at a build of Yggdrasil's development branch: `horde.mjs config set ygCommand "node path/to/bin.js"`. An older Yggdrasil is refused with that instruction, never read around.

### Added
- Horde now needs Yggdrasil, and sets it up for you. Starting a horde on a repository with no architecture graph creates one first; with Grain installed as well, that first graph is read out of your own code — the components you actually have and the rules you already follow — and you are told up front how much of the code you have today those rules would refuse. Without Yggdrasil it stops and says what to install. The old fallback, a second and weaker map the horde kept for itself, is gone: there is one architecture, the horde reads it and never writes it behind your back, and how current it is has one answer instead of two.
- A promise between two parts of the system is now a real thing in the architecture rather than a note kept on the side, and it carries a version and the test that proves it. Proposing one — or raising its version — names that test and tells you who is still reading the old version; the architect approves it and is handed the exact change to make. Listing them shows what the architecture actually declares, not what somebody wrote down once.
- Every role now carries the discipline it is held to, printed into its brief: how a test earns its
  place, what to do when three fixes in a row did not work, what a claim has to be backed by, how a
  finding is ranked, and what has to be agreed before anything is built. One text per discipline, so
  every agent in a role is held to the same words.
- A discipline can be drilled: point it at a repository and it answers from the files and the
  branches, not from what an agent said. A real moment from a mission can be recorded as a case, and
  the recorded cases are re-checked as part of the test suite.
- Sending a change back for fixes no longer loops forever. The first few rounds go back to the same worker; after that, a fresh, more capable one takes over with the full history handed to it; past a further, small number of rounds it stops asking and tells you a decision is needed instead.
- A test that passes once and fails the next time is no longer treated as an ordinary failure or silently escalated to a person. Running it again catches the flake, sends the change back with an instruction to make the test reliable, and records what happened.
- A part of the system that only its own author can review — nobody else assigned to judge it — is no longer stuck waiting forever. Whoever independently verified the change can approve it too, but only when there truly is no one else able to.
- The merge checklist now judges the architecture on the branch itself, whatever else the gate runs. It first records, for free and with no key, every rule a script can decide; then it names every rule left that a reader has to judge, and those go to the ticket's verifier, whose brief carries the exact commands. The verifier's decision is recorded under its own name, so a later run can re-prove it without a key and the report says whose judgement it was. A change is ready to merge only when the whole architecture check comes out green. Starting a horde says that this is now part of every merge.
- Showing a node now lists the rules its code must satisfy, each with what breaking it costs: one blocks the merge, one only warns, one is not in force yet. Owners and workers are told to read them before they touch the node.
- Starting a horde now works out how this repository runs its tests — npm, Maven, Gradle, Cargo, Go, Python, Make — and what its tests are named, and says what it found. Where it can work out neither, it says that too and asks, instead of leaving a merge check that quietly passes on everything.
- The merge check that proves a new test is load-bearing no longer passes silently on a repository whose tests it does not recognise: it refuses, and says which setting to fill in. When it does pass, it names the patterns it looked for.
- A change that adds no test — a rename, a refactor, a settings change — can now be verified. It could not be before, and had no way to reach a merge at all.
- A ticket can name one part of the system, or two when it connects them. Three or more is now refused instead of accepted quietly: nobody owns the whole of such a change.
- Marking a ticket merged now records the merge everywhere it needs to be recorded. The mission's evidence list used to stay empty unless the same merge was entered a second time by hand.
- The mission charter — the goal, what is out of scope, the evidence the mission is judged by, and every later amendment — can now be written and read with a command instead of by hand. Rewriting it reports what happened to the evidence list, and warns when a rewrite drops something a verifier already proved.
- Settings that hold a list of values — the test patterns, the protected paths — can now be set to a list. They used to be stored as text and broke the merge check.
- A ticket now says which files it touches, what it needs from the rest of the system, what it delivers to it, and which piece of the mission's evidence it earns. A file outside the part of the system the ticket is on is refused, and so is needing something nobody is building.
- The order of the work is now computed from those tickets instead of typed in by hand: what can start now, what waits on what, the longest chain, which tickets would collide over the same file, who has to approve a change to something others depend on, and which promised evidence nobody has taken. It also says what the whole thing will cost in agent runs and how many rounds it needs. Two tickets waiting on each other is refused, with the circle named.
- A change that touches a file its ticket never declared no longer merges. Widening the ticket is a command that records who widened it, so the reviewers see it happen.
- When a ticket does have to go back for another look, that look now covers only what moved: the difference between what was approved and what is there now is written out for the owner and for a verifier, with every point the last review left open. A review of the whole change is still available.
- Two missions on the same repository can no longer end up owning the same part of it at the same time. Claiming a part already claimed by another active mission is refused, naming which mission holds it and when it was last active; taking it over needs a ruling recorded first. Finishing a mission frees everything it held, and the status screen and the mission list both show who holds what.
- A ticket can now be marked as quality work — a self-filed improvement outside a wave's assigned scope — rather than the mission's own work.
- Handing out the next ticket now refuses one whose files would collide with a ticket already being worked on (a ticket that never said which files it touches is treated as touching all of them, to be safe); among what is left, whichever ticket has the most other work waiting behind it goes first, and a quality ticket always goes last, however urgent it looks. A new option explains the decision for every ticket still waiting: its place in line, or exactly what is holding it back.
- The status screen now shows, for every piece of promised evidence in the mission, exactly how far along it is: nothing claims it yet, filed but not started, in progress, merged but not yet proven, or actually proven. A mission is no longer considered finished just because the work queue is empty — a command checks that every piece of evidence is proven, the whole repository still passes its checks, the sample audit found nothing wrong, and a cost report exists, and it refuses to call the mission done until all of that holds, naming exactly what is still missing. Deleting a promised piece of evidence from the mission's plan is free before any work has started on it; once work is under way, deleting it needs a recorded, approved exception.
- Any line of code the horde ever merged can now be traced back to its full story: which commit introduced it, which ticket that commit belongs to, who wrote it, who reviewed it, who verified it and at what level, which pieces of evidence it was supposed to prove and whether they were, and what the architecture currently says about the rules standing over it. A closed mission's tickets are searched too, not just the ones still open. A line from before the horde ever touched the repository is reported as exactly that, instead of guessing.
- A ticket that waits on another can now be started on top of it instead of after it, while the first is still being worked on and reviewed. A chain of three used to take three rounds of waiting even when each piece was an hour's work; now the second and third are written and reviewed alongside the first. They still merge in order, and the reviews of the later ones survive the earlier one landing. The plan says which tickets can be started this way.
- Closing a round of work now reports the six things that say whether the mission is getting better at itself: how much work ran side by side against how much was planned to, how many reviews carried over without being redone, what share of audited work did not survive a second look and how confident that share is at this sample size, how many questions a person had to answer for each piece of work that landed, whether the repository's architecture rules came out of the round stronger or weaker, and how many people judged a rule by hand outside the normal review. Rules that got weaker are raised with you rather than logged and forgotten. Reading the architecture this way needs a current release of Yggdrasil; an older one is refused outright, naming which release to install, rather than read as loosely as it can be.
- The audit is now a sample, not a ritual. Instead of always redoing one piece of merged work, the number is set by what the audits keep finding — it doubles when something is caught, thins out after a long clean run, and never drops to nothing. A command says how many to audit next and picks them at random.
- When the same kind of question has been answered the same way three times about the same part of the system, that is a rule nobody has written down yet. A command finds those, shows the answers as evidence, and hands over the exact command that writes the rule into the architecture.
- The test suite now walks the whole thing end to end, on the real tools rather than stand-ins: an empty repository with a little history, the architecture read out of that code and accepted into it, a mission opened on top, one ticket written, reviewed, verified and merged, the promised evidence turned green, the mission closed, and one merged line traced back to everyone who signed for it.

### Fixed
- A mission whose last round of work is already closed can now be finished. The audit that samples that round is done after it closes, and the final check kept asking for one it could no longer see.
- The horde now improves the architecture wherever it works, and only ever asks you before making anything weaker. A rule that has proved itself is promoted on its own: first when it answers its own examples correctly, then to blocking after two rounds of work in which nothing new broke it and nothing is left outstanding — with the reason and the numbers written into the architecture's own history. Improvements the code itself suggests become their own low-priority tickets, worked after everything you asked for and never instead of it. Making a rule weaker, waiving one, or moving its review date stays yours: the horde has no way to do any of it without you. Every round of work ends with a plain list of what it raised and what that was based on, so you can undo any of it. One setting in the mission's charter turns the whole thing off, and a single ticket can be walled off from it on its own.

### Changed
- A review no longer expires just because someone else's work landed first. An approval and a verdict now hold for as long as the ticket's own change is the change that was read, so catching a branch up with the team costs nothing — the tests still run again on the result. Another look is asked for only when the catch-up really touched what the ticket does; how near it has to be before that happens is a setting. Ten tickets ready at once used to cost up to fifty-five verifications between them; now it is ten, plus the few the catch-up genuinely disturbed.

## [0.1.0] - 2026-09-04

### Added
- First version. A prototype, expect rough edges.

[Unreleased]: https://github.com/krzysztofdudek/Horde/compare/v6.0.0...HEAD
[6.0.0]: https://github.com/krzysztofdudek/Horde/compare/v0.4.0...v6.0.0
[0.4.0]: https://github.com/krzysztofdudek/Horde/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/krzysztofdudek/Horde/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/krzysztofdudek/Horde/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/krzysztofdudek/Horde/releases/tag/v0.1.0
