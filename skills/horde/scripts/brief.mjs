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
const ROLES = ['steward', 'owner', 'architect', 'worker', 'verifier', 'auditor', 'counsel'];

const USAGE = `usage: brief.mjs <role> [args] --name <n> [--horde h] [--json]

roles:
  steward <team> --name <n>
  owner <node> --name <n>
  architect --name <n>
  worker <ticket> --name <n> [--takeover]
      --takeover renders a takeover section — a prior worker attempted this ticket N times; the
      ticket is yours; here is its log — for the fresh, one-class-up worker tk.mjs status <ticket>
      changes hands a ticket to once its resume rounds are spent.
  verifier <ticket> --name <n> [--delta <path>]
  auditor <ticket> --wave <n> --name <n>
  counsel --question "<q>" [--attach <file>]… --name <n>

Prints the rendered brief for the Agent tool's prompt, verbatim. Refuses — listing every unfilled
placeholder — rather than print one with "{{…}}" left in it.

--delta <path> renders the verifier's brief for a scoped re-review: the subject is the difference
between what was already approved and what is on the branch now (the file the merge checklist
writes when a ticket's diff moved), together with every finding the last review left open. Without
it the brief is the full verification, as before.

options: --json  --help`;

// ---- role template loading + rendering (reference/roles/, not templates/) --

function loadRoleTemplate(role) {
  const file = join(ROLES_DIR, `${role}.md`);
  if (!existsSync(file)) fail(`unknown role: ${role} (roles: ${ROLES.join(', ')})`);
  return readFileSync(file, 'utf8');
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
  return rendered;
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

// ---- previous findings, for a scoped re-review ---------------------------------------
//
// What the last look at this ticket left open, read from the ticket's own log: the "What failed"
// prose of the most recent verdict, and every changes-request an owner recorded. Nothing else is
// carried over — an approval or a reproduction needs no answer, only a finding does. Read from the
// files rather than passed in, so a scoped brief cannot be rendered with a friendlier list of
// findings than the record actually holds.
function previousFindings(logText) {
  const out = [];
  if (!logText) return out;
  const verdicts = logText.split(/\n(?=## Verdict)/).filter((b) => b.trim().startsWith('## Verdict'));
  const last = verdicts.length ? verdicts[verdicts.length - 1] : null;
  if (last) {
    const idx = last.indexOf('**What failed, if anything**');
    if (idx !== -1) {
      const after = last.slice(idx).split('\n').slice(1);
      for (const line of after) {
        const t = line.replace(/^[-*]\s*/, '').trim();
        if (t && !t.startsWith('<!--')) out.push(t);
      }
    }
  }
  for (const m of logText.matchAll(/^- \S+ review: (\S+) changes by (\S+)[^—\n]*— (.+)$/gm)) {
    out.push(`${m[3]} (${m[1]}, asked by ${m[2]})`);
  }
  return out;
}

// The one paragraph that says what this verdict is about: the whole change, or — when the steward
// passes the delta file the merge checklist wrote — only what moved since the last review, with
// the open findings to answer one by one. Everything about HOW a scoped re-review is judged lives
// in the role brief itself; this fills in which one it is and what it is about.
function verdictScope(root, t, delta) {
  if (delta === true) fail('--delta requires the path of the file to re-review (the merge checklist prints it)');
  const deltaPath = typeof delta === 'string' ? delta : null;
  if (!deltaPath) {
    return `Full verification: every acceptance line above, over the whole of \`${t.queueItem.branch}\` `
      + 'against the team branch.';
  }
  if (readText(join(root, deltaPath)) === null && readText(deltaPath) === null) {
    fail(`--delta names no readable file: ${deltaPath} — run the merge checklist on the branch again to have it written, or drop --delta for a full re-review`);
  }
  const findings = previousFindings(t.logText);
  const lines = [
    `**Scoped re-review.** This ticket was reviewed once already. Since then its branch caught up with`,
    `the team and its own diff moved, so what you judge is the difference — recorded in \`${deltaPath}\`.`,
    'Read that file first: it is the subject of this verdict. Everything the earlier review already',
    'reproduced stands; you do not prove it a second time, and for an acceptance line the delta does',
    'not touch, the record is that line, reproduced earlier and unchanged by the delta (the tool still',
    'takes one item per acceptance line).',
    '',
    'Findings left open by the last review, each needing its own verdict — addressed, or not addressed:',
    '',
  ];
  lines.push(...(findings.length
    ? findings.map((f) => `- ${f}`)
    : ['- (none recorded — the last review left nothing open; then judge the delta alone)']));
  return lines.join('\n');
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

function cmdSteward(horde, root, cfg, positional, flags) {
  const team = positional[0];
  if (!team) fail('steward requires <team>');
  const name = requireName(flags);
  const entry = findRosterEntry(horde, name);
  const fixRounds = cfg.fixRounds || { resume: 3, fresh: 2 };
  const vars = {
    repoRoot: root,
    name, horde, team,
    branch: `${horde}/${team}`,
    charterPath: charterPath(root, horde),
    parallelism: cfg.parallelism,
    parentTeam: (entry && entry.parent) || 'trunk',
    reportsTo: reportsToFor('steward', horde),
    fixRoundsResume: fixRounds.resume,
    fixRoundsFresh: fixRounds.fresh,
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
    takeoverBlock: flags.takeover ? takeoverBlockFor(horde, t) : '',
  };
  const brief = renderRole('worker', vars);
  emit({
    role: 'worker', ticket: rawId, name, takeover: !!flags.takeover, brief,
  }, flags, () => brief);
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
    scope: verdictScope(root, t, flags.delta),
  };
  const brief = renderRole('verifier', vars);
  emit({
    role: 'verifier', ticket: rawId, name, delta: typeof flags.delta === 'string' ? flags.delta : null, brief,
  }, flags, () => brief);
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
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2), { flags: ['takeover'] });
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
