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
- On a repository whose architecture graph Yggdrasil holds, the merge checklist now runs `yg check` on the branch itself, whatever else the gate runs. A graph that refuses the change refuses the merge. Starting a horde on such a repository says so.
- Showing a node now lists the rules its code must satisfy, each with what breaking it costs: one blocks the merge, one only warns, one is not in force yet. Owners and workers are told to read them before they touch the node.
- Starting a horde now works out how this repository runs its tests — npm, Maven, Gradle, Cargo, Go, Python, Make — and what its tests are named, and says what it found. Where it can work out neither, it says that too and asks, instead of leaving a merge check that quietly passes on everything.
- The merge check that proves a new test is load-bearing no longer passes silently on a repository whose tests it does not recognise: it refuses, and says which setting to fill in. When it does pass, it names the patterns it looked for.
- A change that adds no test — a rename, a refactor, a settings change — can now be verified. It could not be before, and had no way to reach a merge at all.
- A ticket can name one part of the system, or two when it connects them. Three or more is now refused instead of accepted quietly: nobody owns the whole of such a change.
- Marking a ticket merged now records the merge everywhere it needs to be recorded. The mission's evidence list used to stay empty unless the same merge was entered a second time by hand.
- The mission charter — the goal, what is out of scope, the evidence the mission is judged by, and every later amendment — can now be written and read with a command instead of by hand. Rewriting it reports what happened to the evidence list, and warns when a rewrite drops something a verifier already proved.
- Settings that hold a list of values — the test patterns, the protected paths — can now be set to a list. They used to be stored as text and broke the merge check.

## [0.1.0] - 2026-09-04

### Added
- First version. A prototype, expect rough edges.

[0.1.0]: https://github.com/krzysztofdudek/Horde/releases/tag/v0.1.0
