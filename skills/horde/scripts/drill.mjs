#!/usr/bin/env node
// horde skill — drill.mjs
//
// A drill asks whether a discipline was actually held, and it asks the files and the branches, not
// the agent. Every assertion below reads real `.horde/` state and real git history: a verdict block
// the verifier wrote, a review line the owner wrote, the commits on a ticket's branch. Nothing here
// reads an agent's prose, because prose is what a discipline fails while sounding fine.
//
// Four of the five disciplines carry a drill (reference/discipline/README.md maps them); debugging
// has none — its rule is "three failed fixes become a dissent", which lives in the fix loop.
//
// The corpus is `tests/drills/<drill>/{violates-*,satisfies-*}/`, the same convention `yg drill`
// uses: `run` expects red on every violates case and green on every satisfies case. A case is a git
// bundle of the relevant branch refs plus a snapshot of `.horde/`, written by `record` from a real
// horde — so a mission's hard moment becomes a fixture instead of being described in a comment.
//
// The revert machinery here is deliberately its own: land.mjs asks whether a branch's new tests
// fail on the branch it merges into, which is a question about the merge; this asks whether the
// commit that introduced them could have failed at the moment it was written, which is a question
// about how the work was done. Same technique, different subject, and the landing gate is not modified.

import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import {
  repoRoot, hordePath, teamPath, readJSON, writeJSON, readText, readConfig, git, nowIso,
  fail, parseArgs, asArray, emit, isMain, resolveHorde, parentBranchOf,
} from './_lib.mjs';
import { findTicket, ticketFiles } from './tk.mjs';
import {
  nodeExists, nodeBoundary, nodeGraphPathPrefix, ticketNodes,
} from './node.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISCIPLINE_DIR = join(HERE, '..', 'reference', 'discipline');
const DEFAULT_CORPUS = join(HERE, 'tests', 'drills');

const USAGE = `usage: drill.mjs <command> [options]

commands:
  list [--corpus <dir>]
      the disciplines, the drill each carries, and the corpus cases recorded for it.
  check <drill> --repo <dir> [--ticket NNN] [--horde h]
      asserts the drill against real state in that repository. ✓/✗ per line, non-zero on any ✗.
  run <drill> [--corpus <dir>] [--yg <command>]
      restores every corpus case into a temporary repository and checks it: a "violates-" case
      must come out red, a "satisfies-" case green. Non-zero when any case says otherwise.
      A case carries no way of invoking the Yggdrasil CLI — that is a property of the machine
      running the drill, never of the recorded state — so it is taken from --yg, else from this
      repository's own config.ygCommand, else the bare "yg" on PATH.
  record <name> --discipline <d> --expect violates|satisfies [--ticket NNN] [--horde h]
      [--corpus <dir>] [--note "…"]
      snapshots this repository's .horde/ state and the ticket's branch refs into a new case
      <corpus>/<drill>/<expect>-<name>/. Runs the check first and refuses when the outcome
      contradicts --expect, so a recorded case is one "run" accepts.

drills: tdd (tdd) · verification (verification) · review (review) · scope (framing)
Debugging carries no drill: its rule — three failed fixes become a dissent — is held by the fix loop.

options: --json  --help`;

// ---- the disciplines and their drills ------------------------------------------------

const DISCIPLINES = ['tdd', 'debugging', 'verification', 'review', 'framing'];

const DRILLS = {
  tdd: {
    discipline: 'tdd',
    asks: 'a commit on the ticket branch introduced tests that fail on that commit\'s parent',
    check: checkTdd,
  },
  verification: {
    discipline: 'verification',
    asks: 'the verdict is reproduced, every row carries a command and what it printed, and the gate\'s sha is the branch tip',
    check: checkVerification,
  },
  review: {
    discipline: 'review',
    asks: 'every change request names a severity, and none of them is Minor alone',
    check: checkReview,
  },
  scope: {
    discipline: 'framing',
    asks: 'the diff stays inside the files the ticket declared, or its nodes when it declared none, and touches no protected path',
    check: checkScope,
  },
};

// --discipline accepts a drill's name, or a discipline that carries exactly one drill.
function resolveDrill(name) {
  if (!name) fail(`--discipline is required, one of: ${Object.keys(DRILLS).join(', ')}`);
  if (DRILLS[name]) return name;
  const owned = Object.keys(DRILLS).filter((d) => DRILLS[d].discipline === name);
  if (owned.length === 1) return owned[0];
  if (DISCIPLINES.includes(name)) {
    fail(`the discipline "${name}" carries no drill — it is held by the process, not by an assertion on files`);
  }
  fail(`unknown drill: ${name} (drills: ${Object.keys(DRILLS).join(', ')})`);
  return null;
}

// ---- git helpers (a drill reads history, so every one of these is read-only) -----------

function shortSha(sha) { return sha ? sha.slice(0, 7) : '(none)'; }

function shaMatches(recorded, tip) {
  if (!recorded || !tip) return false;
  return recorded === tip || recorded === shortSha(tip) || shortSha(recorded) === shortSha(tip);
}

function globToRegExp(glob) {
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let out = '';
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3; } else if (glob.startsWith('**', i)) { out += '.*'; i += 2; } else if (glob[i] === '*') { out += '[^/]*'; i += 1; } else { out += esc(glob[i]); i += 1; }
  }
  return new RegExp(`^${out}$`);
}

function pathInBoundary(path, boundary) {
  return boundary.some((pat) => (pat.includes('*') ? globToRegExp(pat).test(path) : path === pat || path.startsWith(pat)));
}

// Files added by one commit (status A), as paths.
function filesAddedBy(root, sha) {
  const out = git(['diff-tree', '--no-commit-id', '--name-status', '-r', sha], root) || '';
  return out.split('\n').filter(Boolean)
    .map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.join('\t') }; })
    .filter((e) => e.status === 'A')
    .map((e) => e.path);
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

// A nested `node --test` no-ops when it thinks it is already inside a test run; this tool is run
// from inside one by its own suite, so those markers come off before the child starts.
//
// Also forces color off, for the same reason land.mjs's own copy of this function does:
// parseNodeTestSummary expects a plain "ℹ tests N" line at column zero, and FORCE_COLOR/COLORTERM
// inherited from whoever is running this tool (a color terminal, an agent, a CI runner) makes
// Node's test runner prefix that line with an ANSI escape regardless of TTY, turning a real
// "N fail / N tests" into an unparseable "? fail / ? tests".
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

// Runs the given test files at `ref` in a scratch worktree — the files' content taken from
// `contentRef` (which is a different commit when the question is "would these have failed back
// then"). Returns [{path, failures, tests, note}]; failures is null when nothing could run them.
function runTestsAt(root, cfg, ref, contentRef, paths) {
  const tmp = mkdtempSync(join(tmpdir(), 'drill-'));
  const results = [];
  try {
    execFileSync('git', ['worktree', 'add', '--detach', '--force', tmp, ref], { cwd: root, stdio: 'pipe' });
    for (const relPath of paths) {
      const content = git(['show', `${contentRef}:${relPath}`], root);
      if (content === null) { results.push({ path: relPath, failures: null, note: 'could not read the file at that commit' }); continue; }
      const abs = join(tmp, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      if (/\.(m?js|c?js)$/.test(relPath)) {
        const out = runCapture('node', ['--test', relPath], { cwd: tmp, env: childTestEnv() });
        const summary = parseNodeTestSummary(out);
        results.push({
          path: relPath, failures: summary.fail ?? 0, tests: summary.tests, note: `${summary.fail ?? '?'} fail / ${summary.tests ?? '?'} tests`,
        });
      } else if (cfg.gates && cfg.gates.commit) {
        let failed = false;
        try { execSync(cfg.gates.commit, { cwd: tmp, stdio: 'pipe' }); } catch { failed = true; }
        results.push({ path: relPath, failures: failed ? 1 : 0, note: failed ? 'the fast check is red here' : 'the fast check is green here' });
      } else {
        results.push({ path: relPath, failures: null, note: 'no runner: not a node test file, and no fast check configured' });
      }
    }
  } finally {
    try { execFileSync('git', ['worktree', 'remove', tmp, '--force'], { cwd: root, stdio: 'pipe' }); } catch { rmSync(tmp, { recursive: true, force: true }); }
  }
  return results;
}

// ---- the ticket under drill -----------------------------------------------------------

function onlyTicketId(horde) {
  const ids = [];
  const teamsRoot = hordePath(horde, 'teams');
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const issues = join(dir, d.name, 'issues');
      if (existsSync(issues)) {
        for (const i of readdirSync(issues, { withFileTypes: true })) {
          if (i.isDirectory()) ids.push(i.name.split('-')[0]);
        }
      }
      walk(join(dir, d.name, 'teams'));
    }
  };
  walk(teamsRoot);
  const unique = [...new Set(ids)].sort();
  if (unique.length === 1) return unique[0];
  if (unique.length === 0) fail('this horde has no tickets — a drill reads one ticket\'s state');
  fail(`this horde has ${unique.length} tickets (${unique.join(', ')}) — pass --ticket NNN`);
  return null;
}

function ticketContext(horde, ticketId) {
  const id = ticketId || onlyTicketId(horde);
  const ticket = findTicket(horde, id);
  if (!ticket) fail(`no such ticket: ${id}`);
  const leaf = String(ticket.team).split('/').pop();
  const queue = readJSON(teamPath(horde, ticket.team, 'queue.json'), { items: [] });
  const item = asArray(queue.items).find((it) => String(it.ticket) === ticket.id) || null;
  const branch = (item && item.branch) || `${horde}/t-${ticket.id}`;
  // The same parent the merge checklist and the keys use: the team's branch, or the unmerged
  // ticket this one was started from. A drill that counted a stacked ticket's commits from the
  // team branch would be reading its parent's work as its own.
  const parentBranch = item
    ? parentBranchOf(horde, ticket.team, item).branch
    : `${horde}/${leaf}`;
  return {
    horde,
    root: repoRoot(),
    cfg: readConfig() || {},
    ticket,
    item,
    branch,
    parentBranch,
    issueText: ticket.text,
    logText: readText(ticket.logPath) || '',
  };
}

// ---- drill: tdd -----------------------------------------------------------------------
//
// The question is not "was the test written first" — the order somebody typed in is not on the
// branch. It is "could this test have failed at the moment it arrived": the test files a commit
// added, run against that commit's own parent tree. A test that already passes there was written
// after the code that satisfies it, and it has never shown that it can fail.

function checkTdd(ctx) {
  const { root, cfg, branch, parentBranch } = ctx;
  const checks = [];
  const tip = git(['rev-parse', '--verify', branch], root);
  if (!tip) return [{ name: 'branch', ok: false, note: `no such branch: ${branch}` }];
  const base = git(['merge-base', branch, parentBranch], root);
  if (!base) return [{ name: 'branch', ok: false, note: `no merge base between ${branch} and ${parentBranch}` }];

  const globs = Array.isArray(cfg.testGlobs) ? cfg.testGlobs.filter(Boolean) : [];
  if (globs.length === 0) {
    return [{
      name: 'test patterns',
      ok: false,
      note: 'this repository\'s test patterns are unset, so "no new tests" would mean "did not look": horde.mjs config set testGlobs "<glob>,<glob>"',
    }];
  }

  const commits = (git(['rev-list', '--reverse', `${base}..${branch}`], root) || '').split('\n').filter(Boolean);
  checks.push({
    name: 'commits',
    ok: commits.length > 0,
    note: commits.length ? `${commits.length} commit(s) on ${branch} beyond ${shortSha(base)}` : `no commit on ${branch} beyond ${parentBranch}`,
  });
  if (commits.length === 0) return checks;

  const introducing = commits
    .map((sha) => ({ sha, added: filesAddedBy(root, sha).filter((p) => globs.some((g) => globToRegExp(g).test(p))) }))
    .filter((c) => c.added.length > 0);

  checks.push({
    name: 'new tests',
    ok: introducing.length > 0,
    note: introducing.length
      ? introducing.map((c) => `${shortSha(c.sha)}: ${c.added.join(', ')}`).join(' · ')
      : `no commit adds a test file (looked for ${globs.join(', ')}) — a change that adds none records "no-new-tests" on its verdict and is drilled on verification, not here`,
  });
  if (introducing.length === 0) return checks;

  const notes = [];
  let anyRed = false;
  for (const c of introducing) {
    const parent = git(['rev-parse', '--verify', `${c.sha}^`], root);
    if (!parent) { notes.push(`${shortSha(c.sha)}: no parent commit`); continue; }
    const results = runTestsAt(root, cfg, parent, c.sha, c.added);
    const red = results.every((r) => r.failures !== null) && results.some((r) => r.failures > 0);
    if (red) anyRed = true;
    notes.push(`${shortSha(c.sha)} on ${shortSha(parent)}: ${results.map((r) => `${r.path} ${r.note}`).join(', ')}`);
  }
  checks.push({
    name: 'red before',
    ok: anyRed,
    note: anyRed ? notes.join(' · ') : `${notes.join(' · ')} — the tests already passed on the tree they arrived on, so they never showed they can fail`,
  });

  const atTip = runTestsAt(root, cfg, branch, branch, introducing.flatMap((c) => c.added));
  const green = atTip.length > 0 && atTip.every((r) => r.failures === 0);
  checks.push({
    name: 'green after',
    ok: green,
    note: atTip.map((r) => `${r.path} ${r.note}`).join(' · ') || 'nothing to run at the tip',
  });
  return checks;
}

// ---- drill: verification --------------------------------------------------------------

function lastVerdictBlock(logText, ticketId) {
  if (!logText) return null;
  const re = new RegExp(`## Verdict · ${ticketId} ·[\\s\\S]*?(?=\\n## Verdict|$)`, 'g');
  const blocks = logText.match(re);
  return blocks && blocks.length ? blocks[blocks.length - 1] : null;
}

// The verdict's "| item | command | saw |" table, as rows of trimmed cells. The header and the
// separator row are dropped; a row is a claim only when it carries both a command and what it
// printed.
function verdictRows(block) {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => /^\|\s*item\s*\|/.test(l));
  if (start === -1) return [];
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells.length >= 3) rows.push({ item: cells[0], command: cells[1], saw: cells[2] });
  }
  return rows;
}

const EMPTY_CELL = /^(|—|-|–|n\/a|none|not run|tbd|\.\.\.|…)$/i;

function checkVerification(ctx) {
  const {
    root, branch, logText, ticket,
  } = ctx;
  const checks = [];
  const block = lastVerdictBlock(logText, ticket.id);
  if (!block) return [{ name: 'verdict', ok: false, note: `no verdict recorded on ticket ${ticket.id}` }];

  const result = /\*\*Result:\*\*\s*(\S+)/.exec(block)?.[1] || null;
  checks.push({
    name: 'verdict',
    ok: result === 'reproduced',
    note: result ? `result: ${result}` : 'the verdict block names no result',
  });

  const rows = verdictRows(block);
  const blank = rows.filter((r) => EMPTY_CELL.test(r.command) || EMPTY_CELL.test(r.saw));
  checks.push({
    name: 'what was run and seen',
    ok: rows.length > 0 && blank.length === 0,
    note: rows.length === 0
      ? 'the verdict carries no evidence row at all'
      : blank.length === 0
        ? `${rows.length} row(s), each with the command and what it printed`
        : `${blank.length} of ${rows.length} row(s) carry no command or nothing seen: ${blank.map((r) => r.item || '(unnamed)').join(', ')}`,
  });

  const tip = git(['rev-parse', '--verify', branch], root);
  const gateLine = /\*\*Gate:\*\*[^\n]*$/m.exec(block)?.[0] || '';
  const gateSha = /green at sha (\S+)/.exec(gateLine)?.[1] || null;
  checks.push({
    name: 'gate at the tip',
    ok: !!gateSha && shaMatches(gateSha, tip),
    note: !gateSha
      ? `no green gate recorded with a sha (gate line: ${gateLine.trim() || 'missing'})`
      : shaMatches(gateSha, tip)
        ? `green at ${shortSha(gateSha)}, the tip of ${branch}`
        : `green at ${shortSha(gateSha)}, but ${branch} is at ${shortSha(tip)} — the branch moved after the run`,
  });
  return checks;
}

// ---- drill: review --------------------------------------------------------------------

const SEVERITIES = ['Critical', 'Important', 'Minor'];

// tk.mjs writes one log line per reviewed node: "- <iso> review: <node> approve|changes by <who>"
// followed by whatever notes that key carries at the time — the seat it was given under, the sha
// and the diff it is bound to — and then "— <why>". Only the node, the verdict and the reason are
// read here, and everything between them is kept as an opaque tail, so a new note on the key never
// makes a review invisible to the drill.
function reviewLines(logText) {
  const out = [];
  for (const line of (logText || '').split('\n')) {
    const m = /review:\s*(\S+)\s+(approve|changes)\s+by\s+(\S+)(.*)$/.exec(line.trim());
    if (!m) continue;
    const tail = m[4] || '';
    const dash = tail.indexOf(' — ');
    out.push({
      node: m[1],
      verdict: m[2],
      by: m[3],
      notes: (dash === -1 ? tail : tail.slice(0, dash)).trim(),
      why: dash === -1 ? '' : tail.slice(dash + 3).trim(),
    });
  }
  return out;
}

function severitiesIn(text) {
  return SEVERITIES.filter((s) => new RegExp(`\\b${s}\\b`, 'i').test(text));
}

function checkReview(ctx) {
  const { logText } = ctx;
  const reviews = reviewLines(logText);
  const checks = [{
    name: 'reviews recorded',
    ok: reviews.length > 0,
    note: reviews.length ? reviews.map((r) => `${r.node} ${r.verdict} by ${r.by}`).join(' · ') : 'no review recorded on this ticket',
  }];
  if (reviews.length === 0) return checks;

  const changes = reviews.filter((r) => r.verdict === 'changes');
  const unranked = changes.filter((r) => severitiesIn(r.why).length === 0);
  checks.push({
    name: 'findings carry a severity',
    ok: unranked.length === 0,
    note: changes.length === 0
      ? 'no change request to rank'
      : unranked.length === 0
        ? `${changes.length} change request(s), each naming ${SEVERITIES.join('/')}`
        : `${unranked.length} change request(s) name no severity: ${unranked.map((r) => `"${r.why || '(no reason given)'}"`).join(', ')}`,
  });

  const minorOnly = changes.filter((r) => {
    const found = severitiesIn(r.why);
    return found.length > 0 && found.every((s) => s === 'Minor');
  });
  checks.push({
    name: 'Minor did not bounce the ticket',
    ok: minorOnly.length === 0,
    note: minorOnly.length === 0
      ? 'no ticket sent back over Minor findings alone'
      : `${minorOnly.length} change request(s) carry Minor findings only: ${minorOnly.map((r) => `"${r.why}"`).join(', ')} — a Minor finding goes to the ticket log, not back to the worker`,
  });
  return checks;
}

// ---- drill: scope ---------------------------------------------------------------------

const DERIVED_LOCK = /^\.yggdrasil\/yg-lock\.[^/]+\.json$/;

function checkScope(ctx) {
  const {
    root, cfg, branch, parentBranch, issueText,
  } = ctx;
  const tip = git(['rev-parse', '--verify', branch], root);
  if (!tip) return [{ name: 'branch', ok: false, note: `no such branch: ${branch}` }];

  // The same two-step bound the merge checklist uses: the files the ticket declared it would
  // touch, when it declared any, and its named nodes' boundaries otherwise. A drill that judged
  // scope by a different rule than the checklist would pass work the checklist refuses.
  const nodes = ticketNodes(issueText);
  const declared = ticketFiles(issueText);
  const checks = [{
    name: 'scope declared',
    ok: declared.length > 0 || nodes.length > 0,
    note: declared.length
      ? `${declared.length} file(s) declared on the ticket`
      : nodes.length
        ? `no files declared; bounded by the node(s) ${nodes.join(', ')}`
        : 'the ticket declares no file and names no node, so its diff is bounded by nothing',
  }];
  if (declared.length === 0 && nodes.length === 0) return checks;

  const files = (git(['diff', '--name-only', `${parentBranch}...${branch}`], root) || '')
    .split('\n').filter(Boolean).filter((f) => !DERIVED_LOCK.test(f));
  const boundary = declared.length
    ? declared
    : nodes.flatMap((n) => (nodeExists(root, cfg, n) ? [...nodeBoundary(root, cfg, n), nodeGraphPathPrefix(root, cfg, n)] : []));
  const outside = boundary.length ? files.filter((f) => !pathInBoundary(f, boundary)) : files;
  const inside = declared.length ? `the ${declared.length} declared file(s)` : nodes.join(', ');
  checks.push({
    name: 'diff inside the boundary',
    ok: outside.length === 0,
    note: outside.length === 0
      ? `${files.length} file(s), all inside ${inside}`
      : `outside ${inside}: ${outside.join(', ')}`,
  });

  const protectedPaths = cfg.protectedPaths || [];
  const touched = files.filter((f) => protectedPaths.some((p) => f === p || f.startsWith(p)));
  checks.push({
    name: 'no protected path',
    ok: touched.length === 0,
    note: touched.length === 0 ? 'none touched' : `touched: ${touched.join(', ')}`,
  });
  return checks;
}

// ---- running a drill against a repository ----------------------------------------------

function runCheck(drill, { repo, horde: hordeFlag, ticket: ticketFlag }) {
  const cwd = process.cwd();
  process.chdir(resolve(repo || cwd));
  try {
    const horde = resolveHorde({ horde: hordeFlag });
    const ctx = ticketContext(horde, ticketFlag);
    const checks = DRILLS[drill].check(ctx);
    return {
      drill,
      discipline: DRILLS[drill].discipline,
      horde,
      ticket: ctx.ticket.id,
      branch: ctx.branch,
      checks,
      ok: checks.every((c) => c.ok),
    };
  } finally {
    process.chdir(cwd);
  }
}

function renderCheck(result) {
  return [
    `drill ${result.drill} (${DRILLS[result.drill].discipline}) — ticket ${result.ticket} on ${result.branch}`,
    ...result.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.note}`),
    result.ok ? 'HELD' : 'NOT HELD',
  ].join('\n');
}

// ---- the corpus ------------------------------------------------------------------------

function corpusDir(flags) {
  return resolve(flags.corpus || DEFAULT_CORPUS);
}

function corpusCases(corpus, drill) {
  const dir = join(corpus, drill);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name.startsWith('violates-') || d.name.startsWith('satisfies-')))
    .map((d) => ({
      name: d.name,
      dir: join(dir, d.name),
      expect: d.name.startsWith('violates-') ? 'violates' : 'satisfies',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A case is restored, never read in place: `git fetch` from its bundle rebuilds the branches, and
// the snapshot becomes the repository's own `.horde/`. The drill then runs against a real
// repository, exactly as it does on a live mission.
function restoreCase(caseDir, ygCommand) {
  const meta = readJSON(join(caseDir, 'case.json'), null);
  if (!meta) fail(`case has no case.json: ${caseDir}`);
  const tmp = mkdtempSync(join(tmpdir(), 'drill-case-'));
  execFileSync('git', ['init', '-q', tmp], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'drill@horde'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'horde drill'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['fetch', '-q', join(caseDir, 'repo.bundle'), 'refs/heads/*:refs/heads/*'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('git', ['checkout', '-q', meta.parentBranch], { cwd: tmp, stdio: 'pipe' });
  cpSync(join(caseDir, 'horde'), join(tmp, '.horde'), { recursive: true });
  writeFileSync(join(tmp, '.horde', '.gitignore'), '*\n');
  // How a machine invokes the Yggdrasil CLI is a property of the machine, not of the case: a
  // recorded snapshot carries none, and the drill puts this machine's own in before it runs. A
  // case that carried one would only be runnable on the laptop it was recorded on.
  const cfgPath = join(tmp, '.horde', 'config.json');
  const cfg = readJSON(cfgPath, null);
  if (cfg) writeJSON(cfgPath, { ...cfg, ygCommand });
  return { meta, dir: tmp };
}

// The Yggdrasil CLI this run should use: what the caller named, else what the repository the
// drill is invoked from uses, else the bare `yg` an installed Yggdrasil puts on PATH.
function hostYgCommand(flags) {
  if (flags.yg) return String(flags.yg);
  const cfg = readConfig();
  return (cfg && cfg.ygCommand) || 'yg';
}

function cmdRun(drill, flags) {
  const corpus = corpusDir(flags);
  const cases = corpusCases(corpus, drill);
  if (cases.length === 0) fail(`no case recorded for drill "${drill}" under ${corpus}`);
  const results = [];
  const ygCommand = hostYgCommand(flags);
  for (const c of cases) {
    const restored = restoreCase(c.dir, ygCommand);
    try {
      const outcome = runCheck(drill, {
        repo: restored.dir, horde: restored.meta.horde, ticket: restored.meta.ticket,
      });
      const actual = outcome.ok ? 'satisfies' : 'violates';
      const failed = outcome.checks.filter((x) => !x.ok);
      results.push({
        case: c.name,
        expect: c.expect,
        actual,
        asExpected: actual === c.expect,
        why: failed.map((x) => `${x.name} — ${x.note}`).join(' · ') || 'every assertion held',
      });
    } finally {
      rmSync(restored.dir, { recursive: true, force: true });
    }
  }
  const ok = results.every((r) => r.asExpected);
  const result = {
    drill, discipline: DRILLS[drill].discipline, corpus, cases: results, ok,
  };
  emit(result, flags, () => [
    `drill ${drill} (${DRILLS[drill].discipline}) — ${results.length} case(s)`,
    `asks: ${DRILLS[drill].asks}`,
    ...results.map((r) => `${r.asExpected ? '✓' : '✗'} ${r.case} — ${r.actual === 'violates' ? 'red' : 'green'}, expected ${r.expect === 'violates' ? 'red' : 'green'}: ${r.why}`),
    `${results.filter((r) => r.asExpected).length}/${results.length} as expected`,
  ].join('\n'));
  if (!ok) process.exit(1);
}

// ---- list --------------------------------------------------------------------------------

function cmdList(flags) {
  const corpus = corpusDir(flags);
  const rows = DISCIPLINES.map((d) => {
    const drill = Object.keys(DRILLS).find((k) => DRILLS[k].discipline === d) || null;
    return {
      discipline: d,
      text: `reference/discipline/${d}.md`,
      present: existsSync(join(DISCIPLINE_DIR, `${d}.md`)),
      drill,
      cases: drill ? corpusCases(corpus, drill).map((c) => c.name) : [],
    };
  });
  emit({ corpus, disciplines: rows }, flags, () => [
    `corpus: ${corpus}`,
    '',
    ...rows.flatMap((r) => {
      const head = `${r.discipline.padEnd(13)} ${r.drill ? `drill ${r.drill}` : 'no drill — held by the process'}${r.present ? '' : '   (text missing!)'}`;
      if (!r.drill) return [head];
      return [
        head,
        `              asks: ${DRILLS[r.drill].asks}`,
        `              cases: ${r.cases.length ? r.cases.join(', ') : '(none recorded)'}`,
      ];
    }),
  ].join('\n'));
}

// ---- record -------------------------------------------------------------------------------

// Left out of a snapshot: the worktrees (checked-out trees full of absolute paths), the gate-run
// cache (derived), and `.horde/`'s own `.gitignore` — that file holds `*`, so carried into the
// corpus it would make git ignore every file of the case beside it. `restoreCase` writes it back
// exactly as `horde.mjs init` does, so the restored state is the recorded state.
const SNAPSHOT_SKIP = new Set(['worktrees', 'cache', '.gitignore']);

function snapshotHorde(root, dest) {
  const src = join(root, '.horde');
  if (!existsSync(src)) fail('no .horde/ in this repository — there is no state to record');
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const rel = from.slice(src.length + 1);
      if (!rel) return true;
      return !SNAPSHOT_SKIP.has(rel.split('/')[0]);
    },
  });
  // A case is state, not a machine. `ygCommand` on the recording machine is very often an
  // absolute path to a local build, and a case carrying that would run nowhere else, so it is
  // dropped here and supplied again by whoever runs the drill.
  const cfgPath = join(dest, 'config.json');
  const cfg = readJSON(cfgPath, null);
  if (cfg) writeJSON(cfgPath, { ...cfg, ygCommand: null });
}

function cmdRecord(name, flags) {
  if (!name) fail('record requires <name>');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`case name must be lower-case letters, digits and hyphens: ${name}`);
  const expect = flags.expect;
  if (expect !== 'violates' && expect !== 'satisfies') fail('--expect must be "violates" or "satisfies"');
  const drill = resolveDrill(flags.discipline);

  const horde = resolveHorde(flags);
  const root = repoRoot();
  const ctx = ticketContext(horde, flags.ticket);
  const checks = DRILLS[drill].check(ctx);
  const ok = checks.every((c) => c.ok);
  const actual = ok ? 'satisfies' : 'violates';
  if (actual !== expect) {
    fail(`this state ${actual} the ${drill} drill, but --expect says ${expect} — a case is recorded as what it is:\n${checks.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.name} — ${c.note}`).join('\n')}`);
  }

  const dir = join(corpusDir(flags), drill, `${expect}-${name}`);
  if (existsSync(dir)) fail(`case already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });

  snapshotHorde(root, join(dir, 'horde'));

  const base = ctx.cfg.base || null;
  const refs = [...new Set([ctx.branch, ctx.parentBranch, base].filter(Boolean))]
    .filter((r) => git(['rev-parse', '--verify', r], root));
  if (refs.length === 0) fail(`none of the ticket's branches exist: ${ctx.branch}, ${ctx.parentBranch}`);
  execFileSync('git', ['bundle', 'create', join(dir, 'repo.bundle'), ...refs], { cwd: root, stdio: 'pipe' });

  const meta = {
    schema: 'horde-drill-case/1',
    drill,
    discipline: DRILLS[drill].discipline,
    expect,
    horde,
    ticket: ctx.ticket.id,
    branch: ctx.branch,
    parentBranch: ctx.parentBranch,
    tip: git(['rev-parse', ctx.branch], root),
    refs,
    recordedAt: nowIso(),
    note: flags.note || null,
    saw: checks.map((c) => ({ name: c.name, ok: c.ok, note: c.note })),
  };
  writeJSON(join(dir, 'case.json'), meta);

  emit({ case: `${expect}-${name}`, dir, drill, ticket: ctx.ticket.id }, flags,
    () => `recorded ${drill}/${expect}-${name} from ticket ${ctx.ticket.id} — ${refs.length} ref(s) bundled\n${dir}`);
}

// ---- main -----------------------------------------------------------------------------------

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  switch (cmd) {
    case 'list': return cmdList(flags);
    case 'check': {
      const drill = resolveDrill(rest[0]);
      const result = runCheck(drill, { repo: flags.repo, horde: flags.horde, ticket: flags.ticket });
      emit(result, flags, () => renderCheck(result));
      if (!result.ok) process.exit(1);
      return undefined;
    }
    case 'run': return cmdRun(resolveDrill(rest[0]), flags);
    case 'record': return cmdRecord(rest[0], flags);
    default: return fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
