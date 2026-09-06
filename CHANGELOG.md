# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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

## [0.1.0] - 2026-09-04

### Added
- First version. A prototype, expect rough edges.

[0.1.0]: https://github.com/krzysztofdudek/Horde/releases/tag/v0.1.0
