#!/usr/bin/env node
// horde skill — brief.mjs
//
// Renders reference/roles/<role>.md, filled from the charter, config, the gate-run cache, the
// node (via node.mjs's own read helpers — imported, not shelled out, since both live in this
// tool set), the ticket (found by walking every team's issues/ and queue.json, since a ticket
// number is unique per horde but its team is not known up front) and the roster. A brief is never
// printed with an unfilled `{{…}}` — the same collect-every-miss approach _lib's renderTemplate
// uses, reimplemented here because the role files live under reference/roles/, not templates/,
// which renderTemplate is hard-coded to.
//
// Renders and prints only: no ticket log, no roster write. Cost is booked once, at spawn, by
// roster.mjs; a second write here would double it for nothing.
//
// After the role's own text, the brief carries a `## Law` section: the disciplines that role is
// held to, inlined from reference/discipline/ (see ROLE_LAW below). The texts live once, there;
// a role file names its disciplines and never repeats them, so an edit to a discipline reaches
// every brief that carries it without a second copy going stale.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  repoRoot, hordePath, teamPath, readJSON, readText, readConfig, fail, parseArgs, asArray, emit,
  isMain, resolveHorde,
} from './_lib.mjs';
import {
  nodeExists, readNodeCharterText, readNodeContractsText, ticketNodes,
} from './node.mjs';

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'roles');
const DISCIPLINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'discipline');
const ROLES = ['steward', 'owner', 'architect', 'worker', 'verifier', 'auditor', 'counsel'];

// role → the disciplines its brief carries, in order. The texts live once, under
// reference/discipline/; a role file names its disciplines and never repeats them. An entry may
// narrow a discipline to one of its own sections, where the role is held to that part alone (the
// architect gets framing's checklist, not the whole of framing). A role absent from this table
// gets no Law section at all — the steward, the auditor and counsel are held to the charter and
// their own briefs, not to a discipline of their own.
const ROLE_LAW = {
  worker: ['tdd', 'debugging'],
  verifier: ['verification', 'review'],
  owner: ['review'],
  architect: [{ discipline: 'framing', section: 'Checklist' }],
};

const USAGE = `usage: brief.mjs <role> [args] --name <n> [--horde h] [--json]

roles:
  steward <team> --name <n>
  owner <node> --name <n>
  architect --name <n>
  worker <ticket> --name <n>
  verifier <ticket> --name <n>
  auditor <ticket> --wave <n> --name <n>
  counsel --question "<q>" [--attach <file>]… --name <n>

Prints the rendered brief for the Agent tool's prompt, verbatim. Refuses — listing every unfilled
placeholder — rather than print one with "{{…}}" left in it. A role held to a discipline gets it
inline, under "## Law": worker (tdd, debugging), verifier (verification, review), owner (review),
architect (framing's checklist).

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
  return rendered.replace(/\s*$/, '\n') + lawSection(role);
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
// Agent-tool id from anywhere — so a brief that names who to report to also carries that id,
// once roster.mjs (via spawn --agent-id or trace --agent-id) has recorded one, for a report sent
// from a different session's context than the one that did the spawning.
function withAgentId(horde, name) {
  if (name === 'main') return name;
  const entry = findRosterEntry(horde, name);
  return entry && entry.agentId ? `${name} (agent id ${entry.agentId})` : name;
}

// reportsTo — a worker/verifier reports to its own team's steward; an owner (node-scoped, not
// team-scoped) reports to the trunk steward regardless of which team's ticket touches its node;
// a steward/architect/auditor/counsel reports to the director, whose session name is always the
// literal "main" — the name this harness gives the spawning session.
function reportsToFor(role, horde, { team } = {}) {
  let name = 'main';
  if (role === 'worker' || role === 'verifier') {
    name = stewardFor(horde, team) || stewardFor(horde, 'trunk') || 'main';
  } else if (role === 'owner') {
    name = stewardFor(horde, 'trunk') || 'main';
  }
  return withAgentId(horde, name);
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
      const queue = readJSON(join(teamDir, 'queue.json'), { items: [] });
      const canonicalId = match.name.split('-')[0];
      const queueItem = asArray(queue.items).find((it) => String(it.ticket) === canonicalId) || null;
      found = {
        team: teamName, id: canonicalId, issueDirName: match.name, issueText, queueItem,
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

function ticketSection(issueText, heading) {
  if (!issueText) return null;
  const idx = issueText.indexOf(`## ${heading}`);
  if (idx === -1) return null;
  const rest = issueText.slice(idx + `## ${heading}`.length);
  const next = rest.indexOf('\n## ');
  const section = next === -1 ? rest : rest.slice(0, next);
  return section.trim();
}

// sha for a merged ticket — the queue item's own `sha`, else the "merged: NNN <sha>" bullet in
// the team's wave journal (whichever named this ticket last).
function ticketSha(horde, team, ticket, queueItem) {
  if (queueItem && queueItem.sha) return queueItem.sha;
  const isTrunk = !team || team === 'trunk';
  const journal = readText(isTrunk ? hordePath(horde, 'plan.md') : teamPath(horde, team, 'plan.md')) || '';
  const re = new RegExp(`^- \\S+ merged: ${ticket} (\\S+)`, 'm');
  const m = re.exec(journal);
  return m ? m[1] : null;
}

// ---- node text, joined across every node a ticket names -----------------------------

function nodesText(root, cfg, nodes, reader, fallback) {
  const parts = nodes
    .filter((n) => nodeExists(root, cfg, n))
    .map((n) => reader(root, cfg, n) || fallback);
  return parts.length ? parts.join('\n\n---\n\n') : fallback;
}

// ---- charter's "## Nodes" section — the lease line naming a given node, or the template's own
// default rule when nobody has written one yet.
const DEFAULT_LEASE_RULE = 'mission when the node has three or more tickets, wave otherwise (no line '
  + 'found for this node in the charter\'s Nodes section)';

function leaseScopeFor(horde, node) {
  const charter = readText(hordePath(horde, 'charter.md')) || '';
  const idx = charter.indexOf('## Nodes');
  if (idx === -1) return DEFAULT_LEASE_RULE;
  const rest = charter.slice(idx);
  const next = rest.indexOf('\n## ', 1);
  const section = next === -1 ? rest : rest.slice(0, next);
  const line = section.split('\n').find((l) => l.includes(node));
  return line ? line.trim() : DEFAULT_LEASE_RULE;
}

// ---- role command builders -----------------------------------------------------------

function requireName(flags) {
  if (!flags.name) fail('--name <n> is required');
  return flags.name;
}

function cmdSteward(horde, root, cfg, positional, flags) {
  const team = positional[0];
  if (!team) fail('steward requires <team>');
  const name = requireName(flags);
  const entry = findRosterEntry(horde, name);
  const vars = {
    repoRoot: root,
    name, horde, team,
    branch: `${horde}/${team}`,
    charterPath: charterPath(root, horde),
    parallelism: cfg.parallelism,
    parentTeam: (entry && entry.parent) || 'trunk',
    reportsTo: reportsToFor('steward', horde),
  };
  const brief = renderRole('steward', vars);
  emit({ role: 'steward', team, name, brief }, flags, () => brief);
}

function cmdOwner(horde, root, cfg, positional, flags) {
  const node = positional[0];
  if (!node) fail('owner requires <node>');
  const name = requireName(flags);
  const vars = {
    repoRoot: root,
    name, horde, node,
    charterPath: charterPath(root, horde),
    leaseScope: leaseScopeFor(horde, node),
    reportsTo: reportsToFor('owner', horde),
  };
  const brief = renderRole('owner', vars);
  emit({ role: 'owner', node, name, brief }, flags, () => brief);
}

function cmdArchitect(horde, root, cfg, flags) {
  const name = requireName(flags);
  const vars = {
    repoRoot: root,
    name, horde,
    charterPath: charterPath(root, horde),
    graphDir: String(cfg.graphDir || 'architecture/').replace(/\/+$/, '') || 'architecture/',
    reportsTo: reportsToFor('architect', horde),
  };
  const brief = renderRole('architect', vars);
  emit({ role: 'architect', name, brief }, flags, () => brief);
}

function cmdWorker(horde, root, cfg, positional, flags) {
  const rawId = positional[0];
  if (!rawId) fail('worker requires <ticket>');
  const name = requireName(flags);
  const t = findTicket(horde, rawId);
  if (!t) fail(`no such ticket: ${rawId}`);
  if (!t.queueItem) fail(`ticket ${rawId} has no queue item yet (queue.mjs set <id> running creates it)`);
  const nodes = ticketNodes(t.issueText);
  const title = ticketTitle(t.issueText);
  const vars = {
    repoRoot: root,
    name, horde, team: t.team,
    ticketId: t.id, ticketTitle: title,
    node: nodes.join(', ') || null,
    teamBranch: `${horde}/${t.team}`,
    worktree: t.queueItem.worktree,
    branch: t.queueItem.branch,
    fastCheck: cfg.gates && cfg.gates.commit,
    fastCheckCount: fastCheckCount(horde),
    ticketBody: ticketBody(t.issueText),
    nodeCharter: nodesText(root, cfg, nodes, readNodeCharterText, '(no charter yet)'),
    nodeContracts: nodesText(root, cfg, nodes, readNodeContractsText, '(no contracts yet)'),
    protectedPaths: (cfg.protectedPaths || []).join(', ') || '(none)',
    issueDir: `teams/${t.team}/issues/${t.issueDirName}`,
    reportsTo: reportsToFor('worker', horde, { team: t.team }),
  };
  const brief = renderRole('worker', vars);
  emit({ role: 'worker', ticket: rawId, name, brief }, flags, () => brief);
}

function cmdVerifier(horde, root, cfg, positional, flags) {
  const rawId = positional[0];
  if (!rawId) fail('verifier requires <ticket>');
  const name = requireName(flags);
  const t = findTicket(horde, rawId);
  if (!t) fail(`no such ticket: ${rawId}`);
  if (!t.queueItem) fail(`ticket ${rawId} has no queue item yet`);
  const nodes = ticketNodes(t.issueText);
  const title = ticketTitle(t.issueText);
  const vars = {
    repoRoot: root,
    name, horde,
    ticketId: t.id, ticketTitle: title,
    ticketAcceptance: ticketSection(t.issueText, 'Acceptance — evidence'),
    branch: t.queueItem.branch,
    worktree: t.queueItem.worktree,
    teamBranch: `${horde}/${t.team}`,
    gateCommand: cfg.gates && cfg.gates.team,
    nodeContracts: nodesText(root, cfg, nodes, readNodeContractsText, '(no contracts yet)'),
    reportsTo: reportsToFor('verifier', horde, { team: t.team }),
  };
  const brief = renderRole('verifier', vars);
  emit({ role: 'verifier', ticket: rawId, name, brief }, flags, () => brief);
}

function cmdAuditor(horde, root, cfg, positional, flags) {
  const rawId = positional[0];
  if (!rawId) fail('auditor requires <ticket>');
  if (!flags.wave) fail('auditor requires --wave <n>');
  const name = requireName(flags);
  const t = findTicket(horde, rawId);
  if (!t) fail(`no such ticket: ${rawId}`);
  const title = ticketTitle(t.issueText);
  const sha = ticketSha(horde, t.team, t.id, t.queueItem);
  const vars = {
    repoRoot: root,
    name, horde,
    wave: flags.wave,
    ticketId: t.id, ticketTitle: title,
    sha,
    reportsTo: reportsToFor('auditor', horde),
  };
  const brief = renderRole('auditor', vars);
  emit({ role: 'auditor', ticket: rawId, wave: flags.wave, name, brief }, flags, () => brief);
}

function cmdCounsel(horde, root, cfg, flags) {
  if (!flags.question) fail('counsel requires --question "<q>"');
  const name = requireName(flags);
  const files = asArray(flags.attach);
  const attachments = files.length
    ? files.map((f) => `### ${f}\n\n${readText(join(root, f)) ?? readText(f) ?? '(could not read this file)'}`).join('\n\n')
    : '(none attached)';
  const vars = {
    repoRoot: root,
    name, horde,
    question: flags.question,
    charterPath: charterPath(root, horde),
    attachments,
    reportsTo: reportsToFor('counsel', horde),
  };
  const brief = renderRole('counsel', vars);
  emit({ role: 'counsel', name, brief }, flags, () => brief);
}

// ---- main -----------------------------------------------------------------------

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2), { flags: [] });
  const [role, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!role) fail('missing role (see --help)');
  if (!ROLES.includes(role)) fail(`unknown role: ${role} (roles: ${ROLES.join(', ')})`);

  const horde = resolveHorde(flags);
  const root = repoRoot();
  const cfg = readConfig() || {};

  switch (role) {
    case 'steward': return cmdSteward(horde, root, cfg, positional, flags);
    case 'owner': return cmdOwner(horde, root, cfg, positional, flags);
    case 'architect': return cmdArchitect(horde, root, cfg, flags);
    case 'worker': return cmdWorker(horde, root, cfg, positional, flags);
    case 'verifier': return cmdVerifier(horde, root, cfg, positional, flags);
    case 'auditor': return cmdAuditor(horde, root, cfg, positional, flags);
    case 'counsel': return cmdCounsel(horde, root, cfg, flags);
    default: fail(`unknown role: ${role}`);
  }
}

if (isMain(import.meta.url)) main();
