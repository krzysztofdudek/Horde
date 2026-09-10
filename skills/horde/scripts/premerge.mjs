#!/usr/bin/env node
// horde skill — premerge.mjs
//
// The mechanical pre-merge checklist. Never interprets a red item — that's the steward's
// escalation to make — it only reports ✓/✗ per item and exits non-zero on any ✗.
//
// A branch is found by locating the queue item that names it, in trunk's own queue.json: an
// ordinary ticket branch `<horde>/t-NNN`. The branch it must be rooted on, and will merge into, is
// normally `<horde>/trunk` — and, for a ticket started from an unmerged dependency's tip, that
// dependency's branch until it merges. `parentBranchOf` answers that once, and every item below is
// measured against its answer: the base, the diff, the tree a new test is reverted onto.

import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import {
  repoRoot, hordePath, readJSON, writeJSON, readText, writeText, readConfig, git, fail, parseArgs,
  asArray, emit, isMain, resolveHorde, parentBranchOf,
} from './_lib.mjs';
import {
  ticketNodes, runYgCheck, ygCommand, fillDeterministic, pendingProsePairs, globToRegExp, pathInBoundary, ticketBoundary, ygFileContext, ygAvailable,
} from './node.mjs';
import { ticketFiles } from './tk.mjs';

const USAGE = `usage: premerge.mjs <branch> [--level trunk] [--no-gate] [--horde h]

The checks, in order — ✓/✗ per line, non-zero exit on any ✗:
  1. base freshness — branch rooted at its parent branch's tip
  2. scope          — diff stays inside the files the ticket declared, or its node boundaries when
                      it declared none; no protected path touched
  3. revert test    — new test files (named by config.testGlobs), extracted onto the parent's
                      tree, fail there; ✗ when this repository's test patterns are unknown
  4. gate           — green at this SHA (a pre-migration ticket's recorded green gate, or a fresh
                      run)
  5. graph          — the free deterministic verdicts recorded, every prose rule still waiting
                      on a judgement named, and a full "yg check" green on this branch's tree
                      (it runs whatever config.gates holds)
  6. mapping        — every file the branch added is owned by a node on the branch's own tree
                      (a mapping and its first file land in the same commit); skipped with --no-gate
  7. journal        — a log entry newer than the last commit
  8. graph text     — charters, logs and "graph:" commits touched by the branch carry no mission
                      language (wave, ticket NNN, mission, horde, E<n>, .temp/): the graph is plan-agnostic

--level selects the gate command (config.gates.team or .trunk; default team — "trunk" is only for
a branch landing directly on <horde>/trunk; "team" is no longer a value you pass, only the
default). --no-gate skips items 4 and 5 (informational: pass).

options: --json  --help`;

function short(sha) { return sha ? sha.slice(0, 7) : '(none)'; }

// ---- locating the branch's context ------------------------------------------------

// The team whose queue.json names this branch, and the item itself. Only "trunk" exists.
function findQueueItemByBranch(horde, branch) {
  const teamDir = hordePath(horde, 'teams', 'trunk');
  const queue = readJSON(join(teamDir, 'queue.json'), { items: [] });
  const item = asArray(queue.items).find((it) => it.branch === branch);
  return item ? { team: 'trunk', teamDir, item } : null;
}

function findIssueDir(teamDir, ticketId) {
  const issuesDir = join(teamDir, 'issues');
  if (!existsSync(issuesDir)) return null;
  return readdirSync(issuesDir, { withFileTypes: true })
    .find((e) => e.isDirectory() && e.name.startsWith(`${ticketId}-`))?.name || null;
}

// ---- tolerant field readers --------------------------------------------------------

// The last "## Verdict · …" block in a ticket's log — a pre-migration verdict's own rendering.
// Nothing writes one any more; this stays only so a ticket logged before this migration still
// yields its recorded green gate below instead of paying for a fresh run. Read loosely: only the
// **Result:** line and the **Gate:** line ("green at sha …" / "red at sha …") are used.
function lastVerdictBlock(logText, ticketId) {
  if (!logText) return null;
  const re = new RegExp(`## Verdict · ${ticketId} ·[\\s\\S]*?(?=\\n## Verdict|$)`, 'g');
  const blocks = logText.match(re);
  return blocks && blocks.length ? blocks[blocks.length - 1] : null;
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
// touches, the reviewers approved that, and a diff that reaches past it is a widened ticket
// nobody agreed to. The fix is never a quiet pass — it is `tk.mjs edit NNN --files …`, which
// writes the new list and a log line saying who widened it and when.
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
function childTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
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
  // and pick up whatever non-space token starts the next line (e.g. "**Keys:**").
  const header = /\*\*Revert base:\*\*[ \t]*(\S+)/.exec(issueText)?.[1];
  if (header) return header;
  const m = /\bred on (\S+)/.exec(issueText);
  return m ? m[1].replace(/[.,;:]+$/, '') : null;
}

// New test files (git-added, matching config.testGlobs) extracted onto the revert base's tip
// (the parent branch, unless the ticket names another ref — see revertBaseRef) in a scratch
// worktree — never the caller's own tree — and run there; each must show at least one failure,
// since a new test that already passes on its base proves nothing. A file this repo's own runner
// (`node --test`) can run directly is run directly; anything else falls back to the whole
// `gates.commit` command (coarser: any red in that command counts as "a failure" for this file,
// since isolating just its test lane out of an arbitrary configured command isn't possible in
// general — see the README note this tool appends).
function checkRevertTest(root, cfg, branch, parentBranch, files, issueText) {
  const base = revertBaseRef(issueText) || parentBranch;
  // "No new test files in this diff" is only a result when the patterns this repository's tests
  // are named with are actually known. Without them the same ✓ would mean "I did not look" — the
  // strongest guarantee against a fabricated result passing empty, and saying so — so this
  // refuses instead, and names the one setting that fixes it.
  const testGlobs = Array.isArray(cfg.testGlobs) ? cfg.testGlobs.filter(Boolean) : [];
  if (testGlobs.length === 0) {
    return {
      ok: false,
      note: 'cannot recognise a test file in this repository — config.testGlobs is unset, so "no new tests in the diff" would mean "not looked", not "none". Name the patterns this repository\'s tests are written under: horde.mjs config set testGlobs "<glob>,<glob>"',
    };
  }
  const nameStatus = (git(['diff', '--name-status', `${parentBranch}...${branch}`]) || '')
    .split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.join('\t') }; });
  const newTestFiles = nameStatus
    .filter((e) => e.status === 'A' && files.includes(e.path))
    .filter((e) => testGlobs.some((g) => globToRegExp(g).test(e.path)))
    .map((e) => e.path);

  if (newTestFiles.length === 0) {
    return { ok: true, note: `no new test files in diff (looked for ${testGlobs.join(', ')})` };
  }

  if (!git(['rev-parse', '--verify', base])) return { ok: false, note: `revert base not found: ${base}` };

  const tmp = mkdtempSync(join(tmpdir(), 'premerge-revert-'));
  const results = [];
  try {
    execFileSync('git', ['worktree', 'add', '--detach', '--force', tmp, base], { cwd: root, stdio: 'pipe' });
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
    try { execFileSync('git', ['worktree', 'remove', tmp, '--force'], { cwd: root, stdio: 'pipe' }); } catch { rmSync(tmp, { recursive: true, force: true }); }
  }
  const ok = results.every((r) => r.ok);
  const baseNote = base === parentBranch ? '' : `base ${base} — `;
  return { ok, note: baseNote + results.map((r) => `${r.path}: ${r.note}`).join(' · ') };
}

function findWorktreePath(root, branch) {
  const out = git(['worktree', 'list', '--porcelain'], root) || '';
  for (const block of out.split(/\n\n+/)) {
    const wt = /^worktree (.+)$/m.exec(block);
    const br = /^branch refs\/heads\/(.+)$/m.exec(block);
    if (wt && br && br[1] === branch) return wt[1];
  }
  return null;
}

function loadGateCache(horde) {
  return readJSON(hordePath(horde, 'cache', 'last-gate.json'), {});
}

function saveGateCache(horde, cache) {
  writeJSON(hordePath(horde, 'cache', 'last-gate.json'), cache);
}

function checkGate(horde, root, cfg, level, branch, branchSha, logText, ticketId, noGate) {
  const verdictBlock = lastVerdictBlock(logText, ticketId);
  if (verdictBlock) {
    const resultLine = /\*\*Result:\*\*\s*(\S+)/.exec(verdictBlock)?.[1];
    const gateLine = /\*\*Gate:\*\*[^\n]*$/m.exec(verdictBlock)?.[0] || '';
    const shaMatch = /green at sha (\S+)/.exec(gateLine);
    if (resultLine === 'reproduced' && shaMatch && (shaMatch[1] === branchSha || shaMatch[1] === short(branchSha))) {
      return { ok: true, note: `accepted the pre-migration verdict's recorded green gate at ${short(branchSha)}`, cache: { sha: branchSha, result: 'green', count: null } };
    }
  }
  if (noGate) return { ok: true, note: 'skipped (--no-gate)', cache: null };

  const cmd = cfg.gates && cfg.gates[level];
  if (!cmd) return { ok: false, note: `no config.gates.${level} configured` };
  const worktree = findWorktreePath(root, branch);
  if (!worktree) return { ok: false, note: `no worktree checked out for ${branch}` };
  let green = true;
  let out = '';
  try {
    out = execSync(cmd, { cwd: worktree, stdio: 'pipe' }).toString();
  } catch (e) {
    green = false;
    out = ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || '');
  }
  const summary = parseNodeTestSummary(out);
  return {
    ok: green,
    note: green ? `green (${cmd})` : `red (${cmd})`,
    cache: { sha: branchSha, result: green ? 'green' : 'red', count: summary.tests },
  };
}

// The graph gate. The node map IS the Yggdrasil graph, so the graph is what says the code is
// right and `yg check` is the only thing that reads it — it runs on every premerge whatever
// `config.gates` holds, and a graph that refuses the tree is a refused merge. Without this the
// level's gate can be green on a tree `yg check` exits 1 on, which is exactly the state a
// repository whose own gate command doesn't call `yg` is in by default.
//
// The item runs in two halves, because the two costs are different. The free half —
// `yg check --approve --only-deterministic` — records every verdict a script can reach, in any
// worktree, with no key and no judgement, and is always allowed. What it leaves is the prose
// rules, which a reader has to judge; verifier-is-yggdrasil-reviewer says that reader is the
// ticket's verifier, judging under its own name through `yg verdict`. So the item names those
// pairs rather than approving them, and it is ✓ only when a full `yg check` is green — every
// script verdict recorded AND every prose verdict judged and bound to this code.
function checkGraph(root, cfg, branch, noGate) {
  const display = ygCommand(cfg).display;
  if (noGate) return { ok: true, note: `skipped (--no-gate) — \`${display} check\` was not run` };
  const worktree = findWorktreePath(root, branch);
  if (!worktree) {
    return {
      ok: false,
      note: `no worktree checked out for ${branch} — \`${display} check\` reads a tree, so it cannot judge this branch; check it out (queue.mjs set <t> running does) and run premerge again`,
    };
  }

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
        + `${named.length} prose rule(s) still wait on a judgement: ${named.join(' · ')}. `
        + 'The verifier judges them under its own name; its brief carries the exact package/record '
        + `commands, or list them with: node.mjs verdicts --at ${worktree}`,
    };
  }
  return {
    ok: false,
    note: `${res.command} exited ${res.exit} — the graph refuses this tree${res.summary ? `: ${res.summary}` : ''}; a red graph is a red gate, whatever the level's gate command said`,
  };
}

// The graph is plan-agnostic: a node's charter and log say what the node is and what must stay
// true, never which wave, ticket or mission touched it. Mission language in committed graph text
// is the working state of one horde leaking into a document every later reader treats as
// permanent — a real mission found "mission" 63 times across 23 charters. Deterministic on
// purpose: the words below are the ones that only a plan uses.
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
  if (!worktree) return { ok: false, note: 'no worktree checked out for this branch — cannot ask the graph who owns the added files' };
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

// ---- main -------------------------------------------------------------------------

function run(horde, root, cfg, branch, level, noGate, flags) {
  const branchSha = git(['rev-parse', '--verify', branch]);
  if (!branchSha) fail(`no such branch: ${branch}`);

  const found = findQueueItemByBranch(horde, branch);
  if (!found) fail(`no queue item names branch ${branch} — is it tracked by queue.mjs?`);
  const { team, teamDir, item } = found;
  const parent = parentBranchOf(horde, team, item, { cwd: root });
  const parentBranch = parent.branch;

  const changedFiles = (git(['diff', '--name-only', `${parentBranch}...${branch}`]) || '').split('\n').filter(Boolean);
  const addedFiles = (git(['diff', '--name-only', '--diff-filter=A', `${parentBranch}...${branch}`]) || '').split('\n').filter(Boolean);

  const checks = [{ name: 'base freshness', ...checkBaseFreshness(branch, parentBranch) }];

  const ticketId = String(item.ticket);
  const issueDirName = findIssueDir(teamDir, ticketId);
  if (!issueDirName) fail(`no ticket found for ${ticketId} in team ${team}`);
  const issueDirPath = join(teamDir, 'issues', issueDirName);
  const issueText = readText(join(issueDirPath, 'issue.md'));
  const logText = readText(join(issueDirPath, 'log.md'));
  const nodes = ticketNodes(issueText);
  const declaredFiles = ticketFiles(issueText);

  checks.push({ name: 'scope', ...checkScope(root, cfg, nodes, changedFiles, declaredFiles) });
  checks.push({ name: 'revert test', ...checkRevertTest(root, cfg, branch, parentBranch, changedFiles, issueText) });

  const gate = checkGate(horde, root, cfg, level, branch, branchSha, logText, ticketId, noGate);
  checks.push({ name: 'gate', ok: gate.ok, note: gate.note });
  if (gate.cache) {
    const cache = loadGateCache(horde);
    cache[level] = { ...gate.cache, at: new Date().toISOString() };
    saveGateCache(horde, cache);
  }

  checks.push({ name: 'graph', ...checkGraph(root, cfg, branch, noGate) });
  checks.push({ name: 'mapping', ...checkMapping(cfg, findWorktreePath(root, branch), addedFiles, noGate) });

  checks.push({ name: 'journal', ...checkJournal(logText, branch) });
  checks.push({ name: 'graph text', ...checkGraphText(root, branch, parentBranch, changedFiles) });

  const allOk = checks.every((c) => c.ok);
  const result = {
    branch,
    level,
    ticket: ticketId,
    team,
    parent: parentBranch,
    stackedOn: parent.stacked ? parent.stackedOn : null,
    checks,
    ok: allOk,
  };
  emit(result, flags, () => [
    `premerge ${branch} (level: ${level})${parent.stacked ? ` · stacked on ${parent.stackedOn}` : ''}`,
    ...checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.note}`),
    allOk ? 'READY' : 'NOT READY',
  ].join('\n'));
  if (!allOk) process.exit(1);
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), { flags: ['no-gate'] });
  if (flags.help) { console.log(USAGE); process.exit(0); }
  const branch = positional[0];
  if (!branch) fail('premerge requires <branch>');
  if (flags.level === 'team') fail('--level team no longer exists — omit --level, or pass --level trunk for a branch landing directly on <horde>/trunk');
  if (flags.level !== undefined && flags.level !== 'trunk') fail('--level must be "trunk"');
  const level = flags.level || 'team';

  const horde = resolveHorde(flags);
  const root = repoRoot();
  const cfg = readConfig() || {};

  run(horde, root, cfg, branch, level, !!flags['no-gate'], flags);
}

if (isMain(import.meta.url)) main();
