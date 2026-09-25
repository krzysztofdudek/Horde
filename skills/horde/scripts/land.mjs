#!/usr/bin/env node
// horde skill — land.mjs
//
// The gate that lands a change, or refuses it. This is the last command a worker runs: it checks
// the branch against nine items, and when every one of them is green it merges the branch into
// its parent itself. Nobody signs anything. A green run IS the signature, and the landed sha is
// the only trace it leaves.
//
// Three things make this different from the checklist it replaces. It runs in a fresh detached
// worktree at the branch's own tip rather than in the worker's tree, so nothing it measures can
// be disturbed by whoever is still working. It holds one lock per repository around the expensive
// half, so two landings serialize instead of trampling each other. And it merges — which no
// script in this tool used to do; a human did it by hand, which is exactly where a green
// checklist stopped meaning anything.
//
// A branch is found by locating the queue item that names it, in trunk's own queue.json: an
// ordinary ticket branch `<horde>/t-NNN`. The branch it must be rooted on, and will merge into, is
// normally `<horde>/trunk` — for a ticket started from an unmerged dependency's tip, that
// dependency's branch until it merges, and for a prototype ticket `<horde>/prototype`, which the
// trunk never takes. `parentBranchOf` and the prototype guard answer that once between them, and
// every item below is measured against their answer: the base, the diff, the tree a new test is
// reverted onto.
//
// The one thing here that is not a gate run is `--fate`: what became of a ticket after it landed,
// recorded where the landing was recorded. See "what became of a ticket after it landed" below.

import {
  existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hordePath, hordeRoot, readJSON, writeJSON, readText, writeText, readConfig, git, gitBlob, gitError, fail,
  parseArgs, asArray, emit, isMain, resolveHorde, parentBranchOf, resolveTree, provenanceLine,
  withProvenance, nowIso, parseDecisionEntries, decisionField, diffSize, sizeRanks, sizeLine,
  noEvidenceLayerNote, createLockFile, processAlive, readLockText, removeStaleLock, sleepSync, HordeError,
  runMain,
} from './_lib.mjs';
import {
  ticketNodes, runYgCheck, ygCommand, fillDeterministic, pendingProsePairs, hasReviewer,
  globToRegExp, pathInBoundary, ticketBoundary, proposalBoundaryOf, ygFileContext, ygAvailable, ygJson,
  NODE_LOG_FILE, YG_LOCK_FILE, mergesByRule, nodeOfLogFile, ygLogMergeResolve,
} from './node.mjs';
import {
  ticketFiles, ticketEvidence, ticketKind, prototypeBranchOf, ticketReopens, findTicket,
  changesRoundInfo, transitionStatus,
} from './tk.mjs';
import { recordMerged, buildPlan } from './queue.mjs';
import { noteFate } from './wave.mjs';
import { detectEvidenceLayer, HOOK_FILES } from './horde.mjs';

const USAGE = `usage: land.mjs <ticket|branch>[,<ticket|branch>...] [--level trunk] [--no-gate] [--background] [--tree p] [--horde h]
       land.mjs <ticket> --fate reverted --by <sha> [--tree p] [--horde h]
       land.mjs <ticket> --fate reopened --by <ticket> [--tree p] [--horde h]

The gate a change lands through. Nine items, ✓/✗ per line; every one green means the branch is
merged into its parent here and now, and a single ✗ means it is not — nobody's signature is asked
for either way.

  1. base freshness — branch rooted at its parent branch's tip; a branch the parent moved past is
                      brought up to date first (the parent merged into it; conflicts only in a node's
                      log.md, Yggdrasil's lock files or config.appendOnly files are resolved by rule),
                      or, when anything else conflicts, refused as stale before any gate, with no fix
                      round and the files named as conflictFiles
  2. judge          — every prose rule on this tree has a verdict from Yggdrasil's own reviewer
                      (the only judge of a prose rule)
  3. scope          — diff stays inside the files the ticket declared, or its node boundaries when
                      it declared none; no protected path touched
  4. revert test    — new or changed test files (named by config.testGlobs), extracted onto the
                      parent's tree, fail there; or, when the ticket names a "**Mutate:**" command
                      instead, run against a scratch copy of the branch's own tip with that command
                      applied, fail there. A file node --test cannot run goes through gates.commit,
                      which counts only when it is green on that same tree without the file and red
                      with it — and, when that run wrote the config.gates.report file, when the report
                      names a failing case from the file; anything less is "no verdict", a ✗ that
                      names the ways out. Diff carries none of those: ✗, unless the ticket declares
                      "**No new tests:**" with a reason. ✗ when this repository's test patterns are
                      unknown
  5. gate           — config.gates.<level> green on the branch's own tree, run fresh; and, when
                      config.gates.report names the report that run leaves behind ({path, format},
                      format junit|tap|playwright-json), every live promise's own paired case in
                      that report, passing. Missing, skipped or failed there is a red gate naming
                      the promise. No report configured: the item says so rather than passing for
                      a run nobody confirmed
  6. graph          — the free deterministic verdicts recorded, every prose rule still waiting
                      on a judgement named, and a full "yg check" green on this branch's tree
  7. mapping        — every file the branch added is owned by a node on the branch's own tree
                      (a mapping and its first file land in the same commit); skipped with --no-gate
  8. journal        — a log entry newer than the last commit
  9. graph text     — charters, logs and "graph:" commits touched by the branch carry no mission
                      language (wave, ticket NNN, mission, horde, E<n>, .temp/)

Two or more tickets, comma-separated, land under ONE shared run of items 5-7 (gate, graph, mapping)
when they are eligible to: the same parent branch at the same tip, and no changed file in common
(the files that merge by rule are not counted, and are resolved by that rule when combined).
Items 1-4, 8 and 9, and every guard below, still run per ticket, individually, exactly as for one.
A ticket that is not eligible — a different parent, an overlapping file, or a conflict once its
branch is actually combined with the rest for the shared run — lands on its own instead, in this
same call, rather than being dropped; and a shared run that comes back red falls back to landing
every ticket in it on its own too, in this same call, rather than working out which one is guilty.
Either way, a ticket that lands gets its own merge commit, its own journal bullet and its own size
figure, exactly as it would landing alone. A single ticket is entirely unaffected: this is exactly
the nine-item run above, unchanged.

Five guards run before the items and refuse outright rather than reporting an item, because
none of them is a thing a worker can fix by trying again:

  the prototype guard    — a prototype ticket's branch must be cut from "<horde>/prototype", and
                           merges back only there. A prototype never reaches the trunk: nothing
                           verified it, which is what it is for, and its only evidence is the
                           client's acceptance recorded with "tk.mjs accept".
  the law guard          — a branch may not weaken the rules it is judged by. A deleted aspect, a
                           demoted status, a moved review_by, a narrowed reach, an added
                           yg-suppress marker or an aspect detached from a node all refuse, unless
                           the mission's decisions.md carries the client's answer to an "ask" of
                           kind "lower" naming that exact aspect.
  the evidence guard     — a branch may not weaken the proof it is judged by. A promise that stops
                           reading "implemented", a promise whose paired case is gone, a test file
                           removed, a test file carrying fewer assertions than it had, or a new
                           skip marker in one, all refuse — unless the same answered "lower" ask
                           names that promise ("evidence:<id>") or that file ("evidence:<path>").
  the gate guard         — a branch may not weaken the gates it is measured through. The script a
                           config.gates.* command runs, a commit or push hook, or a CI workflow
                           file, removed or rewritten, refuses — unless the same answered "lower"
                           ask names it ("gate:<path>").
  the conflict guard     — a branch may not sharpen a rule and change the code that rule refuses in
                           the same landing. Split it into a code ticket and a legislative one.

--level selects which gate command runs. Omitted — the normal case — runs config.gates.team, the
gate a ticket branch lands through. --level trunk runs config.gates.trunk, for a branch landing
directly on <horde>/trunk. "team" here is the name of a config key kept from before 6.0.0, not a
team you can name: passing --level team is refused outright rather than read as the default.
--no-gate skips items 5, 6 and 7 (informational: pass) and never merges.
A landing whose parent was brought in cleanly and whose only red is prose verdicts left pending by
that merge (the reviewer configured, and nothing else the graph refuses) writes no round and says
"rejudge": true in its result — the ticket goes back to refresh the verdicts, not for a fix.
--background starts the run and prints the path of the result file it will write, immediately.

Everything above — the scope check's own graph read included — runs against the tree --tree
names; without it, cwd, same as an ordinary read anywhere else in this tool set, not this horde's
trunk just because a horde was resolvable. --horde h WRITTEN OUT (no --tree) is what changes that,
for both a gate run and a --fate record: it resolves to that horde's own trunk worktree instead,
exactly as queue.mjs plan/quality and tick.mjs already read it. This is usually invisible — tick.mjs
spawns every gate run with cwd already pointed at the tree it resolved — and matters only when land
is run directly, by hand, with --horde and no --tree.

--fate records what became of a ticket AFTER it landed, and runs no gate: "reverted" when the merge
was undone (--by names the commit that undid it), "reopened" when the evidence the ticket claimed
went red again and a new ticket was filed to earn it back (--by names that ticket, which has to say
"**Reopens:** t-NNN" itself). It goes to the ticket's own result file and to the wave journal, where
the wave close counts it and the retrospective reads it as its own kind of input. Nothing in the
queue moves: the merge commit still stands and the reopening is its own ticket.

options: --json  --help`;

function short(sha) { return sha ? sha.slice(0, 7) : '(none)'; }

// A path with any byte above 0x7f comes back from git C-quoted ("za\305\274\303\263...") unless
// this is off, and every item that compares a diff path against a declared one, or hands it to the
// graph to ask who owns it, would then be working on an escape sequence instead of a filename.
//
// git() returns null on a real failure and '' on a clean result that just has nothing to say, and
// this is the one place that tells them apart. Every caller here feeds a gate item — scope,
// mapping, the revert test, the merge's own conflict list — that already reads an empty list as
// "nothing to flag", so folding a git() failure into that same [] would pass every one of them on
// a diff this landing never actually read. fail()s instead, naming the git error gitError() left
// behind, so a corrupted object or an unreadable ref refuses the landing rather than reading as a
// clean, empty diff.
function diffPaths(args, cwd) {
  const out = git(['-c', 'core.quotepath=false', ...args], cwd);
  if (out === null) {
    const detail = gitError();
    fail(`git ${args.join(' ')} failed, so this landing cannot tell what the branch actually touched — reading that as "nothing changed" would let the scope and mapping items pass on a diff nobody examined${detail ? `: ${detail}` : ''}`);
  }
  return out.split('\n').filter(Boolean);
}

// The nine items, in the order they are reported. Written down as a list rather than left to the
// order the code happens to append in: the items are not all computed in this order (the judge
// reads what the graph item found), and three separate documents used to describe three different
// gates because nothing here was the single place that said what the gate is.
const CHECK_ORDER = [
  'base freshness', 'judge', 'scope', 'revert test', 'gate', 'graph', 'mapping', 'journal', 'graph text',
];

// ---- locating the branch's context ------------------------------------------------

// The team whose queue.json names this branch, and the item itself. Only "trunk" exists. The
// argument is a branch name or a bare ticket id, since `horde land 007` is how a worker says it.
function findQueueItem(horde, arg) {
  const teamDir = hordePath(horde, 'teams', 'trunk');
  const queue = readJSON(join(teamDir, 'queue.json'), { items: [] });
  const items = asArray(queue.items);
  const byBranch = items.find((it) => it.branch === arg);
  if (byBranch) return { team: 'trunk', teamDir, item: byBranch };
  const digits = String(arg).replace(/\D/g, '');
  if (!digits) return null;
  const id = String(parseInt(digits, 10)).padStart(3, '0');
  const byTicket = items.find((it) => String(it.ticket) === id);
  return byTicket ? { team: 'trunk', teamDir, item: byTicket } : null;
}

function findIssueDir(teamDir, ticketId) {
  const issuesDir = join(teamDir, 'issues');
  if (!existsSync(issuesDir)) return null;
  return readdirSync(issuesDir, { withFileTypes: true })
    .find((e) => e.isDirectory() && e.name.startsWith(`${ticketId}-`))?.name || null;
}

// The latest timestamp mentioned anywhere in a journal/log — full ISO first, a bare date
// (wave.mjs's own bullets carry only a date) otherwise. Used to decide "has an entry newer than
// the last commit" without depending on which of the two grains the writer used.
function latestTimestamp(text) {
  if (!text) return null;
  const iso = [...text.matchAll(/\d{4}-\d{2}-\d{2}T[\d:.,]+Z?/g)].map((m) => m[0]);
  if (iso.length) return new Date(iso[iso.length - 1]);
  const dates = [...text.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
  return dates.length ? new Date(`${dates[dates.length - 1]}T23:59:59Z`) : null;
}

// ---- everything this run made, removed on every way out --------------------------------
//
// A scratch worktree has to be gone whether the run ended green, refused an item, refused a
// guard, threw halfway through one, hit a merge conflict, or was killed where it stood. Three
// hooks, because each covers a way out the others do not: `finally` for the ordinary path,
// `exit` for fail() and for an exception that unwinds the whole process, and the two signals,
// which terminate without running either. The jobs are idempotent, so overlapping is free.
const KILL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
function makeCleaner() {
  const jobs = [];
  let ran = false;
  const runAll = () => {
    if (ran) return;
    ran = true;
    for (const job of jobs.slice().reverse()) {
      try { job(); } catch { /* a tree already gone is the outcome we wanted */ }
    }
  };
  process.on('exit', runAll);
  for (const sig of KILL_SIGNALS) {
    process.on(sig, () => { runAll(); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)); });
  }
  return { add: (job) => jobs.push(job), runAll };
}

// A scratch tree's own cleanup removes the directory and git's record of it — but a directory
// that vanished from under the run leaves git still holding the registration, and
// `worktree remove` on a path that is not there fails. `prune` is what forgets it, and it is safe
// to run whatever happened.
function cleanupTree(info, root) {
  try { info.cleanup(); } catch { /* below still runs */ }
  git(['worktree', 'prune'], root);
}

// ---- the lock ----------------------------------------------------------------------
//
// One landing per repository at a time. `.horde/` is resolved through the git common directory,
// so every worktree of one repository finds the same lock file — which is the point: two workers
// landing at once would otherwise run each other's gate commands and `yg check --approve` over
// each other's lock. The lock is held around the expensive half only (the repository's own gate
// command and both `yg check` runs), never around the whole process.
//
// A process that dies holding it must not wedge the repository forever, so the file carries the
// pid that took it: a lock whose pid is gone is taken over with a note rather than waited on.
const LOCK_WAIT_MS = 120000;
const LOCK_POLL_MS = 250;

function lockPath() { return join(hordeRoot(), 'gate.lock'); }

// Exported under its full name because tick takes this same lock: two ticks on one repository would
// otherwise settle the same branch twice and hand the same ticket to two workers, and a lock of
// their own would not stop them racing a landing at the same time.
export function gateLockWaitMs(cfg) {
  const asked = Number(cfg && cfg.gateLockWaitMs);
  return Number.isFinite(asked) && asked > 0 ? asked : LOCK_WAIT_MS;
}

function lockWait(cfg) { return gateLockWaitMs(cfg); }

// createLockFile, processAlive and sleepSync are shared with retro.mjs's own lock and _lib.mjs's
// queue and worktree locks (imported above) — see createLockFile's own comment in _lib.mjs for why
// the file is written beside its name and only then linked into place.

export function acquireGateLock(ticket, branch, { waitMs = LOCK_WAIT_MS } = {}) {
  const path = lockPath();
  const deadline = Date.now() + waitMs;
  const notes = [];
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      createLockFile(path, `${JSON.stringify({
        pid: process.pid, ticket, branch, at: nowIso(),
      }, null, 2)}\n`);
      return {
        ok: true,
        notes,
        release: () => {
          try {
            const held = JSON.parse(readFileSync(path, 'utf8'));
            if (held.pid !== process.pid) return;
          } catch { /* unreadable: ours to clear either way */ }
          try { rmSync(path, { force: true }); } catch { /* already gone */ }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // Read once, and removed only while it still reads exactly that way — the same guard every
    // other lock loop uses (removeStaleLock): between the failed create and this read the holder
    // may have released the lock the normal way and another landing taken a fresh one, and a plain
    // remove would delete that live lock and let two landings merge onto trunk at once. A lock
    // that vanished was released, not abandoned: that is a retry, never a take-over to report.
    const seen = readLockText(path);
    if (seen === null && !existsSync(path)) continue;
    let held = null;
    try { held = JSON.parse(seen); } catch { held = null; }
    // An unreadable or half-written lock file names no pid to wait on, so it is treated exactly
    // like a dead one: taken over, with the take-over said out loud.
    if (!held || !processAlive(held.pid)) {
      notes.push(held
        ? `took over the gate lock left by pid ${held.pid} (ticket ${held.ticket || '?'}, taken ${held.at || 'at an unrecorded time'}) — that process is gone`
        : 'took over an unreadable gate lock file — nothing in it named a process still running');
      removeStaleLock(path, seen);
      continue;
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        notes,
        note: `another landing holds the gate lock: pid ${held.pid} on ticket ${held.ticket || '?'} (branch ${held.branch || '?'}), taken ${held.at || 'at an unrecorded time'}. `
          + `Waited ${Math.round(waitMs / 1000)}s at ${path}. Landings on one repository run one at a time — try again when that one finishes.`,
      };
    }
    sleepSync(LOCK_POLL_MS);
  }
}

// ---- checks -------------------------------------------------------------------------

function checkBaseFreshness(branch, parentBranch) {
  const parentTip = git(['rev-parse', parentBranch]);
  if (!parentTip) {
    const detail = gitError();
    return { ok: false, note: `parent branch not found: ${parentBranch}${detail ? ` — ${detail}` : ''}` };
  }
  const mergeBase = git(['merge-base', branch, parentBranch]);
  const ok = mergeBase === parentTip;
  return {
    ok,
    note: ok
      ? `rooted at ${parentBranch} tip (${short(parentTip)})`
      : `STALE — merge-base ${short(mergeBase)} vs ${parentBranch} tip ${short(parentTip)}`,
  };
}

// A ticket's scope is what it declared it would touch — the `**Files:**` field — and, when it
// declared nothing, its named node(s)' own code boundary plus each node's own graph files
// (yg-node.yaml, log.md), since a ticket logs decisions as part of the same change that touches
// the code. Nothing else under
// .yggdrasil/ (yg-architecture.yaml, aspects, config) is any node's own files, so no ticket's
// scope reaches those by way of this. Yggdrasil's committed lock files are neither in nor out of
// scope: yg writes them itself as a consequence of in-scope edits (a log entry, a merge-resolved
// log.md) and hand edits are what `yg check` in the gate refuses, so they are reported as derived
// and left to the gate.
//
// A declared list is the tighter of the two and it wins: the ticket said which files it
// touches, and a diff that reaches past it is a widened ticket nobody agreed to. The fix is never
// a quiet pass — it is `tk.mjs edit NNN --files …`, which writes the new list and a log line
// saying who widened it and when.
const DERIVED_LOCK = /^\.yggdrasil\/yg-lock\.[^/]+\.json$/;
function checkScope(root, cfg, nodes, files, declared = [], moved = []) {
  const boundary = declared.length ? declared : [...ticketBoundary(root, cfg, nodes), ...moved];
  const derived = files.filter((f) => DERIVED_LOCK.test(f));
  files = files.filter((f) => !DERIVED_LOCK.test(f));
  const outside = boundary.length ? files.filter((f) => !pathInBoundary(f, boundary)) : files;
  const protectedPaths = cfg.protectedPaths || [];
  const touchedProtected = files.filter((f) => protectedPaths.some((p) => f === p || f.startsWith(p)));
  const ok = outside.length === 0 && touchedProtected.length === 0;
  const shown = outside.slice(0, 5).join(', ') + (outside.length > 5 ? '…' : '');
  const parts = [];
  if (declared.length) {
    parts.push(outside.length
      ? `declared ${declared.length} files, touched ${shown} outside them — widen the ticket with tk.mjs edit --files, never in silence`
      : `diff inside the ${declared.length} declared file(s)`);
  } else {
    parts.push(outside.length ? `outside boundary: ${shown}` : 'diff inside node boundary');
  }
  parts.push(touchedProtected.length ? `protected paths touched: ${touchedProtected.join(', ')}` : 'no protected path touched');
  if (derived.length) parts.push(`derived lock files left to yg check: ${derived.join(', ')}`);
  return { ok, note: parts.join(' · ') };
}

function parseNodeTestSummary(output) {
  const extract = (name) => {
    const re = new RegExp(`^(?:ℹ|#) ${name} (\\d+)`, 'gm');
    const matches = [...output.matchAll(re)];
    return matches.length ? parseInt(matches[matches.length - 1][1], 10) : null;
  };
  return { tests: extract('tests'), pass: extract('pass'), fail: extract('fail') };
}

// Whatever the command said, on any exit — except a run stopped at `opts.timeout`, which said
// nothing worth reading and comes back as null so the caller can report the stop rather than parse
// a half-finished transcript as a result.
function runCapture(cmd, args, opts) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).toString();
  } catch (e) {
    if (e.code === 'ETIMEDOUT') return null;
    return (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  }
}

// Strips the markers that tell a nested `node --test` it's already inside a test run (this tool
// itself is regularly invoked from inside one, e.g. by its own test suite) — Node's test runner
// otherwise treats them as a signal to no-op the nested run instead of actually executing it.
//
// Also forces color off. `parseNodeTestSummary` below expects a plain-text "ℹ tests N" line
// anchored at column zero — whoever runs `land` (a person at a color terminal, an agent, a CI
// runner with color forced on) can have FORCE_COLOR/COLORTERM set in their own shell, and Node's
// test runner honors that over TTY detection, so the nested run's summary line arrives prefixed
// with an ANSI escape and the regex misses it. That reads back as "? fail / ? tests" — an
// unparseable note, not a "some tests failed" note — which fails the whole revert-test item and,
// with it, the gate, on a branch that may have been perfectly fine. Silencing color here, not on
// this process's own stdout, keeps it from ever depending on who is running `land` from where.
function childTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;
  delete env.COLORTERM;
  env.NO_COLOR = '1';
  if (env.NODE_OPTIONS) {
    const kept = env.NODE_OPTIONS.split(/\s+/).filter((tok) => tok && !tok.startsWith('--test')).join(' ');
    if (kept) env.NODE_OPTIONS = kept; else delete env.NODE_OPTIONS;
  }
  return env;
}

// The ref new tests must be shown failing on, when it isn't simply the parent branch's tip — a
// contract test that pins a surface the parent already holds is green there by design, and its
// intended failing base is named on the ticket instead: the issue's own "**Revert base:**"
// header (tk.mjs new --revert-base), or else a "red on <ref>" phrase read from its acceptance
// lines. Absent both, the caller falls back to the parent branch's tip as before.
function revertBaseRef(issueText) {
  if (!issueText) return null;
  // [ \t]*, not \s* — an empty value (the common case) must not let this cross the line break
  // and pick up whatever non-space token starts the next line.
  const header = /\*\*Revert base:\*\*[ \t]*(\S+)/.exec(issueText)?.[1];
  if (header) return header;
  const m = /\bred on (\S+)/.exec(issueText);
  return m ? m[1].replace(/[.,;:]+$/, '') : null;
}

// The command that swaps the revert-to-base variant for a mutation one — the issue's own
// "**Mutate:**" header (tk.mjs new --mutate). \S as the first character of the capture, not \s*,
// for the same reason revertBaseRef above avoids it: the empty default ("**Mutate:** " with
// nothing after it) must read as absent, not as a one-space command.
function mutateCommand(issueText) {
  if (!issueText) return null;
  const m = /\*\*Mutate:\*\*[ \t]*(\S.*)$/m.exec(issueText);
  return m ? m[1].trimEnd() : null;
}

// A ticket's own declared exemption from the revert test — "**No new tests:**" followed by a
// reason (tdd.md's "a change that adds no test at all ... says so"). \S as the first character of
// the capture, not \s*, for the same reason revertBaseRef and mutateCommand avoid it: an empty
// header ("**No new tests:** " with nothing after it) is not a reason and must read as absent, so a
// diff with no new or changed test files still refuses rather than passing on an unexplained claim.
function noNewTestsReason(issueText) {
  if (!issueText) return null;
  const m = /\*\*No new tests:\*\*[ \t]*(\S.*)$/m.exec(issueText);
  return m ? m[1].trimEnd() : null;
}

// How a matched test file is run, decided in this one place so a further runner is one more answer
// here rather than a second dispatch somewhere else. "node" is a file this repository's own runner
// (`node --test`) can run directly; "whole-command" is anything else, run through the whole
// `config.gates.commit` (see "the whole-command fallback" below); null is nothing to run it with.
// Shared by both revert-test variants below — the only difference between them is how their tree
// came to hold the file and what state its implementation is in when it runs.
function runnerFor(relPath, cfg) {
  if (/\.(m?js|c?js)$/.test(relPath)) return 'node';
  if (cfg.gates && cfg.gates.testFile) return 'test-file';
  if (cfg.gates && cfg.gates.commit) return 'whole-command';
  return null;
}

const NO_RUNNER_NOTE = 'no runner available (not a node test file, and neither gates.testFile nor gates.commit configured)';

// Every runner here executes whatever the branch or the repository configured, on a landing that may
// be running detached with nothing waiting on it, so each runs under the same ceiling the gate
// command does. A run that reaches it is not a pass — it is a run that told us nothing.
function stoppedNote(cfg) {
  return `did not finish within ${Math.round(gateTimeout(cfg) / 1000)}s and was stopped — a test run that hangs proves nothing; raise the limit with: horde.mjs config set gateTimeoutMs <milliseconds>`;
}

// Runs one already-materialised node test file in `tmp` and reports whether it's red.
function runNodeTestFile(tmp, relPath, cfg) {
  const out = runCapture('node', ['--test', relPath], {
    cwd: tmp, env: childTestEnv(), timeout: gateTimeout(cfg), killSignal: 'SIGTERM',
  });
  if (out === null) return { path: relPath, ok: false, note: stoppedNote(cfg) };
  const summary = parseNodeTestSummary(out);
  return { path: relPath, ok: (summary.fail ?? 0) > 0, note: `${summary.fail ?? '?'} fail / ${summary.tests ?? '?'} tests` };
}

// Runs one already-materialised test file in `tmp` through `config.gates.testFile` — a command with
// `{file}` standing for the file's path — for a file `node --test` cannot run and the commit gate does
// not run either (an end-to-end spec under a runner of its own). Red is proof and green is not, as for a
// node test file; but a command that never ran — the shell's 126 and 127, "not executable" and "not
// found" — is red for the wrong reason, so it is no verdict, never proof.
function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function runTestFileCommand(tmp, relPath, cfg) {
  const command = String(cfg.gates.testFile).replace(/\{file\}/g, () => shellQuote(relPath));
  try {
    execSync(command, {
      cwd: tmp, env: childTestEnv(), stdio: 'pipe', timeout: gateTimeout(cfg), killSignal: 'SIGTERM',
    });
    return { path: relPath, ok: false, note: 'gates.testFile green with it in place — the test passes here, so it proves nothing about the change' };
  } catch (e) {
    if (e.killed === true || e.signal === 'SIGTERM') return { path: relPath, ok: false, note: `gates.testFile ${stoppedNote(cfg)}` };
    const code = typeof e.status === 'number' ? e.status : null;
    if (code === 126 || code === 127) {
      const detail = ((e.stderr ? e.stderr.toString() : '') || '').trim().split('\n')[0];
      return { path: relPath, ok: false, noVerdict: true, note: `no verdict — gates.testFile could not run (exit ${code})${detail ? `: ${detail}` : ''}` };
    }
    return { path: relPath, ok: true, note: `gates.testFile red (exit ${code === null ? `signal ${e.signal}` : code}) with it in place` };
  }
}

// Runs one already-materialised test file with the runner `runnerFor` chose for it.
function runTestFile(tmp, relPath, runner, cfg) {
  return runner === 'test-file' ? runTestFileCommand(tmp, relPath, cfg) : runNodeTestFile(tmp, relPath, cfg);
}

// Sets one test file in a scratch tree to `content` — or takes it out, for null — and hands back
// what the tree held there before, in the same shape, so the same call puts it back. Every file the
// revert test puts into a tree or takes out of one goes through here, so anything a runner needs
// done around that has one place to go.
//
// The index goes with the tree. A runner that works off the index — a pre-commit hook, lint-staged,
// anything asking `git diff --cached` — finds nothing to run when a file is only sitting in the
// working tree and exits 0, which reads as a green run that proves nothing and refuses every real
// test as "not load-bearing". So the file is added to the index the moment it is written, and taken
// out of it the moment it is removed, exactly as the tree says.
function setTestFile(tmp, relPath, content) {
  const abs = join(tmp, relPath);
  const before = existsSync(abs) ? readFileSync(abs) : null;
  if (content === null) {
    rmSync(abs, { force: true });
    git(['rm', '-q', '--cached', '--ignore-unmatch', '--', relPath], tmp);
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    git(['add', '-f', '--', relPath], tmp);
  }
  return before;
}

// ---- the whole-command fallback ------------------------------------------------------------------
//
// A test file `node --test` cannot run is run through the repository's whole `config.gates.commit`,
// because isolating one file's lane out of an arbitrary configured command is not possible in
// general. But a whole command's red is not that file's red, and its green is not that file's green.
// The command can be red before the file is anywhere near it — a test nobody touched failing, an
// environment that is not there — and a runner can skip a file it cannot load and still exit 0.
// Read straight off the exit code, the first is proof nobody earned and the second a "not
// load-bearing" verdict on a test that never ran. So the exit code alone decides nothing:
//
// - A control run comes first: the same tree holding none of the ticket's own test files — the
//   base exactly as it stands, for the revert-to-base variant; the mutated tree with them taken
//   out, for the mutation one. Red or stopped there, no file gets a verdict: its red with the file
//   in place would say nothing about the file.
// - Then each file on its own: put in, run, taken out again, so no file's red is another file's.
// - Red with the file in place and green without it is proof — the control-run rule.
// - `config.gates.report` names the report of the landing gate's own command, and `gates.commit`
//   may or may not write the same file. So it is read here only when this run produced it: the path
//   is cleared before every run, and a file there afterwards is this run's. Produced, it must
//   attribute at least one failing case to the file for a red to count — a red with none of the
//   file's own cases failing came from somewhere else — and a produced report that cannot be read is
//   "no verdict". Not produced (or not configured, or configured where no file can be looked for),
//   the control-run rule alone decides, and the result says no report was available. A report
//   configured for the landing gate and not written here therefore never refuses a run the same
//   repository without one would pass; only a report this run wrote can add a refusal, by showing
//   that a red was not the file's own or by being unreadable.
// - Green is never proof. With a produced report showing every case from the file ran and passed,
//   it is the one "not load-bearing" verdict there is. With nothing from the file in that report it
//   is a file the runner never ran, and with no report available it cannot tell those two apart:
//   both are "no verdict", never a verdict.
//
// "No verdict" refuses the item exactly as a failure does — nothing lands without proof — and the
// item names the ways out of it (NO_VERDICT_WAYS_OUT), because what gets fixed is the run, not the
// test.
//
// The cost is one more `gates.commit` run per landing, and only for a ticket carrying a file that
// needs this fallback at all.

const NO_VERDICT_WAYS_OUT = 'ways out of "no verdict": make gates.commit green on the base without the file; name a revert base where it is green ("**Revert base:** <ref>"); give the ticket a "**Mutate:**" command that only this file catches; or set gates.testFile to a command that runs one test file ({file} stands for its path)';

// Where the fallback looks for a report `gates.commit` may have produced, and in what format — or
// why there is nowhere to look. A path is only ever one gateReportConfig accepted as staying inside
// the tree; a format it refused still leaves that path to look at, so a file produced there is
// reported as unreadable rather than silently ignored.
function fallbackReport(cfg) {
  const conf = gateReportConfig(cfg);
  if (!conf.configured) return { path: null, unavailable: 'no config.gates.report is set' };
  if (!conf.path) return { path: null, unavailable: conf.error };
  return { path: conf.path, format: conf.error ? null : conf.format, error: conf.error || null };
}

// One run of `gates.commit` in `tmp`. The report path is cleared first, so a file there afterwards
// can only be what this run wrote — never one an earlier run, or the base itself, left there.
function runWholeCommand(tmp, cfg, report) {
  if (report.path) rmSync(join(tmp, report.path), { force: true, recursive: true });
  let result;
  try {
    execSync(cfg.gates.commit, { cwd: tmp, stdio: 'pipe', timeout: gateTimeout(cfg) });
    result = { green: true, stopped: false };
  } catch (e) {
    result = { green: false, stopped: e.killed === true || e.signal === 'SIGTERM' };
  }
  result.produced = Boolean(report.path) && existsSync(join(tmp, report.path));
  return result;
}

// `files` are `{path, content}` — the ticket's own version of each file to run — and the tree they
// are run in holds none of the ticket's test files when this is called; `treeName` says which tree
// that is, in the words every note uses.
function runWholeCommandFallback(tmp, cfg, files, treeName) {
  const report = fallbackReport(cfg);
  const control = runWholeCommand(tmp, cfg, report);
  return files.map(({ path, content }) => {
    if (control.stopped) {
      return { path, ok: false, noVerdict: true, note: `no verdict — the control run of gates.commit on ${treeName} without ${path} ${stoppedNote(cfg)}` };
    }
    if (!control.green) {
      return { path, ok: false, noVerdict: true, note: `no verdict — gates.commit is already red on ${treeName} without ${path}, so its red with the file in place would say nothing about the file` };
    }
    const before = setTestFile(tmp, path, content);
    try {
      return wholeCommandVerdict(tmp, cfg, path, runWholeCommand(tmp, cfg, report), report, treeName);
    } finally {
      setTestFile(tmp, path, before);
    }
  });
}

// What one run with the file in place proves, read after a green control run.
function wholeCommandVerdict(tmp, cfg, path, run, report, treeName) {
  const noVerdict = (why) => ({ path, ok: false, noVerdict: true, note: `no verdict — ${why}` });
  if (run.stopped) return { path, ok: false, note: `gates.commit ${stoppedNote(cfg)}` };
  const inPlace = run.green
    ? 'gates.commit green with it in place'
    : `gates.commit red with it in place, green on ${treeName} without it`;

  if (!run.produced) {
    const unavailable = report.path
      ? `no report was available — config.gates.report names ${report.path}, and gates.commit did not write it in this run`
      : `no report was available — ${report.unavailable}`;
    if (!run.green) return { path, ok: true, note: `${inPlace} (whole command, no test-only isolation; ${unavailable})` };
    return noVerdict(`${inPlace}, and ${unavailable}, so nothing shows whether the runner ran it — a file it skipped and a test that proves nothing look the same`);
  }

  if (report.error) return noVerdict(`${inPlace}, and it wrote ${report.path}, which cannot be read: ${report.error}`);
  let text;
  try {
    text = readFileSync(join(tmp, report.path), 'utf8');
  } catch (e) {
    return noVerdict(`${inPlace}, and it wrote ${report.path}, which cannot be read: ${e.code || e.message}`);
  }
  const parsed = parseReport(text, report.format);
  if (parsed.error) return noVerdict(`${inPlace}, and it wrote ${report.path}, which does not read as ${report.format} — ${parsed.error}`);
  const cases = casesAttributedTo(parsed.entries, path);
  const failed = cases.filter((e) => e.status === 'failed');
  const skipped = cases.filter((e) => e.status === 'skipped');
  if (!run.green) {
    if (failed.length) return { path, ok: true, note: `${inPlace}, and ${failed.length} failing case(s) from it in ${report.path} ("${failed[0].name}")` };
    if (!cases.length) return noVerdict(`${inPlace}, but nothing in ${report.path} is attributed to ${path}, so the red is not shown to be its own`);
    return noVerdict(`${inPlace}, but every case from it in ${report.path} ${skipped.length ? 'passed or was skipped' : 'passed'} — the red came from somewhere else`);
  }
  if (!cases.length) return noVerdict(`${inPlace}, and nothing in ${report.path} is attributed to ${path} — the runner never ran it, so this says nothing about whether it is load-bearing`);
  if (failed.length) return noVerdict(`${inPlace}, yet ${report.path} has "${failed[0].name}" from it failed — an exit code and a report that disagree prove nothing`);
  if (skipped.length) return noVerdict(`${inPlace}, and ${skipped.length} of ${cases.length} case(s) from it in ${report.path} were skipped, not run`);
  return { path, ok: false, note: `${inPlace}, and all ${cases.length} case(s) from it in ${report.path} ran and passed on ${treeName} — not load-bearing` };
}

// The whole revert-test note for one variant: each file's own result, and — when any of them is "no
// verdict" — the ways out of it, said once.
function revertTestNote(prefix, results) {
  const body = results.map((r) => `${r.path}: ${r.note}`).join(' · ');
  return `${prefix}${body}${results.some((r) => r.noVerdict) ? ` — ${NO_VERDICT_WAYS_OUT}` : ''}`;
}

// The revert-to-base variant (today's default, unchanged): new test files extracted onto the
// revert base's tip (the parent branch, unless the ticket names another ref — see revertBaseRef)
// in a scratch worktree, and run there; each must show at least one failure, since a new test
// that already passes on its base proves nothing. A file only `gates.commit` can run must also show
// that failure is its own — see "the whole-command fallback" above.
function runRevertToBaseVariant(root, cfg, branch, parentBranch, base, newTestFiles) {
  const baseSha = git(['rev-parse', '--verify', `${base}^{commit}`]);
  if (!baseSha) return { ok: false, note: `revert base not found: ${base}` };

  const info = resolveTree({ scratch: baseSha }, { cwd: root });
  const tmp = info.path;
  const byPath = new Map();
  try {
    const extracted = [];
    for (const relPath of newTestFiles) {
      const content = gitBlob(`${branch}:${relPath}`, root);
      if (content === null) byPath.set(relPath, { path: relPath, ok: false, note: 'could not extract from branch' });
      else extracted.push({ path: relPath, content, runner: runnerFor(relPath, cfg) });
    }
    // The whole-command fallback first, while the base still holds none of the branch's test files
    // — its control run is that base, and each of its files goes back out once it has run.
    const fallback = extracted.filter((f) => f.runner === 'whole-command');
    if (fallback.length) {
      for (const r of runWholeCommandFallback(tmp, cfg, fallback, 'the base')) byPath.set(r.path, r);
    }
    for (const f of extracted) {
      if (f.runner === 'whole-command') continue;
      if (f.runner === null) { byPath.set(f.path, { path: f.path, ok: false, note: NO_RUNNER_NOTE }); continue; }
      setTestFile(tmp, f.path, f.content);
      byPath.set(f.path, runTestFile(tmp, f.path, f.runner, cfg));
    }
  } finally {
    cleanupTree(info, root);
  }
  const results = newTestFiles.map((relPath) => byPath.get(relPath));
  const ok = results.every((r) => r.ok);
  const baseNote = base === parentBranch ? '' : `base ${base} — `;
  return { ok, note: revertTestNote(baseNote, results) };
}

// The mutation variant (the ticket's own "**Mutate:**" command): rather than proving the new
// tests are red before the ticket, this proves they're red once the ticket's own implementation
// is deliberately broken. The command runs in a scratch copy of the branch's own tip — never the
// tree any other checklist item measures, so a broken implementation here can't leak into the
// gate or the graph item that run afterwards — and every new test file (already present in that
// tree, since it's the branch's own tip; nothing needs extracting) must go red once it has run — a
// file only `gates.commit` can run, red in a way the whole-command fallback above accepts as its own.
//
// A command that itself fails to run is reported as its own failure rather than silently treated
// as "no mutation happened, so of course the tests are still green" — a mutate command naming the
// wrong path or a syntax the shell can't run is an authoring error worth surfacing by name, not a
// red the tests happened to produce on their own.
function runMutateVariant(root, cfg, branch, parentBranch, mutate, newTestFiles) {
  const branchSha = git(['rev-parse', '--verify', `${branch}^{commit}`]);
  if (!branchSha) return { ok: false, note: `branch not found: ${branch}` };

  const info = resolveTree({ scratch: branchSha }, { cwd: root });
  const tmp = info.path;
  try {
    // The tree is the branch's own tip, so a runner that works off the index would find nothing
    // staged — the tip is committed. HEAD goes back to where the ticket began and the index stays at
    // the tip: the ticket's whole change is staged, as it would be one commit before it lands, and the
    // working tree (the mutation goes there) is untouched.
    const forkPoint = git(['merge-base', parentBranch, branchSha], root);
    if (forkPoint) git(['reset', '-q', '--soft', forkPoint], tmp);
    try {
      execSync(mutate, { cwd: tmp, stdio: 'pipe', timeout: gateTimeout(cfg) });
    } catch (e) {
      if (e.killed === true || e.signal === 'SIGTERM') {
        return { ok: false, note: `mutate command did not finish within ${Math.round(gateTimeout(cfg) / 1000)}s and was stopped: ${mutate} — raise the limit with: horde.mjs config set gateTimeoutMs <milliseconds>` };
      }
      const detail = ((e.stderr ? e.stderr.toString() : '') || e.message || '').split('\n')[0];
      return { ok: false, note: `mutate command failed to run: ${mutate}${detail ? ` — ${detail}` : ''}` };
    }
    const byPath = new Map();
    const fallback = newTestFiles.filter((relPath) => runnerFor(relPath, cfg) === 'whole-command');
    if (fallback.length) {
      // Every one of the ticket's own test files out of the mutated tree for the fallback's control
      // run — a node test catching the mutation is not a fallback file's red either — then each
      // fallback file back in on its own, and all of them back once that is done.
      const held = newTestFiles.map((relPath) => ({ path: relPath, content: setTestFile(tmp, relPath, null) }));
      const runnable = [];
      for (const h of held) {
        if (!fallback.includes(h.path)) continue;
        if (h.content === null) byPath.set(h.path, { path: h.path, ok: false, note: 'not in the mutated tree — the mutate command removed it, so there is nothing to run' });
        else runnable.push(h);
      }
      if (runnable.length) {
        for (const r of runWholeCommandFallback(tmp, cfg, runnable, 'the mutated tree')) byPath.set(r.path, r);
      }
      for (const h of held) if (h.content !== null) setTestFile(tmp, h.path, h.content);
    }
    for (const relPath of newTestFiles) {
      if (byPath.has(relPath)) continue;
      const runner = runnerFor(relPath, cfg);
      byPath.set(relPath, runner === 'node' || runner === 'test-file'
        ? runTestFile(tmp, relPath, runner, cfg)
        : { path: relPath, ok: false, note: NO_RUNNER_NOTE });
    }
    const results = newTestFiles.map((relPath) => byPath.get(relPath));
    const ok = results.every((r) => r.ok);
    return { ok, note: revertTestNote(`mutate \`${mutate}\` — `, results) };
  } finally {
    cleanupTree(info, root);
  }
}

// New or changed test files (git-added or git-modified, matching config.testGlobs), checked
// against whichever variant the ticket itself asks for — the mutation one when it carries a
// "**Mutate:**" command, the revert-to-base one (today's default, unchanged) otherwise. A modified
// existing test file is treated the same as a new one: its content on the branch is extracted onto
// the revert base exactly like a new file's, and must show a failure there too — a change to an
// existing test's assertions proves nothing about the code it now checks if it already passed on
// the base unmodified. The variant is always the ticket's own choice, never a land.mjs flag.
//
// The result is derived here, by running the tests: nothing anywhere declares to this gate
// whether either variant failed, passed, or was not run, and no flag offers to say so. A
// declaration about a test is not evidence about a test.
//
// Unless the charter has already ruled that this mission has no evidence layer at all — then none
// of that runs, and this item is exempted outright. See the check at the top of the function.
function checkRevertTest(horde, root, cfg, branch, parentBranch, files, issueText) {
  // A mission whose charter has already judged "no evidence layer" answers this item with that
  // judgment, not with the test-file question it doesn't apply to. config.testGlobs is empty on
  // exactly this kind of repository BY CONSTRUCTION — the same emptiness the charter's reading is
  // made from — so refusing on it, or asking for a per-ticket "**No new tests:**" excuse, would be
  // asking a question this mission has already answered "there is nothing here to point at" to.
  // Checked first, before anything else below, so a mission that has made this judgement never
  // reaches any of it — not the testGlobs guard, not the declaration, not even the --mutate /
  // --revert-base conflict guard immediately below.
  const noEvidenceLayer = noEvidenceLayerNote(horde);
  if (noEvidenceLayer) return { ok: true, note: noEvidenceLayer };

  const mutate = mutateCommand(issueText);
  const explicitBase = revertBaseRef(issueText);
  // A ticket naming both answers two different questions with one field each — "where were these
  // tests already known to fail" (revertBase) and "what breaks the implementation they catch"
  // (mutate) — and only one of them actually runs. tk.mjs new already refuses this combination at
  // creation; this is the defense-in-depth twin for a ticket that reached land.mjs with both set
  // some other way (a hand-edited issue.md, most likely), so the ambiguity is never resolved by
  // silently picking a winner.
  if (mutate && explicitBase) {
    return {
      ok: false,
      note: `ticket names both --mutate and a revert base (${explicitBase}) — only one revert-test variant runs, so the other would be silently ignored. Drop whichever this ticket doesn't mean`,
    };
  }
  // "No new test files in this diff" is only a result when the patterns this repository's tests
  // are named with are actually known. Without them the same ✓ would mean "I did not look", so
  // this refuses instead, and names the one setting that fixes it.
  const testGlobs = Array.isArray(cfg.testGlobs) ? cfg.testGlobs.filter(Boolean) : [];
  if (testGlobs.length === 0) {
    return {
      ok: false,
      note: 'cannot recognise a test file in this repository — config.testGlobs is unset, so "no new tests in the diff" would mean "not looked", not "none". Name the patterns this repository\'s tests are written under: horde.mjs config set testGlobs "<glob>,<glob>"',
    };
  }
  const nameStatus = diffPaths(['diff', '--name-status', `${parentBranch}...${branch}`])
    .map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.join('\t') }; });
  const newTestFiles = nameStatus
    .filter((e) => (e.status === 'A' || e.status === 'M') && files.includes(e.path))
    .filter((e) => testGlobs.some((g) => globToRegExp(g).test(e.path)))
    .map((e) => e.path);

  if (newTestFiles.length === 0) {
    const reason = noNewTestsReason(issueText);
    if (reason) {
      return { ok: true, note: `no new or changed test files in diff — declared no-new-tests: ${reason}` };
    }
    return {
      ok: false,
      note: `no new or changed test files in diff (looked for ${testGlobs.join(', ')}) — a change that adds none must say so: declare "**No new tests:** <reason>" in issue.md`,
    };
  }

  if (mutate) return runMutateVariant(root, cfg, branch, parentBranch, mutate, newTestFiles);
  return runRevertToBaseVariant(root, cfg, branch, parentBranch, explicitBase || parentBranch, newTestFiles);
}

// The repository's own gate command, run fresh on the branch's own tree. No recorded green run is
// accepted from anywhere: a "**Gate:** green at sha …" line in a ticket's log is a claim about a
// run this gate did not see, which is exactly the kind of second-hand evidence this command exists
// to stop taking — checkGate itself never reads the cache recordGateCache writes, only ever
// measures fresh and hands back what it found, keyed to `branchSha`: the ticket branch's own tip,
// the tree actually under test here.
//
// That is not the sha a landing that succeeds leaves recorded, though. `run()` merges this tree in
// with `--no-ff`, always — even a clean, fast-forwardable merge — so the commit that lands on the
// parent branch is a new object, its own sha, distinct from `branchSha` by construction (it carries
// two parents; nothing is ever its own parent). The tree the gate just measured and the tree that
// commit carries are identical either way, so once the merge names that sha, that — not
// `branchSha` — is what recordGateCache is called with: the one a later `git rev-parse` of the
// parent branch will actually produce, and so the one `horde.mjs done` and `wave.mjs close` can
// match against without re-running anything.
//
// A command that hangs is not a verdict either, so the run carries a timeout and says so rather
// than leaving a stuck process behind a checklist that never finishes. A stopped command is the
// end of the item — nothing below it is asked anything, the report a half-finished run left
// behind least of all.
//
// The exit code is only half of what this item measures. The other half is the report that
// command's own test runner wrote, when `config.gates.report` names one: a green exit code says
// the command finished, never that a promise's own case ran. See "the gate's own report" further
// down for that half.
const GATE_TIMEOUT_MS = 15 * 60 * 1000;
function gateTimeout(cfg) {
  const asked = Number(cfg && cfg.gateTimeoutMs);
  return Number.isFinite(asked) && asked > 0 ? asked : GATE_TIMEOUT_MS;
}

function checkGate(cfg, level, worktree, branchSha, noGate) {
  if (noGate) return { ok: true, note: 'skipped (--no-gate)', cache: null };
  const cmd = cfg.gates && cfg.gates[level];
  if (!cmd) {
    return {
      ok: false,
      note: `no config.gates.${level} configured — a gate with no command is not a green gate. Set it: horde.mjs config set gates.${level} "<command>"`,
    };
  }
  const timeout = gateTimeout(cfg);
  let green = true;
  let out = '';
  let timedOut = false;
  try {
    out = execSync(cmd, { cwd: worktree, stdio: 'pipe', timeout }).toString();
  } catch (e) {
    green = false;
    timedOut = e.killed === true || e.signal === 'SIGTERM';
    out = ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || '');
  }
  if (timedOut) {
    return {
      ok: false,
      note: `the gate command did not finish within ${Math.round(timeout / 1000)}s and was stopped (${cmd}) — a command that hangs is not a green gate. Raise the limit with: horde.mjs config set gateTimeoutMs <milliseconds>`,
      cache: { sha: branchSha, result: 'red', count: null },
    };
  }
  const summary = parseNodeTestSummary(out);
  // The command's exit code is one half of this item; what its own runner recorded is the other.
  // Read whether the command was green or red, because a report can name a skipped case under a
  // command that exited 0 — which is the whole reason this half exists. See "the gate's own
  // report" below for the config surface, the three formats and the two matching rules; with no
  // `config.gates.report` it reads nothing, refuses nothing, and says so rather than letting a
  // green exit code pass for a run nobody confirmed.
  const report = gateReportVerdict(cfg, worktree);
  const ok = green && report.ok;
  return {
    ok,
    note: `${green ? 'green' : 'red'} (${cmd}) — ${report.note}`,
    cache: { sha: branchSha, result: ok ? 'green' : 'red', count: summary.tests },
  };
}

// Writes a gate measurement to the same file horde.mjs's `done` and wave.mjs's `close` read
// (hordes/<horde>/cache/last-gate.json), keyed by the same level name ("team" or "trunk") land.mjs
// itself ran the gate command under — so a `done` or a `close` right after a landing reads exactly
// what that landing measured, instead of finding nothing there and either re-running the whole gate
// on a tree it was already run on, or reporting the gate as unrecorded. Called from run() only once
// a landing has actually merged, with `cache.sha` already corrected to the sha that merge produced
// (see checkGate's own comment for why that is never `branchSha`).
//
// This is never called from inside the gate-lock critical section above — the sha it needs to write
// does not exist until after that section's own lock has released and the merge it protects nothing
// of has completed — so it is not one continuous critical section with the measurement. It still
// takes that same lock itself, briefly, around its own read-modify-write: two landings finishing at
// once, each merging its own tree onto its own parent, would otherwise still race the exact
// lost-update this file is one shared document for — whichever of the two writes last would erase
// the other's entirely, cache entry and all, rather than merging the two into one file that carries
// both.
function recordGateCache(horde, level, cache, ticketId, branch, cfg) {
  const lock = acquireGateLock(ticketId, branch, { waitMs: lockWait(cfg) });
  // Best-effort: the ticket is already landed by the time this runs — a lock this contended (every
  // other landing on the repository holding it past its own wait) is not a reason to report an
  // already-merged ticket as failed over a cache entry that a later `done` or `close` can still get
  // by running the gate fresh, exactly as either would have before this existed.
  if (!lock.ok) return;
  try {
    const path = hordePath(horde, 'cache', 'last-gate.json');
    const existing = readJSON(path, {});
    writeJSON(path, { ...existing, [level]: { ...cache, at: nowIso(), by: `land ${ticketId}` } });
  } finally {
    lock.release();
  }
}

// The graph gate. The node map IS the Yggdrasil graph, so the graph is what says the code is
// right and `yg check` is the only thing that reads it — it runs on every landing whatever
// `config.gates` holds, and a graph that refuses the tree is a refused merge.
//
// The item runs in two halves, because the two costs are different. The free half —
// `yg check --approve --only-deterministic` — records every verdict a script can reach, in any
// worktree, with no key and no judgement, and is always allowed. What it leaves is the prose
// rules, which only Yggdrasil's configured reviewer judges. So the item names those pairs rather
// than approving them, and it is ✓ only when a full `yg check` is green; the judge item says who
// owes them.
function checkGraph(cfg, worktree, noGate) {
  const display = ygCommand(cfg).display;
  if (noGate) return { ok: true, note: `skipped (--no-gate) — \`${display} check\` was not run` };

  const filled = fillDeterministic(cfg, worktree);
  if (!filled.available) {
    return {
      ok: false,
      note: `cannot run \`${filled.command}\` — the graph's own verdict is part of the gate; install the Yggdrasil CLI, or point config.ygCommand at it (horde.mjs config set ygCommand "node path/to/bin.js")`,
    };
  }
  // A half that was stopped at its ceiling ends the item here, rather than falling through to ask
  // the same wedged command the same question again (the full check, read as its document) and
  // spending a ceiling on each. One stop is the answer; a red graph is a red gate.
  if (filled.timedOut) return { ok: false, note: `\`${filled.command}\` — ${filled.out}` };

  const res = runYgCheck(cfg, worktree);
  if (res.ok) return { ok: true, note: `${res.command} green${res.summary ? ` — ${res.summary}` : ''}` };
  if (res.timedOut) return { ok: false, note: `\`${res.command}\` — ${res.summary}` };

  const pending = pendingProsePairs(cfg, worktree, res);
  if (pending.scriptPending.length) {
    // The free half did not take — a graph the CLI refuses to fill at all, most often because a
    // judgement rule has no judge configured. Nobody should be sent to read a script rule, so the
    // item hands over the CLI's own words instead of naming pairs it cannot classify.
    return {
      ok: false,
      note: `${filled.command} left ${pending.scriptPending.length} script rule(s) with no verdict — `
        + `the free half did not take, and until it does nothing else about the graph can be judged:\n${filled.out.trim()}`,
    };
  }
  if (pending.pairs.length) {
    const named = pending.pairs.map((p) => `${p.aspect} on ${p.unitKind}:${p.unit}`);
    // Whether the pending judgements are ALL this graph says is wrong: every blocking finding is one
    // of those pairs, and none of them is waiting on a reviewer that does not exist. Only then is a
    // red graph nothing but verdicts to refresh — what a catch-up merge leaves behind when it moves
    // the code a verdict was recorded over (see run()'s "rejudge").
    const errors = asArray(res.doc && res.doc.issues).filter((i) => i && i.severity === 'error');
    const onlyProsePending = errors.length > 0 && errors.every((i) => i.aspect && i.cause !== 'reviewer-missing'
      && pending.pairs.some((p) => p.aspect === i.aspect && `${p.unitKind}:${p.unit}` === i.unit));
    return {
      ok: false,
      pending: pending.pairs,
      onlyProsePending,
      note: `${res.command} exited ${res.exit} — the script rules are recorded (free, no key), and `
        + `${named.length} prose rule(s) still wait on a judgement: ${named.join(' · ')}`,
    };
  }
  return {
    ok: false,
    note: `${res.command} exited ${res.exit} — the graph refuses this tree${res.summary ? `: ${res.summary}` : ''}; a red graph is a red gate, whatever the level's gate command said`,
  };
}

// Whether the prose rules are judged. They have one judge: the reviewer configured inside
// Yggdrasil, through `yg check --approve`, which a worker runs before committing (and the commit
// hook, where there is one). The graph item already found any pair still waiting — that answer
// reaches `--json` through it — so this item reads it and names the one way out: the reviewer,
// or configuring one where the repository has none. Nothing else may judge a prose rule.
function checkJudge(cfg, worktree, graphItem, noGate) {
  if (noGate) return { ok: true, note: 'skipped (--no-gate) — no prose rule was checked' };
  const pending = asArray(graphItem && graphItem.pending);
  if (pending.length === 0) {
    return { ok: true, pairs: [], note: 'no prose rule on this tree is waiting on the reviewer' };
  }
  const named = pending.map((p) => `${p.aspect} on ${p.unitKind}:${p.unit}`).join(' · ');
  const display = ygCommand(cfg).display;
  return {
    ok: false,
    pairs: pending,
    note: hasReviewer(worktree)
      ? `${pending.length} prose rule(s) have no verdict from this repository's reviewer: ${named}. Run \`${display} check --approve\` on the branch and commit what it records, then land again`
      : `${pending.length} prose rule(s) have no verdict, and this repository has no Yggdrasil reviewer to give one: ${named}. `
        + 'Prose rules are judged by that reviewer only — configure one (yg init --provider <claude-code|codex|copilot-cli|…> --model <model>), run `yg check --approve`, then land again',
  };
}

// The graph is plan-agnostic: a node's charter and log say what the node is and what must stay
// true, never which wave, ticket or mission touched it. Mission language in committed graph text
// is the working state of one horde leaking into a document every later reader treats as
// permanent. Deterministic on purpose: the words below are the ones that only a plan uses.
const MISSION_WORDS = [
  [/\bwave\b/i, 'wave'],
  [/\bticket\s*\d{3}\b/i, 'ticket NNN'],
  [/\bmission\b/i, 'mission'],
  [/\bhorde\b/i, 'horde'],
  [/\bE\d+\b/, 'E<n> evidence id'],
  [/\.temp\//, '.temp/ path'],
];
export function missionWordsIn(text) {
  const hits = [];
  for (const [re, label] of MISSION_WORDS) if (re.test(String(text || ''))) hits.push(label);
  return hits;
}
const GRAPH_TEXT = /^\.yggdrasil\/model\/.*\/(charter|log)\.md$/;
function checkGraphText(root, branch, parentBranch, changedFiles) {
  const findings = [];
  for (const f of changedFiles.filter((x) => GRAPH_TEXT.test(x))) {
    const text = git(['show', `${branch}:${f}`], root);
    const hits = missionWordsIn(text);
    if (hits.length) findings.push(`${f}: ${hits.join(', ')}`);
  }
  const messages = (git(['log', '--format=%s', `${parentBranch}..${branch}`], root) || '').split('\n').filter((m) => /^graph:/i.test(m));
  for (const msg of messages) {
    const hits = missionWordsIn(msg);
    if (hits.length) findings.push(`commit "${msg}": ${hits.join(', ')}`);
  }
  return {
    ok: findings.length === 0,
    note: findings.length === 0
      ? 'charters, logs and graph commits carry no mission language'
      : `mission language in graph text — ${findings.join(' · ')} (say what the node is and what must stay true; the wave, the ticket and the horde belong in .horde/)`,
  };
}

// A file the graph owns nowhere passes `yg check` in a repository that requires coverage of
// nothing, so a new folder can land with its mapping forgotten and only the next reader finds a
// node with no files. The mapping belongs in the same commit as the first file — this asks the
// graph, on the branch's own tree, who owns every file the branch added. Yggdrasil names three
// owners, and only one of them is a forgotten mapping: a node owns the file, or its architecture
// type covers it (coverage.type_level), or nothing does — and of those, a file the coverage config
// excludes by design is one Yggdrasil says cannot and need not be mapped. Only `none` for any
// other reason, or a file the graph could not answer about at all, is refused here.
export function unmappedFiles(contextByFile) {
  const out = [];
  for (const [file, doc] of contextByFile) {
    const owner = doc && doc.owner;
    const kind = owner && owner.kind;
    if (kind === 'node' || kind === 'type') continue;
    if (kind === 'none' && owner.reason === 'excluded') continue;
    out.push(file);
  }
  return out;
}
function checkMapping(cfg, worktree, addedFiles, noGate) {
  if (noGate) return { ok: true, note: 'skipped (--no-gate) — the graph was not asked who owns the added files' };
  const graphOwn = /^\.yggdrasil\//;
  const candidates = addedFiles.filter((f) => !graphOwn.test(f));
  if (candidates.length === 0) return { ok: true, note: 'no files added outside the graph' };
  if (!ygAvailable(cfg, worktree)) return { ok: false, note: 'the Yggdrasil CLI cannot be run, so the graph cannot say who owns the added files' };
  const contexts = new Map(candidates.map((f) => [f, ygFileContext(worktree, cfg, f)]));
  const unmapped = unmappedFiles(contexts);
  if (unmapped.length === 0) return { ok: true, note: `${candidates.length} added file(s), every one owned by a node, covered by its type, or excluded from coverage by design` };
  const shown = unmapped.slice(0, 5).join(', ') + (unmapped.length > 5 ? '…' : '');
  return {
    ok: false,
    note: `${unmapped.length} added file(s) no node owns: ${shown} — map them in the owning node's yg-node.yaml in this same branch; a mapping and its first file land together`,
  };
}

function checkJournal(text, branch, parentBranch) {
  const lastEntry = latestTimestamp(text);
  // The last commit THIS TICKET's worker made. A merge of the parent into the branch, which this tool
  // makes when the parent moved while the ticket waited, changes nothing the worker did — and neither
  // do the commits that merge brings in: other tickets landed on the parent after this one's log was
  // written. Reading the newest commit reachable from the branch counted those, and refused a ticket
  // for a log "older" than somebody else's work. So only the branch's own commits are read.
  const commitDate = git(['log', '-1', '--no-merges', '--format=%cI', `${parentBranch}..${branch}`]);
  const commitTime = commitDate ? new Date(commitDate) : null;
  if (!lastEntry) return { ok: false, note: 'no log entry found' };
  if (!commitTime) return { ok: false, note: `could not read the last commit on ${branch}` };
  const ok = lastEntry.getTime() >= commitTime.getTime();
  return {
    ok,
    note: ok
      ? `log entry ${lastEntry.toISOString()} ≥ last commit ${commitTime.toISOString()}`
      : `log entry ${lastEntry.toISOString()} predates last commit ${commitTime.toISOString()}`,
  };
}

// ---- the client's answers ------------------------------------------------------------
//
// decisions.md is the mission's own record of what was put to the client and what came back.
// ask.mjs (019) is the only writer — "ask add --kind lower --aspect <a>" opens the question, "ask
// answer <id> "<answer>" [--scope once|mission]" records it, under slug "ask-<id>"; nothing here
// writes to the file except the one line that marks a once-only answer used up.
//
// One block per ask: decide.mjs's own heading, then one line of bold fields and the question and
// answer, exactly what ask.mjs's answerAsk builds:
//
//   ## 2026-09-11 · ask-a-007
//
//   **Kind:** lower · **Aspect:** no-marker · **Scope:** once
//   **Question:** deleting this rule weakens what the mission is judged by.
//   **Answer:** approved — superseded by the type-level check.
//   **By:** client · **At:** 2026-09-11T09:00:00Z
//
// The fields below are read out of the block regardless of what the heading says — this guard has
// never cared about the heading itself, only decide.mjs's own duplicate-slug check needs it, which
// is why the document's parser hands back every block and not just the ones whose heading reads as
// an entry. Kind is "lower" for anything the branch weakens; Aspect names the one thing being
// weakened, and the guards below match on it exactly as it is written: a rule's own id for the law
// guard, "evidence:<promise id>" or "evidence:<test file path>" for the evidence guard, and
// "gate:<path>" for the gate guard. One answer lets one thing through and never a category. Scope
// is "once" (used up by one landing, and this file records which) or "mission" (stands until the
// mission closes). An ask with no Answer is still open and passes nothing.
//
// The conflict-of-interest guard further down (conflictGuard) has no exception of its own: a
// branch that sharpens a rule and changes the code that rule reaches, in one landing, is refused
// every time — there is no ask kind that waives it and none is coming. The refusal's own message
// says what to do instead: split the rule and the code into two landings.
function decisionsPath(horde) { return hordePath(horde, 'decisions.md'); }

function parseAsks(text) {
  return parseDecisionEntries(text).map((entry) => ({
    body: entry.block,
    kind: decisionField(entry.block, 'Kind').toLowerCase(),
    aspect: decisionField(entry.block, 'Aspect'),
    scope: (decisionField(entry.block, 'Scope') || 'once').toLowerCase(),
    answer: decisionField(entry.block, 'Answer'),
    consumed: decisionField(entry.block, 'Consumed'),
  }));
}

// An answer that lets one refusal through: right kind, right aspect, actually answered, and not
// already used up by an earlier landing.
function findAnswer(horde, kind, aspect) {
  const text = readText(decisionsPath(horde));
  return parseAsks(text).find((a) => a.kind === kind
    && a.aspect === aspect
    && /^approved\b/i.test(a.answer)
    && !a.consumed) || null;
}

// A "once" answer is spent by the landing that used it, so the next branch cannot lean on the
// same sentence. Recorded in the file itself rather than in a ledger beside it: the answer and
// the fact that it was used belong in one place a reader opens.
function consumeAnswer(horde, answer, ticketId, sha) {
  if (answer.scope === 'mission') return;
  const path = decisionsPath(horde);
  const text = readText(path) || '';
  const marked = answer.body.replace(
    /(\*\*Answer:\*\*[^\n]*\n)/,
    `$1**Consumed:** ticket ${ticketId} at ${sha} on ${nowIso()}\n`,
  );
  writeText(path, text.replace(answer.body, marked));
}

// ---- reading one tree's graph ---------------------------------------------------------
//
// Every document below is read per tree, never through node.mjs's own readers: those cache by
// node or by file alone, which is right for a command that looks at one tree and exactly wrong
// for a comparison of two.
function ygDocAt(tree, cfg, args, schema, what) {
  return docOrStop(ygJson(tree, cfg, args, schema), cfg, schema, what);
}

function docOrStop(res, cfg, schema, what) {
  if (res.state === 'ok') return res.doc;
  if (res.state === 'no-cli') {
    fail(`\`${res.command}\` could not be started — there is no Yggdrasil CLI at "${ygCommand(cfg).display}", and ${what} cannot be read without one. Point config.ygCommand at a build: horde.mjs config set ygCommand "node path/to/bin.js"`);
  }
  if (res.state === 'stale') {
    fail(`\`${res.command}\` did not answer with the ${schema} document Horde reads (${res.saw}) — ${what} cannot be read from an older CLI, and reading it a second, fragile way is exactly what this document exists to remove. Upgrade the Yggdrasil CLI (npm i -g @chrisdudek/yg), or point config.ygCommand at a newer build`);
  }
  fail(`\`${res.command}\` could not answer for ${what}: ${res.detail || `exit ${res.code}`}`);
  return null;
}

// The reach of every rule on one tree: `yg aspects --json --reach` answers, for each rule the
// graph declares, every unit it judges — one call, no text parsed, and no per-unit walk.
//
// This used to be read off `yg check --json --full`'s pairs, and that was wrong in one way that
// matters here. The gate deliberately has no pairs for a rule at `draft` — the rung exists to keep
// a rule inert — so a draft rule read that way comes back reaching NOTHING, which is
// indistinguishable from a rule that genuinely covers nothing. This guard's whole job is to tell a
// narrowed rule from an untouched one, and "reaches nothing on both sides" is how a draft rule
// silently escaped it; a rule demoted INTO draft looked like it had lost every unit it had, for
// the same reason. `--reach` is the graph's own answer to this exact question and carries the
// draft rungs, so what the guard compares is where a rule applies rather than where it currently
// bites. (It is also the cheap document: no verification runs behind it.)
function reachByAspect(tree, cfg) {
  const doc = ygDocAt(tree, cfg, ['aspects', '--json', '--reach'], 'yg-aspects/1', 'which units each rule reaches');
  const declared = asArray(doc.aspects).filter((a) => a && a.id);
  // A CLI that answered the document but ignored the flag would hand back every rule with no reach
  // at all, which this guard would read as "nothing reaches anything" and wave every narrowing
  // through. Refused rather than read: the whole point of the migration is that an absent reach is
  // never evidence of an empty one.
  if (declared.length && !declared.some((a) => a.reach)) {
    fail('`yg aspects --json --reach` answered a yg-aspects/1 document with no reach on any rule — the CLI took the flag and ignored it, and a missing reach is not an empty one. Upgrade the Yggdrasil CLI (npm i -g @chrisdudek/yg), or point config.ygCommand at a build that answers it.');
  }
  const reach = new Map();
  for (const a of declared) {
    const units = new Set();
    for (const r of asArray(a.reach && a.reach.units)) {
      if (r && r.unit && r.unit.kind && r.unit.path) units.add(`${r.unit.kind}:${r.unit.path}`);
    }
    reach.set(a.id, units);
  }
  return reach;
}

function aspectsById(tree, cfg) {
  const doc = ygDocAt(tree, cfg, ['aspects', '--json'], 'yg-aspects/1', 'the rules this tree carries');
  const out = new Map();
  for (const a of asArray(doc.aspects)) if (a && a.id) out.set(a.id, a);
  return out;
}

// The waiver inventory. Yggdrasil answers this as a document; a CLI that cannot is refused
// outright rather than read as text — a suppression the guard failed to see is a rule silently
// switched off, which is the one thing this guard exists to catch.
function suppressionsAt(tree, cfg) {
  const res = ygJson(tree, cfg, ['suppressions', '--json'], 'yg-suppressions/1');
  if (res.state === 'ok') {
    // Keyed by rule, file and kind, never by line: a marker that stayed put while the lines around
    // it moved is the same waiver, and counting it as a new one would refuse every branch that
    // edited a file with a waiver anywhere above the change.
    const keys = new Set();
    for (const m of asArray(res.doc.markers)) {
      if (m && m.aspect) keys.add(`${m.aspect}|${m.file}|${m.kind || 'file-level'}`);
    }
    return { ok: true, keys };
  }
  return {
    ok: false,
    why: `\`${res.command}\` cannot answer with a yg-suppressions/1 document${res.saw ? ` (${res.saw})` : ''}. `
      + 'A landing may not weaken the rules it is judged by, and an added yg-suppress marker is exactly that — so this stops here rather than reading a waiver inventory meant for a person as if it were data. '
      + 'Upgrade the Yggdrasil CLI (npm i -g @chrisdudek/yg), or point config.ygCommand at a build that answers it.',
  };
}

// A rule's own applicability text, read off the tree rather than inferred. Only `when` and `scope`
// matter here: they are what decides which units the rule reaches, so a change to either is what
// turns a lost pair into "the rule was narrowed" rather than "the rule was unhooked from a node".
const TOP_LEVEL_KEY = /^[A-Za-z_][\w-]*:/;
function aspectReachText(tree, aspectId) {
  const path = join(tree, '.yggdrasil', 'aspects', aspectId, 'yg-aspect.yaml');
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return ''; }
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (/^(when|scope):/.test(line)) { inBlock = true; out.push(line); continue; }
    if (inBlock) {
      if (TOP_LEVEL_KEY.test(line)) { inBlock = false; continue; }
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

// ---- the law guard --------------------------------------------------------------------
//
// A branch may not weaken the rules it is judged by. Six ways it can try, each named separately in
// the refusal, because the fix is different for each and "the graph got weaker" tells nobody
// anything. Deterministic throughout: no model is asked whether a change is a weakening — the
// three documents Yggdrasil answers with say so.
//
// The one thing that lets any of them through is the client's own word, recorded as an answered
// "ask" of kind "lower" naming that exact aspect. Not the worker's, not the architect's: lowering
// what the work is judged by is the client's call, and this reads their answer rather than
// anybody's summary of it.
const RUNGS = ['draft', 'advisory', 'enforced'];

function rung(status) {
  const i = RUNGS.indexOf(String(status || '').toLowerCase());
  return i === -1 ? RUNGS.length : i;
}

// Every unit one tree HAS — independent of any rule reaching it. This has to be read off the tree
// itself and never off the reach sets: an aspect that lost every pair it had is precisely the
// narrowing worth catching, and a "present" set derived from reach would have quietly dropped
// those units on both sides and called the change nothing.
function unitsIn(tree) {
  const units = new Set();
  for (const f of (git(['-c', 'core.quotepath=false', 'ls-files'], tree) || '').split('\n').filter(Boolean)) {
    units.add(`file:${f}`);
    const node = /^\.yggdrasil\/model\/(.+)\/yg-node\.yaml$/.exec(f);
    if (node) units.add(`node:${node[1]}`);
  }
  return units;
}

// A reach set restricted to the units that exist in both trees. Without this a file the branch
// added would read as a widening and a file it deleted as a narrowing, and every branch that
// touched a file would look like it had rewritten the law.
function comparableReach(set, present) {
  return new Set([...(set || [])].filter((u) => present.has(u)));
}

function isStrictSubset(head, base) {
  if (head.size >= base.size) return false;
  for (const u of head) if (!base.has(u)) return false;
  return true;
}

function lawGuard(cfg, horde, baseTree, headTree) {
  const baseAspects = aspectsById(baseTree, cfg);
  const headAspects = aspectsById(headTree, cfg);
  const baseReach = reachByAspect(baseTree, cfg);
  const headReach = reachByAspect(headTree, cfg);

  // Units both trees have. A rule's reach is only compared over these, so nothing the branch
  // added or deleted can be mistaken for a change in what the rule covers.
  const headUnits = unitsIn(headTree);
  const present = new Set([...unitsIn(baseTree)].filter((u) => headUnits.has(u)));

  const refusals = [];
  const answered = (aspect) => findAnswer(horde, 'lower', aspect);
  const refuse = (aspect, kase, what) => {
    const answer = answered(aspect);
    if (answer) return answer;
    refusals.push({
      aspect,
      case: kase,
      note: `${what} The rules a change is judged by are not the change's to weaken. If this really is right, it is the client's call, not this gate's: `
        + `ask.mjs add "<why>" --kind lower --aspect "${aspect}", then ask.mjs answer <id> "<answer>" [--scope once|mission] — `
        + 'once for this landing, mission to stand until the mission closes. The answer lands in decisions.md, which is what this guard reads.',
    });
    return null;
  };
  const used = [];
  const take = (answer) => { if (answer && !used.includes(answer)) used.push(answer); };

  for (const [id, base] of baseAspects) {
    const head = headAspects.get(id);
    const baseSet = comparableReach(baseReach.get(id), present);

    if (!head) {
      // A rule that reaches nothing weakens nothing when it goes: there is no unit that was being
      // judged and now is not. Deleting it is tidying, not lowering.
      if ((baseReach.get(id) || new Set()).size === 0) continue;
      take(refuse(id, 'deleted', `The rule "${id}" is on the base and gone from this branch, and it reaches ${(baseReach.get(id) || new Set()).size} unit(s) there.`));
      continue;
    }

    if (rung(head.status) < rung(base.status)) {
      take(refuse(id, 'demoted', `The rule "${id}" stands at "${base.status}" on the base and "${head.status}" on this branch.`));
    }

    if ((base.reviewBy || null) !== (head.reviewBy || null)) {
      take(refuse(id, 'review_by moved', `The rule "${id}" carries review_by ${base.reviewBy || '(none)'} on the base and ${head.reviewBy || '(none)'} on this branch — when a rule is next re-read is not a thing the work it judges gets to move.`));
    }

    const headSet = comparableReach(headReach.get(id), present);
    if (isStrictSubset(headSet, baseSet)) {
      const lost = [...baseSet].filter((u) => !headSet.has(u));
      const textChanged = aspectReachText(baseTree, id) !== aspectReachText(headTree, id);
      // The same lost pairs mean two different things, and the fix differs: a narrowed predicate
      // is a rewritten rule, an unhooked node is a node that stopped declaring it.
      if (textChanged) {
        take(refuse(id, 'narrowed', `The rule "${id}" has a changed when/scope on this branch and reaches ${headSet.size} of the ${baseSet.size} unit(s) it reached on the base — no longer: ${lost.slice(0, 5).join(', ')}${lost.length > 5 ? '…' : ''}.`));
      } else {
        take(refuse(id, 'detached', `The rule "${id}" is unchanged, but ${lost.length} unit(s) that declared it on the base no longer do on this branch: ${lost.slice(0, 5).join(', ')}${lost.length > 5 ? '…' : ''}.`));
      }
    }
  }

  const baseSupp = suppressionsAt(baseTree, cfg);
  const headSupp = suppressionsAt(headTree, cfg);
  if (!baseSupp.ok || !headSupp.ok) {
    return { ok: false, stopped: (baseSupp.ok ? headSupp : baseSupp).why, refusals, used: [] };
  }
  for (const key of headSupp.keys) {
    if (baseSupp.keys.has(key)) continue;
    const [aspect, file] = key.split('|');
    take(refuse(aspect, 'suppressed', `This branch adds a yg-suppress marker for "${aspect}" on ${file}, which switches that rule off there.`));
  }

  return { ok: refusals.length === 0, refusals, used, headReach };
}

// ---- the conflict-of-interest guard ---------------------------------------------------
//
// Sharpening a rule and changing the code that rule refuses, in one landing, is the author
// grading their own paper: whichever way the rule now reads, it reads that way because the code
// needed it to. Adding a NEW rule is not this — it judged nothing before. Raising an existing
// rule's status is not this either — the rule's text is the same one that already refused or
// passed the code. Changing what the rule SAYS, while changing code it reaches, is.
const ASPECT_TEXT_FILE = /^\.yggdrasil\/aspects\/([^/]+)\/(content\.md|check\.mjs|companion\.mjs|yg-aspect\.yaml)$/;

function conflictGuard(cfg, baseTree, headTree, changedFiles, headReach) {
  const baseAspects = aspectsById(baseTree, cfg);
  const touched = new Map();
  for (const f of changedFiles) {
    const m = ASPECT_TEXT_FILE.exec(f);
    if (!m) continue;
    const [, id, file] = m;
    // A rule this branch invents judged nothing before it existed, so nothing it says about this
    // code can be a rule bent around it.
    if (!baseAspects.has(id)) continue;
    // yg-aspect.yaml carries status and review_by as well as when/scope. Only the two that decide
    // what the rule reaches count as its text here; a raised status is dealt with by the law guard
    // on its way down, never up.
    if (file === 'yg-aspect.yaml' && aspectReachText(baseTree, id) === aspectReachText(headTree, id)) continue;
    if (!touched.has(id)) touched.set(id, new Set());
    touched.get(id).add(file);
  }
  if (touched.size === 0) return { ok: true, refusals: [] };

  const codeFiles = changedFiles.filter((f) => !f.startsWith('.yggdrasil/'));
  // Who owns each changed file, asked once. A rule reaching a whole component reaches every file
  // that component owns, and its pair is written against the component, not the file.
  // A file the graph does not know has no owner. Any other answer that is not the document — an older
  // CLI, a call that failed — stops here: read as "no owner", it matched only a rule's `file:` reach, and a
  // branch that bent a rule reaching the whole component slipped past this guard.
  const ownerOf = new Map();
  for (const f of codeFiles) {
    const res = ygJson(headTree, cfg, ['context', '--file', f, '--json'], 'yg-context/1');
    const doc = res.state === 'absent' ? null : docOrStop(res, cfg, 'yg-context/1', `who owns ${f}`);
    ownerOf.set(f, doc && doc.owner && doc.owner.kind === 'node' ? doc.owner.path : null);
  }
  const refusals = [];
  for (const [id, files] of touched) {
    // Reach comes from the pairs `yg check` actually verifies, not from the list of rules a file's
    // context names: a rule with a `scope.files` filter is named on the component while reaching
    // only some of its files, and asking the context would call every one of them reached.
    const reach = headReach.get(id) || new Set();
    const reached = codeFiles.filter((f) => reach.has(`file:${f}`) || (ownerOf.get(f) && reach.has(`node:${ownerOf.get(f)}`)));
    if (reached.length === 0) continue;
    refusals.push({
      aspect: id,
      case: 'conflict of interest',
      note: `This branch changes the rule "${id}" (${[...files].join(', ')}) and, in the same landing, ${reached.length} file(s) that rule reaches: ${reached.slice(0, 5).join(', ')}${reached.length > 5 ? '…' : ''}. `
        + 'A rule and the code it judges do not get written together by the same hand in one landing. Split it: one ticket for the code, one for the rule, landing separately so each is judged by a law it did not write.',
    });
  }
  return { ok: refusals.length === 0, refusals };
}

// ---- reading one tree's files ------------------------------------------------------------
//
// The two guards below read ordinary tracked content off each tree, the way the law guard reads
// each tree's graph: `baseTree` and `headTree` are real checked-out worktrees, so the question
// "what did this file hold on the base, and what does it hold now" is answered by reading it in
// each of them.
//
// `git ls-files` rather than a directory walk, for the same reason horde.mjs's own evidence-layer
// reading uses it: an untracked leftover is not content this branch is proposing, and counting one
// would refuse a landing over a file nobody committed.
function trackedIn(tree) {
  const out = git(['-c', 'core.quotepath=false', 'ls-files'], tree);
  if (out === null) {
    const detail = gitError();
    fail(`git ls-files could not say what ${tree} holds, so this landing cannot tell what the branch took away — and reading that as "the tree is empty" would wave every removal through${detail ? `: ${detail}` : ''}`);
  }
  return new Set(out.split('\n').filter(Boolean));
}

function contentAt(tree, rel) {
  try { return readFileSync(join(tree, rel), 'utf8'); } catch { return null; }
}

// ---- how much of a test there is -----------------------------------------------------------
//
// Two closed lists, one per question, each combined into a single alternation and counted by
// scanning the file once. One regex rather than one per pattern, deliberately: a match consumes
// the text it covers, so `assert.Equal(` cannot be counted twice for landing in two lists at once.
//
// Crude on purpose. Nothing here is asked what a test MEANS — only whether there is less of it
// than there was — and a pattern that over-counts or under-counts does so identically on both
// trees, where the comparison cancels it out. There is no threshold anywhere below and no number
// to configure: the only figure that decides anything is the difference between two of them.
//
// The languages are the ones this tool already recognises elsewhere and no others: the six build
// systems `horde init` reads a repository with (npm, Maven, Gradle, Cargo, Go, Python), plus .NET,
// which the skip list below already names. A suite written in anything else simply counts zero
// assertions on both trees, which compares equal and refuses nothing — an unknown language is
// never read as a suite that lost its assertions.
const ASSERTIONS = {
  // JavaScript and TypeScript — node:assert, Jest, Vitest, Chai, Playwright.
  'assert(': String.raw`\bassert(?:\s*\.\s*\w+)*\s*\(`,
  'expect(': String.raw`\bexpect\s*\(`,
  // Python — pytest's bare statement, unittest's own methods, and the raises helper.
  'assert <expr>': String.raw`^[ \t]*assert\b`,
  'self.assert…(': String.raw`\bself\s*\.\s*assert\w*\s*\(`,
  'pytest.raises(': String.raw`\bpytest\s*\.\s*raises\s*\(`,
  // Go — the standard library's own failure calls, and testify's two entry points.
  't.Error/Fatal(': String.raw`\bt\s*\.\s*(?:Error|Errorf|Fatal|Fatalf)\s*\(`,
  'require.…(': String.raw`\brequire\s*\.\s*\w+\s*\(`,
  // Java and Kotlin — JUnit's own assertions and AssertJ's entry point.
  'assertThat(': String.raw`\bassert(?:That|Equals|True|False|Null|NotNull|Throws|ArrayEquals|Same|NotSame)\s*\(`,
  // C# — xUnit, NUnit and MSTest all spell it the same way.
  'Assert.…(': String.raw`\bAssert\s*\.\s*\w+\s*\(`,
  // Rust — the macro forms.
  'assert!': String.raw`\bassert(?:_eq|_ne)?\s*!`,
};

// The ways a suite says "not this one", mirrored by hand from the `promises` package's own
// evidence-is-live rule — that package is optional and installed separately, so this skill's own
// self-containment rule keeps it out of reach from here. The list is closed there and closed here:
// a marker nobody wrote a matcher for would be added silently.
//
// Both kinds count the same way for this guard's one question. A `skip` turns off the case it sits
// on and an `only` turns off every case it does not; either one appearing where it was not before
// is a suite that runs less than it ran.
const SKIP_MARKERS = {
  'test.skip': String.raw`\btest\s*\.\s*skip\b`,
  'test.fixme': String.raw`\btest\s*\.\s*fixme\b`,
  'test.only': String.raw`\btest\s*\.\s*only\b`,
  xit: String.raw`\bxit\s*\(`,
  xdescribe: String.raw`\bxdescribe\s*\(`,
  '@pytest.mark.skip': String.raw`@\s*pytest\s*\.\s*mark\s*\.\s*skip`,
  'pytest.skip(': String.raw`\bpytest\s*\.\s*skip\s*\(`,
  't.Skip(': String.raw`\bt\s*\.\s*Skip\s*\(`,
  '[Ignore]': String.raw`\[\s*Ignore\s*[\](]`,
  'Skip =': String.raw`[(,]\s*Skip\s*=\s*["@]`,
};

function counterFor(patterns) {
  const source = Object.values(patterns).join('|');
  return (text) => {
    if (!text) return 0;
    const re = new RegExp(source, 'gm');
    let n = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      n += 1;
      // No pattern above can match the empty string, and this is here so that a later one added
      // carelessly costs a wrong count rather than a landing that never returns.
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
    return n;
  };
}
const countAssertions = counterFor(ASSERTIONS);
const countSkips = counterFor(SKIP_MARKERS);

// ---- reading one tree's promises -----------------------------------------------------------
//
// Where the promises are is horde.mjs's own answer, asked of each tree in turn: the graph's own
// mapping for the doc-shape rule first, and the four usual directory names after it. Asking it per
// tree costs one more `yg aspects --json --reach` per side on a landing that already runs four of
// them plus two `yg check`s, and it is the only reading that finds a promises directory an adopter
// installed at a path of their own.
//
// What is read back per promise is only what these guards compare: its id, its status, and what
// keeps it. The frontmatter reader is the same shape the package's own rules use — flat `key:
// value` scalars plus one level of nesting — mirrored here for the same reason the skip list is.
const SPEC_SUFFIX = '.test';
const PROMISE_CASE_BY_NAME = [
  (n) => new RegExp(String.raw`\b[xf]?(?:test|it)\b(?:\.\w+)*\s*\(\s*[\`'"]${escapeForRegExp(n)}[\`'"]`),
  (n) => new RegExp(`Scenario:[ \\t]*${escapeForRegExp(n)}[ \\t]*$`, 'm'),
  (n) => new RegExp(String.raw`\bdef\s+test_${escapeForRegExp(asSnake(n))}\s*\(`),
  (n) => new RegExp(String.raw`\bfunc\s+Test${escapeForRegExp(asPascal(n))}\s*\(`),
];

function escapeForRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function asSnake(name) { return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
function asPascal(name) {
  return String(name).split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}
function stemOf(path) {
  const base = path.split('/').pop() || path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function promiseFrontmatter(text) {
  const lines = String(text || '').split('\n');
  if ((lines[0] || '').trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length && end === -1; i += 1) if ((lines[i] || '').trim() === '---') end = i;
  if (end === -1) return null;
  const fields = Object.create(null);
  const blocks = Object.create(null);
  let open = null;
  for (let i = 1; i < end; i += 1) {
    const raw = lines[i] || '';
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (/^\s+\S/.test(raw) && open !== null) {
      const at = raw.indexOf(':');
      if (at !== -1) blocks[open][raw.slice(0, at).trim()] = raw.slice(at + 1).trim().replace(/^["'](.*)["']$/, '$1');
      continue;
    }
    if (/^\s/.test(raw)) continue;
    const at = raw.indexOf(':');
    if (at === -1) continue;
    const key = raw.slice(0, at).trim();
    const value = raw.slice(at + 1).trim().replace(/^["'](.*)["']$/, '$1');
    if (value === '') { open = key; blocks[key] = Object.create(null); } else { open = null; fields[key] = value; }
  }
  return { fields, blocks };
}

// ---- the has-evidence aspect's own pin ------------------------------------------------------
//
// A repository may pin one pairing for every promise, instead of each promise saying which it
// uses: the SAME `evidence` setting `packages/promises/has-evidence/check.mjs`'s own `check(ctx)`
// reads off `ctx.config?.evidence` (`DEFAULT_EVIDENCE = 'auto'`), installed on a tree's own
// `.yggdrasil/aspects/has-evidence/yg-aspect.yaml` under a `config:` block. Duplicated here rather
// than imported — this skill's own self-containment rule keeps the (separately installed)
// `promises` package out of reach from `land.mjs`, the same reason `SKIP_MARKERS` above is a
// hand-mirrored copy rather than an import.
const EVIDENCE_ADAPTERS = ['mirror', 'named', 'self', 'artefact'];

// A YAML file's own flat scalars plus one level of nesting — the same shape `promiseFrontmatter`
// above reads, minus the `---` fence: a plain `yg-aspect.yaml` opens straight into its own keys,
// never inside a frontmatter block, so the whole text is the body rather than a slice between two
// markers. Everything else about the read — comments and blank lines skipped, a key with nothing
// after its colon opens a one-level-deep nested block, quotes stripped off a scalar — is the exact
// same algorithm, so the two readers can never drift into reading the same shape two different
// ways.
function flatYamlBlock(text) {
  const fields = Object.create(null);
  const blocks = Object.create(null);
  let open = null;
  for (const raw of String(text || '').split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (/^\s+\S/.test(raw) && open !== null) {
      const at = raw.indexOf(':');
      if (at !== -1) blocks[open][raw.slice(0, at).trim()] = raw.slice(at + 1).trim().replace(/^["'](.*)["']$/, '$1');
      continue;
    }
    if (/^\s/.test(raw)) continue;
    const at = raw.indexOf(':');
    if (at === -1) continue;
    const key = raw.slice(0, at).trim();
    const value = raw.slice(at + 1).trim().replace(/^["'](.*)["']$/, '$1');
    if (value === '') { open = key; blocks[key] = Object.create(null); } else { open = null; fields[key] = value; }
  }
  return { fields, blocks };
}

// The has-evidence aspect's own pin on one tree — one of the four pairings, or null. Null covers
// every shape of "auto" at once, on purpose, so a caller never has to branch on which: the aspect
// is not installed on this tree at all (a repository that has not adopted the has-evidence rule —
// the common, unaffected case); the file carries no `config:` block; the block carries no
// `evidence:` key; the key is written out as `auto` explicitly; or the key names something that is
// none of the four pairings and not `auto` either, which is a graph problem for `yg check` to
// catch (the real rule refuses a setting outside its five recognised words) and never a promise
// this guard would otherwise have to guess a pairing for. Read off the same tree-relative path
// `aspectReachText` above reads aspect content from.
export function evidencePinAt(tree) {
  const text = contentAt(tree, '.yggdrasil/aspects/has-evidence/yg-aspect.yaml');
  if (text === null) return null;
  const raw = flatYamlBlock(text).blocks.config?.evidence;
  if (raw === undefined) return null;
  const setting = String(raw).trim();
  return EVIDENCE_ADAPTERS.includes(setting) ? setting : null;
}

// Which of the four pairings applies to a promise: the tree's own pin when it names one, or — same
// as the real rule's `auto` default — derived from the promise's own frontmatter, exactly the
// branching `adapterOf` in `packages/promises/has-evidence/check.mjs` takes. Shared by `pairingOf`
// and `pairingKind` below so the two can never resolve a different kind for the same promise.
export function pairingAdapter(front, pin) {
  if (pin) return pin;
  if (front.blocks.artefact !== undefined) return 'artefact';
  if (front.fields.evidence === 'self') return 'self';
  if (front.fields.evidence !== undefined) return 'named';
  return 'mirror';
}

// What keeps this promise, as the path of the file that keeps it — or a sentence, for the one
// pairing that is not a file that runs. Null means nothing here keeps it. The four pairings are
// the package's own four, read the same way it reads them. `byStem` is the tree's own tracked
// files indexed by base name, built once by the caller: a mirror pairing asks for one, and asking
// by walking every tracked file per promise is the shape that turns a big repository's landing
// into a scan of the whole tree per promise it holds. `pin` is this tree's own has-evidence
// setting (null under `auto`) — when it names one of the four, it decides the pairing outright,
// the same way the real rule's `check(ctx)` does, regardless of what this promise's own
// frontmatter says. The `artefact`/`named` branches below still read this promise's OWN block or
// field even when pinned: the pin decides WHICH check runs, never the locator or the artefact
// facts themselves — those are never something a repository-wide setting could supply.
export function pairingOf(tree, tracked, byStem, promiseRel, front, pin) {
  const adapter = pairingAdapter(front, pin);
  if (adapter === 'artefact') {
    const block = front.blocks.artefact;
    if (block === undefined) return null;
    const complete = ['path', 'sha256', 'accepted_by', 'at'].every((f) => block[f]);
    return complete ? `the accepted artefact ${block.path}` : null;
  }
  if (adapter === 'self') return promiseRel;
  if (adapter === 'named') {
    if (front.fields.evidence === undefined) return null;
    const raw = String(front.fields.evidence);
    const hash = raw.indexOf('#');
    if (hash <= 0 || hash === raw.length - 1) return null;
    const target = raw.slice(0, hash).trim();
    const name = raw.slice(hash + 1).trim();
    const path = tracked.has(target) ? target : [...tracked].find((f) => f.endsWith(`/${target}`));
    if (!path) return null;
    const text = contentAt(tree, path);
    return PROMISE_CASE_BY_NAME.some((build) => build(name).test(text || '')) ? path : null;
  }
  const found = byStem.get(`${stemOf(promiseRel)}${SPEC_SUFFIX}`) || [];
  return found.length === 1 ? found[0] : null;
}

// Which of the four pairings a promise declares, and — for the one that names a case — what that
// case is called. Takes exactly the branching `pairingOf` above takes (the same `pin`, the same
// `pairingAdapter`), so the two can never disagree about which pairing a promise has. `pairingOf`
// answers "what keeps this promise"; this answers "how", which is what item 5's report reading
// needs and what `pairingOf`'s own answer cannot carry: a `<file>#<case name>` pairing collapses
// to the file there, and the name is the half a runner's report is searched by.
//
// A `named` pairing whose `evidence:` field is malformed (no `#`, or nothing either side of it) —
// or, under a `named` pin, simply absent — comes back with a null case name — the same field shape
// `pairingOf` reads as "nothing keeps this", so such a promise carries no `keptBy` either and
// nothing below looks for it in a report.
export function pairingKind(front, pin) {
  const adapter = pairingAdapter(front, pin);
  if (adapter === 'artefact') return { kind: 'artefact', caseName: null };
  if (adapter === 'self') return { kind: 'self', caseName: null };
  if (adapter === 'named') {
    if (front.fields.evidence === undefined) return { kind: 'named', caseName: null };
    const raw = String(front.fields.evidence);
    const hash = raw.indexOf('#');
    if (hash <= 0 || hash === raw.length - 1) return { kind: 'named', caseName: null };
    return { kind: 'named', caseName: raw.slice(hash + 1).trim() };
  }
  return { kind: 'mirror', caseName: null };
}

export function promisesIn(tree, cfg) {
  const layer = detectEvidenceLayer(tree, cfg);
  const dir = layer.promises && layer.promises.dir;
  if (!dir) return [];
  const tracked = trackedIn(tree);
  const byStem = new Map();
  for (const f of tracked) {
    const stem = stemOf(f);
    if (byStem.has(stem)) byStem.get(stem).push(f); else byStem.set(stem, [f]);
  }
  // Read once per tree, not once per promise: every promise on this tree is judged against the
  // SAME pin, which is the whole point of one — a repository does not pin per file.
  const pin = evidencePinAt(tree);
  const out = [];
  for (const rel of [...tracked].sort()) {
    if (!rel.startsWith(`${dir}/`) || !rel.endsWith('.md') || rel.slice(dir.length + 1).includes('/')) continue;
    const front = promiseFrontmatter(contentAt(tree, rel));
    if (!front || front.fields.status === undefined) continue;
    out.push({
      id: front.fields.id || stemOf(rel),
      path: rel,
      status: front.fields.status,
      // The package accepts "implemented" or one of the repository's own parked words, and the
      // only move that takes a promise out of what anything enforces is leaving "implemented".
      // So that, and only that, is what these two trees are compared on — no parked list to
      // configure, and a repository that renamed its parked words is read exactly the same.
      live: front.fields.status === 'implemented',
      keptBy: pairingOf(tree, tracked, byStem, rel, front, pin),
      // Which pairing it is, and the case name when the pairing names one. Nothing in the guards
      // reads this; item 5's report reading does — see "the gate's own report" below.
      pairing: pairingKind(front, pin),
    });
  }
  return out;
}

// ---- the guards on everything else that protects ---------------------------------------------
//
// The law guard above says a branch may not weaken the rules it is judged by. These two say the
// same thing about the other two ways a mission is held to its work: the proof it is judged by,
// and the gates it is measured through. Same shape, same mechanism, same one way past it — the
// client's own answered "ask" of kind "lower", naming the exact thing being weakened.
//
// The target named on that ask is what tells one refusal from another, and there are three kinds
// of name across the three guards, deliberately spelled so no two can collide:
//
//   <rule id>          a rule in the graph                        (the law guard, unchanged)
//   evidence:<name>    a promise's own id, or a test file's path  (the evidence guard)
//   gate:<path>        a file a gate, a hook or CI actually runs  (the gate guard)
//
// A rule id is a bare directory name under `.yggdrasil/aspects/`, so it can never carry the `:`
// the other two open with; a promise id is a filename stem and a test file is a path, so the two
// that share the `evidence:` prefix never spell each other either.
//
// Nothing here asks a model anything. Both guards read two trees and compare two numbers or two
// pieces of text — a landing is never refused on a judgement about whether a change was fair.
function protectionBook(horde) {
  const refusals = [];
  const used = [];
  return {
    refusals,
    used,
    // Hands back nothing: what the caller does about a refusal is always the same, so the answer,
    // when there is one, is banked here rather than passed back to be banked again at each site.
    refuse(target, kase, what) {
      const answer = findAnswer(horde, 'lower', target);
      if (answer) {
        if (!used.includes(answer)) used.push(answer);
        return;
      }
      refusals.push({
        aspect: target,
        case: kase,
        note: `${what} Nothing that protects the work is the work's own to weaken. If this really is right, it is the client's call, not this gate's: `
          + `ask.mjs add "<why>" --kind lower --aspect "${target}", then ask.mjs answer <id> "<answer>" [--scope once|mission] — `
          + 'once for this landing, mission to stand until the mission closes. The answer lands in decisions.md, which is what this guard reads.',
      });
    },
  };
}

// A promise that was being kept on the base has to still be being kept here. Three ways it can
// stop, and each is named separately because the fix differs: the promise is gone, the promise
// stopped saying anything runs it, or the thing that kept it is no longer there to run.
//
// A promise that was already parked on the base is left entirely alone — nothing was being kept,
// so nothing can have stopped being kept — and so is one this branch invents.
function promiseRefusals(book, basePromises, headPromises, touched) {
  if (!basePromises.length) return;
  const head = new Map(headPromises.map((p) => [p.id, p]));
  for (const was of basePromises) {
    if (!was.live) continue;
    if (!touched.has(was.path) && !(was.keptBy && touched.has(was.keptBy))) continue;
    const now = head.get(was.id);
    if (!now) {
      book.refuse(`evidence:${was.id}`, 'promise gone', `The promise "${was.id}" reads as implemented on the base and is gone from this branch.`);
      continue;
    }
    if (!now.live) {
      book.refuse(`evidence:${was.id}`, 'promise parked', `The promise "${was.id}" stands at "${was.status}" on the base and "${now.status}" on this branch, which takes it out of everything that enforces it.`);
      continue;
    }
    if (was.keptBy && !now.keptBy) {
      book.refuse(`evidence:${was.id}`, 'pairing gone', `The promise "${was.id}" is kept by ${was.keptBy} on the base, and on this branch nothing here keeps it.`);
    }
  }
}

// The suite itself. Every file this repository's own `config.testGlobs` recognise on the base
// tree, plus whatever keeps a live promise there, and three ways a branch can leave less of one
// behind than it found: the file is gone, it carries fewer assertions, or it carries a marker
// that switches part of it off.
//
// Per file and never in total, which is the strictest of the readings available: assertions moved
// out of one file into another are a split, and a split is a thing to say out loud rather than a
// number that happens to come out even. A file whose bytes turn up unchanged under a NEW name is
// the one exception — that is a rename, nothing was taken away, and refusing it would refuse
// tidying up.
function testFileRefusals(book, cfg, baseTree, headTree, basePromises, touched) {
  // Compiled once, not once per file: this is asked of every tracked path in both trees, and a
  // repository big enough for any of this to matter is a repository where rebuilding the same
  // handful of patterns per path is the whole cost of the guard.
  const globs = (Array.isArray(cfg.testGlobs) ? cfg.testGlobs.filter(Boolean) : []).map((g) => globToRegExp(g));
  const baseTracked = trackedIn(baseTree);
  const headTracked = trackedIn(headTree);
  const isTest = (f) => globs.some((re) => re.test(f));

  const watched = new Set([...baseTracked].filter((f) => isTest(f) && touched.has(f)));
  // A promise paired with something the globs do not recognise is still something that keeps a
  // promise, and a skip marker added to it switches that promise off just the same.
  for (const p of basePromises) if (p.live && p.keptBy && baseTracked.has(p.keptBy) && touched.has(p.keptBy)) watched.add(p.keptBy);
  if (!watched.size) return;

  const arrived = new Set();
  for (const f of headTracked) if (isTest(f) && !baseTracked.has(f)) arrived.add(contentAt(headTree, f));

  for (const path of [...watched].sort()) {
    const was = contentAt(baseTree, path);
    if (!headTracked.has(path)) {
      if (arrived.has(was)) continue;
      book.refuse(`evidence:${path}`, 'test removed', `${path} is on the base with ${countAssertions(was)} assertion(s) and gone from this branch.`);
      continue;
    }
    const now = contentAt(headTree, path);
    if (now === was) continue;
    const wasAssertions = countAssertions(was);
    const nowAssertions = countAssertions(now);
    if (nowAssertions < wasAssertions) {
      book.refuse(`evidence:${path}`, 'assertions dropped', `${path} carries ${nowAssertions} assertion(s) on this branch and ${wasAssertions} on the base.`);
    }
    const wasSkips = countSkips(was);
    const nowSkips = countSkips(now);
    if (nowSkips > wasSkips) {
      book.refuse(`evidence:${path}`, 'skip added', `${path} carries ${nowSkips} skip or exclusivity marker(s) on this branch and ${wasSkips} on the base — a case switched off still lets the suite go green.`);
    }
  }
}

function evidenceGuard(cfg, horde, baseTree, headTree, touched) {
  const book = protectionBook(horde);
  // Read once per tree and handed to both passes: each reading asks the graph where this
  // repository keeps its promises, and asking twice for one answer would cost a landing an extra
  // round trip to the CLI for nothing.
  const basePromises = promisesIn(baseTree, cfg);
  const headPromises = basePromises.length ? promisesIn(headTree, cfg) : [];
  promiseRefusals(book, basePromises, headPromises, touched);
  testFileRefusals(book, cfg, baseTree, headTree, basePromises, touched);
  return { ok: book.refusals.length === 0, refusals: book.refusals, used: book.used };
}

// ---- the gate guard ---------------------------------------------------------------------------
//
// What actually runs before a change is allowed through: the script a `config.gates.*` command
// invokes, the commit and push hooks, and the CI workflows. A branch may not take one away or
// rewrite one without the client's word — the hand that writes the code is not the hand that gets
// to decide what checks it.
//
// `config.gates.*` itself lives in `.horde/`, which is not in the repository and is therefore in
// neither tree: there is no earlier version of it to compare against, and a guard that read two
// trees could only ever invent one. What IS in both trees is the file each command actually runs,
// so that is what this watches — a command's own tokens, kept where one of them names a file the
// base tree tracks. A command made of nothing but shell builtins (`true`, `npm run gate`) names no
// tracked file and contributes nothing here, which is the honest answer: this tool cannot see
// inside `npm run gate` and does not pretend to.
//
// `config.protectedPaths` is deliberately NOT watched here, though it belongs to the same family.
// The scope item already refuses any branch that so much as touches one, with no way through at
// all — stricter than this guard, and unanswerable. Watching them here would add a refusal naming
// a client answer that still could not land the change, which is worse than saying nothing.
const CI_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const PUSH_HOOKS = ['.git/hooks/pre-push', '.husky/pre-push'];

// The tokens of a shell command, as candidates for "a file this command runs". Split on whitespace
// and the shell's own separators, unquoted, with a leading `./` taken off — every token is then
// offered to the tracked set, which is what decides whether it names a real file.
function commandTokens(command) {
  return String(command ?? '')
    .split(/[\s;&|()<>]+/)
    .map((t) => t.replace(/^['"]|['"]$/g, '').replace(/^\.\//, ''))
    .filter(Boolean);
}

function gateGuard(cfg, horde, baseTree, headTree, touched) {
  const baseTracked = trackedIn(baseTree);
  const headTracked = trackedIn(headTree);
  const watched = new Set();
  const why = new Map();
  const watch = (rel, reason) => {
    if (!baseTracked.has(rel) || !touched.has(rel) || watched.has(rel)) return;
    watched.add(rel);
    why.set(rel, reason);
  };

  for (const level of ['commit', 'team', 'trunk']) {
    const command = cfg.gates && cfg.gates[level];
    for (const token of commandTokens(command)) watch(token, `config.gates.${level} runs it`);
  }
  for (const rel of [...HOOK_FILES, ...PUSH_HOOKS]) watch(rel, 'it is a commit or push hook');
  // Over what the branch touched rather than over the whole tree: `watch` would refuse everything
  // else anyway, and a repository's workflow directory is not worth walking the tree to find.
  for (const rel of [...touched].sort()) if (CI_WORKFLOW.test(rel)) watch(rel, 'CI runs it');

  const book = protectionBook(horde);
  for (const rel of [...watched].sort()) {
    if (!headTracked.has(rel)) {
      book.refuse(`gate:${rel}`, 'gate removed', `${rel} is on the base — ${why.get(rel)} — and gone from this branch.`);
      continue;
    }
    if (contentAt(baseTree, rel) !== contentAt(headTree, rel)) {
      book.refuse(`gate:${rel}`, 'gate changed', `${rel} reads differently on this branch — ${why.get(rel)}, so what it now runs is what every later change is checked by.`);
    }
  }
  return { ok: book.refusals.length === 0, refusals: book.refusals, used: book.used };
}

// Both new guards, run together, and every answer either of them leaned on. One call site's worth
// of wiring written once, because a landing runs this in two places — a ticket on its own and a
// ticket being screened into a batch — and a guard that ran in only one of them would be a guard
// a worker could get past by landing two tickets at a time.
//
// `changedFiles` is what the branch itself did — the same three-dot diff against the parent branch
// that the scope item and the conflict guard already read — and every comparison below is confined
// to it. Without that confinement a branch merely left behind by its parent would read as having
// deleted every test the parent has added since: two trees differ for two reasons, and only one of
// them is this branch's doing. (The other is item 1's to report, which it does.)
function protectionGuards(cfg, horde, baseTree, headTree, changedFiles) {
  const touched = new Set(changedFiles);
  if (!touched.size) return { refusals: [], used: [] };
  const evidence = evidenceGuard(cfg, horde, baseTree, headTree, touched);
  const gates = gateGuard(cfg, horde, baseTree, headTree, touched);
  return {
    refusals: [...evidence.refusals, ...gates.refusals],
    used: [...evidence.used, ...gates.used],
  };
}

// ---- the gate's own report: what the runner says it actually ran -----------------------------
//
// Everything above this line reads source. Source cannot say what ran. A test file that exists and
// pairs with a promise passes every rule in the `promises` package and every guard in this file
// while being skipped, or while sitting in a directory the gate command's own runner never looks
// at — and a landing measured that way is measured on the presence of a file, not on a run.
//
// The one thing that does say what ran is the runner's own report of its own run. So when
// `config.gates.report` names one, item 5 reads it back after the gate command returns and
// requires every live promise's own paired case to be in it, passing. A promise whose case is
// missing from the report, or in it as skipped or failed, is a promise nothing executed clean.
//
// This is an ordinary red gate, not a guard. The guards above refuse outright because no worker
// can fix a rewritten rule or a deleted test by trying again; a case that did not run is fixed by
// writing it, un-skipping it, or making it pass, and running again — exactly like any failing
// test. So there is no client answer that waives it and none is offered.
//
// Horde runs no runner and configures none: the environment and the runner are the repository's
// own. All of this reads a file that the repository's own gate command left behind.
//
//   horde.mjs config set gates.report.path "<path, relative to the tree the gate ran in>"
//   horde.mjs config set gates.report.format junit|tap|playwright-json
//
// Nothing in horde.mjs needed changing for that: `config set` already writes any dotted path.
//
// What this costs, and only where a report is configured at all: one reading of the tree's own
// promises — the same `yg aspects --json --reach` the law guard already takes per tree, plus one
// `git ls-files` — and one read of the report file. A repository that names no report reads none
// of that and runs nothing extra.
const REPORT_FORMATS = ['junit', 'tap', 'playwright-json'];

// Three fixed strings and one path, validated here by reading them — not through a schema system,
// because there is nothing general about three strings. `configured: false` and a refusal are two
// different answers and the item says them differently: nobody asked for this, versus somebody
// asked for it and wrote it wrong.
function gateReportConfig(cfg) {
  const raw = cfg && cfg.gates ? cfg.gates.report : undefined;
  if (raw === undefined || raw === null || raw === '') return { configured: false };
  const how = `set both: horde.mjs config set gates.report.path "<file the gate writes>" and horde.mjs config set gates.report.format ${REPORT_FORMATS.join('|')}`;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { configured: true, error: `config.gates.report is ${JSON.stringify(raw)} — it is a path and a format, not one value. ${how}` };
  }
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  const format = typeof raw.format === 'string' ? raw.format.trim().toLowerCase() : '';
  if (!path) return { configured: true, error: `config.gates.report names no path, so there is nothing to read. ${how}` };
  // Inside the tree the gate command just ran in, and nowhere else. The whole claim this item makes
  // is that the report is the one THAT run left behind; an absolute path, or one climbing out with
  // `..`, reads a file some other run wrote — very possibly a stale one from a tree nobody measured
  // — and would report it as proof that this branch's cases ran.
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes('..')) {
    return { configured: true, error: `config.gates.report.path is "${path}" — it has to stay inside the tree the gate ran in, because the only report that proves anything about this branch is the one that run left behind; an absolute path or one climbing out with ".." reads some other run's file. ${how}` };
  }
  if (!REPORT_FORMATS.includes(format)) {
    // The path is already known to stay inside the tree, so it is handed back beside the refusal:
    // the revert test's fallback still looks there, to report a file produced in a format nothing
    // here reads instead of ignoring it.
    return { configured: true, path, error: `config.gates.report.format is ${format ? `"${format}"` : 'not set'} — the formats this reads are ${REPORT_FORMATS.join(', ')}, and a format it cannot read is not a report it can check. ${how}` };
  }
  return { configured: true, path, format };
}

// ---- the three formats, each read into one shape ---------------------------------------------
//
// Every parser below answers the same question in the same words: a flat list of
// `{file, name, status}`, where `status` is exactly one of "passed", "failed" or "skipped" and
// `file` is whatever the format could say about where the case lives — null when the format
// cannot say at all, which is the honest answer for TAP and never a guess. The correlation that
// follows reads only that shape and never knows which format produced it.

function decodeXmlText(value) {
  return String(value).replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, entity) => {
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'amp') return '&';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

function xmlAttrs(raw) {
  const out = Object.create(null);
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    out[m[1].toLowerCase()] = decodeXmlText(m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

// JUnit XML. An optional `<testsuites>` wrapper, one or more `<testsuite>` (which may nest), and
// inside each a `<testcase name= classname= …>` that is empty when it passed, carries a
// `<failure>` or an `<error>` when it did not, and a `<skipped/>` when it never ran.
//
// Where a case lives is the one field JUnit writers genuinely disagree about. Read in this order:
// the case's own `file`/`filepath`/`filename`, then the enclosing suite's, then the case's
// `classname` (which most writers use for exactly this, spelled with dots), then the suite's
// `name`. Whichever of those turns up is handed to the deliberately generous attribution rule
// below rather than compared as a string — see `sameFile`.
function parseJUnitReport(text) {
  const cleaned = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (!/<\s*testsuite\b/i.test(cleaned) && !/<\s*testcase\b/i.test(cleaned)) {
    return { error: 'no <testsuite> or <testcase> element is in it' };
  }
  const entries = [];
  const suites = [];
  let open = null;
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (let m = re.exec(cleaned); m !== null; m = re.exec(cleaned)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const rest = m[3];
    const selfClosing = /\/\s*$/.test(rest);
    const attrs = closing ? Object.create(null) : xmlAttrs(rest);
    if (tag === 'testsuite') {
      if (closing) { suites.pop(); continue; }
      const parent = suites[suites.length - 1];
      suites.push({
        file: attrs.file || attrs.filepath || attrs.filename || (parent && parent.file) || null,
        name: attrs.name || (parent && parent.name) || null,
      });
      if (selfClosing) suites.pop();
      continue;
    }
    if (tag === 'testcase') {
      if (closing) { if (open) { entries.push(open); open = null; } continue; }
      if (open) { entries.push(open); open = null; }
      const suite = suites[suites.length - 1];
      const entry = {
        file: attrs.file || attrs.filepath || attrs.filename || (suite && suite.file)
          || attrs.classname || (suite && suite.name) || null,
        name: attrs.name || '',
        status: 'passed',
      };
      if (selfClosing) entries.push(entry); else open = entry;
      continue;
    }
    if (!open || closing) continue;
    // A case carrying both a failure and a skip is a failure: a failure is the stronger fact and
    // neither one is "it ran and passed", which is all this asks.
    if (tag === 'failure' || tag === 'error') open.status = 'failed';
    else if (tag === 'skipped' && open.status === 'passed') open.status = 'skipped';
  }
  if (open) entries.push(open);
  return { entries };
}

// TAP, version 13-ish. A plan line (`1..N`), then `ok <n> - <description>` and
// `not ok <n> - <description>`, each optionally followed by an indented YAML block and optionally
// carrying a trailing `# SKIP <reason>` or `# TODO <reason>` directive. Indentation is a subtest
// nesting, and both the nested lines and the parent's own line are read: a skipped case inside a
// passing parent is exactly what this is looking for.
//
// A `# TODO` counts as skipped, not as passed and not as failed. TAP says a failing TODO is not a
// failure, and that is the point: a case marked TODO is not proof either way, which is the same
// thing a skip is, and this only ever asks whether something ran and passed.
//
// TAP carries no file attribution, structurally — a line says what ran, never where it lives — so
// every entry comes back with `file: null`. That is the format's real limit and the correlation
// below says so out loud rather than inventing one.
function parseTapReport(text) {
  const lines = String(text || '').split('\n');
  const entries = [];
  let inYaml = false;
  let sawPlan = false;
  const re = /^(\s*)(not\s+)?ok\b[ \t]*(\d+)?[ \t]*(?:-[ \t]*)?(.*)$/;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (inYaml) { if (trimmed === '...') inYaml = false; continue; }
    if (trimmed === '---') { inYaml = true; continue; }
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^TAP\s+version\b/i.test(trimmed)) continue;
    if (/^\d+\.\.\d+\b/.test(trimmed)) { sawPlan = true; continue; }
    const m = re.exec(line);
    if (m === null) continue;
    const { name, directive } = tapDirective(m[4] || '');
    entries.push({
      file: null,
      name,
      status: directive ? 'skipped' : (m[2] ? 'failed' : 'passed'),
    });
  }
  if (!entries.length && !sawPlan) return { error: 'it carries no plan line and no "ok"/"not ok" line' };
  return { entries };
}

// The trailing `# SKIP`/`# TODO` directive, split off the description. The last `#` on the line is
// the candidate, and it is only a directive when the word after it is one this recognises —
// a description that merely contains a `#` keeps it.
function tapDirective(description) {
  const at = description.lastIndexOf('#');
  if (at === -1) return { name: description.trim(), directive: null };
  const word = (description.slice(at + 1).trim().split(/\s+/)[0] || '').toUpperCase();
  if (word !== 'SKIP' && word !== 'SKIPPED' && word !== 'TODO') return { name: description.trim(), directive: null };
  return { name: description.slice(0, at).trim(), directive: word === 'TODO' ? 'TODO' : 'SKIP' };
}

// Playwright's `--reporter=json`. A top-level object with `suites`, each suite carrying a `file`
// and either `specs` or nested `suites` (a nested describe block); each spec a `title` and a
// `tests` array (one per project the spec ran under); each test a `results` array whose entries
// carry a `status`.
//
// One entry per test rather than per result, taking the LAST result's status: the earlier ones are
// retries, and a spec that failed once and passed on the retry is reported by Playwright itself as
// having passed. Anything other than "passed" (or the test-level "expected") is read as failed,
// except "skipped" — so `timedOut` and `interrupted` are failures, which is what they are.
function parsePlaywrightReport(text) {
  let doc = null;
  try { doc = JSON.parse(String(text || '')); } catch (e) { return { error: `it is not readable JSON (${e.message})` }; }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.suites)) {
    return { error: 'it has no top-level "suites" array' };
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  const entries = [];
  const walk = (suite, inherited) => {
    if (!suite || typeof suite !== 'object') return;
    const file = suite.file || inherited || null;
    for (const spec of list(suite.specs)) {
      const name = String((spec && spec.title) || '');
      const specFile = (spec && spec.file) || file || null;
      const tests = list(spec && spec.tests);
      if (!tests.length) {
        entries.push({ file: specFile, name, status: spec && spec.ok === true ? 'passed' : 'failed' });
        continue;
      }
      for (const one of tests) {
        const results = list(one && one.results);
        const last = results.length ? results[results.length - 1] : null;
        const raw = (last && last.status) || (one && one.status) || null;
        entries.push({ file: specFile, name, status: playwrightStatus(raw) });
      }
    }
    for (const child of list(suite.suites)) walk(child, file);
  };
  for (const suite of doc.suites) walk(suite, null);
  return { entries };
}

function playwrightStatus(raw) {
  const status = String(raw || '').toLowerCase();
  if (status === 'passed' || status === 'expected') return 'passed';
  if (status === 'skipped') return 'skipped';
  return 'failed';
}

export function parseReport(text, format) {
  if (format === 'junit') return parseJUnitReport(text);
  if (format === 'tap') return parseTapReport(text);
  return parsePlaywrightReport(text);
}

// ---- matching a promise's pairing to what the report says --------------------------------------
//
// Two rules, because a promise's pairing is one of two shapes and they prove different things.
//
// FILE-LEVEL — a `mirror` pairing (a test file named after the promise), a `self` pairing (the
// promise document is itself what runs) — proves "this whole file ran and everything in it
// passed". So the report must carry at least one case attributed to that file, and every case
// attributed to it must have passed.
//
// CASE-LEVEL — a `named` pairing, `evidence: <file>#<case name>` — proves "this one case ran and
// passed", inside a file that may hold other cases the promise says nothing about. So the report
// must carry a case of that name, attributed to that file where the format can say, and every
// such case must have passed. Other cases in the same file are not this promise's business.
//
// The fourth pairing, an accepted artefact, is not checked here at all and never refuses: nothing
// runs an artefact, so there is nothing a runner's report could ever say about it. A live promise
// with no pairing at all is not checked either — "nothing keeps this promise" is the evidence
// layer's own question and the evidence guard's, not a question about whether a run happened.

// Every spelling of "a file extension" and "a generic test-file tail" this drops before comparing.
// Closed lists, on purpose: an unrecognised suffix simply stays as one more segment to match on,
// which can only make the comparison stricter, never looser.
const REPORT_FILE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'go', 'java', 'kt', 'kts', 'rb', 'rs',
  'cs', 'php', 'swift', 'scala', 'groovy', 'feature', 'sh', 'ex', 'exs', 'dart', 'md',
]);
const REPORT_GENERIC_TAILS = new Set(['test', 'tests', 'spec', 'specs', 'e2e', 'it', 'testcase']);

// A file attribution — from anywhere, in any spelling — cut into segments that can be compared.
// Windows separators folded to "/", a leading "./" dropped, then split on BOTH "/" and "." so a
// dotted JUnit class name (`promises.adds-two-numbers.test`) and a real path
// (`promises/adds-two-numbers.test.mjs`) come out as the same segments; any trailing extension and
// any trailing generic test word are then dropped so the two genuinely match. Lower-cased,
// because JUnit writers case these fields freely and two test files differing only in case is not
// a thing this would rather refuse a real green run over.
function attributionSegments(value) {
  const cleaned = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned) return [];
  const parts = cleaned.split(/[/.]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  while (parts.length > 1 && REPORT_FILE_EXTENSIONS.has(parts[parts.length - 1])) parts.pop();
  while (parts.length > 1 && REPORT_GENERIC_TAILS.has(parts[parts.length - 1])) parts.pop();
  return parts;
}

function endsWithSegments(longer, shorter) {
  if (!shorter.length || shorter.length > longer.length) return false;
  const offset = longer.length - shorter.length;
  return shorter.every((segment, i) => longer[offset + i] === segment);
}

// A report entry is attributed to a file when one of the two segment lists ENDS WITH the other.
// Deliberately generous in exactly one direction — depth — because that is the only axis writers
// disagree on: an absolute path (`/build/repo/promises/adds-two-numbers.test.mjs`), a
// repo-relative one, a path relative to some inner root (`adds-two-numbers.test.mjs`) and a bare
// class name (`adds-two-numbers`) are all the same file, and a rule demanding one spelling would
// refuse real green runs. It is not generous sideways: `tests/foo` and `promises/foo` are two
// different files and neither ends with the other.
export function sameFile(attribution, file) {
  const a = attributionSegments(attribution);
  const b = attributionSegments(file);
  if (!a.length || !b.length) return false;
  return endsWithSegments(a, b) || endsWithSegments(b, a);
}

// A report entry's name matches a declared case name when it IS that name, or when it ends with
// it after a separator — runners prefix a case with its suite path in several spellings (`>`, `›`,
// `»`, `::`) and some simply join them with a space. Anchored at the end, never a substring
// search anywhere in the middle.
const CASE_PATH_SEPARATORS = '>›»:|·';
export function sameCase(entryName, declared) {
  const name = String(entryName || '').trim();
  const want = String(declared || '').trim();
  if (!want) return false;
  if (name === want) return true;
  if (name.length <= want.length || !name.endsWith(want)) return false;
  const before = name[name.length - want.length - 1];
  return /\s/.test(before) || CASE_PATH_SEPARATORS.includes(before);
}

// The last thing left when a report carries no file attribution ANYWHERE — which is every TAP
// stream, by the format's own shape. A file can then only be looked for by the name of the case
// inside it, so this compares the paired file's own stem with a case name, both flattened to
// lower-case words: `promises/adds-two-numbers.test.mjs` matches a case called `adds two numbers`,
// `adds-two-numbers` or `Adds Two Numbers`.
//
// That is a convention, not an attribution — the `promises` package's own mirror pairing names the
// test after the promise — and the refusal below says so, because a repository that wants this
// checked exactly should either pair by `<file>#<case name>`, where the name is declared instead
// of inferred, or have its gate write JUnit XML or Playwright's JSON, both of which carry the file.
function flattenWords(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fileStemWords(file) {
  return flattenWords(stemOf(file).replace(/\.(?:test|spec|it)$/i, ''));
}

// The cases a report attributes to one file, by the two rules above: the file itself, wherever the
// report names files at all; and only when it names none anywhere, the case named after the file's
// stem. One rule for both readers of a report — a promise's file-level pairing below, and the revert
// test's whole-command fallback, which asks whether a failing case came from the file it ran.
function casesAttributedTo(entries, file) {
  if (entries.some((e) => e.file)) return entries.filter((e) => e.file && sameFile(e.file, file));
  const stem = fileStemWords(file);
  return stem ? entries.filter((e) => flattenWords(e.name) === stem) : [];
}

// Why this promise has no clean run in the report, as one sentence — or null when it has one.
// `reportNamesFiles` is a fact about the parsed report rather than about the configured format: a
// JUnit writer that emits neither `file` nor `classname` is in exactly TAP's position and is told
// so in the same words.
function promiseReportMiss(entries, reportNamesFiles, promise) {
  const file = promise.keptBy;
  const wanted = promise.pairing.caseName;

  if (wanted) {
    const named = entries.filter((e) => sameCase(e.name, wanted));
    if (!named.length) return `no case named "${wanted}" is in the report at all (${promise.path} pairs it as ${file}#${wanted})`;
    const withFile = named.filter((e) => e.file);
    let used = named;
    if (withFile.length) {
      const inFile = withFile.filter((e) => sameFile(e.file, file));
      if (!inFile.length) {
        const seen = [...new Set(withFile.map((e) => e.file))].slice(0, 3).join(', ');
        return `the report has a case named "${wanted}", but none of them under ${file} — it is filed under ${seen}`;
      }
      used = inFile;
    }
    const bad = used.find((e) => e.status !== 'passed');
    return bad ? `"${wanted}" is in the report as ${bad.status}, not passed` : null;
  }

  if (reportNamesFiles) {
    const inFile = casesAttributedTo(entries, file);
    if (!inFile.length) return `nothing in the report is attributed to ${file}, which is what keeps it — so far as the runner's own record goes, it did not run`;
    const bad = inFile.find((e) => e.status !== 'passed');
    return bad ? `${file} is in the report with "${bad.name}" ${bad.status}, not passed` : null;
  }

  const stem = fileStemWords(file);
  if (!stem) {
    return `this report carries no file attribution at all, and ${file} leaves no name to look one up by either. Pair the promise as "<file>#<case name>", or have the gate write junit or playwright-json — both carry the file`;
  }
  const byName = casesAttributedTo(entries, file);
  if (!byName.length) {
    return `this report carries no file attribution at all, so ${file} could only be looked for by name, and no case in it is named "${stem}". Pair the promise as "<file>#<case name>", or have the gate write junit or playwright-json — both carry the file`;
  }
  const bad = byName.find((e) => e.status !== 'passed');
  return bad ? `the case named after ${file} is in the report as ${bad.status}, not passed` : null;
}

// What the item says when a report is configured and there is nevertheless nothing in this tree
// for it to require — the same "empty is not a finding" discipline the `promises` package's own
// has-evidence rule takes, said out loud rather than reported as a pass over nothing.
function nothingToRequire(all, live) {
  if (!all.length) return 'there are no promises here to require a case for';
  if (!live.length) return `none of this repository's ${all.length} promise(s) reads "implemented"`;
  const artefact = live.filter((p) => p.pairing.kind === 'artefact').length;
  const unpaired = live.filter((p) => !p.keptBy).length;
  const bits = [];
  if (artefact) bits.push(`${artefact} kept by an accepted artefact, which no runner runs`);
  if (unpaired) bits.push(`${unpaired} with nothing paired to them at all`);
  return `no live promise here has a case a runner could have run (${bits.join('; ')})`;
}

// The whole of item 5's second half, as one sentence the gate item carries. Called only after the
// gate command has returned, green or red alike: a report can name a skipped case under a command
// whose own exit code was 0, and that is the exact thing this exists to catch.
function gateReportVerdict(cfg, worktree) {
  const conf = gateReportConfig(cfg);
  if (!conf.configured) {
    return {
      ok: true,
      note: `report: no report configured — nothing here confirms any promise's paired case actually ran (horde.mjs config set gates.report.path "<file the gate writes>" and gates.report.format ${REPORT_FORMATS.join('|')})`,
    };
  }
  if (conf.error) return { ok: false, note: `report: ${conf.error}` };

  const all = promisesIn(worktree, cfg);
  const live = all.filter((p) => p.live);
  const runnable = live.filter((p) => p.keptBy && p.pairing.kind !== 'artefact');
  if (!runnable.length) {
    return { ok: true, note: `report: ${conf.path} (${conf.format}) not read — ${nothingToRequire(all, live)}` };
  }

  const abs = join(worktree, conf.path);
  if (!existsSync(abs)) {
    return {
      ok: false,
      note: `report: config.gates.report names ${conf.path} and the gate command left no such file in the tree it ran in, so ${runnable.length} live promise(s) have a paired case with nothing to show it ran. Either the command does not write the report, or it writes it elsewhere — check the runner's own reporter setting, or point config.gates.report.path at where the file actually lands`,
    };
  }
  const parsed = parseReport(readText(abs), conf.format);
  if (parsed.error) return { ok: false, note: `report: ${conf.path} does not read as ${conf.format} — ${parsed.error}` };

  const entries = parsed.entries;
  const reportNamesFiles = entries.some((e) => e.file);
  const misses = [];
  for (const promise of runnable) {
    const miss = promiseReportMiss(entries, reportNamesFiles, promise);
    if (miss) misses.push(`${promise.id}: ${miss}`);
  }
  if (misses.length) {
    return {
      ok: false,
      note: `report: ${conf.path} (${conf.format}) shows no clean run for ${misses.length} of ${runnable.length} live promise(s) — ${misses.join('; ')}`,
    };
  }
  return {
    ok: true,
    note: `report: ${conf.path} (${conf.format}) — all ${runnable.length} live promise(s) ran and passed in it (${entries.length} case(s) read)`,
  };
}

// ---- the prototype guard ---------------------------------------------------------------
//
// A prototype is built to be looked at and answered, never kept: nothing verified it, which is
// exactly what it is for, and its only evidence is the client saying "yes, that is what I meant"
// — recorded against the charter row it describes, not earned through anything here. The trunk is
// the line every later ticket is cut from, so it is the one place such a branch may not reach: a
// prototype merged there would put unverified code under work nobody chose to build on it.
//
// It lives on `<horde>/prototype` instead, cut from it by queue.mjs and merged back into it by
// this gate — and nothing merges that branch onward. This refuses rather than reporting a red
// item, for the same reason the law guard does: a worker cannot fix it by trying again, and the
// answer is to re-cut the branch, not to change the diff.
function prototypeGuard(horde, kind, ticketId, branch, parent) {
  if (kind !== 'prototype') return parent.branch;
  const proto = prototypeBranchOf(horde);
  // A prototype stacked on another ticket is already off the trunk and on that ticket's branch;
  // the stack decided the base when the branch was cut, and this has nothing to correct.
  if (parent.stacked) return parent.branch;
  const rooted = git(['rev-parse', '--verify', proto]) !== null
    && git(['merge-base', '--is-ancestor', proto, branch]) !== null;
  if (!rooted) {
    fail(
      `${ticketId} is a prototype, and ${branch} is not cut from ${proto} — a prototype never merges into `
      + `${parent.teamBranch}. What it is for is to be shown and answered: nothing verified it, and the trunk is `
      + `what every later ticket is cut from. Cut ${proto} off ${parent.teamBranch} if it does not exist yet, `
      + `re-cut ${branch} from it, and land again. Its answer is recorded with "tk.mjs accept ${ticketId}", not here`,
    );
  }
  return proto;
}

// ---- landing ---------------------------------------------------------------------------
//
// The merge itself, which no script in this tool used to do. It happens in a throwaway detached
// tree at the parent's tip, so no worktree anyone is sitting in is disturbed and a conflict costs
// nothing but that tree — and then the parent branch is moved to what the merge produced, with the
// sha it started from named, so a parent that moved under the run refuses instead of overwriting.
//
// When the parent branch IS checked out somewhere, the merge lands there instead: moving the ref
// under a checkout would leave that tree holding a working copy of a commit it is no longer on.
// A checkout with uncommitted work in it is refused rather than merged into.
function worktreeOn(root, branch) {
  const out = git(['worktree', 'list', '--porcelain'], root) || '';
  for (const block of out.split(/\n\n+/)) {
    const wt = /^worktree (.+)$/m.exec(block);
    const br = /^branch refs\/heads\/(.+)$/m.exec(block);
    if (wt && br && br[1] === branch) return wt[1];
  }
  return null;
}

function conflictingFiles(tree) {
  return diffPaths(['diff', '--name-only', '--diff-filter=U'], tree);
}

// ---- the family's known conflicts, resolved by rule ----------------------------------------------
//
// Parallel tickets on one node collide in the same few files every time: the node's own `log.md`
// (both appended an entry), Yggdrasil's committed lock files (both recorded verdicts), and the
// repository's append-only files such as a CHANGELOG (both added a line under the same heading).
// None of those collisions is a question anybody has to answer, and refusing them as stale sends a
// ticket round a loop no role can end. So a merge that stops on nothing but these is finished here,
// by the rule for each kind, in the order Yggdrasil documents for its own files:
//
//   yg-lock.*.json   the parent's side, whole. A verdict the other side held is judged again by
//                    whatever next runs `yg check --approve`; a lock is never stitched by hand.
//   node log.md      `yg log merge-resolve --node <n>`: the union of both sides, verified, with the
//                    node's baseline recorded in `yg-lock.logs.json`.
//   config.appendOnly  accepted only when both sides did nothing but add lines to the common base;
//                    the result is the base with the parent's additions and then the branch's at
//                    each place lines were added. A deletion or an edit on either side is refused.
//
// Anything else in conflict leaves the merge to be refused exactly as before. Nothing here weakens
// a rule, a proof or a gate: entries are appended and a lock is re-judged, never edited.

function stageText(tree, stage, path) {
  try {
    return execFileSync('git', ['show', `:${stage}:${path}`], { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  } catch {
    return null;
  }
}

// The lines `side` adds to `base`, keyed by the base line they are inserted before (base.length for
// the end), or null when `side` also removed or changed a base line. One insertion is read off the
// common prefix and suffix; several fall back to matching the base in order through the side.
function insertionsOver(base, side) {
  let p = 0;
  while (p < base.length && p < side.length && base[p] === side[p]) p += 1;
  let s = 0;
  while (s < base.length - p && s < side.length - p && base[base.length - 1 - s] === side[side.length - 1 - s]) s += 1;
  if (p + s === base.length) {
    return new Map(side.length > base.length ? [[p, side.slice(p, side.length - s)]] : []);
  }
  const added = new Map();
  let j = 0;
  for (let i = 0; i <= base.length; i += 1) {
    const from = j;
    if (i < base.length) {
      while (j < side.length && side[j] !== base[i]) j += 1;
      if (j === side.length) return null;
    } else {
      j = side.length;
    }
    if (j > from) added.set(i, side.slice(from, j));
    if (i < base.length) j += 1;
  }
  return added;
}

// The pure-addition merge of one append-only file: null when either side did more than add lines.
export function appendOnlyMerge(baseText, parentText, branchText) {
  const base = String(baseText || '').split('\n');
  const parent = insertionsOver(base, String(parentText).split('\n'));
  const branch = insertionsOver(base, String(branchText).split('\n'));
  if (!parent || !branch) return null;
  const out = [];
  for (let i = 0; i <= base.length; i += 1) {
    out.push(...(parent.get(i) || []), ...(branch.get(i) || []));
    if (i < base.length) out.push(base[i]);
  }
  return out.join('\n');
}

// resolveKnownConflicts(tree, cfg, parentSide) — in a tree stopped mid-merge, resolve every
// conflicted file by the rule for its kind and stage it. `parentSide` names which side of this
// merge is the parent branch: 'theirs' when the parent is being brought into a ticket's branch,
// 'ours' when a ticket's branch is being merged onto the parent. Returns {ok: true, resolved} with
// the index ready to commit, or {ok: false, left, note} naming the files no rule covers (or the
// one a rule refused) — the caller aborts the merge, so nothing written here survives a refusal.
function resolveKnownConflicts(tree, cfg, parentSide) {
  const files = conflictingFiles(tree);
  if (!files.length) return { ok: false, left: [], note: 'git named no conflicted file' };
  const left = files.filter((f) => !mergesByRule(f, cfg));
  if (left.length) return { ok: false, left, note: null };
  const resolved = [];
  const branchStage = parentSide === 'theirs' ? 2 : 3;
  const parentStage = parentSide === 'theirs' ? 3 : 2;
  for (const f of files.filter((x) => YG_LOCK_FILE.test(x))) {
    if (git(['checkout', `--${parentSide}`, '--', f], tree) === null || git(['add', '--', f], tree) === null) {
      return { ok: false, left: [f], note: `could not take the parent's side of ${f}: ${gitError()}` };
    }
    resolved.push({ file: f, how: 'lock: the parent\'s side, whole' });
  }
  for (const f of files.filter((x) => !YG_LOCK_FILE.test(x) && !NODE_LOG_FILE.test(x))) {
    const parentText = stageText(tree, parentStage, f);
    const branchText = stageText(tree, branchStage, f);
    const merged = parentText === null || branchText === null ? null : appendOnlyMerge(stageText(tree, 1, f) || '', parentText, branchText);
    if (merged === null) return { ok: false, left: [f], note: `${f} is append-only, and one side did more than add lines to it` };
    writeFileSync(join(tree, f), merged);
    if (git(['add', '--', f], tree) === null) return { ok: false, left: [f], note: `could not stage ${f}: ${gitError()}` };
    resolved.push({ file: f, how: 'append-only: both sides\' additions kept' });
  }
  const logs = files.filter((x) => NODE_LOG_FILE.test(x));
  for (const f of logs) {
    const node = nodeOfLogFile(f);
    const res = node ? ygLogMergeResolve(cfg, tree, node) : { ok: false, out: 'not a node log' };
    if (!res.ok || git(['add', '--', f], tree) === null) {
      return { ok: false, left: [f], note: `\`yg log merge-resolve --node ${node}\` did not resolve ${f}${res.out ? `: ${res.out.split('\n')[0]}` : ''}` };
    }
    resolved.push({ file: f, how: 'node log: yg log merge-resolve' });
  }
  if (logs.length && existsSync(join(tree, '.yggdrasil', 'yg-lock.logs.json'))) git(['add', '--', '.yggdrasil/yg-lock.logs.json'], tree);
  if (conflictingFiles(tree).length) return { ok: false, left: conflictingFiles(tree), note: 'files still in conflict after the rules ran' };
  return { ok: true, resolved };
}

function resolvedLine(resolved) {
  return resolved.map((r) => `${r.file} (${r.how})`).join(', ');
}

// mergeResolving(tree, cfg, ref, message, parentSide) — `git merge --no-ff -m <message> <ref>` in
// `tree`, finishing it by rule when it stops only on the known kinds of conflict. On a refusal the
// merge is aborted and the tree is back where it was: {ok: false, files} names what no rule covers.
function mergeResolving(tree, cfg, ref, message, parentSide, { byRule = true, expectTree = null } = {}) {
  try {
    execFileSync('git', ['merge', '--no-ff', '-m', message, ref], { cwd: tree, stdio: 'pipe' });
    return { ok: true, resolved: [] };
  } catch (e) {
    let outcome;
    try {
      outcome = byRule ? resolveKnownConflicts(tree, cfg, parentSide) : { ok: false, left: [], note: null };
      if (outcome.ok && expectTree) {
        const written = git(['write-tree'], tree);
        if (written !== expectTree) {
          outcome = { ok: false, left: outcome.resolved.map((r) => r.file), note: 'resolved differently from the tree the shared gate measured' };
        }
      }
      if (outcome.ok && git(['commit', '-m', message], tree) === null) {
        outcome = { ok: false, left: outcome.resolved.map((r) => r.file), note: `the resolved merge could not be committed: ${gitError()}` };
      }
    } catch (err) {
      outcome = { ok: false, left: [], note: String((err && err.message) || err) };
    }
    if (!outcome.ok) {
      let files = outcome.left && outcome.left.length ? outcome.left : [];
      try { if (!files.length) files = conflictingFiles(tree); } finally { git(['merge', '--abort'], tree); }
      return {
        ok: false, files, note: outcome.note, out: ((e.stdout && e.stdout.toString()) || '').trim(),
      };
    }
    return { ok: true, resolved: outcome.resolved };
  }
}

// A branch whose parent moved while it waited to land — a sibling landed first — is not wrong, only
// behind. Landing used to run the whole gate on it anyway, come back red on base freshness alone and
// hand the ticket a fix round for work nothing was wrong with. So the parent is merged into the
// branch first: cleanly, or with conflicts only in the files that merge by rule (see "the family's
// known conflicts" above), the branch is brought up to date and this landing goes on with it, once;
// with any other conflict the merge is aborted, the branch is left exactly as it was, and the caller
// refuses it as stale — before any gate, and with nobody to blame for a round.
//
// Done where the branch is checked out when it is (a landed ticket's worktree, refused when it holds
// uncommitted changes to tracked files), and in a scratch tree otherwise, moving the branch only if
// it still stands where this started.
function pullParentIntoBranch(root, cfg, branch, parentBranch, branchSha) {
  const message = `Merge ${parentBranch} into ${branch}\n\nThe parent moved while this ticket waited to land; it is brought in so the gate measures what will merge.`;
  const refuse = (files, extra) => ({
    ok: false,
    conflict: files.length > 0,
    files,
    note: `merging ${parentBranch} into ${branch} ${files.length ? `conflicts in ${files.join(', ')}` : 'could not be done'}${extra ? ` — ${extra}` : ''}; ${branch} is untouched`,
  });
  const byRule = (merged) => (merged.resolved.length ? ` — conflicts resolved by rule: ${resolvedLine(merged.resolved)}` : ' — a conflict-free merge');
  const checkout = worktreeOn(root, branch);
  if (checkout) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], checkout);
    if (dirty === null || dirty !== '') return refuse([], `${branch} is checked out at ${checkout} with uncommitted changes to tracked files, so the parent was not brought in there`);
    const merged = mergeResolving(checkout, cfg, parentBranch, message, 'theirs');
    if (!merged.ok) return refuse(merged.files, merged.note);
    return {
      ok: true, sha: git(['rev-parse', '--verify', branch], root), resolved: merged.resolved, note: `brought ${parentBranch} into ${branch}${byRule(merged)}, made at ${checkout}`,
    };
  }
  const info = resolveTree({ scratch: branchSha }, { cwd: root });
  try {
    const merged = mergeResolving(info.path, cfg, parentBranch, message, 'theirs');
    if (!merged.ok) return refuse(merged.files, merged.note);
    const sha = git(['rev-parse', 'HEAD'], info.path);
    if (git(['update-ref', `refs/heads/${branch}`, sha, branchSha], root) === null) return refuse([], `${branch} moved while the parent was being brought in`);
    return {
      ok: true, sha, resolved: merged.resolved, note: `brought ${parentBranch} into ${branch}${byRule(merged)}`,
    };
  } finally {
    cleanupTree(info, root);
  }
}

// ---- trailers -----------------------------------------------------------------------------
//
// Who worked what, and when, belongs to git — not to `.horde/`, which is uncommitted and gone the
// moment a checkout is thrown away. So the merge commit this tool writes carries the three facts
// that outlive the horde: the ticket it landed, the evidence rows it earned, and what it did to
// the law. `blame.mjs` then reads the edge commit → ticket straight off the commit instead of
// reconstructing it from three places in `.horde/`.
//
// Ordinary git trailers, so `git interpret-trailers` and every tool that already reads them work
// unchanged: one blank line after the subject, then `Key: value` lines. A value is put through
// `trailerValue` first — a newline inside one would end the trailer block early and silently drop
// every line after it, whereas a colon or a non-ASCII character is ordinary content that only a
// parser splitting on the LAST colon, or assuming ASCII, could get wrong (this file's reader, and
// blame.mjs's, both split on the first).
//
// This is the only place trailers are written, because 015 made this the only place a merge commit
// is made at all. An adopter whose history already has its own convention for this is the case to
// watch: adopt theirs and say so, rather than writing a second, competing one beside it.
function trailerValue(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

function renderTrailers(entries) {
  return entries
    .filter(([, value]) => trailerValue(value).length > 0)
    .map(([key, value]) => `${key}: ${trailerValue(value)}`);
}

// What the branch did to the law, read off the files it changed: a rule's own directory under
// `.yggdrasil/aspects/<id>/` appearing is a rule added, and a change inside one that was already
// there is a rule changed. Read from the diff rather than by asking Yggdrasil twice — the gate has
// already run `yg check` on this tree, and the question here is only which rules the diff touched.
function lawTrailers(root, branch, parentBranch) {
  const rows = (git(['diff', '--name-status', `${parentBranch}...${branch}`], root) || '')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const byAspect = new Map();
  for (const row of rows) {
    const [status, ...rest] = row.split(/\t/);
    const m = /^\.yggdrasil\/aspects\/([^/]+)\//.exec(rest[rest.length - 1] || '');
    if (!m) continue;
    const added = status.startsWith('A');
    const seen = byAspect.get(m[1]);
    // One rule, one line: a rule whose diff both adds and edits files is a rule this branch added.
    if (!seen || added) byAspect.set(m[1], added ? 'added' : 'changed');
  }
  return [...byAspect.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, what]) => ['Law', `${id} ${what}`]);
}

function mergeMessage(root, horde, branch, parentBranch, ticketId) {
  const ticket = findTicket(horde, ticketId);
  const evidence = ticket ? ticketEvidence(ticket.text) : [];
  const trailers = renderTrailers([
    // `t-001`, not the bare `001` this tool passes around internally: the trailer is read in git
    // log, months later, beside trailers from every other tool an adopter runs, and a bare number
    // there says nothing. It is the same shape the ticket's own branch carries.
    ['Ticket', `t-${ticketId}`],
    // A ticket that earned no catalogue row gets no Evidence line at all — an empty one would read
    // as "this landed proving nothing", which is a different and false claim.
    ['Evidence', evidence.join(', ')],
    ...lawTrailers(root, branch, parentBranch),
  ]);
  return `merge ${ticketId}: ${branch}\n\n${trailers.join('\n')}\n`;
}

// `resolve` (a batch member only): the shared gate measured a preview tree where this member's
// conflicts in the files that merge by rule were resolved by rule, so the real merge resolves them the
// same way — and refuses unless the result is byte for byte the tree that gate measured
// (`expectTree`). A single ticket never needs it: its parent was brought in before it was measured.
function mergeIntoParent(root, cfg, branch, parentBranch, parentTip, ticketId, cleaner, horde, { resolve = false, expectTree = null } = {}) {
  // Derived from the ticket and from the diff, and from nothing about this run — so a merge an
  // adopter's commit hook rejects costs the commit nothing: the next landing builds the same
  // trailers, byte for byte, rather than a shorter message the second time round.
  const message = mergeMessage(root, horde, branch, parentBranch, ticketId);
  const checkout = worktreeOn(root, parentBranch);
  // A refused merge is aborted inside mergeResolving — `checkout` is a real tree this landing did not
  // make (unlike the scratch tree below, nothing here throws it away), so leaving it mid-merge on top
  // of the conflict would strand it for whoever works there next.
  const refused = (merged) => ({
    ok: false,
    conflict: true,
    files: merged.files,
    note: `the merge into ${parentBranch} conflicts and was aborted — ${parentBranch} is untouched at ${short(parentTip)}. In conflict: ${merged.files.length ? merged.files.join(', ') : merged.out}${merged.note ? ` (${merged.note})` : ''}. Catch the branch up with ${parentBranch}, resolve it there, and land again`,
  });
  const byRule = (merged) => (merged.resolved.length ? ` — resolved by rule: ${resolvedLine(merged.resolved)}` : '');

  if (checkout) {
    // Only what git is tracking counts. An adopter's root is full of untracked files nobody
    // asked for (`yg init` writes agent rules there), and a merge that would actually clobber an
    // untracked file is refused by git itself, below, naming the file.
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], checkout);
    if (dirty === null) return { ok: false, note: `${parentBranch} is checked out at ${checkout}, and that tree could not be read` };
    if (dirty !== '') {
      return {
        ok: false,
        note: `${parentBranch} is checked out at ${checkout} with uncommitted changes to ${dirty.split('\n').length} tracked file(s), and the merge has to happen there — a landing will not move a branch out from under a working tree that has work in it. Commit or stash what is in ${checkout}, then land again`,
      };
    }
    const merged = mergeResolving(checkout, cfg, branch, message, 'ours', { byRule: resolve, expectTree });
    if (!merged.ok) return refused(merged);
    return { ok: true, sha: git(['rev-parse', parentBranch], root), note: `merged --no-ff into ${parentBranch} at ${checkout}${byRule(merged)}` };
  }

  const info = resolveTree({ scratch: parentTip }, { cwd: root });
  cleaner.add(() => cleanupTree(info, root));
  const merged = mergeResolving(info.path, cfg, branch, message, 'ours', { byRule: resolve, expectTree });
  if (!merged.ok) return refused(merged);
  const sha = git(['rev-parse', 'HEAD'], info.path);
  // The old value is named, so a parent that moved while this ran refuses here instead of
  // silently discarding whatever landed on it in the meantime.
  if (git(['update-ref', `refs/heads/${parentBranch}`, sha, parentTip], root) === null) {
    return {
      ok: false,
      note: `${parentBranch} moved while this landing ran — it is no longer at ${short(parentTip)}, so the merge built on that tip was not applied. Nothing was changed; land again against the branch as it stands now`,
    };
  }
  return { ok: true, sha, note: `merged --no-ff into ${parentBranch}${byRule(merged)}` };
}

// ---- the background result file -------------------------------------------------------

function resultPath(horde, ticketId) {
  return hordePath(horde, 'land', `${ticketId}.json`);
}

// A result file is written whole or not read at all: a run killed mid-write leaves a truncated
// JSON document, and a reader that crashed on it would turn one dead process into a stuck queue.
// Unparsable reads as absent, which means the gate simply runs again — the one answer that is
// always safe, since this file is a record of a run and never a substitute for one.
export function readLandResult(horde, ticketId) {
  const path = resultPath(horde, ticketId);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.ticket ? parsed : null;
  } catch {
    return null;
  }
}

function writeLandResult(horde, ticketId, result) {
  writeJSON(resultPath(horde, ticketId), result);
}

// ---- how loaded the landing gate is ------------------------------------------------------
//
// Landings are serial: one gate at a time, whatever the number of workers. Whoever runs the horde
// sees the queue grow and a wave that does not move, and nothing says the gate is the reason. This
// reads what the gate has already recorded about itself — each result file's own timing — and sets
// it against the number of branches waiting for it. It measures and reports; it holds nothing back
// and decides nothing, and it has no limit of its own to compare against: what counts as too long
// is the director's call, made from these numbers.
//
// A batch runs its gate once for the whole group, so a member's share is the shared time over the
// group size — otherwise a batch of four would be read as four slow landings instead of one.
export function landingLoad(horde, items) {
  const ready = (items || []).filter((i) => i.state === 'landed').length;
  const dir = hordePath(horde, 'land');
  const samples = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const result = readLandResult(horde, name.slice(0, -'.json'.length));
    const timing = result && result.timing;
    if (!timing || !Number.isFinite(timing.gateMs)) continue;
    let at = 0;
    try {
      at = statSync(join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    samples.push({ at, ms: timing.gateMs / Math.max(1, Number(timing.sharedBy) || 1) });
  }
  if (!samples.length) return { ready, measured: 0, lastMs: null, meanMs: null, maxMs: null, forecastMs: null };
  samples.sort((a, b) => a.at - b.at);
  const all = samples.map((x) => x.ms);
  const meanMs = Math.round(all.reduce((a, b) => a + b, 0) / all.length);
  return {
    ready,
    measured: all.length,
    lastMs: Math.round(all[all.length - 1]),
    meanMs,
    maxMs: Math.round(Math.max(...all)),
    forecastMs: ready * meanMs,
  };
}

export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function landingLine(load) {
  const waiting = `${load.ready} branch(es) ready to land`;
  if (!load.measured) return `landing: ${waiting}; no gate time measured yet`;
  const forecast = load.ready ? `; about ${formatDuration(load.forecastMs)} if landed one after another` : '';
  return `landing: ${waiting}; gate per landing: last ${formatDuration(load.lastMs)}, mean ${formatDuration(load.meanMs)} over ${load.measured} run(s), max ${formatDuration(load.maxMs)}${forecast}`;
}

// ---- what became of a ticket after it landed ---------------------------------------------
//
// A landing was the end of the record and is not the end of the story. Two things happen to merged
// work and left no trace anywhere: the merge is REVERTED, or the evidence row the ticket claimed to
// turn green goes red again and a new ticket is filed to earn it back — the ticket is REOPENED. A
// return is the plainest signal there is that the evidence was not enough, and until it is written
// down the wave close reports a merge that no longer stands and the retrospective never hears of it.
//
// It is written in the two places the landing itself is written: the ticket's own result file, and
// the wave journal. Nowhere else, and nothing in the queue moves. A fate is a record of what
// happened to work that landed, not a state the ticket goes back into — the merge commit still
// exists (a revert is another commit on top of it), and a reopening is its own ticket with its own
// queue item and its own landing ahead of it.
//
// Both fates name what carries them, and both references are checkable by whoever reads the record
// later: a revert names the commit that undid the merge, and a reopening names the ticket that says
// so itself in its "**Reopens:**" field. Neither is taken on the caller's word.
export const FATES = ['reverted', 'reopened'];

// The result file as a fate can extend it: the gate's own document when the gate wrote one, and a
// bare record naming the ticket when the merge was recorded by hand and there is no run to extend.
// Either way the fate lands in the same field of the same file, so one reader finds every fate.
function landResultForFate(horde, ticketId) {
  const existing = readLandResult(horde, ticketId);
  return existing || { ticket: String(ticketId) };
}

// recordFate(horde, team, ticketId, fate, by) — the fate on the result file and in the journal, in
// one call, because it is one event. Idempotent in both places: the same fate carried by the same
// thing is recorded once however many times it is reported.
export function recordFate(horde, team, ticketId, fate, by) {
  const doc = landResultForFate(horde, ticketId);
  const fates = asArray(doc.fates);
  const already = fates.some((f) => f && f.fate === fate && String(f.by) === String(by));
  const entry = { fate, by: String(by), at: nowIso() };
  if (!already) {
    writeLandResult(horde, ticketId, { ...doc, fates: [...fates, entry] });
  }
  const journal = noteFate(horde, team, ticketId, fate, String(by));
  return {
    ticket: String(ticketId), fate, by: String(by), recorded: !already, entry, journal,
  };
}

// `land.mjs <ticket> --fate reverted|reopened --by <ref>`. Not a gate run at all: nothing is
// measured, nothing is merged, and the ticket's branch is long gone by the time anybody reaches
// for this. It is the one command that writes what happened AFTER a landing.
function runFate(horde, root, arg, flags) {
  const fate = String(flags.fate);
  if (!FATES.includes(fate)) fail(`--fate must be one of: ${FATES.join(', ')}`);
  const found = findQueueItem(horde, arg);
  if (!found) fail(`no queue item names ${arg} — a fate says what became of work this horde landed, so the ticket has to be one it tracks`);
  const { team, item } = found;
  const ticketId = String(item.ticket);
  if (item.state !== 'merged') {
    fail(`t-${ticketId} is ${item.state}, not merged — "${fate}" says what became of a landing, and nothing has landed on this ticket yet`);
  }
  const rawBy = flags.by === undefined || flags.by === true ? '' : String(flags.by).trim();
  if (!rawBy) {
    fail(fate === 'reverted'
      ? `--fate reverted requires --by <sha> — the commit that undid the merge. A revert nobody can point at is a claim, and this record is only worth keeping while it is checkable`
      : `--fate reopened requires --by <ticket> — the ticket filed to earn back what t-${ticketId} claimed. A reopening with no ticket behind it is a note, not a fate`);
  }

  let by;
  if (fate === 'reverted') {
    by = git(['rev-parse', '--verify', `${rawBy}^{commit}`], root);
    if (!by) {
      fail(`--by ${rawBy}: this repository has no such commit — the revert is the evidence that the merge was undone, so it has to be one anybody reading this later can look at`);
    }
  } else {
    let reopening = null;
    try { reopening = findTicket(horde, rawBy); } catch { reopening = null; }
    if (!reopening) fail(`--by ${rawBy}: this horde has no ticket ${rawBy} — file the reopening ticket first (tk.mjs new <slug> … --reopens ${ticketId})`);
    if (reopening.id === ticketId) fail(`--by ${rawBy}: a ticket cannot reopen itself`);
    const declared = ticketReopens(reopening.text);
    if (declared !== ticketId) {
      fail(`--by ${rawBy}: t-${reopening.id} does not say it reopens t-${ticketId}${declared ? ` — it reopens t-${declared}` : ''}. A reopening is the new ticket's own claim and this record only witnesses it; file it with "tk.mjs new <slug> … --reopens ${ticketId}", or name the ticket that does`);
    }
    by = `t-${reopening.id}`;
  }

  const recorded = recordFate(horde, team, ticketId, fate, by);
  emit(recorded, flags, () => [
    `t-${ticketId} ${fate} — ${by}`,
    recorded.recorded ? `recorded in ${resultPath(horde, ticketId)}` : 'already recorded; nothing written twice',
    recorded.journal.appended ? `journal: ${recorded.journal.bullet}` : `journal already carries: ${recorded.journal.bullet}`,
  ].join('\n'));
  return recorded;
}

// This branch's size, and its rank among the mission's other open tickets. The rank comes off
// `queue.mjs plan`'s own ranking, so the landing and the plan the architect read cannot disagree
// about where this ticket sat. A plan that cannot be built right now (an unreadable graph, a
// mission mid-edit) costs the landing nothing: the size is still measured and reported, just
// without a position beside it. Nothing a landing decides depends on either.
function missionSize(horde, team, cfg, root, ticketId, parentBranch, branch) {
  try {
    const plan = buildPlan(horde, team, cfg, { tree: root });
    const mine = plan.tickets.find((t) => t.id === ticketId);
    if (mine && mine.size) return mine.size;
  } catch {
    // fall through to the unranked measurement
  }
  const measured = diffSize(parentBranch, branch, { cwd: root });
  return measured ? (sizeRanks([{ id: ticketId, size: measured }]).get(ticketId) || null) : null;
}

// ---- batching multiple tickets under one gate ------------------------------------------
//
// `run()` above is untouched by any of this — every single-ticket call, `main()`'s included,
// still reaches it directly, unchanged, so a batch of one behaves byte-for-byte as it always has.
// Everything below exists only for two or more tickets asked for in one call, and its whole job is
// to share ONE hold of the gate lock and ONE run of items 5-7 across as many of them as it safely
// can, then land each survivor exactly as `run()` would have on its own.
//
// The shape, in order:
//   1. resolveBatchCandidate  — a LENIENT, non-throwing twin of run()'s own opening section. A
//      ticket this cannot even resolve (no queue item, no branch, no parent) never aborts the
//      others in the same call the way run()'s own fail() would — it just falls to "lands alone".
//   2. groupBatchCandidates   — the batching precondition: same parent branch at the same parent
//      tip, and no changed file in common (Yggdrasil's own derived lock files never count).
//   3. screenBatchMember      — the per-ticket cheap items and both guards, run individually,
//      exactly as run() runs them, against a scratch tree built for that one ticket. A member
//      whose own check or guard already refuses never enters the shared preview tree at all — its
//      content could only spoil the shared gate for tickets that did nothing wrong, and it was
//      never going to land this round regardless of what the shared gate said.
//   4. combineBatchGroup      — the throwaway combined tree: parentTip, then each surviving
//      member's branch merged on in sequence. A merge that unexpectedly conflicts drops that one
//      ticket and continues with the rest — "declared files can lie" is the design's own words for
//      exactly this.
//   5. runSharedGate          — items 5-7 (gate, graph, mapping) plus the judge item, ONCE,
//      against the combined tree, under ONE hold of the gate lock.
//   6. green:  landBatchGreen — each survivor merged into the REAL parent individually, in
//      sequence (mergeIntoParent, unchanged, threaded through the evolving parent tip), so the
//      landing history, the size figure and the journal bullet are one per ticket, same as today.
//      red:    every survivor falls back to standalone — no bisection, ever (the design's own
//      call: worst case costs what it costs today, N runs; best case costs one).
//   7. landAlone              — the fallback, and the home for anything groupBatchCandidates or
//      screenBatchMember ever excludes: `land.mjs <ticket>` run again, as its own subprocess, with
//      nothing carried over from the batch attempt — the same command tick.mjs already runs today,
//      so a ticket landing this way is landing exactly as it always has.

// splitTickets(raw) — one bare token (today's only shape, and the only one `run()` ever sees) or a
// comma-separated list, the same convention this tool set already uses for a multi-value CLI
// argument (queue.mjs's --depends, horde.mjs's testGlobs). Blank entries and exact duplicates are
// dropped; anything else is handed on exactly as typed. A real refusal — an unknown ticket, a
// branch name that collides with nothing — is still land's own job further down, never this one's.
function splitTickets(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(',')) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// resolveBatchCandidate(horde, root, cfg, arg, level) — everything run()'s own opening section
// resolves before its first check, mirrored field for field, but never throwing: a problem that
// would be run()'s own fail() here just comes back as {ok: false, arg, note}, so one unreadable
// ticket in a batch of five costs the other four nothing. Nothing this returns IS a landing — a
// candidate it hands back ok:true still runs every one of its own checks fresh, later, exactly as
// if it had been asked for alone; this function only ever decides whether, and with whom, a ticket
// MIGHT share a gate.
function resolveBatchCandidate(horde, root, cfg, arg, level) {
  try {
    const found = findQueueItem(horde, arg);
    if (!found) return { ok: false, arg, note: `no queue item names ${arg} — is the ticket tracked by queue.mjs?` };
    const { team, teamDir, item } = found;
    const branch = item.branch;
    if (!branch) {
      return {
        ok: false, arg, note: `ticket ${item.ticket} has no branch yet — nothing to land (queue.mjs set ${item.ticket} running cuts one)`,
      };
    }
    const branchSha = git(['rev-parse', '--verify', branch]);
    if (!branchSha) {
      const detail = gitError();
      return { ok: false, arg, note: `no such branch: ${branch}${detail ? ` — ${detail}` : ''}` };
    }
    const ticketId = String(item.ticket);
    const issueDirName = findIssueDir(teamDir, ticketId);
    if (!issueDirName) return { ok: false, arg, note: `no ticket found for ${ticketId} in team ${team}` };
    const issueDirPath = join(teamDir, 'issues', issueDirName);
    const issueText = readText(join(issueDirPath, 'issue.md'));
    const logText = readText(join(issueDirPath, 'log.md'));
    const nodes = ticketNodes(issueText);
    const declaredFiles = ticketFiles(issueText);
    const kind = ticketKind(issueText);

    const parentResolved = parentBranchOf(horde, team, item, { cwd: root });
    const parentBranch = prototypeGuard(horde, kind, ticketId, branch, parentResolved);
    const parent = { ...parentResolved, branch: parentBranch };
    const parentTip = git(['rev-parse', '--verify', parentBranch]);
    if (!parentTip) {
      const detail = gitError();
      return { ok: false, arg, note: `no such branch: ${parentBranch}${detail ? ` — ${detail}` : ''}` };
    }

    const changedFiles = diffPaths(['diff', '--name-only', `${parentBranch}...${branch}`]);
    const size = missionSize(horde, team, cfg, root, ticketId, parentBranch, branch);

    return {
      ok: true,
      arg,
      ticketId,
      team,
      branch,
      branchSha,
      issueDirPath,
      issueText,
      logText,
      nodes,
      declaredFiles,
      parent,
      parentBranch,
      parentTip,
      changedFiles,
      size,
      level,
    };
  } catch (e) {
    if (e instanceof HordeError) return { ok: false, arg, note: e.message };
    throw e;
  }
}

function changedFilesOverlap(a, b) {
  if (!a.length || !b.length) return false;
  const set = new Set(a);
  return b.some((f) => set.has(f));
}

// groupBatchCandidates(candidates, cfg) — the batching precondition, applied before a single scratch
// tree is built for any of it: only candidates sharing one (parentBranch, parentTip) pair mean
// anything by "non-overlapping" — two tickets against different bases are not landing onto the
// same tree, whatever their files say. Within one such pair, a candidate whose changed files —
// leaving out the files that merge by rule (Yggdrasil's lock files, a node's log, config.appendOnly),
// which the combine step resolves — collide with one already accepted falls to the overflow list — greedy, in the order
// handed in, so which of two colliding tickets keeps its place is simply whichever came first. A
// pair with fewer than two survivors is not a batch either: nothing is shared with nobody.
function groupBatchCandidates(candidates, cfg) {
  const byKey = new Map();
  for (const ctx of candidates) {
    const key = `${ctx.parentBranch} ${ctx.parentTip}`;
    if (!byKey.has(key)) byKey.set(key, { parentBranch: ctx.parentBranch, parentTip: ctx.parentTip, candidates: [] });
    byKey.get(key).candidates.push(ctx);
  }
  const groups = [];
  const overflow = [];
  for (const g of byKey.values()) {
    const accepted = [];
    let acceptedFiles = [];
    for (const ctx of g.candidates) {
      const files = ctx.changedFiles.filter((f) => !mergesByRule(f, cfg));
      if (changedFilesOverlap(files, acceptedFiles)) { overflow.push(ctx); continue; }
      accepted.push(ctx);
      acceptedFiles = acceptedFiles.concat(files);
    }
    if (accepted.length >= 2) groups.push({ parentBranch: g.parentBranch, parentTip: g.parentTip, members: accepted });
    else overflow.push(...accepted);
  }
  return { groups, overflow };
}

// screenBatchMember(root, cfg, horde, ctx, basePath, cleaner) — items 1, 3, 4, 8, 9 and every
// guard, for one candidate, exactly as run() runs them: a scratch tree at that ticket's own
// branch tip (basePath is the group's, built once and shared — every member of a group is
// measured against the identical parent tip, so one tree read by all of them is the same reading
// run() would have made per ticket, not a shortcut). A guard refusal or a stopped guard read is
// reported the same as any other screen failure here — the caller's only question is whether this
// member may enter the shared preview tree, never why not.
function screenBatchMember(root, cfg, horde, ctx, basePath, cleaner) {
  const head = resolveTree({ scratch: ctx.branchSha }, { cwd: root });
  cleaner.add(() => cleanupTree(head, root));

  const results = {};
  results['base freshness'] = checkBaseFreshness(ctx.branch, ctx.parentBranch);
  results.scope = checkScope(root, cfg, ctx.nodes, ctx.changedFiles, ctx.declaredFiles, proposalBoundaryOf(horde, ctx.issueText, ctx.nodes));
  results['revert test'] = checkRevertTest(horde, root, cfg, ctx.branch, ctx.parentBranch, ctx.changedFiles, ctx.issueText);
  results.journal = checkJournal(ctx.logText, ctx.branch, ctx.parentBranch);
  results['graph text'] = checkGraphText(root, ctx.branch, ctx.parentBranch, ctx.changedFiles);

  const law = lawGuard(cfg, horde, basePath, head.path);
  if (law.stopped) return { ok: false, note: law.stopped };
  const refusals = [...law.refusals];
  const conflict = conflictGuard(cfg, basePath, head.path, ctx.changedFiles, law.headReach);
  refusals.push(...conflict.refusals);
  const protection = protectionGuards(cfg, horde, basePath, head.path, ctx.changedFiles);
  refusals.push(...protection.refusals);
  if (refusals.length) {
    return {
      ok: false,
      note: `${refusals.length} refusal(s) — this branch may not land as it stands:\n${refusals.map((g) => `- ${g.aspect} (${g.case}): ${g.note}`).join('\n')}`,
    };
  }
  if (!Object.values(results).every((r) => r.ok)) {
    return { ok: false, note: 'a per-ticket check already refuses this branch — excluded from the shared gate rather than spending it on content that cannot land this round', results };
  }
  return { ok: true, results, answersUsed: [...law.used, ...protection.used] };
}

// combineBatchGroup(root, cfg, group, cleaner) — step 3 of the design: one throwaway worktree at the
// group's own parent tip, each surviving member's branch merged on in sequence, `--no-ff` like
// every other merge this tool writes. Expected to be conflict-free by construction (the tickets
// were pre-filtered as non-overlapping) except in the files that merge by rule, which are resolved
// by that rule; a merge that conflicts anywhere else drops that one ticket and
// continues combining the rest, exactly as the design calls for. Nothing here is committed to any
// branch — the tree is discarded the moment this run ends, win or lose.
function combineBatchGroup(root, cfg, group, cleaner) {
  const info = resolveTree({ scratch: group.parentTip }, { cwd: root });
  cleaner.add(() => cleanupTree(info, root));
  const surviving = [];
  const dropped = [];
  for (const ctx of group.members) {
    const message = `combine ${ctx.ticketId}: preview merge of ${ctx.branch} for a shared landing gate\n\n`
      + 'Discarded the moment the gate has run; never referenced by any branch.\n';
    // Members may share the files that merge by rule (a node's log, the lock files, a CHANGELOG):
    // those are resolved here exactly as the real merge will resolve them, and the tree each merge
    // produced is kept, so the real merge can be held to it.
    const merged = mergeResolving(info.path, cfg, ctx.branch, message, 'ours');
    if (merged.ok) {
      ctx.combined = { tree: git(['rev-parse', 'HEAD^{tree}'], info.path), resolved: merged.resolved };
      surviving.push(ctx);
    } else {
      dropped.push({
        ctx,
        note: `combine conflict against the batch's shared preview tree — excluded from the batch and landed on its own: ${merged.files.length ? merged.files.join(', ') : '(git named no file)'}`,
      });
    }
  }
  return { info, surviving, dropped };
}

// runSharedGate(cfg, level, worktreePath, addedFiles) — items 5-7 plus the judge item, each run
// exactly once, on the combined tree, exactly as run() runs them on a single ticket's own tree.
// The caller holds the gate lock around this call and only this call, mirroring run()'s own
// lock-around-the-expensive-half shape, now paid once for the whole group rather than once per
// member.
function runSharedGate(cfg, level, worktreePath, addedFiles) {
  const gate = checkGate(cfg, level, worktreePath, null, false);
  const graph = checkGraph(cfg, worktreePath, false);
  const mapping = checkMapping(cfg, worktreePath, addedFiles, false);
  const judge = checkJudge(cfg, worktreePath, graph, false);
  return {
    gate, graph, mapping, judge,
  };
}

// finishBatchMember(horde, ctx, outcome, provenanceInfo, flags, group, level, lockNotes) — the
// batch's own twin of run()'s finish(): writes the result file when asked (--background's child
// always is) and hands back the same shape a single-ticket run's own result carries. Never exits
// the process — a batch keeps going whatever one member's own outcome was, so the exit code is the
// whole batch's to decide, once, at the very end.
// A batch member's share of the one shared gate run: how long that run took, and how many landings it served.
function batchTiming(shared, group) {
  return { gateMs: shared.gateMs ?? null, landingMs: null, sharedBy: group.members.length };
}

function finishBatchMember(horde, ctx, outcome, provenanceInfo, flags, group, level, lockNotes, timing = null) {
  const noEvidenceLayer = noEvidenceLayerNote(horde);
  const full = {
    ...withProvenance({
      ticket: ctx.ticketId,
      branch: ctx.branch,
      sha: ctx.branchSha,
      ok: outcome.ok,
      checks: outcome.checks,
      pairs: [],
      landed: outcome.landed,
      lock: lockNotes,
      size: ctx.size,
      timing,
      noEvidenceLayer,
      level,
      parent: group.parentBranch,
      stackedOn: ctx.parent.stacked ? ctx.parent.stackedOn : null,
      at: nowIso(),
    }, provenanceInfo),
    branch: ctx.branch,
    sha: ctx.branchSha,
  };
  if (flags.result) writeLandResult(horde, ctx.ticketId, full);
  return full;
}

// landBatchGreen(...) — step 5 of the design, on green: each surviving member merged into the REAL
// parent individually, in sequence — mergeIntoParent unchanged, the evolving parent tip threaded
// through so the second merge lands on top of the first exactly as the throwaway combine already
// proved it would. A member whose branch moved since the shared gate ran, or whose own merge fails
// for any other reason, does not stop the rest — it is reported, on its own result, exactly as
// run() would report the same thing for a single ticket, and the tip carried into the next
// member's merge is left wherever the last successful one put it. The gate cache is written once,
// after the loop, at whatever tip the batch actually reached — the tree a later `done` or `close`
// will actually find.
function landBatchGreen(root, cfg, horde, level, group, provenanceInfo, shared, lockNotes, flags, cleaner) {
  let currentTip = group.parentTip;
  const landedPairs = [];
  const sharedChecks = {
    judge: shared.judge, gate: shared.gate, graph: shared.graph, mapping: shared.mapping,
  };
  for (const ctx of group.members) {
    const perTicket = { ...ctx.screen.results, ...sharedChecks };
    const checks = CHECK_ORDER.map((name) => ({ name, ok: !!perTicket[name].ok, note: perTicket[name].note }));

    const nowSha = git(['rev-parse', '--verify', ctx.branch]);
    if (nowSha !== ctx.branchSha) {
      checks.push({
        name: 'merge',
        ok: false,
        note: `${ctx.branch} moved while this landing ran — every item above was measured at ${short(ctx.branchSha)} and the branch now stands at ${short(nowSha)}. Nothing was merged for this ticket; land it again`,
      });
      recordChanges(horde, ctx.ticketId, checks);
      landedPairs.push({ arg: ctx.arg, full: finishBatchMember(horde, ctx, { ok: false, checks, landed: null }, provenanceInfo, flags, group, level, lockNotes, batchTiming(shared, group)) });
      continue;
    }

    const resolved = !!(ctx.combined && ctx.combined.resolved.length);
    const merged = mergeIntoParent(root, cfg, ctx.branch, group.parentBranch, currentTip, ctx.ticketId, cleaner, horde, {
      resolve: resolved, expectTree: resolved ? ctx.combined.tree : null,
    });
    if (!merged.ok) {
      checks.push({ name: 'merge', ok: false, note: merged.note });
      recordChanges(horde, ctx.ticketId, checks);
      landedPairs.push({ arg: ctx.arg, full: finishBatchMember(horde, ctx, { ok: false, checks, landed: null }, provenanceInfo, flags, group, level, lockNotes, batchTiming(shared, group)) });
      continue;
    }

    currentTip = merged.sha;
    const landed = { ticket: ctx.ticketId, sha: merged.sha, at: nowIso() };
    recordMerged(horde, ctx.team, ctx.ticketId, merged.sha, { tree: root });
    appendLanded(ctx.issueDirPath, landed, group.parentBranch);
    ctx.screen.answersUsed.forEach((answer) => consumeAnswer(horde, answer, ctx.ticketId, ctx.branchSha));
    checks.push({ name: 'merge', ok: true, note: `${merged.note} — ${short(merged.sha)}` });
    landedPairs.push({ arg: ctx.arg, full: finishBatchMember(horde, ctx, { ok: true, checks, landed }, provenanceInfo, flags, group, level, lockNotes, batchTiming(shared, group)) });
  }
  if (currentTip !== group.parentTip && shared.gate.cache) {
    recordGateCache(
      horde,
      level,
      { ...shared.gate.cache, sha: currentTip },
      `batch(${group.members.map((m) => m.ticketId).join(',')})`,
      null,
      cfg,
    );
  }
  return landedPairs;
}

// landAlone(self, root, horde, level, noGate, argForTicket) — the fallback, and the ONLY thing
// this file ever does with a ticket that groupBatchCandidates, screenBatchMember or a red shared
// gate excludes from a batch: run `land.mjs <argForTicket>` again, fresh, as its own subprocess,
// with --tree pinned at the exact worktree this run is already using (never --horde alone, which
// would let the child re-resolve — and re-sync — a horde's trunk tree independently of what this
// run has been reading and writing). Nothing about the batch attempt is carried over: no consumed
// answer, no screened check, nothing — the child re-derives all of it itself, which is what makes
// this identical to land.mjs <ticket> run on its own, the same command tick.mjs already runs
// today.
function landAlone(self, root, horde, level, noGate, argForTicket) {
  const args = [argForTicket];
  if (level === 'trunk') args.push('--level', 'trunk');
  if (noGate) args.push('--no-gate');
  args.push('--tree', root, '--horde', horde, '--result', '--json');
  try {
    const out = execFileSync(process.execPath, [self, ...args], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ticket: argForTicket, full: JSON.parse(out) };
  } catch (e) {
    const stdout = e && e.stdout ? String(e.stdout) : '';
    if (stdout.trim()) {
      try { return { ticket: argForTicket, full: JSON.parse(stdout) }; } catch { /* fall through */ }
    }
    const stderr = e && e.stderr ? String(e.stderr).trim() : String((e && e.message) || e);
    return { ticket: argForTicket, full: null, refused: stderr || 'land.mjs exited without a parseable result' };
  }
}

function landEachAlone(self, root, horde, level, noGate, argList) {
  return argList.map((argForTicket) => landAlone(self, root, horde, level, noGate, argForTicket));
}

// normalizeOutcome(arg, full, refused) — every outcome this file produces, whether a real landing
// result (from finishBatchMember, in-process) or a fallback subprocess's own answer, folded to one
// shape keyed by `arg` — the exact token the caller asked this run to land, ticket id or branch
// name, never the resolved ticket id alone: the two can differ, and the final report has to find
// every one of the caller's own tickets again, in the caller's own order, however it was landed.
function normalizeOutcome(arg, full, refused) {
  return full
    ? {
      arg, ok: !!full.ok, ticket: full.ticket, landed: full.landed || null, refused: null, full,
    }
    : {
      arg, ok: false, ticket: arg, landed: null, refused: refused || 'land.mjs exited without a parseable result', full: null,
    };
}

function finishMany(tickets, outcomes, flags) {
  const byArg = new Map(outcomes.map((o) => [o.arg, o]));
  const ordered = tickets.map((t) => byArg.get(t) || {
    arg: t, ok: false, ticket: t, landed: null, refused: 'not processed',
  });
  const allOk = ordered.every((o) => o.ok);
  const landedCount = ordered.filter((o) => o.ok).length;
  const summary = {
    tickets, ok: allOk, results: ordered, at: nowIso(),
  };
  emit(summary, flags, () => [
    `land batch: ${tickets.length} ticket(s) — ${landedCount} landed, ${tickets.length - landedCount} not`,
    ...ordered.map((o) => `${o.ok ? '✓' : '✗'} ${o.ticket}${o.landed ? ` LANDED ${short(o.landed.sha)}` : ''}${!o.ok && o.refused ? ` — ${o.refused}` : ''}`),
  ].join('\n'));
  // Never exits the process — runMany()'s own `finally` (cleaner.runAll()) still has cleanup to
  // do on the way out, so the exit code is main()'s own call to make once runMany() has actually
  // returned, not this frame's, mid-stack.
  return summary;
}

// startBatchInBackground(horde, root, level, noGate, tickets) — the batch's own twin of
// startInBackground(): one detached worker for the whole request instead of one per ticket. A
// ticket this foreground pass cannot even find a queue item for is refused right here, exactly as
// the single-ticket --background path already refuses inline, and — unlike that path, which is
// the whole call — it does not hold up any OTHER ticket in the same request: the same independence
// N separate `land.mjs --background` calls already had, kept even though this is now one call.
function startBatchInBackground(horde, root, level, noGate, tickets) {
  const resolved = [];
  const items = [];
  for (const t of tickets) {
    const found = findQueueItem(horde, t);
    if (found) {
      resolved.push({ arg: t, ticket: String(found.item.ticket), branch: found.item.branch });
    } else {
      items.push({
        ticket: t, branch: null, resultFile: null, started: false, note: `no queue item names ${t} — is the ticket tracked by queue.mjs?`,
      });
    }
  }
  if (resolved.length) {
    const self = fileURLToPath(import.meta.url);
    const args = [resolved.map((r) => r.arg).join(',')];
    if (level === 'trunk') args.push('--level', 'trunk');
    if (noGate) args.push('--no-gate');
    args.push('--horde', horde, '--result', '--json');
    const child = spawn(process.execPath, [self, ...args], {
      detached: true, stdio: 'ignore', cwd: root,
    });
    child.unref();
    for (const r of resolved) {
      items.push({
        ticket: r.ticket, branch: r.branch, resultFile: resultPath(horde, r.ticket), pid: child.pid || null, started: true, note: null,
      });
    }
  }
  return items;
}

// runMany(horde, root, cfg, tickets, level, noGate, flags) — the entry point for two or more
// tickets. --no-gate never merges and skips items 2, 5, 6 and 7 outright (see USAGE) — with
// nothing expensive left to share, batching buys nothing, so every ticket just runs alone, in this
// same process, exactly as --no-gate already behaves for one. Otherwise: resolve every ticket
// leniently, group what is eligible to batch, screen and combine each group, run its shared gate
// once, and land what survives — everything this excludes along the way, for any reason, lands
// alone instead, in this same run.
function runMany(horde, root, cfg, tickets, level, noGate, flags) {
  const self = fileURLToPath(import.meta.url);

  if (noGate) {
    const alone = landEachAlone(self, root, horde, level, noGate, tickets);
    return finishMany(tickets, alone.map((o) => normalizeOutcome(o.ticket, o.full, o.refused)), flags);
  }

  const cleaner = makeCleaner();
  const outcomes = [];
  const standalone = [];
  try {
    const candidates = tickets.map((t) => resolveBatchCandidate(horde, root, cfg, t, level));
    for (const c of candidates) if (!c.ok) standalone.push(c.arg);
    const resolvable = candidates.filter((c) => c.ok);

    const { groups, overflow } = groupBatchCandidates(resolvable, cfg);
    for (const c of overflow) standalone.push(c.arg);

    for (const group of groups) {
      const baseTree = resolveTree({ scratch: group.parentTip }, { cwd: root });
      cleaner.add(() => cleanupTree(baseTree, root));

      const survivors = [];
      for (const ctx of group.members) {
        const screen = screenBatchMember(root, cfg, horde, ctx, baseTree.path, cleaner);
        if (!screen.ok) { standalone.push(ctx.arg); continue; }
        ctx.screen = screen;
        survivors.push(ctx);
      }
      if (survivors.length < 2) {
        for (const ctx of survivors) standalone.push(ctx.arg);
        continue;
      }

      const combined = combineBatchGroup(root, cfg, { ...group, members: survivors }, cleaner);
      for (const d of combined.dropped) standalone.push(d.ctx.arg);
      if (combined.surviving.length < 2) {
        for (const ctx of combined.surviving) standalone.push(ctx.arg);
        continue;
      }

      const combinedSha = git(['rev-parse', 'HEAD'], combined.info.path);
      const addedFiles = diffPaths(['diff', '--name-only', '--diff-filter=A', `${group.parentTip}...HEAD`], combined.info.path);

      const lock = acquireGateLock(`batch(${combined.surviving.map((m) => m.ticketId).join(',')})`, null, { waitMs: lockWait(cfg) });
      if (!lock.ok) {
        // The whole point of one hold was to avoid N of them — refused once here is refused for
        // every member alike; none of them ran the shared gate, so all of them fall back.
        for (const ctx of combined.surviving) standalone.push(ctx.arg);
        continue;
      }
      cleaner.add(lock.release);
      let shared;
      const sharedStart = Date.now();
      try {
        shared = runSharedGate(cfg, level, combined.info.path, addedFiles);
      } finally {
        lock.release();
      }
      // How long the shared gate took, once — every member's result carries it, marked as shared.
      shared.gateMs = Date.now() - sharedStart;
      const sharedOk = shared.gate.ok && shared.graph.ok && shared.mapping.ok && shared.judge.ok;
      if (!sharedOk) {
        // Design: on red, do not bisect. Fall back to landing every member of this group on its
        // own, in this same run — the worst case costs exactly what it costs today.
        for (const ctx of combined.surviving) standalone.push(ctx.arg);
        continue;
      }

      const provenanceInfo = { path: combined.info.path, branch: null, sha: combinedSha };
      const landed = landBatchGreen(
        root, cfg, horde, level, { ...group, members: combined.surviving }, provenanceInfo, shared, lock.notes, flags, cleaner,
      );
      for (const pair of landed) outcomes.push(normalizeOutcome(pair.arg, pair.full, null));
    }

    const alone = landEachAlone(self, root, horde, level, noGate, standalone);
    for (const o of alone) outcomes.push(normalizeOutcome(o.ticket, o.full, o.refused));

    return finishMany(tickets, outcomes, flags);
  } finally {
    cleaner.runAll();
  }
}

// ---- main -------------------------------------------------------------------------

function run(horde, root, cfg, arg, level, noGate, flags) {
  const cleaner = makeCleaner();
  const landingStart = Date.now();
  const found = findQueueItem(horde, arg);
  if (!found) fail(`no queue item names ${arg} — is the ticket tracked by queue.mjs?`);
  const { team, teamDir, item } = found;
  const branch = item.branch;
  if (!branch) fail(`ticket ${item.ticket} has no branch yet — nothing to land (queue.mjs set ${item.ticket} running cuts one)`);
  let branchSha = git(['rev-parse', '--verify', branch]);
  if (!branchSha) {
    const detail = gitError();
    fail(`no such branch: ${branch}${detail ? ` — ${detail}` : ''}`);
  }

  const ticketId = String(item.ticket);
  const issueDirName = findIssueDir(teamDir, ticketId);
  if (!issueDirName) fail(`no ticket found for ${ticketId} in team ${team}`);
  const issueDirPath = join(teamDir, 'issues', issueDirName);
  const issueText = readText(join(issueDirPath, 'issue.md'));
  const logText = readText(join(issueDirPath, 'log.md'));
  const nodes = ticketNodes(issueText);
  const declaredFiles = ticketFiles(issueText);
  // Read before the parent is resolved, because for one kind of ticket it decides what the parent
  // IS. Every other item below is measured against whatever that answer turns out to be.
  const kind = ticketKind(issueText);

  const parentResolved = parentBranchOf(horde, team, item, { cwd: root });
  const parentBranch = prototypeGuard(horde, kind, ticketId, branch, parentResolved);
  // What every reader of this run's result is told it landed on — the branch actually measured
  // against and merged into, not the one the queue's own shape would have implied.
  const parent = { ...parentResolved, branch: parentBranch };
  const parentTip = git(['rev-parse', '--verify', parentBranch]);
  // Every guard but the prototype one reads two trees and compares them. Without a base there is
  // no comparison to make,
  // and a landing that skipped the comparison because the base was missing would be the one
  // landing where the law could be rewritten freely.
  if (!parentTip) {
    const detail = gitError();
    fail(`no such branch: ${parentBranch} — the guards that keep a landing from weakening the rules read the base tree and this branch's tree and compare them, and with no base there is nothing to compare against. Restore ${parentBranch}, or fix config.base${detail ? ` (${detail})` : ''}`);
  }

  // A branch the parent has moved past is brought up to date before anything is measured, so what the
  // gate measures is what will merge; a conflict is refused below, before any gate. --no-gate never
  // writes to a branch, so it measures and reports the staleness as it stands.
  let pulled = null;
  if (!noGate && !checkBaseFreshness(branch, parentBranch).ok) {
    pulled = pullParentIntoBranch(root, cfg, branch, parentBranch, branchSha);
    if (pulled.ok) {
      branchSha = pulled.sha;
      const ticket = findTicket(horde, ticketId);
      if (ticket) appendTicketLine(ticket, `- ${nowIso()} land ${pulled.note} (${short(branchSha)})\n`);
    }
  }

  const changedFiles = diffPaths(['diff', '--name-only', `${parentBranch}...${branch}`]);
  const addedFiles = diffPaths(['diff', '--name-only', '--diff-filter=A', `${parentBranch}...${branch}`]);

  // How big this change turned out, and where that sits among the mission's other open tickets —
  // read off the plan's own ranking so the number here and the number the architect read in the
  // plan are the same number, never two answers to one question. No item passes or fails on it:
  // it is a line in the result, for whoever is deciding how the next ticket like this gets cut.
  const size = missionSize(horde, team, cfg, root, ticketId, parentBranch, branch);

  // The tree every item below reads is made here, at the branch's own tip, and is nobody's
  // working copy. The checklist used to run in whichever worktree happened to hold the branch,
  // which meant a gate could be measuring a tree somebody was still typing into.
  const head = resolveTree({ scratch: branchSha }, { cwd: root });
  cleaner.add(() => cleanupTree(head, root));
  const base = resolveTree({ scratch: parentTip }, { cwd: root });
  cleaner.add(() => cleanupTree(base, root));

  const results = {};
  const guards = [];
  let landed = null;
  let lockNotes = [];

  try {
    // A tree that vanished from under the run is not a red item — every item below would answer
    // about nothing at all — so it stops here, naming the path, while the cleanup still runs and
    // git is still told to forget the registration.
    for (const [what, info] of [['this branch', head], ['the base', base]]) {
      if (!existsSync(info.path)) {
        fail(`the worktree this landing made for ${what} is gone from ${info.path} — it was created for this run and removed by something else while the run was going. Nothing was measured and nothing was merged; land again`);
      }
    }

    results['base freshness'] = checkBaseFreshness(branch, parentBranch);
    if (pulled && pulled.ok && results['base freshness'].ok) {
      results['base freshness'] = { ok: true, note: `${pulled.note}; ${results['base freshness'].note}` };
    }
    // Behind the parent and the parent does not merge into it: there is nothing to gate. Not a red
    // gate and not a fix round — the ticket did nothing wrong — so no round is counted and nothing
    // else is run; the result says stale so whoever reads it sends the ticket back for the merge.
    if (!noGate && !results['base freshness'].ok) {
      const why = pulled && !pulled.ok ? `${results['base freshness'].note}. ${pulled.note}` : results['base freshness'].note;
      return finish(horde, ticketId, {
        ticket: ticketId,
        branch,
        sha: branchSha,
        ok: false,
        stale: true,
        // The files the parent's merge stopped on that no rule resolves, sorted — what tick counts a
        // repeat by, and what the next worker's brief names as its to resolve.
        conflictFiles: pulled && !pulled.ok ? [...asArray(pulled.files)].sort() : [],
        checks: [{ name: 'base freshness', ok: false, note: why }],
        pairs: [],
        landed: null,
        lock: lockNotes,
        size,
      }, head, flags, parent, level);
    }
    results.scope = checkScope(root, cfg, nodes, changedFiles, declaredFiles, proposalBoundaryOf(horde, issueText, nodes));
    results['revert test'] = checkRevertTest(horde, root, cfg, branch, parentBranch, changedFiles, issueText);
    results.journal = checkJournal(logText, branch, parentBranch);
    results['graph text'] = checkGraphText(root, branch, parentBranch, changedFiles);

    if (!noGate) {
      // Every guard runs before the expensive half and before anything merges: a branch that
      // rewrote the law it is judged by would otherwise be judged by the law it wrote, and one
      // that took away the proof or the gate would be measured by what it left behind.
      const law = lawGuard(cfg, horde, base.path, head.path);
      if (law.stopped) fail(law.stopped);
      guards.push(...law.refusals);
      const conflict = conflictGuard(cfg, base.path, head.path, changedFiles, law.headReach);
      guards.push(...conflict.refusals);
      const protection = protectionGuards(cfg, horde, base.path, head.path, changedFiles);
      guards.push(...protection.refusals);
      if (guards.length) {
        fail(`${guards.length} refusal(s) — this branch may not land as it stands:\n${guards.map((g) => `- ${g.aspect} (${g.case}): ${g.note}`).join('\n')}`);
      }
      [...law.used, ...protection.used].forEach((answer) => consumeAnswer(horde, answer, ticketId, branchSha));
    }

    // The lock covers the repository's own gate command and both `yg check` runs, and nothing
    // else: those are what two landings at once would run over each other.
    const lock = noGate ? { ok: true, notes: [], release: () => {} } : acquireGateLock(ticketId, branch, { waitMs: lockWait(cfg) });
    lockNotes = lock.notes || [];
    if (!lock.ok) fail(lock.note);
    // Also on the cleaner, so a landing killed while holding it releases rather than leaving the
    // next one to work out that the pid is gone.
    cleaner.add(lock.release);
    // How long the gate held the lock: the measurement a director reads to decide whether landings are
    // what is slowing the mission (see landingLoad). Not taken when there was no gate to run.
    const gateStart = Date.now();
    try {
      results.gate = checkGate(cfg, level, head.path, branchSha, noGate);
      results.graph = checkGraph(cfg, head.path, noGate);
      results.mapping = checkMapping(cfg, head.path, addedFiles, noGate);
    } finally {
      lock.release();
    }
    const gateMs = noGate ? null : Date.now() - gateStart;
    const timing = () => ({ gateMs, landingMs: Date.now() - landingStart, sharedBy: 1 });
    results.judge = checkJudge(cfg, head.path, results.graph, noGate);

    const checks = CHECK_ORDER.map((name) => ({ name, ok: !!results[name].ok, note: results[name].note }));
    const allOk = checks.every((c) => c.ok);
    // A catch-up merge moves the code the branch's prose verdicts were recorded over, so a tree that is
    // red only because those verdicts are now pending was made red by somebody else's landing, not by
    // this ticket — the same reason a stale branch costs no round. The result says "rejudge" and no
    // round is written; tick sends the ticket back with a narrow brief to refresh the verdicts.
    const redNames = checks.filter((c) => !c.ok).map((c) => c.name);
    const rejudge = !allOk && !noGate && !!(pulled && pulled.ok)
      && redNames.includes('judge') && redNames.every((n) => n === 'judge' || n === 'graph')
      && !!(results.graph && results.graph.onlyProsePending) && hasReviewer(head.path);

    if (allOk && !noGate) {
      // The sha the items were measured against has to be the sha that lands. A branch that moved
      // while this ran would otherwise merge a commit nothing in this run ever looked at.
      const nowSha = git(['rev-parse', '--verify', branch]);
      if (nowSha !== branchSha) {
        fail(`${branch} moved while this landing ran — every item above was measured at ${short(branchSha)} and the branch now stands at ${short(nowSha)}. Nothing was merged; land again against the branch as it stands now`);
      }
      const merged = mergeIntoParent(root, cfg, branch, parentBranch, parentTip, ticketId, cleaner, horde);
      if (!merged.ok) {
        checks.push({ name: 'merge', ok: false, note: merged.note });
        recordChanges(horde, ticketId, checks);
        return finish(horde, ticketId, {
          ticket: ticketId, branch, sha: branchSha, ok: false, checks, pairs: [], landed: null, lock: lockNotes, size, timing: timing(),
        }, head, flags, parent, level);
      }
      landed = { ticket: ticketId, sha: merged.sha, at: nowIso() };
      recordMerged(horde, team, ticketId, merged.sha, { tree: root });
      appendLanded(issueDirPath, landed, parentBranch);
      // The gate item above measured `branchSha` — this merge's tree is that same tree, now under
      // a sha `done` and `close` can actually find on the branch they read. See checkGate's comment.
      if (results.gate.cache) recordGateCache(horde, level, { ...results.gate.cache, sha: merged.sha }, ticketId, branch, cfg);
      checks.push({ name: 'merge', ok: true, note: `${merged.note} — ${short(merged.sha)}` });
    } else if (!allOk && !noGate && !rejudge) {
      recordChanges(horde, ticketId, checks);
    }

    const judge = results.judge || {};
    return finish(horde, ticketId, {
      ticket: ticketId,
      branch,
      sha: branchSha,
      ok: allOk,
      ...(rejudge ? { rejudge: true } : {}),
      checks,
      pairs: asArray(judge.pairs),
      landed,
      lock: lockNotes,
      size,
      timing: timing(),
    }, head, flags, parent, level);
  } finally {
    cleaner.runAll();
  }
}

// A red gate is a fact about this ticket, recorded where the ticket's own history lives: the
// status goes to "changes" with the gate's own words, and the round counter ticks so a fix loop
// that is going nowhere is visible as a number rather than as a feeling. Nothing here is written
// to Yggdrasil's incident ledger — a rule that refused this branch did its job, and an adopter's
// incident register is for rules that failed to.
function recordChanges(horde, ticketId, checks) {
  const ticket = findTicket(horde, ticketId);
  if (!ticket) return;
  const red = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.note}`);
  const roundInfo = changesRoundInfo(horde, ticket);
  if (roundInfo.refused) {
    appendTicketLine(ticket, `- ${nowIso()} land refused and the fix rounds are spent — ${roundInfo.message}\n`);
    return;
  }
  transitionStatus(ticket, 'changes', `land refused: ${red.join(' · ')}`, roundInfo);
}

function appendTicketLine(ticket, line) {
  const existing = readText(ticket.logPath) || '';
  writeText(ticket.logPath, existing + line);
}

// The landed sha, in the ticket's own log. Together with the queue item's own record (written by
// recordMerged) this is the whole trace a landing leaves: no key, no verdict block, no signature
// — the commit that exists is the claim, and it is checkable.
function appendLanded(issueDirPath, landed, parentBranch) {
  const path = join(issueDirPath, 'log.md');
  const existing = readText(path) || '';
  writeText(path, `${existing}- ${landed.at} landed ${landed.ticket} on ${parentBranch} as ${landed.sha}\n`);
}

function finish(horde, ticketId, result, head, flags, parent, level) {
  // Whether this mission has anything at all to run a proof against, stated on every landing rather
  // than left to be inferred from items that all talk about globs and commands. When the charter's
  // answer is "nothing", every row this ticket earns is held up by what it names itself, and the
  // person reading the items below is the one who has to go and look — so they are told, here,
  // once, whatever the items say.
  const noEvidenceLayer = noEvidenceLayerNote(horde);
  // withProvenance names the tree this ran in; `branch` and `sha` stay the ticket's own, because
  // the throwaway tree is detached and would otherwise report the branch as null — erasing the one
  // field every reader of this result needs. The tree sits at exactly `sha` either way.
  const full = {
    ...withProvenance({
      ...result,
      noEvidenceLayer,
      level,
      parent: parent.branch,
      stackedOn: parent.stacked ? parent.stackedOn : null,
      at: nowIso(),
    }, head),
    branch: result.branch,
    sha: result.sha,
  };
  if (flags.result) writeLandResult(horde, ticketId, full);
  emit(full, flags, () => [
    `land ${result.branch} (level: ${level})${parent.stacked ? ` · stacked on ${parent.stackedOn}` : ''}`,
    `change size: ${sizeLine(result.size)}${result.size && result.size.biggestQuarter ? ' of this mission — worth a look at how the next ticket like it is cut' : ''}`,
    ...asArray(result.lock).map((n) => `· ${n}`),
    ...(noEvidenceLayer ? [noEvidenceLayer] : []),
    ...result.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.note}`),
    result.landed ? `LANDED ${short(result.landed.sha)}` : 'NOT LANDED',
    provenanceLine(head),
  ].join('\n'));
  // Never exits the process — same discipline as finishBatchMember's own note above: run()'s
  // `finally` still has cleanup to do on the way out, so the exit code is main()'s own call to
  // make once run() has actually returned, not this frame's, mid-stack.
  return full;
}

// `--background` is the same run, started and let go of: the caller gets the path of the file the
// run will write and stops waiting. Nothing reads that file here — a landing never trusts a
// recorded result, its own or anyone's — it is written for whatever asks later what happened.
//
// This is the one command in the tool set that deliberately outlives its caller: detached,
// unreffed, answering only through that file. Nothing waits on it and nothing reaps it, which is
// exactly what makes an unbounded wait inside it dangerous — a step that never returns is a
// process with no parent that stays until the machine is rebooted.
//
// There is no reaper for it, and that is a decision rather than an omission. Every blocking step a
// landing takes now carries its own ceiling — the gate command and both revert-test runners at
// `config.gateTimeoutMs`, every call to the Yggdrasil CLI at `config.ygTimeoutMs` — so the run has
// a bounded life by construction, and a watchdog would be a second mechanism guarding against
// nothing left unbounded. Building one would mean identifying "our" processes from outside: by
// argv through `pgrep` (not portable, and it reads other hordes' and other repositories' landings
// as ours), or by a pid file (which outlives the process and points at a reused pid). Both trade a
// bounded wait for the chance of killing something that was never ours, which is a worse failure
// than the one being fixed. Reconcile settles *state* — queue rows and abandoned gate locks, which
// are this repository's own files and mean exactly one thing; killing operating-system processes on
// a guess is not the same authority, and it is not taken here.
//
// What it hands back is the result file's path and the pid of the process it started: the result
// file is absent for the whole of a landing's slow, lock-free half (the revert test, the guards) and
// the gate lock is not yet taken, so the pid is the one thing that tells a caller — tick — the
// landing is going and not to ask for it twice.
function startInBackground(horde, ticketId, argv) {
  const self = fileURLToPath(import.meta.url);
  const args = argv.filter((a) => a !== '--background');
  const child = spawn(process.execPath, [self, ...args, '--result', '--json'], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();
  return { path: resultPath(horde, ticketId), pid: child.pid || null };
}

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv, { flags: ['no-gate', 'background', 'result'] });
  if (flags.help) { console.log(USAGE); process.exit(0); }
  const arg = positional[0];
  if (!arg) fail('land requires <ticket|branch>');
  if (flags.fate !== undefined) {
    // A fate is about a landing that already happened, so none of the gate's own flags mean
    // anything here — measuring a branch that no longer exists is not what is being asked for.
    for (const bad of ['level', 'no-gate', 'background']) {
      if (flags[bad] !== undefined) fail(`--${bad} does not go with --fate — a fate records what became of a landing, it never runs one`);
    }
    // No --tree: cwd, the same ordinary default every read in this tool set takes — not this
    // horde's trunk just because a horde was resolvable, which is the question still open on ask
    // a-002. --horde WRITTEN OUT is what changes that, read the same way as the gate-run path
    // below: `flags.horde`, never resolveHorde(flags)'s own default-to-the-sole-horde value below
    // it. The tree barely matters to what --fate itself does with it — the one read it makes off
    // root is a single, repo-wide `git rev-parse` — but the flag is not read one way here and
    // another way three lines down for the same script and the same caller.
    const root = resolveTree({ tree: flags.tree, horde: flags.horde }, { cwd: process.cwd() }).path;
    runFate(resolveHorde(flags), root, arg, flags);
    return;
  }
  if (flags.level === 'team') fail('--level team no longer exists — omit --level, or pass --level trunk for a branch landing directly on <horde>/trunk');
  if (flags.level !== undefined && flags.level !== 'trunk') fail('--level must be "trunk"');
  // "team" is the config key this reads the gate command from (config.gates.team) and the key the
  // result and cache/last-gate.json are filed under — not a team, and not something a caller can
  // pass. The key predates 6.0.0 and is kept: it is what every adopter's .horde/config.json holds
  // for the gate a ticket branch lands through, and renaming it would move that command out from
  // under them for no change in what runs.
  const level = flags.level || 'team';

  const horde = resolveHorde(flags);
  // No --tree: cwd, same as an ordinary read anywhere else in this tool set — NOT this horde's
  // trunk just because a horde was resolvable, which is the one question still open on ask a-002.
  // What this DOES now honor is --horde typed explicitly: `flags.horde`, never `horde` above
  // (resolveHorde's own default-to-the-sole-horde reading), so a bare `land.mjs <ticket>` call —
  // the shape tick.mjs itself spawns, cwd already pointed where tick resolved it — is untouched,
  // and only a caller who actually wrote --horde (running land.mjs directly, as a maintainer
  // might) gets this horde's own trunk instead of whatever tree the shell happened to be sitting
  // on — the same distinction queue.mjs plan/quality and tick.mjs already draw. land.mjs is the
  // one script every doc in this tool set names as trunk's sole writer, so resolving --horde here
  // to the tree it may actually merge into is not a new exception, just this script catching up to
  // its own rule.
  const info = resolveTree({ tree: flags.tree, horde: flags.horde }, { cwd: process.cwd() });
  const root = info.path;
  const cfg = readConfig() || {};
  // One bare token (today's only shape) or a comma-separated list — `arg` itself, never split, is
  // what every single-ticket branch below still reads, so a plain `land.mjs <ticket>` call is
  // untouched byte for byte. Splitting only matters once there is a second one to batch with.
  const tickets = splitTickets(arg);

  if (flags.background) {
    if (tickets.length <= 1) {
      const found = findQueueItem(horde, arg);
      if (!found) fail(`no queue item names ${arg} — is the ticket tracked by queue.mjs?`);
      const ticketId = String(found.item.ticket);
      const { path, pid } = startInBackground(horde, ticketId, argv);
      emit(
        { ticket: ticketId, branch: found.item.branch, resultFile: path, pid, started: nowIso() },
        flags,
        () => `land ${ticketId} started in the background — its result will be written to ${path}`,
      );
      return;
    }
    const items = startBatchInBackground(horde, root, level, !!flags['no-gate'], tickets);
    emit({ tickets, items, started: nowIso() }, flags, () => [
      `land batch of ${tickets.length} ticket(s) started in the background:`,
      ...items.map((it) => (it.started
        ? `  ${it.ticket} — result will be written to ${it.resultFile}`
        : `  ${it.ticket} — not started: ${it.note}`)),
    ].join('\n'));
    return;
  }

  if (tickets.length <= 1) {
    const result = run(horde, root, cfg, arg, level, !!flags['no-gate'], flags);
    if (!result.ok) process.exit(1);
    return;
  }
  const summary = runMany(horde, root, cfg, tickets, level, !!flags['no-gate'], flags);
  if (!summary.ok) process.exit(1);
}

if (isMain(import.meta.url)) runMain(main);
