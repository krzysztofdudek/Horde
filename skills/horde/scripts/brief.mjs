#!/usr/bin/env node
// horde skill — brief.mjs
//
// Renders reference/roles/<role>.md, filled from the charter, config, the gate-run cache, the
// node (via node.mjs's own read helpers — imported, not shelled out, since both live in this
// tool set) and the ticket (found by walking every team's issues/ and queue.json, since a ticket
// number is unique per horde but its team is not known up front). A brief is never printed with an
// unfilled `{{…}}` — the same collect-every-miss approach _lib's renderTemplate uses, reimplemented
// here because the role files live under reference/roles/, not templates/, which renderTemplate is
// hard-coded to.
//
// Renders and prints only: no ticket log, no state write of any kind.
//
// After the role's own text, the brief carries a `## Law` section: the disciplines that role is
// held to, inlined from reference/discipline/ (see ROLE_LAW below). The texts live once, there;
// a role file names its disciplines and never repeats them, so an edit to a discipline reaches
// every brief that carries it without a second copy going stale.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hordePath, teamPath, readJSON, readText, readConfig, fail, parseArgs, asArray, emit,
  isMain, resolveHorde, parentBranchOf, resolveTree,
} from './_lib.mjs';
import { nodeExists, readNodePortsText, ticketNodes } from './node.mjs';

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'roles');
const DISCIPLINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'discipline');

// The role and discipline files address the skill's own scripts as
// `${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/…`, so a person reading the raw file sees a path
// that still works for the manual drop-in. A brief handed to a spawned agent carries the absolute
// directory this script runs from instead: a subagent is not guaranteed to inherit
// CLAUDE_PLUGIN_ROOT, and in a repository that installed the plugin the drop-in fallback does not
// exist — a real mission had the director export the variable by hand into every brief.
const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT_TOKEN = /\$\{CLAUDE_PLUGIN_ROOT(?::-[^}]*)?\}/g;
export function absolutizePluginRoot(text, root = SKILL_ROOT) {
  return text.replace(PLUGIN_ROOT_TOKEN, root);
}
const ROLES = ['worker', 'architect'];

// role → the disciplines its brief carries, in order. The texts live once, under
// reference/discipline/; a role file names its disciplines and never repeats them. An entry may
// narrow a discipline to one of its own sections, where the role is held to that part alone (the
// architect gets framing's checklist, not the whole of framing).
const ROLE_LAW = {
  worker: ['tdd', 'debugging'],
  architect: [{ discipline: 'framing', section: 'Checklist' }],
};

const USAGE = `usage: brief.mjs <role> [args] --name <n> [--horde h] [--json]

roles:
  architect --name <n>
  worker <ticket> --name <n> [--takeover]
      --takeover renders a takeover section — a prior worker attempted this ticket N times; the
      ticket is yours; here is its log — for the fresh, one-class-up worker tk.mjs status <ticket>
      changes hands a ticket to once its resume rounds are spent.

Prints the rendered brief for the Agent tool's prompt, verbatim. Refuses — listing every unfilled
placeholder — rather than print one with "{{…}}" left in it. A role held to a discipline gets it
inline, under "## Law": worker (tdd, debugging), architect (framing's checklist).

options: --json  --help`;

// ---- role template loading + rendering (reference/roles/, not templates/) --

function loadRoleTemplate(role) {
  const file = join(ROLES_DIR, `${role}.md`);
  if (!existsSync(file)) fail(`unknown role: ${role} (roles: ${ROLES.join(', ')})`);
  return readFileSync(file, 'utf8');
}

// ---- the Law section (reference/discipline/, appended after the role's own text) ------------
//
// Headings inside a discipline file are demoted by two levels so the file's own "# Title" becomes
// an "### Title" under the brief's "## Law" — the texts are written to stand alone as files and
// to read as sections here, without a second copy of either.

function demoteHeadings(text) {
  return text.replace(/^(#{1,4}) /gm, (whole, hashes) => `${hashes}## `);
}

function disciplineTitle(text, file) {
  const m = /^#\s+(.+)$/m.exec(text);
  if (!m) fail(`discipline file has no title: ${file}`);
  return m[1].trim();
}

// One "## <name>" section of a discipline file, without its own heading line.
function disciplineSection(text, section, file) {
  const idx = text.indexOf(`## ${section}\n`);
  if (idx === -1) fail(`discipline ${file} has no section "${section}"`);
  const rest = text.slice(idx + `## ${section}\n`.length);
  const next = rest.indexOf('\n## ');
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function disciplineText(entry) {
  const name = typeof entry === 'string' ? entry : entry.discipline;
  const file = join(DISCIPLINE_DIR, `${name}.md`);
  if (!existsSync(file)) fail(`unknown discipline: ${name}`);
  const text = readFileSync(file, 'utf8');
  const title = disciplineTitle(text, `${name}.md`);
  if (typeof entry === 'string') return demoteHeadings(text.trim());
  return `### ${title} — ${entry.section}\n\n${demoteHeadings(disciplineSection(text, entry.section, `${name}.md`))}`;
}

function lawSection(role) {
  const entries = ROLE_LAW[role];
  if (!entries || entries.length === 0) return '';
  const body = entries.map(disciplineText).join('\n\n---\n\n');
  return [
    '',
    '## Law',
    '',
    'These hold for every ticket, whatever the ticket says. They are the same texts every agent in',
    'this role is given, and the merge checklist enforces what can be enforced mechanically.',
    '',
    body,
    '',
  ].join('\n');
}

function renderRole(role, vars) {
  const text = loadRoleTemplate(role);
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
    fail(`brief for "${role}" has unfilled placeholder(s): ${[...new Set(unfilled)].join(', ')}`);
  }
  return absolutizePluginRoot(rendered.replace(/\s*$/, '\n') + lawSection(role));
}

// ---- charter / config / cache -----------------------------------------------

function charterPath(root, horde) {
  return relative(root, hordePath(horde, 'charter.md'));
}

function gateFastCheckCount() {
  return 'unknown — report the count you get';
}

function fastCheckCount(horde) {
  const cache = readJSON(hordePath(horde, 'cache', 'last-gate.json'), null);
  const n = cache && cache.commit && cache.commit.count;
  return n !== undefined && n !== null ? String(n) : gateFastCheckCount();
}

// ---- roster -------------------------------------------------------------------

function loadRoster(horde) {
  const doc = readJSON(hordePath(horde, 'roster.json'), { entries: [] });
  return asArray(doc.entries);
}

function findRosterEntry(horde, name) {
  return loadRoster(horde).find((e) => e.name === name) || null;
}

// Most recent live (not dead/retired) steward for a team; null when none exists yet.
function stewardFor(horde, team) {
  const live = loadRoster(horde).filter((e) => e.role === 'steward' && e.team === team && e.state !== 'dead' && e.state !== 'retired');
  return live.length ? live[live.length - 1].name : null;
}

// Agents are addressable by name only from the session that spawned them, but by their raw
// Agent-tool id from anywhere — so a brief that names who to report to also carries that id, for a
// report sent from a different session's context than the one that did the spawning. Nothing in
// this tool set writes roster.json any more; this reads it only for backward compatibility with a
// mission still carrying one from before this migration.
function withAgentId(horde, name) {
  if (name === 'main') return name;
  const entry = findRosterEntry(horde, name);
  return entry && entry.agentId ? `${name} (agent id ${entry.agentId})` : name;
}

// reportsTo — always the agent's own parent, never anyone else: an agent is addressable by the one
// that spawned it, and a brief that named anybody else would be telling it to reach a session it
// has no way to reach. The architect is always a direct report of the director, whose session name
// is always the literal "main" — the name this harness gives the top-level session. `spawnedBy` and
// a live steward for the worker's team are only ever found in a roster.json a pre-migration mission
// left on disk; a fresh mission never writes one, so a worker's fallback is "main" too.
function reportsToFor(role, horde, { team, name } = {}) {
  const entry = name ? findRosterEntry(horde, name) : null;
  if (entry && entry.spawnedBy) return withAgentId(horde, entry.spawnedBy);
  const fallback = role === 'worker' ? (stewardFor(horde, team) || stewardFor(horde, 'trunk') || 'main') : 'main';
  return withAgentId(horde, fallback);
}

// ---- tickets (found by walking every team, since a ticket's team isn't known up front) --------

function normalizeTicketId(id) {
  return /^\d+$/.test(id) && id.length < 3 ? id.padStart(3, '0') : id;
}

function walkTeams(horde, visit, teamDir = hordePath(horde, 'teams'), teamName = null) {
  if (!existsSync(teamDir)) return;
  for (const d of readdirSync(teamDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const full = join(teamDir, d.name);
    visit(d.name, full);
    walkTeams(horde, visit, join(full, 'teams'), d.name);
  }
}

// findTicket(horde, id) — {team, issueDirName, issueText, queueItem} or null. Tries the id as
// given, then zero-padded to 3 digits (tk.mjs's counter renders NNN that way).
function findTicket(horde, rawId) {
  for (const id of [rawId, normalizeTicketId(rawId)]) {
    let found = null;
    walkTeams(horde, (teamName, teamDir) => {
      if (found) return;
      const issuesDir = join(teamDir, 'issues');
      if (!existsSync(issuesDir)) return;
      const match = readdirSync(issuesDir, { withFileTypes: true })
        .find((e) => e.isDirectory() && e.name.startsWith(`${id}-`));
      if (!match) return;
      const issueText = readText(join(issuesDir, match.name, 'issue.md'));
      const logText = readText(join(issuesDir, match.name, 'log.md'));
      const queue = readJSON(join(teamDir, 'queue.json'), { items: [] });
      const canonicalId = match.name.split('-')[0];
      const queueItem = asArray(queue.items).find((it) => String(it.ticket) === canonicalId) || null;
      found = {
        team: teamName, id: canonicalId, issueDirName: match.name, issueText, logText, queueItem,
      };
    });
    if (found) return found;
  }
  return null;
}

function ticketTitle(issueText) {
  const m = /^#\s*\S+\s*·\s*(.+)$/m.exec(issueText || '');
  return m ? m[1].trim() : null;
}

function ticketBody(issueText) {
  if (!issueText) return null;
  const lines = issueText.split('\n');
  if (lines[0] && lines[0].startsWith('#')) lines.shift();
  while (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\n').trim();
}

// ---- node text, joined across every node a ticket names -----------------------------

function nodesText(root, cfg, nodes, reader, fallback) {
  const parts = nodes
    .filter((n) => nodeExists(root, cfg, n))
    .map((n) => reader(root, cfg, n) || fallback);
  return parts.length ? parts.join('\n\n---\n\n') : fallback;
}

// ---- role command builders -----------------------------------------------------------

function requireName(flags) {
  if (!flags.name) fail('--name <n> is required');
  return flags.name;
}

// tk.mjs's own "changes" log line carries "(round N/cap — <label>)" — read back the same way
// tk.mjs's own priorChangesRounds does, so the takeover block can say how many times a prior
// worker actually attempted this ticket before the fresh, one-class-up one takes it over.
const CHANGES_ROUND_RE = /\(round (\d+)\/\d+ — /;

function latestChangesRound(logText) {
  let max = 0;
  for (const line of (logText || '').split('\n')) {
    const m = CHANGES_ROUND_RE.exec(line);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// "a prior worker attempted this ticket N times; the ticket is yours; here is its log" — rendered
// only with --takeover, for the fresh worker a ticket's fix-loop hands off to once the resume
// rounds are spent. The round just logged (the one that triggered this takeover) is not itself a
// prior attempt, hence the -1.
function takeoverBlockFor(horde, t) {
  const logPath = join(teamPath(horde, t.team, 'issues', t.issueDirName), 'log.md');
  const logText = readText(logPath) || '(no log yet)';
  const attempts = Math.max(latestChangesRound(logText) - 1, 0);
  return [
    '## Takeover',
    '',
    `A prior worker attempted this ticket ${attempts} time${attempts === 1 ? '' : 's'}; the ticket is yours now. Its log so far:`,
    '',
    '```',
    logText.trim() || '(empty)',
    '```',
  ].join('\n');
}

function cmdArchitect(horde, cfg, flags) {
  const name = requireName(flags);
  const info = resolveTree({ tree: flags.tree, horde });
  const vars = {
    repoRoot: info.path,
    name, horde,
    charterPath: charterPath(info.path, horde),
    reportsTo: reportsToFor('architect', horde, { name }),
  };
  const brief = renderRole('architect', vars);
  emit({
    role: 'architect', name, brief, tree: info.path, branch: info.branch, sha: info.sha,
  }, flags, () => brief);
}

// The branch this ticket is cut from, and the paragraph that says so when it is not the one
// anybody would assume. A ticket started from a dependency that has not merged yet is rooted on
// that ticket's branch; merging the team branch into it instead would pull in what the parent has
// not landed and change the ticket's own diff — which is what its keys are bound to. So the first
// action names the parent the tools measure against, and the note says which ticket it belongs to.
function stackNoteFor(parent) {
  if (!parent.stacked) return '';
  return [
    `**This ticket is stacked.** Ticket ${parent.stackedOn} has not merged yet and your work sits on top of it: your`,
    `base is its branch \`${parent.branch}\`, which is what the merge above names — not the team branch`,
    `\`${parent.teamBranch}\`. What ${parent.stackedOn} changed is under you already: build on it, never redo it, and`,
    `never merge the team branch yourself. When ${parent.stackedOn} lands, the steward tells you; the team branch`,
    'is your base from then on, like any other ticket\'s.',
    '',
  ].join('\n');
}

function cmdWorker(horde, cfg, positional, flags) {
  const rawId = positional[0];
  if (!rawId) fail('worker requires <ticket>');
  const name = requireName(flags);
  const t = findTicket(horde, rawId);
  if (!t) fail(`no such ticket: ${rawId}`);
  if (!t.queueItem) fail(`ticket ${rawId} has no queue item yet (queue.mjs set <id> running creates it)`);
  // The worker's own worktree, already an absolute path from cmdSet's provisionTree — resolveTree
  // is not asked to re-verify it here: it would insist the tree actually exist as a registered
  // worktree of this repository, which a queue item seeded by hand (a fixture, a pre-migration
  // mission read as history) never was and never needs to be just to render a brief. Reading the
  // node's own ports, though, is a graph read like any other command's — `--tree`/`--horde` if
  // given, cwd otherwise, never assumed to be the ticket's own tree (nothing has run there yet).
  const worktree = t.queueItem.worktree;
  const root = resolveTree({ tree: flags.tree, horde: flags.horde }).path;
  const nodes = ticketNodes(t.issueText);
  const title = ticketTitle(t.issueText);
  const parent = parentBranchOf(horde, t.team, t.queueItem, { cwd: root });
  const vars = {
    repoRoot: worktree,
    name, horde, team: t.team,
    ticketId: t.id, ticketTitle: title,
    node: nodes.join(', ') || null,
    parentBranch: parent.branch,
    stackNote: stackNoteFor(parent),
    worktree,
    branch: t.queueItem.branch,
    fastCheck: cfg.gates && cfg.gates.commit,
    fastCheckCount: fastCheckCount(horde),
    ticketBody: ticketBody(t.issueText),
    nodePorts: nodesText(root, cfg, nodes, readNodePortsText, '(this ticket names no component the graph knows)'),
    protectedPaths: (cfg.protectedPaths || []).join(', ') || '(none)',
    issueDir: `teams/${t.team}/issues/${t.issueDirName}`,
    reportsTo: reportsToFor('worker', horde, { team: t.team, name }),
    takeoverBlock: flags.takeover ? takeoverBlockFor(horde, t) : '',
  };
  const brief = renderRole('worker', vars);
  emit({
    role: 'worker', ticket: rawId, name, takeover: !!flags.takeover, brief, tree: worktree, branch: t.queueItem.branch,
  }, flags, () => brief);
}


// ---- main -----------------------------------------------------------------------

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2), { flags: ['takeover'] });
  const [role, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!role) fail('missing role (see --help)');
  if (!ROLES.includes(role)) fail(`unknown role: ${role} (roles: ${ROLES.join(', ')})`);

  const horde = resolveHorde(flags);
  const cfg = readConfig() || {};

  switch (role) {
    case 'architect': return cmdArchitect(horde, cfg, flags);
    case 'worker': return cmdWorker(horde, cfg, positional, flags);
    default: fail(`unknown role: ${role}`);
  }
}

if (isMain(import.meta.url)) main();
