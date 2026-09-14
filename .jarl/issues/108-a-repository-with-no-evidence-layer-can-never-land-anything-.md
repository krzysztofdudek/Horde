# 108 · a repository with no evidence layer can never land anything: the revert-test item refuses outright when testGlobs is unset

**Status:** open
**Kind:** gap
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/land.mjs
**Found by:** issue 031 worker
**Where:** skills/horde/scripts/land.mjs checkRevertTest, the `config.testGlobs` guard

## What
On a repository the charter judges as having no evidence layer, `config.testGlobs` is empty by
construction — that is the same emptiness the judgement is made from. checkRevertTest refuses
unconditionally in that state ("cannot recognise a test file in this repository — config.testGlobs
is unset"), and that refusal comes BEFORE the ticket's own `**No new tests:** <reason>` exemption is
read. So on exactly the kind of repository the "no evidence layer found" judgement describes, the
revert-test item is red on every ticket and nothing can ever land.

## Why
Horde tells such a repository that every catalogue row names its own proof — a scenario, a film, a
screenshot — and then the landing gate blocks every one of them over a test convention the mission
has already established does not exist. Either the charter's judgement should reach the landing gate
(a mission that has declared "nothing here to point at" answers this item differently from one whose
patterns are merely unconfigured), or Horde should say plainly that it cannot land work in a
repository with no test convention at all. Today it says neither, and the two answers disagree.

Not a regression and not touched by issue 031, which only made the absence audible. Found while
writing 031's fixture: the landing there is red on this item and the sentence is asserted on a
refused run because a green one is unreachable.

## Acceptance
A decision first, not a patch: does a charter-declared "no evidence layer" change what the
revert-test item asks for, or is a repository with no test convention simply one Horde will not land
in? Whichever it is, the landing gate and the charter say the same thing, and a test on a fixture
with no evidence layer proves it.

## Evidence
- **ran:** node --test tests/land.test.mjs (the 031 branch, subtest "and so does a refused one") · **saw:** exit 1, revert test ok:false, note "config.testGlobs is unset", on a ticket whose branch does carry a new test file

