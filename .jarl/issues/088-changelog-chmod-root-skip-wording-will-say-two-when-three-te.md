# 088 · CHANGELOG chmod/root skip wording will say 'two' when three tests now carry the guard

**Status:** done
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** proces
**Files:** CHANGELOG.md
**Found by:** reviewer of 083, confirmed by reeve
**Where:** CHANGELOG.md, the `[6.0.0]` `### Fixed` entry added for issue 069

## What
The CHANGELOG entry for issue 069 reads "Two permission-based tests no longer fail with a false
alarm when the test suite runs as an administrator account, which ignores file permissions by
design." Issue 083 later applied the identical fix to a third test in `law-diff.test.mjs`, so the
sentence now undercounts.

## Why
An adopter reading the changelog is told two tests were fixed when three were.

## Acceptance
The sentence says three, not two, and still names no file. `grep -c` for the chmod-skip guard
across the test suite equals the number the sentence states.

Dowód, którego oczekuję: `grep -rn "chmod cannot force a write to fail as root" skills/horde/scripts/tests/*.mjs | wc -l` matches the CHANGELOG's own count.


## Evidence

- **ran:** grep -rn chmod tests/*.mjs · **saw:** count 3, matches corrected wording; merged

