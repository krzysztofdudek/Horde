# 125 · brief.test.mjs, docs.test.mjs and horde.test.mjs each still carry a raw, unretried git commit exposed to the same signing 503 issue 122 just consolidated everywhere else

**Status:** done
**Kind:** bug
**Priority:** 3
**Tier:** standard
**Tags:** 
**Files:** skills/horde/scripts/tests/brief.test.mjs, skills/horde/scripts/tests/docs.test.mjs, skills/horde/scripts/tests/horde.test.mjs
**Found by:** issue 122 worker
**Where:**

## What


## Why


## Acceptance


## Evidence

Found while consolidating issue 122's 17 files into a shared, exported, retry-safe git() in helpers.mjs. The audit behind 122 (and 118 before it) grepped only for local 'function git(' definitions, which is why these three were missed: none of them fits that exact shape.

brief.test.mjs (skills/horde/scripts/tests/brief.test.mjs:17) does define a local 'function git(args, cwd)', but that wrapper is only ever called with 'checkout'/'rev-parse' (confirmed by grep across the file), so it carries no signing exposure and correctly stayed out of 122's scope. Separately, though, the same file bypasses its own wrapper once: line 256 is a raw 'execFileSync('git', ['-C', parent.worktree, 'commit', '--allow-empty', '-qm', 'the first link'], { encoding: 'utf8' })' with no retry at all.

horde.test.mjs defines its own local wrapper too, just under a different name -- 'function gitIn(args, cwd)' at skills/horde/scripts/tests/horde.test.mjs:687 -- which is why 'function git(' never matched it. gitIn() is called with add/branch/commit/rev-parse/worktree (grep confirmed, no merge or revert), so it needs the same plain-commit retry the 14-of-17 'captures stderr but never retries' files needed. It already captures stderr (stdio:['ignore','pipe','pipe'], encoding utf8), same as those 14. horde.test.mjs additionally bypasses gitIn() entirely once, the same way brief.test.mjs does: line 994 is a raw 'execFileSync('git', ['commit', '-qm', 'the code the graph will describe'], { cwd: dir })' with no retry.

docs.test.mjs has no local git wrapper of any name -- every git call in the file is a raw execFileSync('git', ...). One of them writes a signed commit and is exposed the same way: skills/horde/scripts/tests/docs.test.mjs:565, 'execFileSync('git', ['-c', 'user.email=test@test.com', '-c', 'user.name=Test User', 'commit', '-qm', 'graph'], { cwd: dir })' -- note the two '-c key=value' globals ahead of the subcommand, the same prefix shape 122's consolidated git() already generalizes past.

The fix issue 122 built is a direct drop-in for all three: helpers.mjs now exports a git(args, cwd) that retries commit/merge/revert past any '-C'/'-c' prefix and returns the trimmed stdout, so closing this is import git from ./helpers.mjs in each of the three files, replace the raw execFileSync('git', ['commit'...]) bypass call with it, and for horde.test.mjs additionally retarget every gitIn(...) call site to the shared git() and delete the now-redundant local gitIn(). None of the three needs the merge/revert side of the retry logic -- confirmed no caller in any of them uses either subcommand.
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node /home/user/Yggdrasil/source/cli/dist/bin.js" timeout 600 node --test tests/brief.test.mjs tests/horde.test.mjs tests/docs.test.mjs · **saw:** tests 146, pass 145, fail 0, cancelled 0, skipped 1, todo 0 (skip is pre-existing/environmental: 'a horde directory that cannot be written refuses' # SKIP root bypasses file-mode permissions)
- **ran:** HORDE_TEST_YG=... node --test tests/brief.test.mjs tests/docs.test.mjs tests/horde.test.mjs, merger's own run on the merged tip · **saw:** 146 tests, 145 pass, 0 fail, 1 pre-existing unrelated skip (root bypasses file-mode permissions)

