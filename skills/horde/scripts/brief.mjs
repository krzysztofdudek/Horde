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
import {
  nodeExists, readNodePortsText, ticketNodes, ygCheckJson, ygAspectsJson,
} from './node.mjs';
import { collectRetroInput, classesPath } from './retro.mjs';

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
const ROLES = ['worker', 'architect', 'legislate', 'retro'];

// role → the disciplines its brief carries, in order. The texts live once, under
// reference/discipline/; a role file names its disciplines and never repeats them. An entry may
// narrow a discipline to one of its own sections, where the role is held to that part alone (the
// architect gets framing's checklist, not the whole of framing).
const ROLE_LAW = {
  worker: ['tdd', 'debugging'],
  architect: [{ discipline: 'framing', section: 'Checklist' }],
  // A rule is a claim about this repository, and the one discipline that decides whether a claim
  // is worth writing down is framing's own checklist — the same part the architect is held to.
  legislate: [{ discipline: 'framing', section: 'Checklist' }],
  // Sorting a mission's findings into rule, taste and inexpressible is the review discipline's own
  // weighing done one level up, so it gets the whole of that text rather than a section of it; and
  // the second half of the run is a measurement, which is verification's subject.
  retro: ['review', 'verification'],
};

const USAGE = `usage: brief.mjs <role> [args] --name <n> [--horde h] [--json]

roles:
  architect --name <n>
  worker <ticket> --name <n> [--takeover]
      --takeover renders a takeover section — a prior worker attempted this ticket N times; the
      ticket is yours; here is its log — for the fresh, one-class-up worker tk.mjs status <ticket>
      changes hands a ticket to once its resume rounds are spent.
  legislate <territory> --name <n>
      one pass over one territory's law: what its gate refused this wave, what its own tickets
      recorded, and which rules reach nothing any more. Writes rules in its own branch and raises
      them on evidence; it never lowers one.
  retro --name <n>
      one pass over the WHOLE mission, at its end: every gate refusal and every remark in a
      ticket's log, sorted into the rules the law could have said, the taste that goes to a
      component's own log, and what the law will not express at all. Writes one classification
      file; retro.mjs turns it into the document.

Prints the rendered brief for the Agent tool's prompt, verbatim. Refuses — listing every unfilled
placeholder — rather than print one with "{{…}}" left in it. A role held to a discipline gets it
inline, under "## Law": worker (tdd, debugging), architect and legislate (framing's checklist), retro
(review, verification).

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

// A ticket reads as `t-004` and is the same ticket as `004` or `4` — the number is the identity,
// the prefix only says what kind of thing it is, and the folder on disk is still named NNN.
function normalizeTicketId(id) {
  const m = /(\d+)\s*$/.exec(String(id));
  return m ? m[1].padStart(3, '0') : id;
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


// ---- legislate: one territory's own law -------------------------------------------------------
//
// Everything this brief carries is scoped to the territory named, and to nothing else. A pass that
// saw another area's refusals would propose that area's rules, which is exactly the "law written by
// somebody who does not work here" this role replaces.

function loadTerritories(horde) {
  const doc = readJSON(hordePath(horde, 'territories.json'), null);
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}

// The tickets this territory owns, anywhere in the horde: a ticket belongs to a territory when a
// component it names is one of the territory's own.
function ticketsOfTerritory(horde, nodes) {
  const owned = new Set(nodes);
  const out = [];
  walkTeams(horde, (teamName, teamDir) => {
    const issuesDir = join(teamDir, 'issues');
    if (!existsSync(issuesDir)) return;
    for (const e of readdirSync(issuesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const issueText = readText(join(issuesDir, e.name, 'issue.md')) || '';
      if (!ticketNodes(issueText).some((n) => owned.has(n))) continue;
      out.push({
        id: e.name.split('-')[0],
        team: teamName,
        title: ticketTitle(issueText) || '(untitled)',
        log: readText(join(issuesDir, e.name, 'log.md')) || '',
      });
    }
  });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// What the landing gate refused, from the result files `land --result` leaves behind — one per
// ticket, each carrying the checks that ran and the note each wrote. Only this territory's tickets,
// and only the checks that said no.
function gateRefusalsFor(horde, tickets) {
  const lines = [];
  for (const t of tickets) {
    const doc = readJSON(hordePath(horde, 'land', `${t.id}.json`), null);
    for (const c of asArray(doc && doc.checks)) {
      if (!c || c.ok) continue;
      lines.push(`- ticket ${t.id} · ${c.name} — ${c.note}`);
    }
  }
  return lines.length ? lines.join('\n') : '(nothing this wave — the gate refused none of this territory\'s landings)';
}

// Rules that judge nothing here. Read from the gate's own per-pair report, which is the graph's
// answer to "what does this rule reach" and costs one keyless call.
function deadRulesFor(root, cfg) {
  const doc = ygCheckJson(root, cfg);
  if (!doc) return '(not measured — the Yggdrasil CLI could not be read from here)';
  const reached = new Set(asArray(doc.pairs).map((p) => p && p.aspect).filter(Boolean));
  const aspects = ygAspectsJson(root, cfg);
  if (!aspects) return '(not measured — the Yggdrasil CLI could not be read from here)';
  const dead = asArray(aspects.aspects).filter((a) => a && a.id && !reached.has(a.id));
  if (dead.length === 0) return '(none — every rule the graph declares reaches something here)';
  return dead.map((a) => `- **${a.id}** [${a.status}] — ${a.description || 'no description'}`).join('\n');
}

function ticketLogFor(tickets) {
  if (tickets.length === 0) return '(this territory has no tickets yet)';
  return tickets.map((t) => {
    const body = t.log.trim() || '(no log)';
    return [`- **${t.id} · ${t.title}**`, '', '  ```', ...body.split('\n').map((l) => `  ${l}`), '  ```'].join('\n');
  }).join('\n\n');
}

function cmdLegislate(horde, cfg, positional, flags) {
  const territory = positional[0];
  if (!territory) fail('legislate requires <territory> — a pass over "the whole repository" is exactly the law nobody who works here wrote');
  const name = requireName(flags);
  const territories = loadTerritories(horde);
  const known = Object.keys(territories).sort();
  const entry = territories[territory];
  if (!entry) {
    fail(`no such territory: ${territory} (this mission's cut names: ${known.join(', ') || '(none — refine.mjs --step cut writes territories.json)'})`);
  }
  const nodes = asArray(entry.nodes).filter(Boolean);
  if (nodes.length === 0) fail(`territory "${territory}" names no component, so there is no area to write law for`);

  const info = resolveTree({ tree: flags.tree, horde });
  const tickets = ticketsOfTerritory(horde, nodes);
  const law = (cfg && cfg.law) || {};
  const vars = {
    repoRoot: info.path,
    name,
    horde,
    territory,
    nodes: nodes.join(', '),
    branch: `${horde}/legislate-${territory}`,
    charterPath: charterPath(info.path, horde),
    reportsTo: reportsToFor('legislate', horde, { name }),
    gateRefusals: gateRefusalsFor(horde, tickets),
    ticketLog: ticketLogFor(tickets),
    deadRules: deadRulesFor(info.path, cfg),
    retireAfterWaves: law.retireAfterWaves === undefined ? 2 : law.retireAfterWaves,
  };
  const brief = renderRole('legislate', vars);
  emit({
    role: 'legislate',
    territory,
    nodes,
    name,
    tickets: tickets.map((t) => t.id),
    brief,
    tree: info.path,
    branch: info.branch,
    sha: info.sha,
  }, flags, () => brief);
}

// The retrospective one-shot's brief carries the mission's whole input inline — every gate refusal
// and every remark, with the key each is answered against. Measured on a fixture at real-mission
// scale (40 tickets over four waves) that input is around 70KB, well inside the size a single
// territory is held to, which is why this is one pass over the mission rather than one per area:
// the cross-area repetitions are the whole point, and nobody who sees one area can see them.
function cmdRetro(horde, cfg, flags) {
  const name = requireName(flags);
  const info = resolveTree({ tree: flags.tree, horde });
  const input = collectRetroInput(horde);
  const listing = (items, empty) => (items.length
    ? items.map((it) => `- \`${it.key}\` · ticket ${it.ticket} — ${it.text}`).join('\n')
    : empty);

  const vars = {
    repoRoot: info.path,
    name,
    horde,
    charterPath: charterPath(info.path, horde),
    classesPath: classesPath(horde),
    reportsTo: reportsToFor('retro', horde, { name }),
    gateRefusals: listing(
      input.items.filter((it) => it.source === 'gate'),
      '(none — the gate refused nothing on this mission)',
    ),
    remarks: listing(
      input.items.filter((it) => it.source === 'log'),
      '(none — no ticket log carries a line that is not a state entry)',
    ),
  };
  const brief = renderRole('retro', vars);
  emit({
    role: 'retro',
    horde,
    name,
    items: input.items.length,
    notes: input.notes,
    brief,
    tree: info.path,
    branch: info.branch,
    sha: info.sha,
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
    case 'legislate': return cmdLegislate(horde, cfg, positional, flags);
    case 'retro': return cmdRetro(horde, cfg, flags);
    default: fail(`unknown role: ${role}`);
  }
}

if (isMain(import.meta.url)) main();
