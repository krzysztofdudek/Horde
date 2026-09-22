// Shared internals for the horde skill's scripts. Not a user-facing command — imported only.
// Zero dependencies, Node ESM, node core modules only.
//
// State root: `.horde/` beside the repository's git common dir, so every worktree of a
// repository sees the same state (a worktree's common dir points at the main checkout's .git).

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, rmSync,
  cpSync, linkSync, renameSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

// The stderr text of the most recent failed git() call — see gitError() below.
let lastGitError = null;

// git(args, cwd) — execFileSync wrapper, trimmed stdout on success, null on any failure
// (not a repo, no such ref, git not found, …). Every other git-touching export goes through this.
//
// A null return conflates two very different situations: git ran and correctly reported "no" (a
// ref does not exist, a path is not tracked, two branches share no history) and git could not
// answer at all (not a repository, the binary is missing, a real fatal error). A caller that reads
// null as the first case unconditionally and carries on is reading a possible error as "nothing
// is wrong" — a false zero standing in for a refusal. gitError() is how a caller tells the two
// apart before deciding which one it just saw: it holds the stderr git printed for the failure
// git() just returned null for (empty string when git exited non-zero without printing anything,
// e.g. a clean `--quiet` existence check), and is cleared on the next successful call. Read it
// immediately after the git() call it explains — another git() call overwrites it.
export function git(args, cwd = process.cwd()) {
  try {
    const out = execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    lastGitError = null;
    return out;
  } catch (e) {
    lastGitError = (e.stderr ? e.stderr.toString() : String(e.message || e)).trim();
    return null;
  }
}

// The exact bytes of one blob (`git show <ref>`), never trimmed. `git()`'s own trim is right for
// command output — a sha, a status line, a log — and wrong for a file's content: a test file that
// ends in a blank line, or in none, is a different file once its trailing whitespace is gone, and a
// revert test has to run the file the branch actually carries, not a nearby one. `null` on any git
// failure, same as `git()`.
export function gitBlob(ref, cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['show', ref], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    lastGitError = null;
    return out;
  } catch (e) {
    lastGitError = (e.stderr ? e.stderr.toString() : String(e.message || e)).trim();
    return null;
  }
}

// gitError() — the stderr text of the most recent failed git() call (see git() above), or null
// when that call succeeded or none has run yet. Never printed on its own: a caller folds it into
// its own refusal so the refusal says WHY, in git's own words, not just THAT.
export function gitError() {
  return lastGitError;
}

// ---- how big a change is, and where that size sits among the changes beside it ---------------
//
// Size is the one thing about a change that held up when it was measured: how many lines it moves
// and how many files it spreads over. Everything below reports it and nothing acts on it — there
// is no size at which a change becomes "too big", because no such number survived measurement
// either. What survives is the comparison: this change against the others in the same mission.

// diffSize(from, to, {cwd}) — `git diff --numstat from...to`, summed: {files, lines} where lines
// is insertions plus deletions. A branch that has changed nothing yet measures {files: 0,
// lines: 0}; null means there was nothing to read at all (an unknown ref, no git), so "measured,
// and it is empty" never looks like "could not be measured" to a caller.
//
// Three dots, matching every other diff in this tool set: what the branch ADDS on top of where it
// was cut from, never what the base has moved on to since. For a merge commit read as `<sha>^1`
// to `<sha>` the two forms coincide, since the first parent is an ancestor of the merge.
export function diffSize(from, to, { cwd = process.cwd() } = {}) {
  const out = git(['-c', 'core.quotepath=false', 'diff', '--numstat', `${from}...${to}`], cwd);
  if (out === null) return null;
  let files = 0;
  let lines = 0;
  for (const row of out.split('\n').filter(Boolean)) {
    const [added, removed] = row.split('\t');
    files += 1;
    // A binary file's counts come back as "-": a file touched, with no lines to count.
    lines += (Number(added) || 0) + (Number(removed) || 0);
  }
  return { files, lines };
}

// A quartile has four quarters. That is what the word means — it is not a size, and nothing here
// compares a change against it.
const QUARTERS = 4;

// biggerChange(a, b) — orders two measured sizes. Lines first, because that is the measured
// signal; files only separates two changes that move the same number of lines. There is
// deliberately no exchange rate between the two (no "a file is worth N lines"): a made-up
// constant is exactly what this signal does without.
function biggerChange(a, b) {
  return (a.lines - b.lines) || (a.files - b.files);
}

// sizeRanks(entries) — where each measured change sits among the others handed in beside it.
// `entries` is [{id, size}], `size` being diffSize's answer or null for a change nothing could be
// measured on; the answer is a Map from id to {files, lines, rank, of, biggestQuarter}.
//
// `rank` counts from the biggest (1 is the biggest change in the set) and ties share a rank.
// `of` is how many changes were measured — the set the rank is against, so a reader always knows
// what a rank was out of. `biggestQuarter` is true when the change sits in the biggest quarter of
// THIS set and at least one measured change beside it is smaller: a lone change, or a set where
// everything is the same size, has no biggest quarter to be in, and saying otherwise would be
// calling a change outsized against nothing.
//
// Every number in the answer comes out of the set handed in. Multiply every size by any factor
// and the answer is identical; take the same change to a mission of bigger work and it moves.
// That is what makes this a rank rather than a threshold.
export function sizeRanks(entries) {
  const measured = asArray(entries).filter((e) => e && e.size);
  const out = new Map();
  const of = measured.length;
  if (of === 0) return out;
  const cutoff = Math.ceil(of / QUARTERS);
  for (const e of measured) {
    const rank = 1 + measured.filter((o) => biggerChange(o.size, e.size) > 0).length;
    const smaller = measured.filter((o) => biggerChange(o.size, e.size) < 0).length;
    out.set(e.id, {
      files: e.size.files,
      lines: e.size.lines,
      rank,
      of,
      biggestQuarter: rank <= cutoff && smaller > 0,
    });
  }
  return out;
}

// sizeLine(size) — one measured size, written out on its own, for the reader looking at a single
// change. The plan and the wave close render whole lists and use a compact form of their own.
export function sizeLine(size) {
  if (!size) return 'not measured';
  const where = size.of > 1 ? ` — ${size.rank} of ${size.of} by size, biggest first` : '';
  return `${size.lines} line(s) across ${size.files} file(s)${where}${size.biggestQuarter ? ' · biggest quarter' : ''}`;
}

// repoRoot() — the working tree root of the repository at the current directory, found via
// `git rev-parse --show-toplevel`. Independent of where the scripts themselves live, so the
// same install works against whatever repository the caller's cwd is inside.
export function repoRoot() {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top) return top;
  const detail = gitError();
  throw new Error(`not a git repository (or any parent up to the mount point): ${process.cwd()}${detail ? ` — ${detail}` : ''}`);
}

// ---- resolveTree: a command works on the tree it was told, never on cwd by accident -----------
//
// D2 (narrowed by D6, once 014 removed sub-teams and every seat but worker/architect): the tree a
// command reads or writes is always named outright — `--tree` (any worktree of this repository),
// `--ticket` (a worker's own tree), `--scratch` (a throwaway detached tree at a sha — only the
// landing script uses this), `--horde` (the tip of that horde's trunk, read-only — the
// only writer of trunk is the landing script), or, for a command with no horde scope at all,
// bare cwd. The narrowest scope given wins; a command that took `--horde` never quietly falls
// back to cwd just because that flag was left off by a caller that meant to pass it.
//
// `cleanup()` is always safe to call in a `finally`: for `scratch` it removes the worktree it
// made, for everything else it does nothing — `tree`/`ticket` are worktrees the caller does not
// own, `trunk` is a worktree kept around and resynced on every read (see resolveHordeTrunk), and
// `cwd` was never created by this call at all.

const NOOP = () => {};

// A `git worktree list --porcelain` block, parsed. Fields exactly as git prints them: `path` is
// the worktree's directory, `branch` is the short name (no `refs/heads/`) or null when detached,
// `sha` is HEAD, `prunable` is set (to git's own reason string) when the worktree's directory is
// gone from disk but git has not been told to forget it (`git worktree prune`).
function parseWorktreeList(text) {
  return text.split(/\n\n+/).filter((b) => b.trim().length).map((block) => {
    const entry = {
      path: null, sha: null, branch: null, detached: false, prunable: null,
    };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) entry.sha = line.slice('HEAD '.length);
      else if (line.startsWith('branch refs/heads/')) entry.branch = line.slice('branch refs/heads/'.length);
      else if (line === 'detached') entry.detached = true;
      else if (line.startsWith('prunable')) entry.prunable = line.slice('prunable'.length).trim() || 'gitdir points to non-existent location';
    }
    return entry;
  });
}

// The worktrees git itself knows about for the repository at `cwd` — every worktree of it, main
// checkout included, whichever one of them `cwd` happens to sit inside. fail()s when `cwd` is not
// inside a git repository at all, since nothing below can answer "is this a tree of THIS repo"
// without first knowing what "this repo" is.
function thisRepoWorktrees(cwd) {
  const out = git(['worktree', 'list', '--porcelain'], cwd);
  if (out === null) {
    const detail = gitError();
    fail(`not a git repository (or any parent up to the mount point): ${cwd}${detail ? ` — ${detail}` : ''}`);
  }
  return parseWorktreeList(out);
}

function realpathMaybe(path) {
  try { return realpathSync(path); } catch { return null; }
}

// The one place a path given on the command line (`--tree`, or one built from `--ticket`) is
// checked against what git actually knows, telling apart the three ways it can be wrong: never
// registered as a worktree of this repository at all (a plain directory, another repository's
// worktree, or a path that plain does not exist — `notFound` decides the wording), and registered
// but gone from disk (`git worktree prune` is the fix, never a stack trace). `path` is returned
// byte-for-byte as given — never git's own (possibly symlink-resolved) rendering of it — so
// `--json` provenance reproduces exactly what was typed, proof against a caller that builds the
// path by string-concatenation rather than passing it through untouched.
function resolveKnownTreePath(path, cwd, kind, notFound) {
  const entries = thisRepoWorktrees(cwd);
  const real = realpathMaybe(path);
  const match = entries.find((e) => e.path === path || (real && e.path === real));
  if (!match) { notFound(); return null; }
  if (match.prunable) {
    fail(`${path} is a worktree git still knows about, but its directory is gone from disk (${match.prunable}) — run \`git worktree prune\` and recreate it`);
  }
  return {
    path, branch: match.branch, sha: match.sha, kind, cleanup: NOOP,
  };
}

function resolveExplicitTree(rawTree, cwd) {
  const path = resolve(cwd, String(rawTree));
  return resolveKnownTreePath(path, cwd, 'tree', () => {
    if (existsSync(path)) {
      fail(`${rawTree} is not a worktree of this repository (\`git worktree list --porcelain\` does not know it)`);
    }
    fail(`no such tree: ${rawTree} does not exist — create one with \`git worktree add ${path} <branch>\` first`);
  });
}

function padTicketId(id) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10);
  if (Number.isNaN(n)) fail(`invalid ticket id: ${id}`);
  return String(n).padStart(3, '0');
}

function resolveTicketTree(ticket, horde, cwd) {
  if (!horde) fail('--ticket requires --horde (or a single horde already on this repository)');
  const id = padTicketId(ticket);
  const path = join(hordeRoot(), 'worktrees', horde, `t-${id}`);
  return resolveKnownTreePath(path, cwd, 'ticket', () => {
    if (existsSync(path)) {
      fail(`${path} exists but is not a worktree of this repository (\`git worktree list --porcelain\` does not know it)`);
    }
    fail(`no worktree for ticket ${id} — create it with \`queue.mjs set ${id} running --horde ${horde}\` (expected at ${path})`);
  });
}

// ---- one lock file, four holders ---------------------------------------------------------------
//
// Every lock in this tool set is the same shape: a JSON blob naming the pid that holds it, at a
// path whose mere existence is the lock — land.mjs's gate lock, retro.mjs's retrospective lock,
// the worktree lock and the queue lock right below. Writing that file in place looks like one
// step and is three: the path is created empty, the content is written a moment later, and the
// file is closed. A locker that reads the path inside that window finds an empty file naming no
// pid, reads that exactly like a genuinely dead holder's lock, and takes over — while the first
// holder is still writing. Both then believe they hold it.
//
// So the content goes to a name nobody is watching first, whole and closed, and only then takes
// the lock's own name. Linking is the step that decides: it either wins outright or fails with
// EEXIST, and the lock path carries its whole content from the instant it exists at all — so it
// never exists as an empty file naming no holder for a racing caller to read as abandoned.
//
// The temporary name carries the pid, which no two live processes share; the few random
// characters after it keep even two containers that share a mount and a pid number apart.
export function createLockFile(path, content) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(temp, content);
  try {
    linkSync(temp, path);
  } catch (e) {
    if (e.code === 'EEXIST') throw e;
    // A filesystem that cannot make a second name for a file cannot be held this way. It keeps
    // the single call, narrow window and all, rather than being left with no lock at all.
    writeFileSync(path, content, { flag: 'wx' });
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* the lock is the link, not this name */ }
  }
}

// A process that dies holding any of these locks must not wedge the repository forever, so every
// lock file carries the pid that took it, and a lock whose pid is gone is taken over — with each
// caller's own note about it — rather than waited out.
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// readLockText(path) / removeStaleLock(path, seen) — taking over a lock judged abandoned, safely.
// Between reading a lock and finding its holder gone, that holder may have released it the normal
// way and another process taken a fresh lock at the same path. Removing the path then deletes a
// live lock and lets two writers in, and one of their writes is lost — measured: 24 parallel
// `node.mjs propose` under load left 23 proposals in graph.json. So a lock is removed only while it
// still reads exactly as it did when it was judged. One narrow window stays open: two processes
// taking over the same genuinely abandoned lock at once can still, between one's second read and
// its remove, lose the other's fresh lock — a crash-recovery corner, not the everyday release.
export function readLockText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

export function removeStaleLock(path, seen) {
  if (readLockText(path) !== seen) return;
  try { rmSync(path, { force: true }); } catch { /* someone else got there first */ }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---- one process at a time per worktree path ---------------------------------------------------
//
// Making a worktree is a check-then-act: nothing is there, so make it. Two processes that both
// reach the check before either has made anything both go on to make it, and git refuses the
// second outright — `fatal: '<path>' already exists` — where the honest answer is the very tree
// the first one just finished making. Nothing serialized those two: tick.mjs alone holds a lock
// this far down (it took its own resolve inside the gate lock, for a self-race of its own), and
// every other caller that resolves a horde's trunk — the queue, a brief, a refinement, a
// retrospective, a graph write — reaches this code with nothing between it and a sibling doing
// exactly the same thing at the same moment.
//
// Reading trunk has a second window of the same shape, one step further on. A trunk tree that
// already exists is resynced with `git reset --hard`, and git takes its own index lock on that
// worktree to do it; two resyncs at once and the second is refused by git for as long as the
// first is running (`Unable to create '<gitdir>/index.lock': File exists`).
//
// A lock keyed by the worktree path closes both windows with one mechanism, which is why it is a
// lock rather than the narrower alternative of reading git's "already exists" as success. That
// alternative answers the first window only, and answers it slightly wrong: `git worktree add`
// creates the directory before it has checked anything out into it, and `config.worktree.copy` is
// copied in later still, so a caller that takes "the path is there" for "the tree is ready" can
// hand back a tree another process is still filling. Waiting for the first caller to finish hands
// back the finished tree instead, which is the answer both callers asked for.
//
// It lives beside the worktree, never inside it: `<path>.lock` is under `.horde/`, which is
// gitignored whole, so `git worktree add` never sees it and `git reset --hard` never touches it.
const TREE_LOCK_WAIT_MS = 120000;
const TREE_LOCK_POLL_MS = 50;

// Shared by the queue lock and the counter lock below (allocateId): both wrap the same plain
// read-it, change-it, write-it-back on a small JSON file, so both wait and poll on the same
// schedule rather than each earning a tuned pair of its own.
const QUEUE_LOCK_WAIT_MS = 15000;
const QUEUE_LOCK_POLL_MS = 20;

// withTreeLock(treePath, fn) — runs `fn` with nothing else on this repository creating or
// resyncing the worktree at `treePath`. Returns whatever `fn` returns; releases on the way out of
// either a return or a throw, fail()'s HordeError included (it unwinds rather than exiting, so
// the `finally` below really does run).
function withTreeLock(treePath, fn, { waitMs = TREE_LOCK_WAIT_MS } = {}) {
  const path = `${treePath}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      createLockFile(path, `${JSON.stringify({ pid: process.pid, tree: treePath, at: nowIso() }, null, 2)}\n`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const seen = readLockText(path);
    if (seen === null) continue; // released between the failed create and this read: try again
    let held = null;
    try { held = JSON.parse(seen); } catch { held = null; }
    // An unreadable or half-written lock file names no pid to wait on, so it is treated exactly
    // like a dead one: taken over rather than waited on.
    if (!held || !processAlive(held.pid)) {
      removeStaleLock(path, seen);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`the worktree at ${treePath} is being made or resynced by another process (pid ${held.pid}, since ${held.at || 'an unrecorded time'}) — timed out waiting for ${path}`);
    }
    sleepSync(TREE_LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8'));
      if (holder.pid !== process.pid) throw new Error('not ours');
      rmSync(path, { force: true });
    } catch { /* unreadable, already gone, or already taken over by someone else: nothing to do */ }
  }
}

// resolveHordeTrunk(horde, cwd) — the tip of `<horde>/trunk`, read-only for everything but the
// landing script. Trunk is a branch that `horde.mjs init` deliberately leaves unchecked
// out, so there is nothing on disk to hand back until something asks: the first ask provisions a
// worktree for it, once, at a fixed path under `.horde/`; every ask after that resyncs that same
// worktree to the branch's current tip (`git reset --hard`) rather than making — and leaking — a
// fresh one. That is also why its `cleanup()` is a no-op: the tree is meant to be kept, not thrown
// away after one read.
//
// The rule that only the landing script writes trunk is right, but a manual edit can still land
// in that tree (a maintainer poking around, a stray script) — and `git reset --hard` would discard
// it without a trace. So the resync counts what it is about to discard first (every tracked path
// `git status --porcelain` reports besides `??`, since those are exactly the ones `reset --hard`
// touches — an untracked file survives it untouched) and, when that count is not zero, says so on
// stderr in one line before proceeding. The reset still happens either way: trunk stays read-only,
// this only stops it from being silent about the cost.
//
// Both halves of that — the one-time provision and every resync after it — run under
// `withTreeLock` (see above), so two processes asking for one horde's trunk at the same moment
// take turns instead of colliding: the first makes or resyncs the tree, the second waits and then
// reads the finished one. The branch-tip read above it stays outside the lock; it is a pure read
// of a ref, and holding the tree for it would serialize callers over nothing.
function resolveHordeTrunk(horde, cwd) {
  const branch = `${horde}/trunk`;
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  if (tip === null) fail(`no such horde branch: ${branch} — has horde.mjs init run for "${horde}"?`);
  const path = join(hordeRoot(), 'worktrees', horde, 'trunk');
  const cfg = readConfig() || {};
  try {
    withTreeLock(path, () => {
      if (!existsSync(path)) {
        // Detached at trunk's current tip, never attached to the branch itself: an attached
        // worktree would hold the branch name exclusively, and nothing else on the repository —
        // not the main checkout, not a test, not the landing script — could then check
        // `<horde>/trunk` out anywhere else. Detached, this tree is free to exist alongside any
        // of that.
        try {
          // The unlocked body, since this call already holds this path's lock — going through the
          // exported provisionTree() would be this process waiting on itself.
          makeTree(path, tip, cfg);
        } catch (e) {
          fail(e.message);
        }
      } else {
        const status = git(['status', '--porcelain'], path);
        const discarded = status ? status.split('\n').filter((line) => line.length && !line.startsWith('??')).length : 0;
        if (discarded > 0) {
          process.stderr.write(`trunk resync discarded ${discarded} uncommitted change${discarded === 1 ? '' : 's'} at ${path} — trunk (${branch}) is written only by the landing script, so every read resets it to the branch's tip\n`);
        }
        if (git(['reset', '--hard', branch], path) === null) {
          const detail = gitError();
          fail(`could not sync the trunk tree at ${path} to ${branch}${detail ? ` — ${detail}` : ''}`);
        }
      }
    });
  } catch (e) {
    // A refusal raised inside is already one line with its own exit code, and is rethrown as it
    // stands. Only the lock's own timeout arrives here as a plain throw, and that is a refusal
    // too — another process holding this tree for two minutes is something to read, not a stack
    // trace to decipher.
    if (e instanceof HordeError) throw e;
    fail(e.message);
  }
  return {
    path, branch, sha: git(['rev-parse', branch], cwd), kind: 'trunk', cleanup: NOOP,
  };
}

// resolveScratchTree(sha, cwd) — a throwaway detached worktree at a sha already in this
// repository, for the landing script (015) alone. Unlike every other kind, its `cleanup()`
// really does remove what it made — and it is called here too, the moment provisioning itself
// fails partway (`git worktree add` succeeded, the `worktree.copy` copy did not): a scratch tree
// that failed to finish provisioning is not left behind for `git worktree list` to still know
// about.
function resolveScratchTree(shaArg, cwd) {
  const sha = git(['rev-parse', '--verify', '--quiet', `${shaArg}^{commit}`], cwd);
  if (sha === null) fail(`no such commit: ${shaArg} — --scratch takes a sha already in this repository`);
  const dir = join(hordeRoot(), 'scratch', `${sha.slice(0, 12)}-${process.pid}-${Date.now()}`);
  const cleanup = () => {
    git(['worktree', 'remove', '--force', dir], cwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  };
  try {
    provisionTree(dir, sha, readConfig() || {});
  } catch (e) {
    cleanup();
    fail(e.message);
  }
  return {
    path: dir, branch: null, sha, kind: 'scratch', cleanup,
  };
}

function resolveCwd(cwd) {
  const path = git(['rev-parse', '--show-toplevel'], cwd);
  if (path === null) fail(`not a git repository (or any parent up to the mount point): ${cwd}`);
  const branchOut = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return {
    path: resolve(cwd, path),
    branch: branchOut && branchOut !== 'HEAD' ? branchOut : null,
    sha: git(['rev-parse', 'HEAD'], cwd),
    kind: 'cwd',
    cleanup: NOOP,
  };
}

// resolveTree({tree, ticket, scratch, horde}, {cwd}) — see the block comment above. Precedence is
// the order the flags are checked in below: `--tree` beats `--ticket` beats `--scratch` beats
// `--horde` beats bare cwd, matching the order the skill's own reference documents them in.
export function resolveTree({
  tree, ticket, horde, scratch,
} = {}, { cwd = process.cwd() } = {}) {
  if (tree !== undefined && tree !== null && tree !== false) return resolveExplicitTree(tree, cwd);
  if (ticket !== undefined && ticket !== null && ticket !== false) return resolveTicketTree(ticket, horde, cwd);
  if (scratch !== undefined && scratch !== null && scratch !== false) return resolveScratchTree(scratch, cwd);
  if (horde !== undefined && horde !== null && horde !== false) return resolveHordeTrunk(horde, cwd);
  return resolveCwd(cwd);
}

// assertGraphWritable(info, {horde, cfg}) — the two refusals a graph write (node.mjs log --run,
// promote, demote, bind's take-over log) is held to: trunk is the landing script's alone (kind
// "trunk" is always read-only — the moment a caller means to write it, it says so with an
// explicit `--tree` naming trunk's own path, which resolves as kind "tree" instead and is not
// caught here), and a write from cwd sitting on the mission's own base branch is almost always
// the wrong tree found by accident rather than named on purpose — `--tree` said explicitly is
// exactly how that accident is ruled out.
export function assertGraphWritable(info, { horde, cfg } = {}) {
  if (info.kind === 'trunk') {
    fail(`trunk (${info.path}, branch ${info.branch}) is written only by the landing script — pass --tree ${info.path} if this really is that`);
  }
  const base = cfg && cfg.base;
  if (info.kind === 'cwd' && base && info.branch === base) {
    // Audited under issue 114, against ask a-002, and left as-is: this `horde` is the caller's own
    // resolved value (node.mjs main() passes resolveHorde(flags), not flags.horde), and that is
    // deliberate here, not the ordinary-read gap 114 fixed elsewhere. This line is reached only
    // when `info` — resolved above THIS function, by the caller, the correct flags.horde way —
    // already came back "cwd", which happens only when --horde was NOT typed; using flags.horde
    // here too would always be undefined at exactly this point and the hint below would never fire.
    // It is also not an ordinary read: nothing is resolved FOR the write itself here, only a path
    // to name in a refusal already decided above, one line up — and for a graph write specifically,
    // trunk is where the write belongs once named on purpose (node.mjs main()'s own comment above
    // its resolveTree call: "a graph WRITE ... is the one place --horde alone DOES mean trunk").
    //
    // Issue 124: the path is composed by hand instead of through resolveTree({horde}). A refusal
    // that writes nothing must not provision anything either, and resolveTree's horde-branch
    // resolution is not a free read — resolveHordeTrunk runs `git worktree add` the first time a
    // horde's trunk tree is asked for, and `git reset --hard` to resync it every time after,
    // discarding whatever uncommitted state sat there. Both are real, visible side effects a caller
    // about to be told "this command wrote nothing" should never trigger just so this line can name
    // a suggested path. The join below is exactly the `path` resolveHordeTrunk itself computes
    // before either of those branches runs (a plain join off hordeRoot(), never touching git), so
    // the suggested path is byte-for-byte the same whenever the tree already exists on disk —
    // dropping resolveTree here removes only the provisioning/resync side effect, never the
    // suggestion's content.
    const trunkPath = horde ? join(hordeRoot(), 'worktrees', horde, 'trunk') : null;
    fail(`${info.path} is on "${base}" — a graph write from here is almost certainly the wrong tree found by accident, not named on purpose${trunkPath ? `; the mission's tree is at ${trunkPath}` : ''}. Pass --tree explicitly if this checkout really is what you mean`);
  }
}

// provisionTree(path, ref, cfg) — `git worktree add` at `path` for `ref` (a branch name checks
// out attached to it, anything else — a sha, most often — detached), then copies every
// `config.worktree.copy` entry from the repository root into the new tree. Idempotent: a second
// call at a path that already exists does nothing at all, not even re-validate `worktree.copy` —
// `queue.mjs set <ticket> running` calls this every time a ticket's state is re-read, and the
// worker's own edits to their tree are not something a repeated call should ever touch. Throws
// (never fail()s) on every refusal, the same idiom `claimLease` uses: the two callers that need to
// clean up a half-made tree on failure (resolveScratchTree) or need their own wording (the ticket
// worktree cut in queue.mjs cmdSet) both need the message before anything is printed, not a
// process already gone.
//
// A `worktree.copy` entry git already tracks is refused before the tree is even created — git put
// that file on every branch already, and copying over it would desync the tree from its own
// branch. A `worktree.copy` entry that does not exist is refused instead at copy time, after the
// tree exists: the alternative (checking before `git worktree add`) would mean this function could
// refuse without ever having touched git worktree state at all, which is exactly the case
// resolveScratchTree's own cleanup path exists to handle, and untested here would leave it dead
// code.
//
// The whole of it — the "is it already there" check, the `git worktree add` and the copying —
// runs under `withTreeLock` (see above), because the check and the act are two steps and a second
// process arriving between them would be refused by git rather than handed the tree the first one
// is making. `makeTree` below is the same body without the lock, for the one caller
// (resolveHordeTrunk) that is already holding this path's lock when it gets here.
export function provisionTree(path, ref, cfg) {
  return withTreeLock(path, () => makeTree(path, ref, cfg));
}

function makeTree(path, ref, cfg) {
  if (existsSync(path)) return { created: false, copied: [] };
  const root = repoRoot();
  const copyList = cfg && cfg.worktree && Array.isArray(cfg.worktree.copy) ? cfg.worktree.copy : [];
  for (const rel of copyList) {
    if (git(['ls-files', '--error-unmatch', '--', rel], root) !== null) {
      throw new Error(`config.worktree.copy names "${rel}", which git already tracks on this branch — copying over a tracked path would desync the worktree from its own branch`);
    }
    // null above also covers a genuine ls-files failure that has nothing to do with "untracked" —
    // git's own text for the case this loop actually means to allow always names the pathspec as
    // unmatched; anything else read the same way would let a real failure through as "safe to
    // copy" (a false zero for the desync check this loop exists to make).
    const trackedCheckError = gitError();
    if (trackedCheckError && !/did not match any file/i.test(trackedCheckError)) {
      throw new Error(`could not tell whether config.worktree.copy's "${rel}" is tracked on this branch — ${trackedCheckError}`);
    }
  }
  const isBranch = git(['show-ref', '--verify', '--quiet', `refs/heads/${ref}`], root) !== null;
  const args = isBranch ? ['worktree', 'add', path, ref] : ['worktree', 'add', '--detach', path, ref];
  if (git(args, root) === null) {
    const detail = gitError();
    throw new Error(`could not create worktree at ${path} for ${ref}${detail ? ` — ${detail}` : ''}`);
  }
  const copied = [];
  for (const rel of copyList) {
    const src = join(root, rel);
    if (!existsSync(src)) throw new Error(`config.worktree.copy names "${rel}", which does not exist at ${src}`);
    const dest = join(path, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    copied.push(rel);
  }
  return { created: true, copied };
}

// provenanceLine(info) / withProvenance(obj, info) — the one line every command that resolved a
// tree ends with ("tree: <path> · branch: <branch> · <sha>"), and the three fields (`tree`,
// `branch`, `sha`) its `--json` carries alongside whatever else it reports. `branch` prints
// literally as `null` for a detached (scratch) tree — the point is telling apart "no branch, on
// purpose" from a field that was simply forgotten.
export function provenanceLine(info) {
  return `tree: ${info.path} · branch: ${info.branch === null ? 'null' : info.branch} · ${info.sha}`;
}

export function withProvenance(obj, info) {
  return {
    ...obj, tree: info.path, branch: info.branch, sha: info.sha,
  };
}

// gitCommonDir() — the shared `.git` directory: for a worktree this resolves to the main
// checkout's, which is exactly what lets every worktree find the same `.horde/`. Git prints it
// relative to cwd for the main checkout but absolute for a worktree, so resolve() (a no-op on
// an already-absolute path) normalizes both.
function gitCommonDir() {
  const out = git(['rev-parse', '--git-common-dir']);
  if (!out) {
    const detail = gitError();
    throw new Error(`not a git repository (or any parent up to the mount point): ${process.cwd()}${detail ? ` — ${detail}` : ''}`);
  }
  return resolve(process.cwd(), out);
}

// hordeRoot({create}) — `.horde/` beside the repository root (dirname of the git common dir).
// Only `horde.mjs init` should pass `create: true`: that is the one call site allowed to bring
// `.horde/` into existence, with its `.gitignore` written at the same time so the directory is
// never accidentally committed even for one commit.
export function hordeRoot({ create = false } = {}) {
  const common = gitCommonDir();
  const dir = join(dirname(common), '.horde');
  if (create && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '*\n');
  }
  return dir;
}

export function configPath() {
  return join(hordeRoot(), 'config.json');
}

export function readConfig() {
  return readJSON(configPath(), null);
}

// The class weights a fresh mission starts with — used to rank a queue.mjs plan (the critical
// path and each ticket's remaining weight) by how heavy the tickets on it are. Host-neutral on
// purpose: Horde installs the same way on Claude Code, Codex, Cursor… and each host has its own
// roster of model names (Codex has no "sonnet"), so a default keyed by a Claude model name would
// mean nothing on most of them. "light|standard|heavy|max" says only how a run's weight ranks
// against the others in the same mission; an adopter names each tier after a real model through
// this same `config.classes` map (Claude Code: light: haiku, standard: sonnet, heavy: opus;
// Codex: light: gpt-5-mini, heavy: gpt-5; …) — that mapping is theirs to make, never Horde's to
// guess.
//
// A different "class" from EVIDENCE_CLASSES further down this file: that one names what KIND OF
// PROOF a charter row rests on, this one names how heavy a ticket runs. Never the same word in
// anything printed — see EVIDENCE_CLASSES' own comment.
export const DEFAULT_CLASSES = {
  light: 1, standard: 3, heavy: 10, max: 30,
};

// firstClass(cfg) — the class a caller gets when none was named: the mission's own first
// configured class when it has one (an adopter's config.classes carries their own choice and
// order), otherwise DEFAULT_CLASSES' first key. Never a literal model name — see DEFAULT_CLASSES.
export function firstClass(cfg) {
  const keys = Object.keys((cfg && cfg.classes) || {});
  return keys.length ? keys[0] : Object.keys(DEFAULT_CLASSES)[0];
}

// classUp(cfg, cls) — the next rung on the ladder above `cls`: the mission's own config.classes
// key order when it configured one (the same order firstClass reads its first key from),
// otherwise DEFAULT_CLASSES'. This is the "class up" a fix round's fresh worker gets once a
// ticket's rounds pass config.fixRounds.resume (tick.mjs dispatch, gated on `takeover`) — one
// rung heavier, not a jump to the top. `cls` comes back unchanged when it is already the heaviest
// rung on that ladder, or is not on it at all (an unrecognized class name, or none) — this never
// throws; an unrecognized class is not this helper's problem to solve.
export function classUp(cfg, cls) {
  const configured = Object.keys((cfg && cfg.classes) || {});
  const keys = configured.length ? configured : Object.keys(DEFAULT_CLASSES);
  const i = keys.indexOf(cls);
  return i === -1 || i === keys.length - 1 ? cls : keys[i + 1];
}

export function writeConfig(cfg) {
  writeJSON(configPath(), cfg);
}

export function hordePath(horde, ...parts) {
  return join(hordeRoot(), 'hordes', horde, ...parts);
}

// ---- one counter, three prefixes ---------------------------------------------------------------
//
// Everything the horde numbers comes out of ONE sequence, `hordes/<h>/counter.json`, and wears the
// prefix that says what kind of thing it is: `t-` a ticket, `g-` anything the architect rules on
// (a graph change, a port proposal, a contract proposal, a rule proposal), `a-` a question put to
// the client. Before this there were three independent sequences, so a ticket and a port proposal
// could both be "1" in the same mission and `show 20` was an ambiguous question. There is no `e-`
// or `d-`: escalation and dissent folded into the client channel and have no kind of their own.
//
// The number is the identity and the prefix is how it is read, so an id is rendered with its
// prefix everywhere and accepted either way — a bare number still resolves, for one release, so a
// mission started before this keeps working.
export const ID_PREFIXES = { ticket: 't', graph: 'g', ask: 'a' };

export function counterPath(horde) {
  return hordePath(horde, 'counter.json');
}

// "4" → "004". Three digits, the width tickets have always been written at, so all three kinds
// sort and read alike.
export function padNumber(n) {
  return String(n).padStart(3, '0');
}

// The number inside an identifier, however it was written: "g-004", "004", "4", 4. Null when there
// is no number in it at all.
export function idNumber(id) {
  const m = /(\d+)\s*$/.exec(String(id ?? ''));
  return m ? parseInt(m[1], 10) : null;
}

// ---- the counter lock (one sequence, one writer) -----------------------------------------------
//
// allocateId used to do the same thing queue.json used to do before withQueueLock existed: read
// counter.json, work out the next number, write it back — a plain read-compute-write with nothing
// between two processes doing it at once. Two tickets filed in parallel, a ticket racing a proposal,
// tick.mjs's "stuck" path filing an ask while landing — any two calls that land between each
// other's read and write hand out the same number to two different things, exactly the class of bug
// 010 and the loop-fix issues already closed against queue.json. counter.json was the one shared
// sequence this missed.
//
// Same machinery as withQueueLock, keyed to counter.json instead: `createLockFile` for the
// exclusive-create, `processAlive` to take over a dead holder rather than wait on it forever, and
// the queue lock's own QUEUE_LOCK_WAIT_MS / QUEUE_LOCK_POLL_MS rather than a tuned pair of its own.
//
// Lock order: withCounterLock is always the innermost lock taken. allocateId acquires it, reads,
// writes and releases before returning — it never calls out to anything that takes another lock
// while this one is held, and nothing that holds the counter lock ever tries to take the queue
// lock. So a caller that already holds the queue lock (tick.mjs's "stuck" path files an ask via
// allocateId from inside its own withQueueLock block) can still call allocateId safely: the two
// locks are only ever taken in one order — queue lock first, counter lock second and released
// immediately — never the reverse, so there is no cycle for two processes to deadlock on.
function counterLockPath(horde) {
  return `${counterPath(horde)}.lock`;
}

// The shared machinery behind every per-file lock in this tool set: exclusive-create `<file>.lock`
// naming the pid that holds it (so a racing caller can never read a lock still being written as an
// abandoned one and take it out from under its holder), take over a dead holder rather than wait on
// it forever, and release in a `finally` so a refusal raised through fail() still lets go. One
// implementation — queue.json's own withQueueLock predates this and is left as it is (its own
// tuned two extra fields, `team` and a bespoke error line, are not worth a generic options bag for
// one caller) — but every per-file lock added after it (counter.json below, and asks.json /
// graph.json in node.mjs and ask.mjs) goes through this one, so a later fix to the primitive fixes
// every one of them at once instead of a fourth or fifth hand-rolled copy.
function withFileLock(path, meta, fn, { waitMs = QUEUE_LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      createLockFile(path, `${JSON.stringify({ pid: process.pid, ...meta, at: nowIso() }, null, 2)}\n`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const seen = readLockText(path);
    if (seen === null) continue; // released between the failed create and this read: try again
    let held = null;
    try { held = JSON.parse(seen); } catch { held = null; }
    // An unreadable or half-written lock file names no pid to wait on, so it is treated exactly
    // like a dead one: taken over rather than waited on.
    if (!held || !processAlive(held.pid)) {
      removeStaleLock(path, seen);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`${path} is locked by another process (pid ${held.pid}, taken ${held.at || 'at an unrecorded time'}) — timed out waiting for it`);
    }
    sleepSync(QUEUE_LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8'));
      if (holder.pid !== process.pid) throw new Error('not ours');
      rmSync(path, { force: true });
    } catch { /* unreadable, already gone, or already taken over by someone else: nothing to do */ }
  }
}

function withCounterLock(horde, fn, { waitMs = QUEUE_LOCK_WAIT_MS } = {}) {
  return withFileLock(counterLockPath(horde), { horde }, fn, { waitMs });
}

// asks.json and graph.json — the same read-modify-write hazard queue.json and counter.json already
// had, closed here rather than with two more hand-rolled copies. Lock order: both are always the
// innermost lock taken relative to the queue lock, exactly like the counter lock — tick.mjs's red-
// gate handling calls fileAsk (addAsk) from inside its own withQueueLock block, so the queue lock is
// sometimes held while this one is acquired, but never the other way: nothing that holds the asks or
// the graph lock ever tries to take the queue lock (checked at every one of node.mjs's, queue.mjs's
// and audit.mjs's own call sites — recordAdvisory/recordAudit are always called after their nearby
// withQueueLock block has already released, never from inside one). Only one exception nests the
// other direction: asks.json's answerAsk calls into decide.mjs's own decisions lock WHILE holding
// this one — asks lock outermost, decisions lock innermost, the one order the two are ever taken in.
// So the full ordering, queue first when it appears at all, is: queue → { asks → decisions, graph,
// counter } — never the reverse on any edge, so there is no cycle for two processes to deadlock on.
export function withAsksLock(horde, fn, { waitMs = QUEUE_LOCK_WAIT_MS } = {}) {
  return withFileLock(`${hordePath(horde, 'asks.json')}.lock`, { horde, kind: 'asks' }, fn, { waitMs });
}

export function withGraphLock(horde, fn, { waitMs = QUEUE_LOCK_WAIT_MS } = {}) {
  return withFileLock(`${hordePath(horde, 'graph.json')}.lock`, { horde, kind: 'graph' }, fn, { waitMs });
}

// writeJSONAtomic(file, obj) — same document shape as writeJSON, written so a reader outside the
// lock above (or outside any lock) never observes a torn write: the content goes whole to a name
// nobody is watching, exactly like createLockFile's own temp-then-link, then `renameSync` swaps it
// into place in one filesystem operation instead of writeJSON's own write-in-place.
function writeJSONAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(temp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(temp, file);
}

// allocateId(horde, kind, {floor}) — the next number in the shared sequence, as {n, number, id}.
// `floor` is the highest number a caller already knows about from its own file: a graph.json
// written before this change carries ids from a sequence the counter never saw, and handing out a
// number below them would collide on the very mission this exists to keep working.
export function allocateId(horde, kind, { floor = 0 } = {}) {
  const prefix = ID_PREFIXES[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind} (kinds: ${Object.keys(ID_PREFIXES).join(', ')})`);
  const path = counterPath(horde);
  return withCounterLock(horde, () => {
    const doc = readJSON(path, { next: 1 });
    const declared = Number(doc && doc.next);
    const n = Math.max(Number.isFinite(declared) && declared >= 1 ? declared : 1, Number(floor) + 1);
    writeJSONAtomic(path, { next: n + 1 });
    return { n, number: padNumber(n), id: `${prefix}-${padNumber(n)}` };
  });
}

// The note a command prints when it was handed a bare number instead of a prefixed id. Null when
// the caller wrote the prefix, so the note only ever appears where it is actually earned.
export function migrationNote(ref, resolvedId) {
  if (String(ref) === String(resolvedId)) return null;
  return `("${ref}" was read as ${resolvedId} — identifiers carry their kind now; a bare number is `
    + 'accepted for one release so a mission started before this keeps working)';
}

// ---- the quality policy (ruling quality-always-authorised) ------------------------------------
//
// The charter's own answer to "may the horde improve what it was not asked to improve": the
// `## Quality` section's `**Policy:**` line. `autonomous` (the default, and what the charter
// template writes) means the horde raises the graph wherever the evidence allows and files the
// improvements it finds, without asking; `only-the-work` means it does nothing beyond the tickets
// the mission names. Neither setting ever authorises LOWERING anything — that is the chairman's,
// under every policy.
//
// Read from the charter rather than kept in config.json because it is a promise made to the
// chairman in the document they read and amend, and a second copy in a config file could disagree
// with it. A charter written before this field existed reads as `autonomous`: that is the ruling's
// own default, and an older mission does not silently opt out of it.

export const QUALITY_POLICIES = ['autonomous', 'only-the-work'];

// The `**Policy:**` line inside the charter's `## Quality` section, or null when there is none.
// Scoped to that section on purpose: another section could carry a policy line of its own, and a
// loose search would misread it as the quality setting.
export function qualityPolicyIn(charterText) {
  const text = String(charterText || '');
  const start = text.search(/^##\s+Quality\s*$/m);
  if (start === -1) return null;
  const rest = text.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  const m = /^\*\*Policy:\*\*\s*([^\n·]*?)\s*(?:·|$)/m.exec(section);
  return m ? m[1].trim() : null;
}

// qualityPolicy(horde) — the resolved policy: `autonomous` when the charter names no policy at
// all (no charter yet, no `## Quality` section, no `**Policy:**` line — the ruling's own default,
// see above), otherwise exactly what the charter says. A value present but not one of
// QUALITY_POLICIES is refused rather than quietly read as `autonomous` — the more permissive of
// the two — mirroring the same refusal horde.mjs's `charter edit` already applies when the line is
// WRITTEN; reading it back is held to the same discipline, not a softer one, so a charter hand-
// edited (or written by an older release, before a rename) outside that command cannot leave the
// horde silently running more freely than whoever wrote the line intended.
export function qualityPolicy(horde) {
  const found = qualityPolicyIn(readText(hordePath(horde, 'charter.md')));
  if (found === null) return 'autonomous';
  if (!QUALITY_POLICIES.includes(found)) {
    fail(
      `the charter's Quality section says "**Policy:** ${found}", which is not a setting this horde has.\n`
      + 'That line decides whether the horde improves the architecture wherever it works or sticks to the '
      + 'tickets alone, and a word nothing recognises must not quietly read as autonomous, the more permissive '
      + 'of the two — that would let the horde judge and file work an operator who wrote something else never '
      + 'authorised.\n'
      + `Fix the charter to one of: ${QUALITY_POLICIES.join(', ')} (or drop the section, which reads as `
      + `${QUALITY_POLICIES[0]}), with horde.mjs charter edit.`,
    );
  }
  return found;
}

// ---- the documents, read in one place ---------------------------------------------------------
//
// Four markdown documents carry state this tool set reads back: a ticket's `log.md` (its state
// lines, and the verdict blocks standing in it), a ticket's `issue.md` (its acceptance checklist),
// the mission's `charter.md` (its evidence catalogue, and the quality policy above) and the
// mission's `decisions.md` (its entries). Every reader of those shapes lives here.
//
// It has to, and this is the whole reason: a shape written by one tool and read by three is a
// silent measurement bug the day its wording moves. Each reader used to carry its own regex, so a
// tool went on counting, only counting the wrong thing, with nothing wrong to see in the file. One
// parser per document means a rewording breaks in one place or nowhere.
//
// Nothing here writes. The documents' formats are whatever their writers already produce; these
// functions only read them back.

// One markdown section: `heading` up to the next `## `, or the rest of the document. The ticket's
// checklist and the charter's catalogue both live under a heading that starts `## Acceptance`, so
// both are cut out with this.
export function markdownSection(text, heading) {
  const body = String(text || '');
  const start = body.indexOf(heading);
  if (start === -1) return '';
  const rest = body.slice(start);
  const next = rest.indexOf('\n## ', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

// One table row as trimmed cells: the outer pipes dropped, an escaped `\|` staying inside its own
// cell rather than splitting it in two.
export function markdownTableCells(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

// --- a ticket's log.md: its state lines -------------------------------------------------------
//
// Two kinds of line, one shape. Everything `appendLog` writes is `- <stamp> <text>`, and
// `transitionStatus` writes that same line with the text `status: <state>[ — <note>]`, plus
// `(round N/cap — <label>)` when the transition is a round of the fix loop. What tells a state
// entry from a remark is the SHAPE of the line, never its words — a remark that happens to talk
// about a status is still a remark.

const LOG_ENTRY_RE = /^-\s+(.*)$/;
const LOG_STATUS_RE = /^(\S+)\s+status:\s(.*)$/;
const LOG_ROUND_RE = /\(round (\d+)\/(\d+) — ([^)]*)\)/;

export function parseLogEntries(logText) {
  const entries = [];
  String(logText || '').split('\n').forEach((raw, index) => {
    const m = LOG_ENTRY_RE.exec(raw.trim());
    if (!m) return;
    const text = m[1];
    const status = LOG_STATUS_RE.exec(text);
    const round = LOG_ROUND_RE.exec(text);
    const said = status ? status[2].replace(LOG_ROUND_RE, '').trim() : '';
    const dash = said.indexOf(' — ');
    entries.push({
      index,
      text,
      isStatus: !!status,
      stamp: status ? status[1] : null,
      status: status ? (dash === -1 ? said : said.slice(0, dash)).trim() : null,
      note: status && dash !== -1 ? said.slice(dash + 3).trim() : null,
      round: round ? parseInt(round[1], 10) : null,
      cap: round ? parseInt(round[2], 10) : null,
      label: round ? round[3].trim() : null,
    });
  });
  return entries;
}

// How many rounds of the fix loop this log already records — the counter `changesRoundInfo` reads
// back instead of keeping a second file beside the log and having to hold the two in step.
export function latestChangesRound(logText) {
  let max = 0;
  for (const line of String(logText || '').split('\n')) {
    const m = LOG_ROUND_RE.exec(line);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// --- a ticket's log.md: the verdict blocks standing in it --------------------------------------
//
// `## Verdict · <ticket> · <date> · by <verifier> (<class>)`, then `**Result:** <result>`, then a
// `| item | command | saw |` table of what was run and what it printed. Nothing in this tool set
// writes one any more; they are read back off missions that ran before the verifier seat was
// cassated, so the shape is fixed by what is already on disk. A block runs to the next verdict,
// not to the next heading of any kind: a verdict carries subheadings of its own.
//
// Two shapes reach the file and both are read. A verdict written straight into log.md opens its
// own line; one handed to the log as a remark carries the log's own `- <stamp> ` in front of the
// heading, because that is what stamps every line it appends. The stamp is dropped and the two
// read the same — a verdict is no less a verdict for having been logged rather than written.

const VERDICT_STAMP_RE = /^-\s+\S+\s+(?=## Verdict)/;
const VERDICT_HEADING_RE = /^## Verdict · (\S+) · (\d{4}-\d{2}-\d{2}) · by (\S+) \(([^)]+)\)/;
const VERDICT_RESULT_RE = /^\*\*Result:\*\*\s*(\S+)/m;
const VERDICT_TABLE_HEAD_RE = /^\|\s*item\s*\|/;

function verdictRowsIn(block) {
  const lines = block.split('\n');
  const head = lines.findIndex((l) => VERDICT_TABLE_HEAD_RE.test(l.trim()));
  if (head === -1) return [];
  const rows = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.trim().startsWith('|')) break;
    const cells = markdownTableCells(line);
    if (cells.length >= 3) rows.push({ item: cells[0], command: cells[1], saw: cells[2] });
  }
  return rows;
}

export function parseVerdictBlocks(logText) {
  const out = [];
  for (const raw of String(logText || '').split(/\n(?=(?:-\s+\S+\s+)?## Verdict)/)) {
    const block = raw.trim().replace(VERDICT_STAMP_RE, '');
    if (!block.startsWith('## Verdict')) continue;
    const heading = VERDICT_HEADING_RE.exec(block);
    const result = VERDICT_RESULT_RE.exec(block);
    out.push({
      block,
      ticket: heading ? heading[1] : null,
      date: heading ? heading[2] : null,
      verifier: heading ? heading[3] : null,
      class: heading ? heading[4] : null,
      result: result ? result[1] : null,
      rows: verdictRowsIn(block),
    });
  }
  return out;
}

// --- a ticket's issue.md: its acceptance checklist ---------------------------------------------
//
// Every `- [ ]` (or `- [x]`) line under the heading that starts `## Acceptance`, minus the
// template's own placeholder. A ticket with none of these has nothing a verifier can reproduce,
// so nothing could ever prove it done.

const ACCEPTANCE_LINE_RE = /^- \[([ xX])\]\s*(.*)$/;
const ACCEPTANCE_PLACEHOLDER_RE = /^(…|\.\.\.)?$/;

export function parseAcceptanceLines(issueText) {
  const out = [];
  for (const raw of markdownSection(issueText, '## Acceptance').split('\n')) {
    const line = raw.trim();
    const m = ACCEPTANCE_LINE_RE.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (ACCEPTANCE_PLACEHOLDER_RE.test(text)) continue;
    out.push({ raw: line, checked: m[1].trim() !== '', text });
  }
  return out;
}

// --- the mission's charter.md: its evidence catalogue -------------------------------------------
//
// The table under the heading that starts `## Acceptance`: | id | evidence | node | reproduced by |
// | evidence class |. The fifth cell is optional and came later (issue 120) — a row written before
// it existed simply has four cells, which reads exactly like a fifth cell left blank.
// A row counts once any cell holds text — the template ships one all-empty row, which is no row.

// The six kinds of proof a charter row's fifth cell — or a promise file's own `class:` field — may
// name, fixed rather than configured (issue 024). This is a hand-kept mirror of
// packages/promises/doc-shape/check.mjs's own CLASSES export, not an import of it: that package is
// a separate, optional offer a repository may adopt for its promise files, this skill's own
// self-containment rule (CLAUDE.md: "all behavior must be self-contained in skills/horde/") means
// nothing under scripts/ may reach outside skills/horde/ for it, and the words are few enough that
// keeping the two lists in step by hand costs less than a cross-package dependency would.
//
// Never confuse this with DEFAULT_CLASSES above — that is Horde's own model-weight ladder
// (light/standard/heavy/max), a different "class" naming how heavy a ticket is dispatched at. This
// one names what KIND OF PROOF a row of evidence rests on, and every reader of it (parseEvidenceRows
// below, wave.mjs's own per-class report) says "evidence class" or "kind of proof", never a bare
// "class", so the two are never mistaken for one another in anything printed.
export const EVIDENCE_CLASSES = [
  'e2e scenario',
  'hermetic test',
  'mutation',
  'recorded stub',
  'artifact',
  'client testimony',
];

export function parseEvidenceRows(charterText) {
  const section = markdownSection(charterText, '## Acceptance');
  if (!section) return [];
  const lines = section.split('\n').filter((l) => l.trim().startsWith('|'));
  // lines[0] = header, lines[1] = --- separator, lines[2..] = data
  return lines.slice(2)
    .map(markdownTableCells)
    .filter((cells) => cells.some((c) => c.length > 0))
    .map(([id, evidence, node, reproducedBy, evidenceClass]) => ({
      id, evidence, node, reproducedBy: reproducedBy || '', evidenceClass: evidenceClass || '',
    }));
}

// --- the mission's charter.md: whether this repository has an evidence layer at all -------------
//
// One judgement per mission, written into the charter's own section when the cut is accepted: what
// proof means HERE, read off this repository rather than brought along. One of its answers is that
// there is nothing to point at — no test suite, no directory of promises, not even a file named
// like a test — and that answer opens the section with "No evidence layer found".
//
// It is read back from the charter rather than detected again, because the charter is the file a
// person corrects: a judgement somebody rewrote by hand is the one that stands, not whatever the
// repository happens to look like the next time a tool goes looking.
//
// Anchored to the START of the section, deliberately. The charter template quotes the same phrase
// in the middle of a sentence while telling the architect when to write it, and a mission whose cut
// has not run yet has judged nothing at all — a loose search would read those instructions as a
// verdict, and every landing, every wave close and the retrospective would announce an absence
// nobody has established.

export const EVIDENCE_SECTION = 'Evidence in this repository';

const NO_EVIDENCE_LAYER_RE = /^no evidence layer found\b/i;

// The one sentence every surface says when that is what the charter holds. It lives here, said the
// same way in all of them, because a mission with nothing to run its proof against is one fact
// about the whole mission — not a different remark invented at each place it comes up.
export const NO_EVIDENCE_LAYER_NOTE = 'No evidence layer in this repository: the charter says there '
  + 'is no test suite, no promises directory and nothing named like a test, so nothing here is '
  + 'proved by running it. Every row of the evidence catalogue stands on what it names itself — a '
  + 'scenario, a film, a screenshot, a measurement — and somebody has to look at that to know it '
  + 'holds.';

// True when the charter's own judgement is that there is nothing here to point at.
export function noEvidenceLayerIn(charterText) {
  const heading = `## ${EVIDENCE_SECTION}`;
  const section = markdownSection(charterText, heading);
  if (!section) return false;
  return NO_EVIDENCE_LAYER_RE.test(section.slice(heading.length).trim());
}

// noEvidenceLayerNote(horde) — the sentence to say, or null when this mission has an evidence layer
// (or has not judged yet, which is not the same claim and is never said as one).
export function noEvidenceLayerNote(horde) {
  return noEvidenceLayerIn(readText(hordePath(horde, 'charter.md'))) ? NO_EVIDENCE_LAYER_NOTE : null;
}

// --- the mission's decisions.md: its entries ---------------------------------------------------
//
// One block per `## ` heading: `## <date> · <slug>[ · ticket <id>][ · node <id>]`, then the body.
// A heading in any other shape (a preamble, a lessons banner) still opens a block, with its fields
// reading null — the two readers of this file want different halves of it. One matches entries by
// slug and so needs the heading; the other reads an ask's bold fields out of the body and has
// never cared what the heading above them said.

const DECISION_HEADING_RE = /^## (\d{4}-\d{2}-\d{2}) · ([^\s·]+)(?: · ticket (\S+))?(?: · node (\S+))?\s*$/;

export function parseDecisionEntries(text) {
  const lines = String(text || '').split('\n');
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('## ')) { i++; continue; }
    const heading = lines[i];
    const m = DECISION_HEADING_RE.exec(heading);
    i++;
    const raw = [];
    while (i < lines.length && !lines[i].startsWith('## ')) { raw.push(lines[i]); i++; }
    const body = [...raw];
    while (body.length && body[0].trim() === '') body.shift();
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    entries.push({
      heading,
      date: m ? m[1] : null,
      slug: m ? m[2] : null,
      ticket: m && m[3] ? m[3] : null,
      node: m && m[4] ? m[4] : null,
      body: body.join('\n'),
      // The entry's own text, verbatim, so a caller can find and rewrite it inside the document.
      block: [heading, ...raw].join('\n'),
    });
  }
  return entries;
}

// One `**<Label>:**` field out of an entry's block — the middle dot separates fields on a line, so
// a value stops at the next one.
export function decisionField(block, label) {
  const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n·]*)`, 'i').exec(String(block || ''));
  return m ? m[1].trim() : '';
}

// Resolves a team's short LEAF name (e.g. "lark") to its full on-disk segment chain
// (["trunk", "lark"]) by walking roster.json's steward entries' own `parent` links back to
// "trunk". Pre-6.0.0 history, and read-only: nothing writes a steward entry any more and a fresh
// mission only ever has "trunk", so this always takes the "trunk" fast path below in practice.
// Kept as a lookup rather than hard-coded because leaf names are the only address that stays
// correct no matter how deep a team is nested, and a mission started before 6.0.0 can still carry
// a real chain worth resolving. "trunk" is the implicit root and needs no roster lookup at all.
function resolveTeamSegments(horde, leaf, seen = new Set()) {
  if (!leaf || leaf === 'trunk') return ['trunk'];
  if (seen.has(leaf)) fail(`team "${leaf}" has a cyclical parent chain in roster.json`);
  seen.add(leaf);
  const doc = readJSON(hordePath(horde, 'roster.json'), { entries: [] });
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const entry = entries.find((e) => e.role === 'steward' && e.team === leaf);
  if (!entry) fail(`no such team: "${leaf}" — every ticket is filed on "trunk"; a nested team is only ever found in a mission started before 6.0.0`);
  return [...resolveTeamSegments(horde, entry.parent, seen), leaf];
}

// teamPath(horde, team, ...parts) — `team` is normally just the short LEAF name a team was
// created under ("lark"), unique per horde; this resolves its real nesting from roster.json and
// inserts the literal "teams/" segments that actually separate each level on disk
// ("teams/trunk/teams/lark"), so every caller works from the one name a brief or a queue item
// already carries, never having to spell out or track the ancestry itself. A full slash path
// ("trunk/lark") is also accepted, but only when it matches what the roster independently
// resolves for that same leaf — anything else (a stale or guessed path, or the literal segment
// "teams") is refused rather than silently landing in a wrong or doubly-nested directory.
export function teamPath(horde, team, ...parts) {
  const given = String(team).split('/').filter(Boolean);
  if (given.length === 0) fail('--team is required');
  if (given.includes('teams')) {
    fail(`invalid --team "${team}" — "teams" is inserted automatically and must not be written`);
  }
  const leaf = given[given.length - 1];
  const resolved = resolveTeamSegments(horde, leaf);
  if (given.length > 1 && given.join('/') !== resolved.join('/')) {
    fail(`--team "${team}" does not match "${leaf}"'s actual location ("${resolved.join('/')}") — pass just the leaf name "${leaf}"`);
  }
  return hordePath(horde, ...resolved.flatMap((s) => ['teams', s]), ...parts);
}

// ---- the queue lock (queue-single-writer) ------------------------------------------------------
//
// queue.json is read whole, changed in memory, and written back whole — a plain read-modify-write.
// Two processes doing that at once (two sessions on one horde, a tick racing a hand-run `queue.mjs
// set`) can each read the same document, apply their own change, and write it back: whichever
// write lands second wins outright and the other's change is gone with no trace and no error. The
// same exclusive-create trick decide.mjs's `withDecisionsLock` uses closes it — every command that
// changes queue.json wraps its read, its change and its write in one call to `withQueueLock`, so
// no two ever interleave.
//
// A fourth hand-rolled copy of this lock (decide.mjs, land.mjs's `acquireGateLock` and retro.mjs's
// `acquireRetroLock` already each have their own) is what this is instead of: one shared primitive
// in `_lib.mjs`, scoped per horde+team so two different queues never wait on each other. It is
// created the same atomic way those two are — `createLockFile` above, content written whole to a
// name nobody is watching and only then linked into place — so a racing caller can never read a
// lock still being written as an abandoned one and take it out from under its holder.
//
// A refusal raised through `fail()` now unwinds the stack, so the `finally` releasing this lock
// does run. A holder can still die without releasing — killed outright, or the machine going down
// — and a dead holder must not wedge every later command on this queue forever, so — exactly like
// `acquireGateLock` and `acquireRetroLock` — the lock file names the pid that took it, and a pid
// no longer running is taken over immediately rather than waited out.
//
// QUEUE_LOCK_WAIT_MS / QUEUE_LOCK_POLL_MS are declared above, next to the tree lock's own timing,
// because allocateId's counter lock (below) reuses them too: it is the same short read-compute-
// write shape as a queue.json update, not the longer worktree-creation wait the tree lock is tuned
// for, so it takes the queue lock's numbers rather than earning a tuned pair of its own.

function queueLockPath(horde, team) {
  return `${teamPath(horde, team, 'queue.json')}.lock`;
}

export function withQueueLock(horde, team, fn, { waitMs = QUEUE_LOCK_WAIT_MS } = {}) {
  const path = queueLockPath(horde, team);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      createLockFile(path, `${JSON.stringify({ pid: process.pid, horde, team, at: nowIso() }, null, 2)}\n`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const seen = readLockText(path);
    if (seen === null) continue; // released between the failed create and this read: try again
    let held = null;
    try { held = JSON.parse(seen); } catch { held = null; }
    // An unreadable or half-written lock file names no pid to wait on, so it is treated exactly
    // like a dead one: taken over rather than waited on.
    if (!held || !processAlive(held.pid)) {
      removeStaleLock(path, seen);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`queue.json for team "${team}" is locked by another process (pid ${held.pid}, taken ${held.at || 'at an unrecorded time'}) — timed out waiting for ${path}`);
    }
    sleepSync(QUEUE_LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8'));
      if (holder.pid !== process.pid) throw new Error('not ours');
      rmSync(path, { force: true });
    } catch { /* unreadable, already gone, or already taken over by someone else: nothing to do */ }
  }
}

// ---- cross-horde leases (node-lease-across-hordes) -------------------------------------------
// Exclusive ownership across every live horde on one repository: `.horde/leases.json` maps a
// SUBJECT to the horde currently bound to it and since when. A subject is a node id (`node.mjs
// bind <node>`) or a territory name (`refine.mjs --step cut`, which leases the cut it just
// validated) — the file, the history and the refusal are one mechanism either way, because the
// question both ask is the same one: is another live horde already working this. This file is NOT
// per-horde — every horde on the repository reads and writes the one shared document, which is
// exactly why it lives beside config.json rather than under hordes/<horde>/. `horde.mjs archive`
// is the only remover (a horde's leases are released the moment it is no longer live). `history`
// is an append-only record of every bind/take/release so a contested subject's story survives past
// the current state; its `node` field keeps that name for the shape's sake and carries whichever
// subject the entry is about.

export function leasesPath() {
  return join(hordeRoot(), 'leases.json');
}

// A lease file that will not parse is NOT an empty one. An interrupted run leaves a truncated
// JSON behind, and reading that as "nothing is leased" would hand out a subject another live horde
// still holds — the one failure this whole file exists to prevent. So it refuses, by name.
export function readLeases() {
  let doc;
  try {
    doc = readJSON(leasesPath(), null);
  } catch (e) {
    fail(
      `${leasesPath()} will not parse as JSON, so what is leased on this repository cannot be read: ${e.message}\n`
      + 'A lease file half-written by an interrupted run is not an empty one — treating it as empty would hand '
      + 'out a subject another live horde still holds.\n'
      + 'Repair the file, or delete it if no horde on this repository holds anything.',
    );
  }
  const leases = doc && doc.leases && typeof doc.leases === 'object' ? doc.leases : {};
  const history = doc && Array.isArray(doc.history) ? doc.history : [];
  return { leases, history };
}

function renderLeases(doc) {
  const entries = Object.entries(doc.leases).sort(([a], [b]) => a.localeCompare(b));
  const lines = ['# Leases', '', '| leased | horde | since |', '|---|---|---|'];
  if (entries.length === 0) lines.push('| | | |');
  for (const [node, lease] of entries) lines.push(`| ${node} | ${lease.horde} | ${lease.since} |`);
  if (doc.history.length > 0) {
    lines.push('', '## History', '');
    for (const h of [...doc.history].reverse()) {
      const bits = [h.at, h.event, h.node, `-> ${h.horde}`];
      if (h.from) bits.push(`(from ${h.from})`);
      if (h.escalation) bits.push(`escalation ${h.escalation}`);
      lines.push(`- ${bits.join(' ')}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function writeLeases(doc) {
  writeJSON(leasesPath(), doc, { render: renderLeases });
}

// releaseLeasesForHorde(horde) — drops every lease this horde holds and records a "release" entry
// per subject in the history. Called by horde.mjs archive so an archived horde's nodes and
// territories are free the moment it stops being live; returns the released subjects (empty when
// it held none).
export function releaseLeasesForHorde(horde) {
  const doc = readLeases();
  const released = Object.entries(doc.leases).filter(([, l]) => l.horde === horde).map(([node]) => node);
  if (released.length === 0) return released;
  const at = nowIso();
  for (const node of released) {
    delete doc.leases[node];
    doc.history.push({
      node, event: 'release', horde, from: null, escalation: null, at,
    });
  }
  writeLeases(doc);
  return released;
}

// leaseConflict(horde, subject) — the live holder blocking `horde` from this subject, or null when
// there is none (never leased, held by `horde` itself, or held by a horde no longer live). A pure
// read, safe to call before mutating anything — which is exactly why horde.mjs init uses it to
// refuse a --nodes overlap BEFORE creating the horde's branch, rather than discovering the
// conflict after state already exists.
export function leaseConflict(horde, subject) {
  const liveHordes = listHordes();
  const { leases } = readLeases();
  const existing = leases[subject];
  return existing && existing.horde !== horde && liveHordes.includes(existing.horde) ? existing : null;
}

// The refusal, in the subject's own words. Both halves matter: WHO holds it and how recently they
// moved (so a horde nobody has touched in a week reads as the stale thing it is), and what the
// taker can actually do about it. That second half differs by kind, because the ways out differ. A
// node can be taken over on an answered ask. A territory cannot: who works an area when two
// hordes want it is the client's call, answered once at the frame, and there is no command here
// that overrides it — so this says archive, and otherwise says to go and ask, rather than naming a
// mechanism that would not run.
function leaseRefusalMessage(taker, subject, holder, kind) {
  const activity = latestActivity(hordePath(holder.horde)) || 'no recorded activity';
  const head = `${kind} "${subject}" is leased by horde "${holder.horde}" (since ${holder.since}; last activity `
    + `${activity}) and that horde is not archived — archive it (\`horde.mjs archive ${holder.horde}\`) `;
  return kind === 'territory'
    ? `${head}or put it to the client, whose answer decides which mission gets this area; nothing here takes a territory over`
    : `${head}or take the lease over an answered ask: \`node.mjs bind ${subject} --take --ask <id> --horde ${taker}\``;
}

// assertLeaseAvailable(horde, subject, {kind}) — throws leaseConflict's refusal, otherwise returns
// quietly. horde.mjs init calls this for every requested node before creating anything of its own,
// so the whole command refuses cleanly (no orphaned branch, no half-created horde) on the very
// message node.mjs bind would give later for the same node; refine.mjs calls it for every
// territory of a cut before claiming any of them.
export function assertLeaseAvailable(horde, subject, { kind = 'node' } = {}) {
  const conflict = leaseConflict(horde, subject);
  if (conflict) throw new Error(leaseRefusalMessage(horde, subject, conflict, kind));
}

// claimLease(horde, subject, {take, ask, kind}) — the one path that acquires a lease, for a
// node and for a territory alike. Ownership is exclusive across every live horde on a repository:
// returns {status: 'held' | 'claimed' | 'taken', ...} on success; throws Error with a
// what/why/next-shaped message the caller passes straight to fail() on any refusal. Shared by
// horde.mjs init (--nodes, at creation, after assertLeaseAvailable has already cleared it),
// node.mjs bind (<node>, any time) and refine.mjs (one territory of a validated cut), so every
// tool refuses the same overlap the same way and writes the same history line — one derivation,
// three callers, per the scripts' own convention (see node.mjs's consumersOf).
//
// The write is the commit point, and it is the LAST thing that happens: everything before it is a
// read or an in-memory edit, so a run killed partway leaves the file exactly as it found it and
// the subject free for the next attempt. Callers claiming several subjects at once hold to the
// same shape by validating all of them before claiming any.
export function claimLease(horde, subject, { take = false, ask = null, kind = 'node' } = {}) {
  const doc = readLeases();
  const node = subject;
  const existing = doc.leases[node];

  if (existing && existing.horde === horde) {
    return { status: 'held', node, horde, since: existing.since };
  }

  const conflict = leaseConflict(horde, node);
  if (conflict) {
    if (!take) throw new Error(leaseRefusalMessage(horde, node, conflict, kind));
    if (!ask) {
      throw new Error('--take requires --ask <id> — an answered ask on this horde justifying the take-over');
    }
    const askDoc = readJSON(hordePath(horde, 'asks.json'), { items: [] });
    const item = (Array.isArray(askDoc.items) ? askDoc.items : []).find((it) => it.id === String(ask));
    if (!item) throw new Error(`no such ask: ${ask} (on horde "${horde}")`);
    if (item.state !== 'answered') {
      throw new Error(`ask ${ask} is not answered yet — \`ask.mjs answer ${ask} "<answer>" --horde ${horde}\` first`);
    }
    const from = conflict.horde;
    const at = nowIso();
    doc.leases[node] = { horde, since: at };
    doc.history.push({
      node, event: 'take', horde, from, ask: String(ask), at,
    });
    writeLeases(doc);
    return {
      status: 'taken', node, horde, from, ask: String(ask), answer: item.answer,
    };
  }

  // Free: never leased, or held by a horde no longer live — archiving already releases a horde's
  // leases, so this branch is a defensive fallback for state written before that, not the normal
  // path.
  const freedFrom = existing ? existing.horde : null;
  const at = nowIso();
  doc.leases[node] = { horde, since: at };
  doc.history.push({
    node, event: 'bind', horde, from: freedFrom, ask: null, at,
  });
  writeLeases(doc);
  return { status: 'claimed', node, horde, freedFrom };
}

// ---- which horde a COMPONENT belongs to -------------------------------------------------------
//
// A lease is held on a SUBJECT, and a subject is a node id or a territory name (see the block
// above). Both live in the one flat map, which is right for the question a lease answers ("is
// another live horde already working this") and wrong for the question every sweep over the graph
// actually asks: given a component, whose mission is it?
//
// Since the cut (refine.mjs --step cut) a mission leases TERRITORIES, not the nodes inside them —
// so a repository whose hordes were cut has `leases` full of territory names and not one node id,
// and reading `leases[node]` there answers "leased by no horde" about every component in the
// mission. This resolves both ways round: the node's own lease first (the direct bind that
// `horde.mjs init --nodes` and `node.mjs bind` take), then the territory holding it, read from the
// territories.json of whichever live horde leases that territory.
//
// `via` says which of the two answered, because the two mean different things to a reader: a node
// bound by name was named by somebody, a node inside a territory was cut into one.

export function territoriesPathFor(horde) {
  return hordePath(horde, 'territories.json');
}

// One horde's cut, as {territory: {nodes, …}}. Missing is an ordinary answer (a mission that was
// never cut); unparseable is a refusal naming the file, for the same reason readLeases refuses —
// a half-written document read as an empty one silently loses everything the cut decided.
export function readTerritories(horde) {
  const path = territoriesPathFor(horde);
  if (!existsSync(path)) return {};
  let doc;
  try {
    doc = readJSON(path, null);
  } catch (e) {
    fail(
      `${path} will not parse as JSON, so this mission's cut cannot be read: ${e.message}\n`
      + 'A cut half-written by an interrupted run is not an absent one — reading it as empty would put every '
      + 'component of this mission outside it.\n'
      + 'Repair the file, or delete it if this mission has no cut.',
    );
  }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}

// leaseHolderForNode(node) — {horde, via} for whichever live horde holds this component, or null
// when none does. `via` is 'node' for a direct bind and 'territory:<name>' for a component inside
// a leased territory.
export function leaseHolderForNode(node) {
  const { leases } = readLeases();
  const live = listHordes();
  const direct = leases[node];
  if (direct && direct.horde && live.includes(direct.horde)) {
    return { horde: direct.horde, via: 'node', since: direct.since };
  }
  for (const [subject, lease] of Object.entries(leases)) {
    if (!lease || !lease.horde || !live.includes(lease.horde)) continue;
    const territories = readTerritories(lease.horde);
    const spec = territories[subject];
    if (!spec) continue;
    if (!asArray(spec.nodes).includes(node)) continue;
    return { horde: lease.horde, via: `territory:${subject}`, since: lease.since };
  }
  return null;
}

// ---- a horde's own last activity (most recent mtime under its directory) ---------------------
// Shared by horde.mjs list (a horde reporting its own last activity) and node.mjs bind (naming
// the last activity of whichever horde currently holds a lease being contested), so a refusal
// message and the `list` column agree on what "last activity" means rather than each tool
// computing its own notion of it.
function dirMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

export function latestActivity(dest) {
  let latest = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else latest = Math.max(latest, dirMtime(full));
    }
  };
  walk(dest);
  return latest ? new Date(latest).toISOString() : null;
}

// listHordes() — names under hordes/, excluding the archive.
export function listHordes() {
  const dir = join(hordeRoot(), 'hordes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_archive')
    .map((d) => d.name)
    .sort();
}

// resolveHorde(args) — args is a parsed-flags object (or {flags} from parseArgs). `--horde name`
// wins outright; otherwise the sole existing horde is the default; anything else is a refusal
// (fail() raises it, matching every other tool's error contract).
export function resolveHorde(args) {
  const flags = args && args.flags ? args.flags : args || {};
  const hordes = listHordes();
  if (flags.horde) {
    if (!hordes.includes(flags.horde)) fail(`no such horde: ${flags.horde}`);
    return flags.horde;
  }
  if (hordes.length === 1) return hordes[0];
  if (hordes.length === 0) fail('no horde exists — run horde.mjs init <name> --base <branch>');
  fail(`multiple hordes exist (${hordes.join(', ')}) — pass --horde <name>`);
}

// parentBranchOf(horde, team, item) — the branch a queue item's own branch is rooted on, merges
// into, and is measured against. Normally the team's branch. A ticket started from an
// unmerged dependency's tip (`queue.mjs set NNN running --on MMM`, recorded as `stackedOn`) is
// rooted on that dependency's branch instead, so a chain of three tickets does not cost three
// waves. The stack lasts exactly as long as the dependency is unmerged: once it merges, its work
// is on the team branch, `stackedOn` is cleared by the write that recorded the merge, its branch
// is gone, and the parent is the team branch again. The state and branch are checked here as well
// as cleared there, so a `stackedOn` left behind by anything resolves to the team branch — the
// answer that is at worst stale, never one naming a branch that no longer exists.
//
// One function, because everything measured against a parent has to name the same one: how fresh
// the base is, what the diff contains, the identity a key binds to, what a new test is reverted
// onto, and what the range-diff of a moved diff is taken against. Two answers here would be a
// ticket whose keys are recorded against one branch and checked against another.
export function parentBranchOf(horde, team, item, { cwd } = {}) {
  const teamBranch = `${horde}/${String(team).split('/').pop()}`;
  const stackedOn = item && item.stackedOn ? String(item.stackedOn) : null;
  const out = {
    branch: teamBranch, teamBranch, stackedOn, stacked: false,
  };
  if (!stackedOn) return out;
  const queue = readJSON(teamPath(horde, team, 'queue.json'), { items: [] });
  const parent = asArray(queue.items).find((i) => String(i.ticket) === stackedOn);
  if (!parent || parent.state === 'merged' || !parent.branch) return out;
  if (git(['rev-parse', '--verify', parent.branch], cwd || repoRoot()) === null) return out;
  return { ...out, branch: parent.branch, stacked: true };
}

export function readJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${e.message}`);
  }
}

// writeJSON(file, obj, {render}) — obj is always the source of truth; when `render` is given
// (obj) => mdText, the sibling `.md` (same path, `.json` swapped for `.md`) is written alongside,
// never the other way around.
export function writeJSON(file, obj, { render } = {}) {
  // Written to a sibling and renamed over the file, never in place: an in-place write truncates the
  // file first, so a reader with no lock (tk.mjs, tick.mjs, a test polling queue.json while a
  // detached land.mjs writes it) could catch it empty or half-written and die on "Unexpected end of
  // JSON input". Now it sees the whole old document or the whole new one.
  writeJSONAtomic(file, obj);
  if (render) {
    const mdFile = file.replace(/\.json$/, '.md');
    writeFileSync(mdFile, render(obj));
  }
}

export function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function appendText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const existing = readText(file);
  const sep = existing && existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(file, sep + text, { flag: 'a' });
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return nowIso().slice(0, 10);
}

// A refusal, raised — never an exit. A library function that killed the process took the decision
// away from its caller: a loop meant to run unattended (`tick.mjs --watch`) died on the first
// refusal it should have written down and retried, and a caller that wanted to handle one could
// not. Every tool below still ends on a refusal exactly as before, because `runMain` turns this
// into the same `error: ...` line and the same exit code — and `process.exit` now lives only
// there, in one place, at the edge of each script.
export class HordeError extends Error {
  constructor(msg, code = 1) {
    super(msg);
    this.name = 'HordeError';
    this.code = code;
  }
}

export function fail(msg, code = 1) {
  throw new HordeError(msg, code);
}

// runMain(main) — the one place a horde tool exits. A refusal raised anywhere below prints the
// same `error: ...` line it always did and exits with its code; anything else keeps its stack and
// crashes loudly, because an unexpected throw is a bug, not a refusal.
export function runMain(main) {
  try {
    const result = main();
    if (result && typeof result.then === 'function') result.then(undefined, exitOnFailure);
  } catch (e) {
    exitOnFailure(e);
  }
}

function exitOnFailure(e) {
  if (e instanceof HordeError) {
    console.error(`error: ${e.message}`);
    process.exit(e.code);
  }
  throw e;
}

// emit(result, args, human) — JSON when `--json` was passed (args may be a parsed-flags object
// or the {flags} shape parseArgs returns), else the human-readable rendering: `human` may be a
// string or a zero-arg function returning one; when omitted, `result` itself is printed.
export function emit(result, args, human) {
  const flags = args && args.flags ? args.flags : args || {};
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (human === undefined) {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return;
  }
  console.log(typeof human === 'function' ? human() : human);
}

// True when this module was invoked directly as a script (not imported by another tool, e.g.
// ask.mjs importing decide.mjs's appendDecision).
// compared as paths, not as URL strings: a directory with a space is percent-encoded in the
// module URL and plain in argv, and a string comparison would silently never match
export function isMain(moduleUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return resolve(fileURLToPath(moduleUrl)) === resolve(process.argv[1]);
  } catch {
    return false;
  }
}

// parseArgs(argv, {flags, aliases}) — `flags` names booleans that never consume the next token
// (in addition to the always-boolean `json`/`help`); `aliases` maps a short name to its long
// form before classification. `--k v`, `--k=v`, repeated `--k` (collects into an array, in
// order), and bare `--k` (true, when it's declared boolean or is trailing/followed by another
// flag) are all supported. Everything not starting with `--` is positional.
export function parseArgs(argv, { flags: boolNames = [], aliases = {} } = {}) {
  const bools = new Set(['json', 'help', ...boolNames]);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    name = aliases[name] || name;
    if (value === undefined) {
      const next = argv[i + 1];
      if (bools.has(name) || next === undefined || next.startsWith('--')) {
        value = true;
      } else {
        value = next;
        i++;
      }
    }
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      flags[name] = Array.isArray(flags[name]) ? [...flags[name], value] : [flags[name], value];
    } else {
      flags[name] = value;
    }
  }
  return { positional, flags };
}

export function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => cells.map((s, i) => s.padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(columns.map((c) => c.header)));
  for (const r of rows) console.log(line(columns.map((c) => String(r[c.key] ?? ''))));
}

// renderTemplate(name, vars) — loads templates/<name>.md and replaces every `{{key}}` or
// `{{key | default}}` token. `key` is whatever sits before the first `|` (spaces, hyphens and
// all — the templates use it loosely, e.g. `{{n-1}}`, `{{quality | autonomous}}`,
// `{{revertBase | }}`, not only identifier-shaped names), trimmed. A token with a value in
// `vars` (anything but undefined/null) is replaced by that value; one without a value but with
// a default is replaced by the default text; one with neither throws — the whole template is
// rendered first so the thrown message can list every unfilled key at once, not just the first.
export function renderTemplate(name, vars = {}) {
  const file = join(TEMPLATES_DIR, `${name}.md`);
  const text = readFileSync(file, 'utf8');
  const unfilled = [];
  const rendered = text.replace(/\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?))?\s*\}\}/g, (whole, rawKey, def) => {
    const key = rawKey.trim();
    const value = vars[key];
    if (value !== undefined && value !== null) return String(value);
    if (def !== undefined) return def;
    unfilled.push(key);
    return whole;
  });
  if (unfilled.length > 0) {
    throw new Error(`template ${name}.md: unfilled placeholder(s): ${[...new Set(unfilled)].join(', ')}`);
  }
  return rendered;
}
