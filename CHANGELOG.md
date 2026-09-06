# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- On a repository whose architecture graph Yggdrasil holds, the merge checklist now runs `yg check` on the branch itself, whatever else the gate runs. A graph that refuses the change refuses the merge. Starting a horde on such a repository says so.
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
- Any line of code the horde ever merged can now be traced back to its full story: which commit introduced it, which ticket that commit belongs to, who wrote it, who reviewed it, who verified it and at what level, which pieces of evidence it was supposed to prove and whether they were, and — on a repository with an architecture graph — what that graph currently says about the rules standing over it. A closed mission's tickets are searched too, not just the ones still open. A line from before the horde ever touched the repository is reported as exactly that, instead of guessing.
- A ticket that waits on another can now be started on top of it instead of after it, while the first is still being worked on and reviewed. A chain of three used to take three rounds of waiting even when each piece was an hour's work; now the second and third are written and reviewed alongside the first. They still merge in order, and the reviews of the later ones survive the earlier one landing. The plan says which tickets can be started this way.
- Closing a round of work now reports the five things that say whether the mission is getting better at itself: how much work ran side by side against how much was planned to, how many reviews carried over without being redone, what share of audited work did not survive a second look and how confident that share is at this sample size, how many questions a person had to answer for each piece of work that landed, and whether the repository's architecture rules came out of the round stronger or weaker. Rules that got weaker are raised with you rather than logged and forgotten.
- The audit is now a sample, not a ritual. Instead of always redoing one piece of merged work, the number is set by what the audits keep finding — it doubles when something is caught, thins out after a long clean run, and never drops to nothing. A command says how many to audit next and picks them at random.
- When the same kind of question has been answered the same way three times about the same part of the system, that is a rule nobody has written down yet. A command finds those, shows the answers as evidence, and hands over the exact command that writes the rule into the architecture.

### Changed
- A review no longer expires just because someone else's work landed first. An approval and a verdict now hold for as long as the ticket's own change is the change that was read, so catching a branch up with the team costs nothing — the tests still run again on the result. Another look is asked for only when the catch-up really touched what the ticket does; how near it has to be before that happens is a setting. Ten tickets ready at once used to cost up to fifty-five verifications between them; now it is ten, plus the few the catch-up genuinely disturbed.

## [0.1.0] - 2026-09-04

### Added
- First version. A prototype, expect rough edges.

[0.1.0]: https://github.com/krzysztofdudek/Horde/releases/tag/v0.1.0
