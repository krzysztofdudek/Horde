#!/usr/bin/env node
// horde skill — tk.mjs
//
// Tickets, over teams/<team>/issues/NNN-slug/{issue.md,log.md}. NNN is unique across the whole
// horde (hordes/<horde>/counter.json), not per team, so a ticket keeps one identity across a
// `move`. The **Keys:** line on issue.md is the single place the two-signature rule (an author,
// a verifier) and per-node review approvals live, because that is what queue.mjs's merge refusal
// and premerge.mjs's mechanical checklist both need to read without talking to anyone.
//
// The combined "**Node:** … · **Class:** … · **Severity:** … · **Team:** …" line and the
// "**Depends on:** … · **Branch:** …" line are parsed positionally by label, stopping at the
// next `**Label:**` or end of line — none of those values contain a literal "·". The **Keys:**
// line is different: its own segments are separated by "·", so it gets its own whole-line
// regex and is split on "·" directly. Every node the ticket names gets one Keys segment, in the
// order the **Node:** field lists them, so approvals can be tracked per node even though the
// field itself has no per-node structure otherwise.
//
// Exports findTicket, the field/keys helpers and padId so queue.mjs and verify.mjs — which also
// need to read and update a ticket's Keys line and status — don't reimplement the parsing.

import {
  existsSync, mkdirSync, readdirSync, renameSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  hordePath, teamPath, readJSON, writeJSON, readText, writeText, appendText, nowIso, fail,
  parseArgs, asArray, emit, isMain, resolveHorde, renderTemplate, readConfig, git, patchIdOf,
} from './_lib.mjs';
import { trace as traceRoster, ownerNameForNode, architectIsLive } from './roster.mjs';

const STATUSES = ['proposed', 'queued', 'running', 'landed', 'changes', 'verified', 'merged', 'escalated', 'dropped'];
const SEVERITIES = ['high', 'medium', 'low'];
const REVIEW_PENDING_STATUSES = new Set(['landed', 'changes']);
const OPEN_EXCLUDE = new Set(['merged', 'dropped']);

const USAGE = `usage: tk.mjs <command> [options]

commands:
  new <slug> --title "<t>" --node <n> [--node <n2> …] --class <c> [--severity high|medium|low]
      [--depends NNN,…] [--evidence "<…>"]… [--revert-base <ref>] [--team t] [--horde h]
      renders templates/ticket.md; status starts "proposed". --node is repeatable, up to two —
      two nodes mark a contract ticket, and both get their own approval slot in the Keys line;
      three or more is refused, since no owner holds the whole of such a diff.
      --revert-base names the ref premerge.mjs's revert test should use instead of the parent
      branch's tip (for a test meant to already be green there, e.g. a contract test). Each
      --evidence value becomes its own "- [ ] …" line in the ticket's Acceptance — evidence
      checklist. A catalogue id (E1, E2, …) cited in an --evidence value must already be a row
      in the horde's charter.md evidence table — refuses otherwise, listing the unknown ids.
  list [--state s] [--node n] [--review-pending] [--open] [--team t] [--horde h]
  show <ticket> [--log] [--horde h]
  status <ticket> <${STATUSES.join('|')}> ["note"] [--horde h]
      "changes" counts the round and prints it: rounds 1..config.fixRounds.resume (default 3) —
      resume the same worker; the next config.fixRounds.fresh (default 2) rounds — "fresh worker,
      class up", one class heavier, briefed with "brief.mjs worker NNN --takeover"; beyond that it
      refuses and prints the next step (escalate.mjs add … --kind adjudicate --ticket NNN, then
      queue.mjs set NNN escalated).
  log <ticket> "<text>" [--horde h]
  grep <regex> [--horde h]
  key <ticket> author --by <name> | --from-queue [--horde h]
      sets the author key. --from-queue reads it from the ticket's own queue item's recorded
      "agent" instead — for a successor steward recovering a ticket that "queue.mjs reconcile"
      marked landed after the original steward died before it could set the key by hand. The
      verifier key is set only by verify.mjs.
  review-request <ticket> [--delta <path>] [--horde h]
      appends a timestamped log entry; starts the owner's liveness window. --delta names the
      file holding the difference between what was approved before and what is on the branch
      now (the merge checklist writes it and prints its path), so the owner reads that instead
      of the whole change again.
  review <ticket> approve|changes ["why"] --by <name> [--node n] [--horde h]
      records an approval or a changes-request for one node in the Keys line. Pass --node when
      the ticket names more than one; --by architect with no --node approves every node the
      ticket names at once (the case where a node's own owner is the ticket's author and so
      cannot review it). Refuses --by equal to the ticket's author. An "approve" also binds to
      what was read: the ticket's branch's current tip sha and the identity of its diff against
      the team branch (both from its queue item). The branch catching up with the team keeps the
      approval; a change to the ticket's own diff voids it and premerge.mjs's item 2 (keys) asks
      for the review again. The ticket's own verifier may approve in an owner's place (marked
      "<name>(verifier-seat)" in the Keys line) only when the ticket's author is that node's own
      owner and the roster has no live architect — refused otherwise.
  move <ticket> --team t [--horde h]
      relocates the issue folder to team t's issues/.
  edit <ticket> --by <name> [--horde h]
      rewrites the body (everything from "## What" on) from stdin, leaving the header block —
      the id/title heading, Status, Node/Class/Severity/Team, Depends on/Branch, Keys — untouched.
      Appends "body edited by <name>" to the log. What owners use to write ticket bodies.

options: --json  --help`;

// --- field parsing -----------------------------------------------------

export function parseField(text, label) {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n·]*?)\\s*(?:·|$)`, 'm');
  const m = re.exec(text);
  return m ? m[1].trim() : '';
}

function setField(text, label, value) {
  const re = new RegExp(`(\\*\\*${label}:\\*\\*\\s*)[^\\n·]*`, 'm');
  return text.replace(re, `$1${value}`);
}

export function nodesOf(text) {
  const raw = parseField(text, 'Node');
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const KEYS_LINE_RE = /^\*\*Keys:\*\*\s*(.*)$/m;

export function parseKeys(text) {
  const nodes = nodesOf(text);
  const m = KEYS_LINE_RE.exec(text);
  const parts = (m ? m[1] : '').split('·').map((s) => s.trim()).filter(Boolean);
  const takeVal = (seg) => {
    const sp = seg.indexOf(' ');
    const v = sp === -1 ? '' : seg.slice(sp + 1).trim();
    return v || '—';
  };
  const nodeApprovals = {};
  nodes.forEach((n, i) => { nodeApprovals[n] = parts[2 + i] ? takeVal(parts[2 + i]) : '—'; });
  return {
    author: parts[0] ? takeVal(parts[0]) : '—',
    verifier: parts[1] ? takeVal(parts[1]) : '—',
    nodeApprovals,
  };
}

function writeKeys(text, keys) {
  const nodes = nodesOf(text);
  const segs = [`author ${keys.author || '—'}`, `verifier ${keys.verifier || '—'}`];
  for (const n of nodes) segs.push(`${n} ${keys.nodeApprovals[n] || '—'}`);
  return text.replace(KEYS_LINE_RE, `**Keys:** ${segs.join(' · ')}`);
}

export function setAuthorKey(text, name) {
  const keys = parseKeys(text);
  keys.author = name;
  return writeKeys(text, keys);
}

export function setVerifierKey(text, name) {
  const keys = parseKeys(text);
  keys.verifier = name;
  return writeKeys(text, keys);
}

export function setNodeApproval(text, node, value) {
  const keys = parseKeys(text);
  if (!Object.prototype.hasOwnProperty.call(keys.nodeApprovals, node)) {
    throw new Error(`ticket does not name node: ${node}`);
  }
  keys.nodeApprovals[node] = value;
  return writeKeys(text, keys);
}

export function hasAuthor(text) { return parseKeys(text).author !== '—'; }
export function hasVerifier(text) { return parseKeys(text).verifier !== '—'; }

export function allNodesApproved(text) {
  const keys = parseKeys(text);
  return nodesOf(text).every((n) => {
    const v = keys.nodeApprovals[n];
    return v && v !== '—' && !v.startsWith('changes:');
  });
}

export function setStatus(text, status) {
  return text.replace(/^\*\*Status:\*\*.*$/m, `**Status:** ${status}`);
}

// --- the fix-loop breaker (config.fixRounds) ------------------------------

// tk.mjs's own log line for a "changes" transition carries "(round N/cap — <label>)" — read back
// to work out how many rounds this ticket has already been through, without a second, separate
// counter file to keep in sync with the log.
const ROUND_LOG_RE = /\(round (\d+)\/\d+ — /;

function priorChangesRounds(ticket) {
  const log = readText(ticket.logPath) || '';
  let max = 0;
  for (const line of log.split('\n')) {
    const m = ROUND_LOG_RE.exec(line);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// What this round of "changes" means: rounds 1..resume ask the steward to resume the same
// worker with the findings; the next "fresh" rounds ask for a new one, one class heavier, briefed
// with "brief.mjs worker NNN --takeover"; beyond resume+fresh this refuses outright — another
// round would be a stall dressed up as progress, not a fix, so the caller is told to rule on it
// instead (escalate.mjs add … --kind adjudicate, then queue.mjs set … escalated).
export function changesRoundInfo(horde, ticket) {
  const cfg = readConfig();
  const fixRounds = (cfg && cfg.fixRounds) || {};
  const resume = Number(fixRounds.resume ?? 3);
  const fresh = Number(fixRounds.fresh ?? 2);
  const cap = resume + fresh;
  const round = priorChangesRounds(ticket) + 1;
  if (round > cap) {
    return {
      refused: true,
      round,
      resume,
      fresh,
      message: `ticket ${ticket.id} has already gone through ${cap} round(s) of changes (config.fixRounds: `
        + `resume ${resume} + fresh ${fresh}) — another round is a stall, not a fix. Rule on it: `
        + `escalate.mjs add "<why>" --kind adjudicate --ticket ${ticket.id}, then queue.mjs set ${ticket.id} escalated`,
    };
  }
  const label = round <= resume ? 'resume same worker' : 'fresh worker, class up';
  return {
    refused: false, round, resume, fresh, cap, label,
  };
}

// Writes the status and its log line for one transition, embedding the round suffix
// changesRoundInfo computed (when given) so priorChangesRounds can read it back later. Shared by
// cmdStatus and verify.mjs's own "flaky" transition, so both count against the one cap.
export function transitionStatus(ticket, status, note, roundInfo) {
  const roundSuffix = roundInfo ? ` (round ${roundInfo.round}/${roundInfo.cap ?? roundInfo.resume + roundInfo.fresh} — ${roundInfo.label})` : '';
  writeText(ticket.issuePath, setStatus(ticket.text, status));
  appendText(ticket.logPath, `- ${nowIso()} status: ${status}${note ? ` — ${note}` : ''}${roundSuffix}\n`);
  return roundSuffix;
}

// --- id / lookup ---------------------------------------------------------

export function padId(idInput) {
  const n = parseInt(String(idInput).replace(/\D/g, ''), 10);
  if (Number.isNaN(n)) throw new Error(`invalid ticket id: ${idInput}`);
  return String(n).padStart(3, '0');
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket';
}

// Every team directory the horde has, as the short "parent/child" path strings teamPath()
// expects — mirrors status.mjs's own recursive walk of teams/<team>/teams/… so a ticket can be
// found by id alone, without the caller having to know which (sub-)team it lives under.
function allTeamPaths(horde) {
  const root = hordePath(horde, 'teams');
  const out = [];
  const walk = (rel) => {
    out.push(rel);
    const subDir = teamPath(horde, rel, 'teams');
    if (existsSync(subDir)) {
      for (const d of readdirSync(subDir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(`${rel}/${d.name}`);
      }
    }
  };
  if (existsSync(root)) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory()) walk(d.name);
    }
  }
  return out;
}

export function findTicket(horde, idInput) {
  const id = padId(idInput);
  for (const team of allTeamPaths(horde)) {
    const issuesDir = teamPath(horde, team, 'issues');
    if (!existsSync(issuesDir)) continue;
    const match = readdirSync(issuesDir, { withFileTypes: true })
      .find((d) => d.isDirectory() && d.name.startsWith(`${id}-`));
    if (match) {
      const dir = join(issuesDir, match.name);
      const issuePath = join(dir, 'issue.md');
      const logPath = join(dir, 'log.md');
      return {
        id, team, dir, issuePath, logPath, dirName: match.name, text: readText(issuePath) || '',
      };
    }
  }
  return null;
}

function requireTicket(horde, idInput) {
  let id;
  try { id = padId(idInput); } catch (e) { fail(e.message); }
  const ticket = findTicket(horde, id);
  if (!ticket) fail(`no such ticket: ${id}`);
  return ticket;
}

function appendLog(ticket, text) {
  appendText(ticket.logPath, `- ${nowIso()} ${text}\n`);
}

// The evidence catalogue table in the horde's charter.md: | id | evidence | node | reproduced by |.
// Read the same way wave.mjs reads it (header row, separator row, then data), but kept as its own
// copy here rather than imported — this tool only needs the id column, and staying self-contained
// avoids coupling two tools that are refused for merge independently of one another.
function charterEvidenceIds(horde) {
  const text = readText(hordePath(horde, 'charter.md')) || '';
  const idx = text.indexOf('## Acceptance');
  if (idx === -1) return new Set();
  const rest = text.slice(idx);
  const nextHeading = rest.indexOf('\n## ', 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const lines = section.split('\n').filter((l) => l.trim().startsWith('|'));
  const ids = lines.slice(2)
    .map((l) => (l.split('|')[1] || '').trim())
    .filter(Boolean);
  return new Set(ids);
}

// Every catalogue id (E1, E2, …) a ticket's --evidence values cite must already be a row in the
// charter — a ticket claiming evidence the charter never promised would let it count toward a
// wave's "green" total (wave.mjs's own reading of the acceptance section) without the chairman
// ever having agreed that id belonged to the mission.
function checkEvidenceIds(horde, evidence) {
  const cited = new Set();
  for (const e of evidence) {
    for (const m of String(e).match(/\bE\d+\b/g) || []) cited.add(m);
  }
  if (cited.size === 0) return;
  const known = charterEvidenceIds(horde);
  const unknown = [...cited].filter((id) => !known.has(id));
  if (unknown.length) {
    fail(`unknown evidence id(s), not in the charter's evidence catalogue: ${unknown.join(', ')}`);
  }
}

// --- commands --------------------------------------------------------------

// --revert-base <ref> on `new` — the ref premerge.mjs's revert test should extract a ticket's new
// tests onto instead of the parent branch's tip, for a test that is meant to already be green
// there (a contract test pinning a surface that already holds) and is red somewhere else named
// on the ticket's own acceptance line instead (e.g. "red on develop"). Empty by default: the
// template's own "**Revert base:**" line then renders with nothing after it, which premerge.mjs
// reads as "use the parent tip".
function revertBaseVar(flags) {
  return flags['revert-base'] ? { revertBase: flags['revert-base'] } : {};
}

function cmdNew(horde, positional, flags) {
  const slug = positional[0];
  if (!slug) fail('new requires <slug>');
  if (!flags.title) fail('new requires --title "<t>"');
  const nodes = asArray(flags.node);
  if (nodes.length === 0) fail('new requires --node <n> (repeatable)');
  // The model allows a ticket one node, or two when the ticket carries a contract between them —
  // and no more, because a ticket spanning three nodes needs three owners' approval for one diff
  // and no owner holds the whole of it. Three were being accepted in silence.
  if (nodes.length > 2) {
    fail(`a ticket names one node, or two when it carries a contract between them — this one names ${nodes.length} (${nodes.join(', ')}). Split it into one ticket per node, with the contract between them on its own ticket if they need one`);
  }
  const cfg = readConfig();
  const classes = (cfg && cfg.classes) || {};
  if (Object.keys(classes).length && !Object.prototype.hasOwnProperty.call(classes, flags.class)) {
    fail(`unknown class: ${flags.class} (config classes: ${Object.keys(classes).join(', ')})`);
  }
  if (!flags.class) fail('new requires --class <c>');
  const severity = flags.severity || 'medium';
  if (!SEVERITIES.includes(severity)) fail(`--severity must be one of: ${SEVERITIES.join(', ')}`);
  const team = flags.team || 'trunk';
  const evidence = asArray(flags.evidence);
  checkEvidenceIds(horde, evidence);

  const counterPath = hordePath(horde, 'counter.json');
  const counter = readJSON(counterPath, { next: 1 });
  const id = padId(counter.next);
  const dirName = `${id}-${slugify(slug)}`;
  const dir = teamPath(horde, team, 'issues', dirName);
  if (existsSync(dir)) fail(`issue folder already exists: ${dirName}`);

  const depends = flags.depends ? String(flags.depends).split(',').map((s) => s.trim()).filter(Boolean) : [];
  let text = renderTemplate('ticket', {
    id,
    title: flags.title,
    status: 'proposed',
    node: nodes.join(', '),
    class: flags.class,
    severity,
    team,
    branch: '—',
    ...(depends.length ? { dependsOn: depends.join(', ') } : {}),
    ...revertBaseVar(flags),
  });
  // The Keys line only names author/verifier by default; extend it with one slot per node now
  // that the Node field (which the parser reads to know the node list) is actually rendered.
  text = writeKeys(text, parseKeys(text));
  if (evidence.length) {
    text = text.replace('- [ ] …', evidence.map((e) => `- [ ] ${e}`).join('\n'));
  }

  mkdirSync(dir, { recursive: true });
  writeText(join(dir, 'issue.md'), text);
  writeText(join(dir, 'log.md'), '');
  writeJSON(counterPath, { next: counter.next + 1 });

  emit({ id, dirName, team }, flags, () => `${id} created — ${dirName} (team ${team})`);
}

function cmdList(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const issuesDir = teamPath(horde, team, 'issues');
  let rows = [];
  if (existsSync(issuesDir)) {
    rows = readdirSync(issuesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const text = readText(join(issuesDir, d.name, 'issue.md')) || '';
        return {
          id: parseField(text, 'id') || d.name.slice(0, 3),
          title: (/^#\s*\S+\s*·\s*(.*)$/.exec((text.split('\n')[0] || '').trim()) || [])[1] || '',
          status: parseField(text, 'Status'),
          node: nodesOf(text),
          severity: parseField(text, 'Severity'),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  if (flags.state) rows = rows.filter((r) => r.status === flags.state);
  if (flags.node) rows = rows.filter((r) => r.node.includes(flags.node));
  if (flags['review-pending']) rows = rows.filter((r) => REVIEW_PENDING_STATUSES.has(r.status));
  if (flags.open) rows = rows.filter((r) => !OPEN_EXCLUDE.has(r.status));
  emit(rows, flags, () => (rows.length ? rows.map((r) => `${r.id} ${r.status} ${r.severity} ${r.title}`).join('\n') : '(no tickets)'));
}

function cmdShow(horde, positional, flags) {
  const ticket = requireTicket(horde, positional[0]);
  if (flags.log) {
    const logText = readText(ticket.logPath) || '';
    emit({ id: ticket.id, log: logText }, flags, () => logText || '(empty log)');
    return;
  }
  emit({ id: ticket.id, team: ticket.team, text: ticket.text }, flags, () => ticket.text);
}

function cmdStatus(horde, positional, flags) {
  const [idRaw, status, note] = positional;
  if (!idRaw || !status) fail('status requires <ticket> <state>');
  if (!STATUSES.includes(status)) fail(`unknown state: ${status} (allowed: ${STATUSES.join(', ')})`);
  const ticket = requireTicket(horde, idRaw);

  let roundInfo = null;
  if (status === 'changes') {
    roundInfo = changesRoundInfo(horde, ticket);
    if (roundInfo.refused) fail(roundInfo.message);
  }

  const roundSuffix = transitionStatus(ticket, status, note, roundInfo);
  emit(
    { id: ticket.id, status, ...(roundInfo ? { round: roundInfo.round, phase: roundInfo.label } : {}) },
    flags,
    () => `${ticket.id}: ${status}${roundSuffix}`,
  );
}

function cmdLog(horde, positional, flags) {
  const [idRaw, text] = positional;
  if (!idRaw || !text) fail('log requires <ticket> "<text>"');
  const ticket = requireTicket(horde, idRaw);
  appendLog(ticket, text);
  emit({ id: ticket.id }, flags, () => `logged on ${ticket.id}`);
}

function cmdGrep(horde, positional, flags) {
  const pattern = positional[0];
  if (!pattern) fail('grep requires <regex>');
  let re;
  try { re = new RegExp(pattern); } catch (e) { fail(`bad regex: ${e.message}`); }
  const results = [];
  for (const team of allTeamPaths(horde)) {
    const issuesDir = teamPath(horde, team, 'issues');
    if (!existsSync(issuesDir)) continue;
    for (const d of readdirSync(issuesDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const id = d.name.slice(0, 3);
      for (const file of ['issue.md', 'log.md']) {
        const text = readText(join(issuesDir, d.name, file)) || '';
        for (const line of text.split('\n')) {
          if (re.test(line)) results.push({ id, file, line });
        }
      }
    }
  }
  emit(results, flags, () => (results.length ? results.map((r) => `${r.id} ${r.file}: ${r.line}`).join('\n') : '(no matches)'));
}

// The ticket's own queue item's recorded "agent" — read directly off queue.json rather than
// through queue.mjs, since queue.mjs already imports from this file and a two-way import between
// them would be a cycle. Used by cmdKey's --from-queue: after "queue.mjs reconcile" marks a
// ticket landed following a steward's death, the successor recovers who actually did the work
// from the same record reconcile itself trusts, instead of guessing or leaving the key unset.
function authorFromQueue(horde, ticket) {
  const queue = readJSON(teamPath(horde, ticket.team, 'queue.json'), { items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];
  const item = items.find((i) => i.ticket === ticket.id);
  if (!item || !item.agent) fail(`no queue item with a recorded agent for ticket ${ticket.id}`);
  return item.agent;
}

// What an approval is bound to: the ticket's own branch, from its queue item's recorded "branch"
// — read directly off queue.json the same way authorFromQueue does, for the same reason (queue.mjs
// already imports this module; importing back would be a cycle) — as both the tip sha the review
// was given at (provenance) and the identity of the diff that was read (the binding). A branch
// that only catches up with its team keeps the same diff, so the approval stands; a change to what
// the ticket actually does gives a different one, and premerge.mjs asks for the review again.
// Both null when there's no queue item or branch to read yet (a ticket approved before ever being
// queued) — the approval is then recorded as the bare name, exactly as it always was.
function ticketBranchKey(horde, ticket) {
  const queue = readJSON(teamPath(horde, ticket.team, 'queue.json'), { items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];
  const item = items.find((i) => i.ticket === ticket.id);
  if (!item || !item.branch) return { sha: null, patchId: null };
  const cfg = readConfig();
  const teamLeaf = String(ticket.team).split('/').pop();
  const parentBranch = `${horde}/${teamLeaf}`;
  return {
    sha: git(['rev-parse', '--short', item.branch]),
    patchId: patchIdOf(item.branch, parentBranch, { context: cfg && cfg.keyContext }),
  };
}

// The recorded form of an approval: "<name>" alone, "<name>@<sha>" when only the branch tip is
// known (and the approval is then good for that one commit only, as it always was), or
// "<name>@<sha>+<patch-id>" when the diff's identity is known too — the sha stays readable and
// stays the provenance; the patch-id after the "+" is what the approval is actually held to.
function approvalValue(name, { sha, patchId }) {
  if (!sha) return name;
  return patchId ? `${name}@${sha}+${patchId}` : `${name}@${sha}`;
}

function cmdKey(horde, positional, flags) {
  const [idRaw, field] = positional;
  if (!idRaw || !field) fail('key requires <ticket> author');
  if (field !== 'author') fail('key only sets "author" here — the verifier key is set by verify.mjs');
  if (!flags.by && !flags['from-queue']) fail('key requires --by <name> or --from-queue');
  const ticket = requireTicket(horde, idRaw);
  const author = flags['from-queue'] ? authorFromQueue(horde, ticket) : flags.by;
  writeText(ticket.issuePath, setAuthorKey(ticket.text, author));
  appendLog(ticket, `key: author set to ${author}`);
  emit({ id: ticket.id, author }, flags, () => `${ticket.id}: author = ${author}`);
}

// --delta <path> — the file holding the difference between what the owner already approved and
// what is on the branch now, written by premerge.mjs when a ticket's diff moved after the review.
// Logged by path rather than by content: the owner reads the file, and the log keeps the record of
// which re-review this request was, so a later reader can tell a scoped one from a full one.
function cmdReviewRequest(horde, positional, flags) {
  const ticket = requireTicket(horde, positional[0]);
  if (flags.delta === true) fail('--delta requires the path of the file to re-review (the merge checklist prints it)');
  const delta = typeof flags.delta === 'string' ? flags.delta : null;
  appendLog(ticket, delta ? `review requested — scoped re-review: ${delta}` : 'review requested');
  emit(
    { id: ticket.id, delta },
    flags,
    () => `review requested: ${ticket.id}${delta ? ` — scoped re-review: ${delta}` : ''}`,
  );
}

function cmdReview(horde, positional, flags) {
  const [idRaw, verdict, why] = positional;
  if (!idRaw || !verdict) fail('review requires <ticket> approve|changes');
  if (verdict !== 'approve' && verdict !== 'changes') fail('review verdict must be "approve" or "changes"');
  if (!flags.by) fail('review requires --by <name>');
  const ticket = requireTicket(horde, idRaw);
  const keys = parseKeys(ticket.text);
  if (flags.by === keys.author) fail("the reviewer cannot be the ticket's author");
  const nodes = nodesOf(ticket.text);

  let targets;
  if (flags.node) {
    if (!nodes.includes(flags.node)) fail(`ticket does not name node: ${flags.node}`);
    targets = [flags.node];
  } else if (flags.by === 'architect') {
    targets = nodes.slice();
  } else if (nodes.length === 1) {
    targets = nodes;
  } else {
    fail('ticket names multiple nodes — pass --node <n>, or review as "architect" to approve all at once');
  }

  // The approval seat: a ticket's own recorded verifier may stand in for "approve" only when the
  // ticket's author is the target node's own owner (nobody reviews their own ticket, and the
  // owner IS the author here) and the roster carries no live architect (the usual stand-in) —
  // otherwise a verifier has no standing to approve at all, and this refuses rather than letting
  // it through unmarked. A "changes" request has no such gap to fill, so this never touches it.
  let verifierSeat = false;
  if (verdict === 'approve' && keys.verifier !== '—' && flags.by === keys.verifier) {
    const notOwned = targets.filter((n) => ownerNameForNode(horde, n) !== keys.author);
    const liveArchitect = architectIsLive(horde);
    if (notOwned.length > 0 || liveArchitect) {
      const reasons = [];
      if (notOwned.length) reasons.push(`the ticket's author does not own: ${notOwned.join(', ')}`);
      if (liveArchitect) reasons.push('a live architect is on the roster and reviews it instead');
      fail(
        `${flags.by} is this ticket's verifier, not an owner or the architect — a verifier stands in `
        + `for approval only when the ticket's author owns the node and no architect is live; refused `
        + `because ${reasons.join(' and ')}`,
      );
    }
    verifierSeat = true;
  }

  const key = verdict === 'approve' ? ticketBranchKey(horde, ticket) : { sha: null, patchId: null };
  const seatTag = verifierSeat ? '(verifier-seat)' : '';
  const value = verdict === 'approve'
    ? approvalValue(`${flags.by}${seatTag}`, key)
    : `changes:${flags.by}`;
  let text = ticket.text;
  for (const n of targets) text = setNodeApproval(text, n, value);

  if (verdict === 'changes') {
    text = setStatus(text, 'changes');
  } else if (allNodesApproved(text)) {
    text = setStatus(text, 'verified');
  }
  writeText(ticket.issuePath, text);
  const shaNote = key.sha ? ` at ${key.sha}` : '';
  const diffNote = key.patchId ? ` (diff ${key.patchId.slice(0, 7)})` : '';
  const seatNote = verifierSeat ? ' (verifier-seat)' : '';
  for (const n of targets) appendLog(ticket, `review: ${n} ${verdict} by ${flags.by}${seatNote}${shaNote}${diffNote}${why ? ` — ${why}` : ''}`);
  traceRoster(horde, flags.by);
  emit(
    {
      id: ticket.id,
      verdict,
      by: flags.by,
      nodes: targets,
      verifierSeat,
      sha: key.sha,
      diff: key.patchId,
    },
    flags,
    () => `${ticket.id}: ${verdict} by ${flags.by}${seatNote} (${targets.join(', ')})${diffNote}`,
  );
}

function cmdMove(horde, positional, flags) {
  const ticket = requireTicket(horde, positional[0]);
  if (!flags.team) fail('move requires --team <t>');
  if (flags.team === ticket.team) fail(`already in team ${flags.team}`);
  const destDir = teamPath(horde, flags.team, 'issues', ticket.dirName);
  if (existsSync(destDir)) fail(`destination already exists: ${destDir}`);
  mkdirSync(teamPath(horde, flags.team, 'issues'), { recursive: true });
  const updated = setField(ticket.text, 'Team', flags.team);
  writeText(ticket.issuePath, updated);
  renameSync(ticket.dir, destDir);
  emit({ id: ticket.id, from: ticket.team, to: flags.team }, flags, () => `${ticket.id} moved: ${ticket.team} -> ${flags.team}`);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// The header block is everything above "## What" (id/title heading, Status, the combined
// Node/Class/Severity/Team line, Depends-on/Branch, Keys) — edit replaces only what comes after
// it, so none of that state can be clobbered by a body rewrite.
function cmdEdit(horde, positional, flags) {
  const ticket = requireTicket(horde, positional[0]);
  if (!flags.by) fail('edit requires --by <name>');
  const stdin = readStdin();
  if (!stdin.trim()) fail('edit requires the new body on stdin (everything from "## What" on)');
  const idx = ticket.text.indexOf('## What');
  if (idx === -1) fail(`ticket ${ticket.id}: could not find the "## What" section to replace`);
  const header = ticket.text.slice(0, idx);
  const body = stdin.replace(/\s+$/, '');
  const updated = `${header}${body}\n`;
  writeText(ticket.issuePath, updated);
  appendLog(ticket, `body edited by ${flags.by}`);
  emit({ id: ticket.id, bytes: body.length }, flags, () => `${ticket.id}: body updated (${body.length} bytes)`);
}

function main() {
  const {
    positional: allPositional,
    flags,
  } = parseArgs(process.argv.slice(2), { flags: ['open', 'review-pending', 'log', 'from-queue'] });
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'new': return cmdNew(horde, positional, flags);
    case 'list': return cmdList(horde, positional, flags);
    case 'show': return cmdShow(horde, positional, flags);
    case 'status': return cmdStatus(horde, positional, flags);
    case 'log': return cmdLog(horde, positional, flags);
    case 'grep': return cmdGrep(horde, positional, flags);
    case 'key': return cmdKey(horde, positional, flags);
    case 'review-request': return cmdReviewRequest(horde, positional, flags);
    case 'review': return cmdReview(horde, positional, flags);
    case 'move': return cmdMove(horde, positional, flags);
    case 'edit': return cmdEdit(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
