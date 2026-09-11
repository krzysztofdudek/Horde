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
// normally `<horde>/trunk` — and, for a ticket started from an unmerged dependency's tip, that
// dependency's branch until it merges. `parentBranchOf` answers that once, and every item below is
// measured against its answer: the base, the diff, the tree a new test is reverted onto.

import {
  existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hordePath, hordeRoot, readJSON, writeJSON, readText, writeText, readConfig, git, fail, parseArgs,
  asArray, emit, isMain, resolveHorde, parentBranchOf, resolveTree, provenanceLine, withProvenance,
  nowIso,
} from './_lib.mjs';
import {
  ticketNodes, runYgCheck, ygCommand, fillDeterministic, pendingProsePairs, verdictCommandsFor,
  globToRegExp, pathInBoundary, ticketBoundary, ygFileContext, ygAvailable, ygJson,
} from './node.mjs';
import { ticketFiles, ticketEvidence, findTicket, changesRoundInfo, transitionStatus } from './tk.mjs';
import { recordMerged } from './queue.mjs';

const USAGE = `usage: land.mjs <ticket|branch> [--level trunk] [--no-gate] [--background] [--horde h]

The gate a change lands through. Nine items, ✓/✗ per line; every one green means the branch is
merged into its parent here and now, and a single ✗ means it is not — nobody's signature is asked
for either way.

  1. base freshness — branch rooted at its parent branch's tip
  2. judge          — every prose rule on this tree has a judgement (config.judge says who makes
                      it: "tier" is Yggdrasil's own reviewer, "one-shot" hands the pairs back)
  3. scope          — diff stays inside the files the ticket declared, or its node boundaries when
                      it declared none; no protected path touched
  4. revert test    — new test files (named by config.testGlobs), extracted onto the parent's
                      tree, fail there; ✗ when this repository's test patterns are unknown
  5. gate           — config.gates.<level> green on the branch's own tree, run fresh
  6. graph          — the free deterministic verdicts recorded, every prose rule still waiting
                      on a judgement named, and a full "yg check" green on this branch's tree
  7. mapping        — every file the branch added is owned by a node on the branch's own tree
                      (a mapping and its first file land in the same commit); skipped with --no-gate
  8. journal        — a log entry newer than the last commit
  9. graph text     — charters, logs and "graph:" commits touched by the branch carry no mission
                      language (wave, ticket NNN, mission, horde, E<n>, .temp/)

Two guards run before the items and refuse outright rather than reporting an item, because
neither is a thing a worker can fix by trying again:

  the law guard          — a branch may not weaken the rules it is judged by. A deleted aspect, a
                           demoted status, a moved review_by, a narrowed reach, an added
                           yg-suppress marker or an aspect detached from a node all refuse, unless
                           the mission's decisions.md carries the client's answer to an "ask" of
                           kind "lower" naming that exact aspect.
  the conflict guard     — a branch may not sharpen a rule and change the code that rule refuses in
                           the same landing. Split it into a code ticket and a legislative one.

--level selects the gate command (config.gates.trunk; default team — "trunk" is only for a branch
landing directly on <horde>/trunk; "team" is no longer a value you pass, only the default).
--no-gate skips items 5, 6 and 7 (informational: pass) and never merges.
--background starts the run and prints the path of the result file it will write, immediately.

options: --json  --help`;

function short(sha) { return sha ? sha.slice(0, 7) : '(none)'; }

// A path with any byte above 0x7f comes back from git C-quoted ("za\305\274\303\263...") unless
// this is off, and every item that compares a diff path against a declared one, or hands it to the
// graph to ask who owns it, would then be working on an escape sequence instead of a filename.
function diffPaths(args, cwd) {
  return (git(['-c', 'core.quotepath=false', ...args], cwd) || '').split('\n').filter(Boolean);
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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireGateLock(ticket, branch, { waitMs = LOCK_WAIT_MS } = {}) {
  const path = lockPath();
  const deadline = Date.now() + waitMs;
  const notes = [];
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({
        pid: process.pid, ticket, branch, at: nowIso(),
      }, null, 2)}\n`, { flag: 'wx' });
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
    let held = null;
    try { held = JSON.parse(readFileSync(path, 'utf8')); } catch { held = null; }
    // An unreadable or half-written lock file names no pid to wait on, so it is treated exactly
    // like a dead one: taken over, with the take-over said out loud.
    if (!held || !processAlive(held.pid)) {
      notes.push(held
        ? `took over the gate lock left by pid ${held.pid} (ticket ${held.ticket || '?'}, taken ${held.at || 'at an unrecorded time'}) — that process is gone`
        : 'took over an unreadable gate lock file — nothing in it named a process still running');
      try { rmSync(path, { force: true }); } catch { /* someone else got there first */ }
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
  if (!parentTip) return { ok: false, note: `parent branch not found: ${parentBranch}` };
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
// A declared list is the tighter of the two and it wins: the owner said which files this ticket
// touches, and a diff that reaches past it is a widened ticket nobody agreed to. The fix is never
// a quiet pass — it is `tk.mjs edit NNN --files …`, which writes the new list and a log line
// saying who widened it and when.
const DERIVED_LOCK = /^\.yggdrasil\/yg-lock\.[^/]+\.json$/;
function checkScope(root, cfg, nodes, files, declared = []) {
  const boundary = declared.length ? declared : ticketBoundary(root, cfg, nodes);
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

function runCapture(cmd, args, opts) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).toString();
  } catch (e) {
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

// New test files (git-added, matching config.testGlobs) extracted onto the revert base's tip
// (the parent branch, unless the ticket names another ref — see revertBaseRef) in a scratch
// worktree, and run there; each must show at least one failure, since a new test that already
// passes on its base proves nothing.
//
// The result is derived here, by running the tests: nothing anywhere declares to this gate
// whether a revert failed, passed, or was not run, and no flag offers to say so. A declaration
// about a test is not evidence about a test.
//
// A file this repo's own runner (`node --test`) can run directly is run directly; anything else
// falls back to the whole `gates.commit` command (coarser: any red in that command counts as "a
// failure" for this file, since isolating just its test lane out of an arbitrary configured
// command isn't possible in general).
function checkRevertTest(root, cfg, branch, parentBranch, files, issueText) {
  const base = revertBaseRef(issueText) || parentBranch;
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
    .filter((e) => e.status === 'A' && files.includes(e.path))
    .filter((e) => testGlobs.some((g) => globToRegExp(g).test(e.path)))
    .map((e) => e.path);

  if (newTestFiles.length === 0) {
    return { ok: true, note: `no new test files in diff (looked for ${testGlobs.join(', ')})` };
  }

  const baseSha = git(['rev-parse', '--verify', `${base}^{commit}`]);
  if (!baseSha) return { ok: false, note: `revert base not found: ${base}` };

  const info = resolveTree({ scratch: baseSha }, { cwd: root });
  const tmp = info.path;
  const results = [];
  try {
    for (const relPath of newTestFiles) {
      const content = git(['show', `${branch}:${relPath}`], root);
      if (content === null) { results.push({ path: relPath, ok: false, note: 'could not extract from branch' }); continue; }
      const abs = join(tmp, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      if (/\.(m?js|c?js)$/.test(relPath)) {
        const out = runCapture('node', ['--test', relPath], { cwd: tmp, env: childTestEnv() });
        const summary = parseNodeTestSummary(out);
        results.push({ path: relPath, ok: (summary.fail ?? 0) > 0, note: `${summary.fail ?? '?'} fail / ${summary.tests ?? '?'} tests` });
      } else if (cfg.gates && cfg.gates.commit) {
        let failed = false;
        try { execSync(cfg.gates.commit, { cwd: tmp, stdio: 'pipe' }); } catch { failed = true; }
        results.push({ path: relPath, ok: failed, note: failed ? 'gates.commit red (whole command — no test-only isolation available)' : 'gates.commit green — not load-bearing' });
      } else {
        results.push({ path: relPath, ok: false, note: 'no runner available (not a node test file, and no gates.commit configured)' });
      }
    }
  } finally {
    cleanupTree(info, root);
  }
  const ok = results.every((r) => r.ok);
  const baseNote = base === parentBranch ? '' : `base ${base} — `;
  return { ok, note: baseNote + results.map((r) => `${r.path}: ${r.note}`).join(' · ') };
}

// The repository's own gate command, run fresh on the branch's own tree. No recorded green run is
// accepted from anywhere: a "**Gate:** green at sha …" line in a ticket's log is a claim about a
// run this gate did not see, which is exactly the kind of second-hand evidence this command
// exists to stop taking. (`horde.mjs done` still accepts a matching cached green for the trunk
// gate; that is its own call, about a mission that is already merged, and it stays there.)
//
// A command that hangs is not a verdict either, so the run carries a timeout and says so rather
// than leaving a stuck process behind a checklist that never finishes.
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
  return {
    ok: green,
    note: green ? `green (${cmd})` : `red (${cmd})`,
    cache: { sha: branchSha, result: green ? 'green' : 'red', count: summary.tests },
  };
}

// The graph gate. The node map IS the Yggdrasil graph, so the graph is what says the code is
// right and `yg check` is the only thing that reads it — it runs on every landing whatever
// `config.gates` holds, and a graph that refuses the tree is a refused merge.
//
// The item runs in two halves, because the two costs are different. The free half —
// `yg check --approve --only-deterministic` — records every verdict a script can reach, in any
// worktree, with no key and no judgement, and is always allowed. What it leaves is the prose
// rules, which a reader has to judge. So the item names those pairs rather than approving them,
// and it is ✓ only when a full `yg check` is green. Who that reader is — Yggdrasil's own reviewer,
// or a judge this command hands the pairs to — is config.judge's answer, read by the judge item.
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

  const res = runYgCheck(cfg, worktree);
  if (res.ok) return { ok: true, note: `${res.command} green${res.summary ? ` — ${res.summary}` : ''}` };

  const pending = pendingProsePairs(cfg, worktree);
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
    return {
      ok: false,
      pending: pending.pairs,
      note: `${res.command} exited ${res.exit} — the script rules are recorded (free, no key), and `
        + `${named.length} prose rule(s) still wait on a judgement: ${named.join(' · ')}`,
    };
  }
  return {
    ok: false,
    note: `${res.command} exited ${res.exit} — the graph refuses this tree${res.summary ? `: ${res.summary}` : ''}; a red graph is a red gate, whatever the level's gate command said`,
  };
}

// Who judges the prose rules, and whether they have. The graph item already found the pairs still
// waiting — that answer reaches `--json` through it, so this item reads it rather than opening a
// second, separately-paid channel to the same question.
//
//   tier      — this repository has a Yggdrasil reviewer configured. It fills the prose pairs
//               itself during the graph item's own run, so the only thing left to check is that
//               nothing came back unjudged.
//   one-shot  — this repository has no reviewer. The pairs are handed back with the two commands
//               that judge each one, the landing reports itself not ready, and it is run again
//               once the judge has answered.
//
// There is no default, on purpose: `horde init` decides it by looking at the repository, and a
// guessed answer here would either invent a reviewer that does not exist or pay for one twice.
function checkJudge(cfg, ticketId, graphItem, noGate) {
  const policy = cfg.judge;
  if (noGate) return { ok: true, note: 'skipped (--no-gate) — no prose rule was judged' };
  if (policy !== 'tier' && policy !== 'one-shot') {
    return {
      ok: false,
      note: `config.judge is ${policy === undefined ? 'unset' : `"${policy}"`} — who judges this repository's prose rules is not something this gate guesses. `
        + 'Set it to "tier" if the repository has a Yggdrasil reviewer configured, or "one-shot" if it has none and a judge answers out of band: '
        + 'horde.mjs config set judge tier|one-shot (horde.mjs init works it out for a new repository)',
    };
  }
  const pending = asArray(graphItem && graphItem.pending);
  if (pending.length === 0) {
    return {
      ok: true,
      pairs: [],
      note: policy === 'tier'
        ? 'every prose rule on this tree is judged — Yggdrasil\'s own reviewer answered them during the graph check'
        : 'no prose rule on this tree is waiting on a judgement',
    };
  }
  const pairs = pending.map((p) => ({ ...p, commands: verdictCommandsFor(cfg, p, '<judge>') }));
  if (policy === 'tier') {
    return {
      ok: false,
      pairs,
      note: `config.judge is "tier", so Yggdrasil's own reviewer was expected to judge these, and ${pairs.length} came back unjudged: `
        + `${pairs.map((p) => `${p.aspect} on ${p.unitKind}:${p.unit}`).join(' · ')}. Check the reviewer this repository has configured (yg init --provider …), or set config.judge to "one-shot" if it has none`,
    };
  }
  return {
    ok: false,
    pairs,
    brief: judgeBrief(ticketId, pairs),
    note: `${pairs.length} prose rule(s) wait on a judge, and this repository has none configured (config.judge: one-shot): `
      + `${pairs.map((p) => `${p.aspect} on ${p.unitKind}:${p.unit}`).join(' · ')}. The pairs and the exact commands that judge them are on this result; land again once they are answered`,
  };
}

// What a judge is handed: the pairs, and for each the two commands in the order they are run —
// the package names the hash, the record is bound to it. Written out in full so a judge copies
// rather than composes, since the hash is the one field it cannot invent.
function judgeBrief(ticketId, pairs) {
  return [
    `Ticket ${ticketId} cannot land until every prose rule below carries a judgement.`,
    '',
    'For each pair: read the rule, read the unit, decide pass or refused, then run the two commands.',
    'The package prints the hash; the record binds your verdict to it.',
    '',
    ...pairs.flatMap((p) => [
      `${p.aspect} on ${p.unitKind}:${p.unit}`,
      `  ${p.commands.package}`,
      `  ${p.commands.record}`,
      '',
    ]),
  ].join('\n');
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
// graph, on the branch's own tree, who owns every file the branch added.
export function unmappedFiles(contextByFile) {
  const out = [];
  for (const [file, doc] of contextByFile) {
    const kind = doc && doc.owner && doc.owner.kind;
    if (kind !== 'node') out.push(file);
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
  if (unmapped.length === 0) return { ok: true, note: `${candidates.length} added file(s), every one owned by a node` };
  const shown = unmapped.slice(0, 5).join(', ') + (unmapped.length > 5 ? '…' : '');
  return {
    ok: false,
    note: `${unmapped.length} added file(s) no node owns: ${shown} — map them in the owning node's yg-node.yaml in this same branch; a mapping and its first file land together`,
  };
}

function checkJournal(text, branch) {
  const lastEntry = latestTimestamp(text);
  const commitDate = git(['log', '-1', '--format=%cI', branch]);
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
// The fields below are read out of the block's body regardless of what the heading says — this
// guard has never parsed the heading itself, only decide.mjs's own duplicate-slug check needs
// that. Kind is "lower" for a rule the branch weakens, matched by the law guard below. Scope is
// "once" (used up by one landing, and this file records which) or "mission" (stands until the
// mission closes). An ask with no Answer is still open and passes nothing.
//
// The conflict-of-interest guard further down (conflictGuard) also calls findAnswer, with kind
// "conflict" — a branch that sharpens a rule and changes the code it judges in one landing. That
// is not one of ask.mjs's four kinds (019 only defines stop/stuck/lower/charter), so there is
// today no sanctioned path that produces a "conflict" block: only a decisions.md entry written by
// hand (decide.mjs add <slug> "**Kind:** conflict · **Aspect:** <id> ...") satisfies it. Flagged,
// not fixed here — inventing a fifth ask kind is exactly what 019 says not to do on its own.
function decisionsPath(horde) { return hordePath(horde, 'decisions.md'); }

function parseAsks(text) {
  if (!text) return [];
  const blocks = String(text).split(/^## /m).slice(1);
  return blocks.map((raw) => {
    const body = `## ${raw}`;
    const field = (label) => {
      const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n·]*)`, 'i').exec(body);
      return m ? m[1].trim() : '';
    };
    return {
      body,
      kind: field('Kind').toLowerCase(),
      aspect: field('Aspect'),
      scope: (field('Scope') || 'once').toLowerCase(),
      answer: field('Answer'),
      consumed: field('Consumed'),
    };
  });
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
  const res = ygJson(tree, cfg, args, schema);
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

// The reach of every rule on one tree: `yg check --json` already enumerates every (aspect, unit)
// pair it verifies, which IS the set of units each rule reaches — one call, no text parsed, and
// no per-unit walk. `--full` because a repository with a configured reference branch would
// otherwise answer about a different slice of itself in each of the two trees, and a comparison
// of two different questions is not a comparison.
function reachByAspect(tree, cfg) {
  const doc = ygDocAt(tree, cfg, ['check', '--json', '--full'], 'yg-check/1', 'which units each rule reaches');
  const reach = new Map();
  for (const pair of asArray(doc.pairs)) {
    if (!pair || !pair.aspect || !pair.unit) continue;
    const key = `${pair.unit.kind}:${pair.unit.path}`;
    if (!reach.has(pair.aspect)) reach.set(pair.aspect, new Set());
    reach.get(pair.aspect).add(key);
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

function conflictGuard(cfg, horde, baseTree, headTree, changedFiles, headReach) {
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
  const ownerOf = new Map();
  for (const f of codeFiles) {
    const doc = ygJson(headTree, cfg, ['context', '--file', f, '--json'], 'yg-context/1');
    ownerOf.set(f, doc.state === 'ok' && doc.doc.owner && doc.doc.owner.kind === 'node' ? doc.doc.owner.path : null);
  }
  const refusals = [];
  for (const [id, files] of touched) {
    // Reach comes from the pairs `yg check` actually verifies, not from the list of rules a file's
    // context names: a rule with a `scope.files` filter is named on the component while reaching
    // only some of its files, and asking the context would call every one of them reached.
    const reach = headReach.get(id) || new Set();
    const reached = codeFiles.filter((f) => reach.has(`file:${f}`) || (ownerOf.get(f) && reach.has(`node:${ownerOf.get(f)}`)));
    if (reached.length === 0) continue;
    if (findAnswer(horde, 'conflict', id)) continue;
    refusals.push({
      aspect: id,
      case: 'conflict of interest',
      note: `This branch changes the rule "${id}" (${[...files].join(', ')}) and, in the same landing, ${reached.length} file(s) that rule reaches: ${reached.slice(0, 5).join(', ')}${reached.length > 5 ? '…' : ''}. `
        + 'A rule and the code it judges do not get written together by the same hand in one landing. Split it: one ticket for the code, one for the rule, landing separately so each is judged by a law it did not write.',
    });
  }
  return { ok: refusals.length === 0, refusals };
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

function mergeIntoParent(root, cfg, branch, parentBranch, parentTip, ticketId, cleaner, horde) {
  // Derived from the ticket and from the diff, and from nothing about this run — so a merge an
  // adopter's commit hook rejects costs the commit nothing: the next landing builds the same
  // trailers, byte for byte, rather than a shorter message the second time round.
  const message = mergeMessage(root, horde, branch, parentBranch, ticketId);
  const checkout = worktreeOn(root, parentBranch);

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
    try {
      execFileSync('git', ['merge', '--no-ff', '-m', message, branch], { cwd: checkout, stdio: 'pipe' });
    } catch (e) {
      const files = conflictingFiles(checkout);
      git(['merge', '--abort'], checkout);
      return {
        ok: false,
        conflict: true,
        files,
        note: `the merge into ${parentBranch} conflicts and was aborted — ${parentBranch} is untouched at ${short(parentTip)}. In conflict: ${files.length ? files.join(', ') : ((e.stdout && e.stdout.toString()) || '').trim()}. Catch the branch up with ${parentBranch}, resolve it there, and land again`,
      };
    }
    return { ok: true, sha: git(['rev-parse', parentBranch], root), note: `merged --no-ff into ${parentBranch} at ${checkout}` };
  }

  const info = resolveTree({ scratch: parentTip }, { cwd: root });
  cleaner.add(() => cleanupTree(info, root));
  try {
    execFileSync('git', ['merge', '--no-ff', '-m', message, branch], { cwd: info.path, stdio: 'pipe' });
  } catch (e) {
    const files = conflictingFiles(info.path);
    git(['merge', '--abort'], info.path);
    return {
      ok: false,
      conflict: true,
      files,
      note: `the merge into ${parentBranch} conflicts and was aborted — ${parentBranch} is untouched at ${short(parentTip)}. In conflict: ${files.length ? files.join(', ') : ((e.stdout && e.stdout.toString()) || '').trim()}. Catch the branch up with ${parentBranch}, resolve it there, and land again`,
    };
  }
  const merged = git(['rev-parse', 'HEAD'], info.path);
  // The old value is named, so a parent that moved while this ran refuses here instead of
  // silently discarding whatever landed on it in the meantime.
  if (git(['update-ref', `refs/heads/${parentBranch}`, merged, parentTip], root) === null) {
    return {
      ok: false,
      note: `${parentBranch} moved while this landing ran — it is no longer at ${short(parentTip)}, so the merge built on that tip was not applied. Nothing was changed; land again against the branch as it stands now`,
    };
  }
  return { ok: true, sha: merged, note: `merged --no-ff into ${parentBranch}` };
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

// ---- main -------------------------------------------------------------------------

function run(horde, root, cfg, arg, level, noGate, flags) {
  const cleaner = makeCleaner();
  const found = findQueueItem(horde, arg);
  if (!found) fail(`no queue item names ${arg} — is the ticket tracked by queue.mjs?`);
  const { team, teamDir, item } = found;
  const branch = item.branch;
  if (!branch) fail(`ticket ${item.ticket} has no branch yet — nothing to land (queue.mjs set ${item.ticket} running cuts one)`);
  const branchSha = git(['rev-parse', '--verify', branch]);
  if (!branchSha) fail(`no such branch: ${branch}`);

  const parent = parentBranchOf(horde, team, item, { cwd: root });
  const parentBranch = parent.branch;
  const parentTip = git(['rev-parse', '--verify', parentBranch]);
  // Both guards read two trees and compare them. Without a base there is no comparison to make,
  // and a landing that skipped the comparison because the base was missing would be the one
  // landing where the law could be rewritten freely.
  if (!parentTip) {
    fail(`no such branch: ${parentBranch} — the guards that keep a landing from weakening the rules read the base tree and this branch's tree and compare them, and with no base there is nothing to compare against. Restore ${parentBranch}, or fix config.base`);
  }

  const ticketId = String(item.ticket);
  const issueDirName = findIssueDir(teamDir, ticketId);
  if (!issueDirName) fail(`no ticket found for ${ticketId} in team ${team}`);
  const issueDirPath = join(teamDir, 'issues', issueDirName);
  const issueText = readText(join(issueDirPath, 'issue.md'));
  const logText = readText(join(issueDirPath, 'log.md'));
  const nodes = ticketNodes(issueText);
  const declaredFiles = ticketFiles(issueText);

  const changedFiles = diffPaths(['diff', '--name-only', `${parentBranch}...${branch}`]);
  const addedFiles = diffPaths(['diff', '--name-only', '--diff-filter=A', `${parentBranch}...${branch}`]);

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
    results.scope = checkScope(root, cfg, nodes, changedFiles, declaredFiles);
    results['revert test'] = checkRevertTest(root, cfg, branch, parentBranch, changedFiles, issueText);
    results.journal = checkJournal(logText, branch);
    results['graph text'] = checkGraphText(root, branch, parentBranch, changedFiles);

    if (!noGate) {
      // Both guards run before the expensive half and before anything merges: a branch that
      // rewrote the law it is judged by would otherwise be judged by the law it wrote.
      const law = lawGuard(cfg, horde, base.path, head.path);
      if (law.stopped) fail(law.stopped);
      guards.push(...law.refusals);
      const conflict = conflictGuard(cfg, horde, base.path, head.path, changedFiles, law.headReach);
      guards.push(...conflict.refusals);
      if (guards.length) {
        fail(`${guards.length} refusal(s) — this branch may not land as it stands:\n${guards.map((g) => `- ${g.aspect} (${g.case}): ${g.note}`).join('\n')}`);
      }
      law.used.forEach((answer) => consumeAnswer(horde, answer, ticketId, branchSha));
    }

    // The lock covers the repository's own gate command and both `yg check` runs, and nothing
    // else: those are what two landings at once would run over each other.
    const lock = noGate ? { ok: true, notes: [], release: () => {} } : acquireGateLock(ticketId, branch, { waitMs: lockWait(cfg) });
    lockNotes = lock.notes || [];
    if (!lock.ok) fail(lock.note);
    // Also on the cleaner, so a landing killed while holding it releases rather than leaving the
    // next one to work out that the pid is gone.
    cleaner.add(lock.release);
    try {
      results.gate = checkGate(cfg, level, head.path, branchSha, noGate);
      results.graph = checkGraph(cfg, head.path, noGate);
      results.mapping = checkMapping(cfg, head.path, addedFiles, noGate);
    } finally {
      lock.release();
    }
    results.judge = checkJudge(cfg, ticketId, results.graph, noGate);

    const checks = CHECK_ORDER.map((name) => ({ name, ok: !!results[name].ok, note: results[name].note }));
    const allOk = checks.every((c) => c.ok);

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
          ticket: ticketId, branch, sha: branchSha, ok: false, checks, pairs: [], brief: null, landed: null, lock: lockNotes,
        }, head, flags, parent, level);
      }
      landed = { ticket: ticketId, sha: merged.sha, at: nowIso() };
      recordMerged(horde, team, ticketId, merged.sha, { tree: root });
      appendLanded(issueDirPath, landed, parentBranch);
      checks.push({ name: 'merge', ok: true, note: `${merged.note} — ${short(merged.sha)}` });
    } else if (!allOk && !noGate) {
      recordChanges(horde, ticketId, checks);
    }

    const judge = results.judge || {};
    return finish(horde, ticketId, {
      ticket: ticketId,
      branch,
      sha: branchSha,
      ok: allOk,
      checks,
      pairs: asArray(judge.pairs),
      brief: judge.brief || null,
      landed,
      lock: lockNotes,
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
  // withProvenance names the tree this ran in; `branch` and `sha` stay the ticket's own, because
  // the throwaway tree is detached and would otherwise report the branch as null — erasing the one
  // field every reader of this result needs. The tree sits at exactly `sha` either way.
  const full = {
    ...withProvenance({
      ...result,
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
    ...asArray(result.lock).map((n) => `· ${n}`),
    ...result.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.note}`),
    result.landed ? `LANDED ${short(result.landed.sha)}` : 'NOT LANDED',
    provenanceLine(head),
  ].join('\n'));
  if (!result.ok) process.exit(1);
  return full;
}

// `--background` is the same run, started and let go of: the caller gets the path of the file the
// run will write and stops waiting. Nothing reads that file here — a landing never trusts a
// recorded result, its own or anyone's — it is written for whatever asks later what happened.
function startInBackground(horde, ticketId, argv) {
  const self = fileURLToPath(import.meta.url);
  const args = argv.filter((a) => a !== '--background');
  const child = spawn(process.execPath, [self, ...args, '--result', '--json'], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();
  return resultPath(horde, ticketId);
}

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv, { flags: ['no-gate', 'background', 'result'] });
  if (flags.help) { console.log(USAGE); process.exit(0); }
  const arg = positional[0];
  if (!arg) fail('land requires <ticket|branch>');
  if (flags.level === 'team') fail('--level team no longer exists — omit --level, or pass --level trunk for a branch landing directly on <horde>/trunk');
  if (flags.level !== undefined && flags.level !== 'trunk') fail('--level must be "trunk"');
  const level = flags.level || 'team';

  const horde = resolveHorde(flags);
  const info = resolveTree({ tree: flags.tree }, { cwd: process.cwd() });
  const root = info.path;
  const cfg = readConfig() || {};

  if (flags.background) {
    const found = findQueueItem(horde, arg);
    if (!found) fail(`no queue item names ${arg} — is the ticket tracked by queue.mjs?`);
    const ticketId = String(found.item.ticket);
    const path = startInBackground(horde, ticketId, argv);
    emit(
      { ticket: ticketId, branch: found.item.branch, resultFile: path, started: nowIso() },
      flags,
      () => `land ${ticketId} started in the background — its result will be written to ${path}`,
    );
    return;
  }

  run(horde, root, cfg, arg, level, !!flags['no-gate'], flags);
}

if (isMain(import.meta.url)) main();
