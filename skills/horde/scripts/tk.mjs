#!/usr/bin/env node
// horde skill — tk.mjs
//
// Tickets, over teams/<team>/issues/NNN-slug/{issue.md,log.md}. NNN is unique across the whole
// horde (hordes/<horde>/counter.json), not per team, so a ticket keeps one identity across a
// `move` — and that counter is shared with everything else the horde numbers, so a ticket and a
// graph proposal can never wear the same number. A ticket reads as `t-NNN`; NNN alone is the same
// ticket, and stays the name of its folder and of the `id:` its issue.md carries.
//
// The combined "**Node:** … · **Class:** … · **Severity:** … · **Team:** …" line and the
// "**Depends on:** … · **Branch:** …" line are parsed positionally by label, stopping at the
// next `**Label:**` or end of line — none of those values contain a literal "·".
//
// Four more fields — **Files:**, **Consumes:**, **Produces:**, **Evidence:** — are what the plan
// is computed from: the paths the ticket touches, the ports it needs and delivers, the charter
// evidence rows it earns. They are validated where they are written (a file inside the node's
// boundary, a port that reads <node>/<port>@<version> and that something actually produces, an
// evidence id the charter carries), because a ticket that declares an impossible plan is cheapest
// to refuse at the proposal.
//
// Exports findTicket, the field helpers and padId so queue.mjs — which also needs to read a
// ticket's status — doesn't reimplement the parsing.

import {
  existsSync, mkdirSync, readdirSync, renameSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  hordePath, teamPath, readJSON, writeJSON, readText, writeText, appendText, nowIso, fail,
  parseArgs, asArray, emit, isMain, resolveHorde, renderTemplate, readConfig, resolveTree,
  allocateId,
} from './_lib.mjs';
import {
  ticketBoundary, pathInBoundary, portExists,
} from './node.mjs';
// `queue.mjs` imports this file in turn. The cycle is the one this tool set already runs on (see
// wave.mjs's own note): every binding on both sides is a hoisted function declaration and neither
// module calls the other while it is still being evaluated. The alternative — a second writer of
// dependencies here — is exactly the thing worth avoiding, because a cycle is only caught once the
// whole DAG is built, and that lives there.
import { addDependency } from './queue.mjs';

// "blocked" is where a ticket stops rather than pretends: its fix rounds are spent, so another
// round would be a state dressed up as progress. Nothing in this tool set moves it out again —
// only the client's own answer to the "stuck" ask filed against it does, and that answer is a
// product decision, which is why there is no escalation kind for it and no command here that
// rules on one.
const STATUSES = ['proposed', 'queued', 'running', 'landed', 'changes', 'blocked', 'verified', 'merged', 'escalated', 'dropped'];
const SEVERITIES = ['high', 'medium', 'low'];
// A ticket is "work" (the mission's own scope) unless it names itself "quality" — a self-filed
// improvement outside a wave's assigned scope (better graph, normalization, tidy-up) that
// `queue.mjs next` always ranks after every work ticket, whatever its severity, per the
// quality-always-authorised ruling: quality is raised in free parallelism, never ahead of the work.
const KINDS = ['work', 'quality'];
// A ticket's own answer to the charter's quality policy (ruling quality-always-authorised). The
// mission's policy is the default; `tk.mjs new --no-quality` sets this one ticket to
// "only-the-work" — the work it names, nothing beside it — which is how a single delicate change
// is walled off without turning the policy off for the whole mission. Neither value ever permits
// making anything weaker.
const TICKET_QUALITY = ['autonomous', 'only-the-work'];
const REVIEW_PENDING_STATUSES = new Set(['landed', 'changes']);
const OPEN_EXCLUDE = new Set(['merged', 'dropped']);

const USAGE = `usage: tk.mjs <command> [options]

commands:
  new <slug> --title "<t>" --node <n> [--node <n2> …] --class <c> [--severity high|medium|low]
      [--kind work|quality] [--no-quality] [--depends NNN,…] [--files a,b] [--consumes <node>/<port>@<v>,…]
      [--produces <node>/<port>@<v>,…] [--evidence "<…>"]… [--revert-base <ref>]
      [--team t] [--horde h]
      renders templates/ticket.md; status starts "proposed". --node is repeatable, up to two —
      three or more is refused, since nobody holds the whole of such a diff.
      --kind defaults to "work"; "quality" marks a self-filed improvement outside a wave's
      assigned scope (better graph, normalization, tidy-up) — queue.mjs next always ranks it
      after every work ticket, whatever its severity.
      --no-quality walls this one ticket off from the mission's quality policy: the work it names
      and nothing beside it, whatever the charter says. It never permits the opposite — nothing
      here can make a rule weaker at any setting.
      --revert-base names the ref land.mjs's revert test should use instead of the parent
      branch's tip (for a test meant to already be green there, e.g. a contract test).
      --files lists the paths the ticket touches (each must lie inside a named node's boundary;
      the merge checklist refuses a diff that reaches past them). --consumes/--produces name the
      ports the ticket needs and delivers, as <node>/<port>@<version>; a consumed port with no
      producing ticket and no such port in the graph is refused. An --evidence value that is
      nothing but catalogue ids ("E2,E5") fills the Evidence field; any other value becomes its
      own "- [ ] …" line in the ticket's Acceptance — evidence checklist, and the ids cited in it
      fill the field too. A catalogue id (E1, E2, …) must already be a row in the horde's
      charter.md evidence table — refuses otherwise, listing the unknown ids.
  list [--state s] [--node n] [--review-pending] [--open] [--team t] [--horde h]
  show <ticket> [--log] [--horde h]
  status <ticket> <${STATUSES.join('|')}> ["note"] [--horde h]
      "changes" counts the round and prints it: rounds 1..config.fixRounds.resume (default 3) —
      resume the same worker; the next config.fixRounds.fresh (default 2) rounds — "fresh worker,
      class up", one class heavier, briefed with "brief.mjs worker NNN --takeover"; beyond that it
      refuses.
  log <ticket> "<text>" [--horde h]
  grep <regex> [--horde h]
  review-request <ticket> [--delta <path>] [--horde h]
      appends a timestamped log entry. --delta names the file holding the difference between
      what was approved before and what is on the branch now (the merge checklist writes it and
      prints its path), so a re-review reads that instead of the whole change again.
  edit <ticket> --by <name> [--files a,b] [--consumes …] [--produces …] [--evidence E1,…]
      [--depends NNN,MMM] [--horde h]
      rewrites the body (everything from "## What" on) from stdin, leaving the header block —
      the id/title heading, Status, Node/Class/Severity/Team, Depends on/Branch, Files,
      Consumes/Produces, Evidence — untouched. Appends "body edited by <name>" to the log.
      What owners use to write ticket bodies. With any of --files/--consumes/--produces/
      --evidence it changes those fields instead, each with its own log line saying who changed
      it — how a ticket is widened when the work turns out to touch a file it never declared.
      --depends adds dependencies to the ticket's queue item, one per number, through the same
      path "queue.mjs dep" uses — so a dependency is written the same way whoever writes it, and
      the cycle check lives in one place. The ticket has to be in the queue for that.

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

// A ticket written before the Kind field existed (or written by hand) reads as "work" — the
// field degrades to the mission-scope default rather than to an unrecognized value.
export function ticketKind(text) {
  return parseField(text, 'Kind') === 'quality' ? 'quality' : 'work';
}

// A ticket written before the Quality field existed reads as "autonomous" — the mission's own
// default, not a silent opt-out of it.
export function ticketQuality(text) {
  return parseField(text, 'Quality') === 'only-the-work' ? 'only-the-work' : 'autonomous';
}

// --- the four structural fields ----------------------------------------
//
// **Files:** the paths this ticket touches · **Consumes:**/**Produces:** the ports it needs and
// delivers, `<node>/<port>@<version>` · **Evidence:** the catalogue rows it earns. Together they
// are what the plan is computed from: the order between tickets, which of them collide over a
// file, who has to approve a version bump, and which promised evidence nobody is building. Read
// through these three functions everywhere, so a ticket written by hand in an old shape (an
// empty field, the word "none") degrades to "not declared" rather than to a wrong answer.

function listField(text, label) {
  const raw = parseField(text || '', label);
  if (!raw || raw === 'none' || raw === '—') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function ticketFiles(text) { return listField(text, 'Files'); }

export function ticketEvidence(text) { return listField(text, 'Evidence'); }

// `<node>/<port>@<version>`, where the node is a whole graph path ("orders/order-service") and
// the port is its last segment before the "@" — null when the text is not that shape at all.
export function parsePortRef(raw) {
  const m = /^([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/([A-Za-z0-9._-]+)@(\d+)$/.exec(String(raw).trim());
  if (!m) return null;
  return {
    node: m[1], port: m[2], version: Number(m[3]), ref: `${m[1]}/${m[2]}@${m[3]}`,
  };
}

// label is "Consumes" or "Produces". Unparseable entries are dropped here — `new`/`edit` refuse
// them at the door, so anything that reached the file was well-formed when it was written.
export function ticketPorts(text, label) {
  return listField(text, label).map(parsePortRef).filter(Boolean);
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
// round would be a stall dressed up as progress, not a fix. What happens then is tick's: the queue
// item and the ticket both go to "blocked" and the client is asked, once, with the gate's own last
// words and the path of the ticket's log.
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
        + `resume ${resume} + fresh ${fresh}) — another round is a stall, not a fix.`,
    };
  }
  const label = round <= resume ? 'resume same worker' : 'fresh worker, class up';
  return {
    refused: false, round, resume, fresh, cap, label,
  };
}

// Writes the status and its log line for one transition, embedding the round suffix
// changesRoundInfo computed (when given) so priorChangesRounds can read it back later.
export function transitionStatus(ticket, status, note, roundInfo) {
  const roundSuffix = roundInfo ? ` (round ${roundInfo.round}/${roundInfo.cap ?? roundInfo.resume + roundInfo.fresh} — ${roundInfo.label})` : '';
  writeText(ticket.issuePath, setStatus(ticket.text, status));
  appendText(ticket.logPath, `- ${nowIso()} status: ${status}${note ? ` — ${note}` : ''}${roundSuffix}\n`);
  return roundSuffix;
}

// --- id / lookup ---------------------------------------------------------

// A ticket by any of the ways it gets written: "4", "004", "t-004". The prefix is how an id reads,
// the number is what it IS, so everything below works from the number alone.
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

// The acceptance lines of a ticket: every `- [ ]` (or `- [x]`) line under "## Acceptance", minus
// the template's own placeholder. A ticket with none has nothing a verifier can reproduce, so
// nothing can ever prove it done — `queue add` refuses it (a real mission found one at verifier
// briefing time, after the work was already written).
const ACCEPTANCE_PLACEHOLDER = /^- \[[ x]\]\s*(…|\.\.\.)?\s*$/;
export function acceptanceLines(issueText) {
  const text = String(issueText || '');
  const idx = text.indexOf('## Acceptance');
  if (idx === -1) return [];
  const rest = text.slice(idx);
  const nextHeading = rest.indexOf('\n## ', 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section.split('\n').map((l) => l.trim())
    .filter((l) => /^- \[[ x]\]/.test(l) && !ACCEPTANCE_PLACEHOLDER.test(l));
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

// `--evidence` says two things at once, and which one it is, is decided by what was written: a
// value that is nothing but catalogue ids ("E2,E5") names the rows this ticket earns and fills
// the **Evidence:** field; anything else is an acceptance line, written into the ticket's own
// checklist as before — and any id cited inside it fills the field too, so a ticket that says
// "E2: the engine denies by default" is counted for E2 without saying E2 twice.
const EVIDENCE_ID_LIST = /^E\d+(?:\s*,\s*E\d+)*$/;
function splitEvidenceValues(values) {
  const ids = [];
  const acceptance = [];
  const addId = (id) => { if (!ids.includes(id)) ids.push(id); };
  for (const raw of values) {
    const value = String(raw).trim();
    if (!value) continue;
    if (EVIDENCE_ID_LIST.test(value)) {
      for (const id of value.split(',').map((s) => s.trim())) addId(id);
      continue;
    }
    acceptance.push(value);
    for (const id of value.match(/\bE\d+\b/g) || []) addId(id);
  }
  return { ids, acceptance };
}

// --- the structural fields: parsing and refusals ---------------------------

// A comma list, from one flag or several ("--files a,b --files c").
function listFlag(value) {
  return asArray(value).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
}

// Every path a ticket declares must lie inside the boundary of a node the ticket names: a ticket
// is work on a node, and a file outside every one of its nodes belongs to somebody else's — the
// owner who would have to approve it never sees this ticket. A node the graph does not know
// contributes no boundary, and with no boundary at all there is nothing to check against.
function checkFilesInBoundary(nodes, files) {
  if (files.length === 0) return;
  const cfg = readConfig() || {};
  const root = resolveTree({}).path;
  const boundary = ticketBoundary(root, cfg, nodes);
  if (boundary.length === 0) return;
  const outside = files.filter((f) => !pathInBoundary(f, boundary));
  if (outside.length) {
    fail(`file(s) outside the boundary of ${nodes.join(', ')}: ${outside.join(', ')} — the boundary is ${boundary.join(', ')}. Declare only files of the node this ticket is on, or ask the architect to move the boundary`);
  }
}

function parsePortList(raw, label) {
  return listFlag(raw).map((entry) => {
    const ref = parsePortRef(entry);
    if (!ref) fail(`--${label.toLowerCase()} takes <node>/<port>@<version> (e.g. auth/policy@2) — got "${entry}"`);
    return ref;
  });
}

// Every ticket of the horde that is not dropped, as {id, team, text} — the population a
// `Consumes` looks for its producer in, and the one the plan is derived over.
export function allTickets(horde) {
  const out = [];
  for (const team of allTeamPaths(horde)) {
    const issuesDir = teamPath(horde, team, 'issues');
    if (!existsSync(issuesDir)) continue;
    for (const d of readdirSync(issuesDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const text = readText(join(issuesDir, d.name, 'issue.md')) || '';
      const status = parseField(text, 'Status');
      if (status === 'dropped') continue;
      out.push({
        id: d.name.slice(0, 3), team, dirName: d.name, text, status,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// A port a ticket consumes has to come from somewhere: a ticket that produces it (this team's or
// another's — a cross-team contract is still a contract), or the graph, where the port already
// exists. Neither, and the ticket is planning against something nobody is building; the refusal
// names the port so the owner can either file the producing ticket or use the port that exists.
function checkConsumesHaveProducers(horde, consumes, selfId) {
  if (consumes.length === 0) return;
  const cfg = readConfig() || {};
  const root = resolveTree({}).path;
  const tickets = allTickets(horde).filter((t) => t.id !== selfId);
  const missing = consumes.filter((c) => {
    if (portExists(root, cfg, c.node, c.port)) return false;
    return !tickets.some((t) => ticketPorts(t.text, 'Produces').some((p) => p.node === c.node && p.port === c.port));
  });
  if (missing.length) {
    fail(`nothing produces ${missing.map((c) => c.ref).join(', ')} — no ticket of this horde produces that port and the graph has no port "${missing[0].port}" on node "${missing[0].node}". File the producing ticket first, or name the port that already exists`);
  }
}

// --- commands --------------------------------------------------------------

// createTicket(horde, spec) — the one place a ticket comes into being, so a ticket filed by a tool
// (the quality pass over Grain's advisories, `queue.mjs quality`) is the same object, validated the
// same way, as one an owner files by hand. `cmdNew` is this with the flags read off the command
// line; nothing else writes an issue folder. Refusals still go through fail(), which is the tools'
// shared error contract — a caller wanting a softer answer checks first.
//
// `revertBase` (`--revert-base <ref>` on `new`) is the ref land.mjs's revert test extracts a
// ticket's new tests onto instead of the parent branch's tip, for a test meant to already be green
// there (a contract test pinning a surface that already holds) and red somewhere else named on the
// ticket's own acceptance line instead (e.g. "red on develop"). Empty by default: the template's own
// "**Revert base:**" line then renders with nothing after it, which land.mjs reads as "use the
// parent tip".
export function createTicket(horde, spec) {
  const {
    slug, title, nodes, cls, severity = 'medium', kind = 'work', quality = 'autonomous',
    team = 'trunk', evidence = [], files: fileList = [], consumes: consumesRaw,
    produces: producesRaw, depends = [], revertBase = null,
  } = spec;
  if (!slug) fail('new requires <slug>');
  if (!title) fail('new requires --title "<t>"');
  if (!Array.isArray(nodes) || nodes.length === 0) fail('new requires --node <n> (repeatable)');
  // The model allows a ticket one node, or two when the ticket carries a contract between them —
  // and no more, because a ticket spanning three nodes needs three owners' approval for one diff
  // and no owner holds the whole of it. Three were being accepted in silence.
  if (nodes.length > 2) {
    fail(`a ticket names one node, or two when it carries a contract between them — this one names ${nodes.length} (${nodes.join(', ')}). Split it into one ticket per node, with the contract between them on its own ticket if they need one`);
  }
  const cfg = readConfig();
  const classes = (cfg && cfg.classes) || {};
  if (Object.keys(classes).length && !Object.prototype.hasOwnProperty.call(classes, cls)) {
    fail(`unknown class: ${cls} (config classes: ${Object.keys(classes).join(', ')})`);
  }
  if (!cls) fail('new requires --class <c>');
  if (!SEVERITIES.includes(severity)) fail(`--severity must be one of: ${SEVERITIES.join(', ')}`);
  if (!KINDS.includes(kind)) fail(`--kind must be one of: ${KINDS.join(', ')}`);
  if (!TICKET_QUALITY.includes(quality)) fail(`ticket quality must be one of: ${TICKET_QUALITY.join(', ')}`);
  checkEvidenceIds(horde, evidence);
  const { ids: evidenceIds, acceptance } = splitEvidenceValues(evidence);

  const files = listFlag(fileList);
  const consumes = parsePortList(consumesRaw, 'Consumes');
  const produces = parsePortList(producesRaw, 'Produces');
  checkFilesInBoundary(nodes, files);
  checkConsumesHaveProducers(horde, consumes, null);

  const allocated = allocateId(horde, 'ticket');
  const id = allocated.number;
  const dirName = `${id}-${slugify(slug)}`;
  const dir = teamPath(horde, team, 'issues', dirName);
  if (existsSync(dir)) fail(`issue folder already exists: ${dirName}`);

  let text = renderTemplate('ticket', {
    id,
    title,
    status: 'proposed',
    node: nodes.join(', '),
    class: cls,
    severity,
    team,
    kind,
    quality,
    branch: '—',
    ...(depends.length ? { dependsOn: depends.join(', ') } : {}),
    ...(files.length ? { files: files.join(', ') } : {}),
    ...(consumes.length ? { consumes: consumes.map((c) => c.ref).join(', ') } : {}),
    ...(produces.length ? { produces: produces.map((p) => p.ref).join(', ') } : {}),
    ...(evidenceIds.length ? { evidence: evidenceIds.join(', ') } : {}),
    ...(revertBase ? { revertBase } : {}),
  });
  if (acceptance.length) {
    text = text.replace('- [ ] …', acceptance.map((e) => `- [ ] ${e}`).join('\n'));
  }

  mkdirSync(dir, { recursive: true });
  const issuePath = join(dir, 'issue.md');
  writeText(issuePath, text);
  writeText(join(dir, 'log.md'), '');

  return {
    id,
    ref: allocated.id,
    dirName,
    dir,
    issuePath,
    team,
    kind,
    quality,
    files,
    consumes: consumes.map((c) => c.ref),
    produces: produces.map((p) => p.ref),
    evidence: evidenceIds,
  };
}

function cmdNew(horde, positional, flags) {
  const created = createTicket(horde, {
    slug: positional[0],
    title: flags.title,
    nodes: asArray(flags.node),
    cls: flags.class,
    severity: flags.severity || 'medium',
    kind: flags.kind || 'work',
    // --no-quality is the single-ticket form of the charter's own only-the-work: this ticket gets
    // the work it names and nothing beside it, whatever the mission's policy says.
    quality: flags['no-quality'] ? 'only-the-work' : 'autonomous',
    team: flags.team || 'trunk',
    evidence: asArray(flags.evidence),
    files: flags.files,
    consumes: flags.consumes,
    produces: flags.produces,
    depends: flags.depends ? String(flags.depends).split(',').map((s) => s.trim()).filter(Boolean) : [],
    revertBase: flags['revert-base'] || null,
  });
  emit({
    id: created.id,
    ref: created.ref,
    dirName: created.dirName,
    team: created.team,
    kind: created.kind,
    quality: created.quality,
    files: created.files,
    consumes: created.consumes,
    produces: created.produces,
    evidence: created.evidence,
  }, flags, () => `${created.ref} created — ${created.dirName} (team ${created.team})`);
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
  emit({
    id: ticket.id,
    team: ticket.team,
    kind: ticketKind(ticket.text),
    quality: ticketQuality(ticket.text),
    text: ticket.text,
  }, flags, () => ticket.text);
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

// --delta <path> — the file holding the difference between what the owner already approved and
// what is on the branch now, written by land.mjs when a ticket's diff moved after the review.
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

// Writes one of the four structural fields into the header, adding the line when an older ticket
// has none — the fields are what the plan is computed from, so a ticket written before they
// existed gains them where it can be read, rather than staying invisible to the plan forever.
const FIELD_AFTER = {
  Files: 'Depends on',
  Consumes: 'Files',
  Produces: 'Consumes',
  Evidence: 'Produces',
};
function setHeaderField(text, label, value) {
  // In place, and only the field's own value: Consumes and Produces share one line, so the
  // replacement stops at the "·" that separates them (and keeps the spaces around it).
  const inPlace = new RegExp(`(\\*\\*${label}:\\*\\*[ \\t]*)[^\\n·]*?(?=[ \\t]*(?:·|$))`, 'm');
  if (inPlace.test(text)) return text.replace(inPlace, `$1${value}`);
  const anchor = new RegExp(`^(\\*\\*${FIELD_AFTER[label]}:\\*\\*[^\\n]*)$`, 'm');
  if (anchor.test(text)) return text.replace(anchor, `$1\n**${label}:** ${value}`);
  return text.replace(/^(\*\*Status:\*\*[^\n]*)$/m, `$1\n**${label}:** ${value}`);
}

// The header block is everything above "## What" (id/title heading, Status, the combined
// Node/Class/Severity/Team line, Depends-on/Branch, Files, Consumes/Produces, Evidence) —
// edit replaces only what comes after it, so none of that state can be clobbered by a body
// rewrite. The four structural fields are the exception: they are changed by their own flags,
// each with its own log line, because widening a ticket's files or changing what it delivers is
// a decision reviewers have to be able to see happen, never a silent drift.
// Everything from "## What" on, replaced; the header block (the fields every other tool parses)
// left exactly as it was. One derivation, because a ticket filed by a tool writes its body the
// same way an owner does through `edit`.
function replaceTicketBody(ticket, text, body) {
  const idx = text.indexOf('## What');
  if (idx === -1) fail(`ticket ${ticket.id}: could not find the "## What" section to replace`);
  return `${text.slice(0, idx)}${body.replace(/\s+$/, '')}\n`;
}

// setTicketBody(horde, id, body, by) — the same write, addressed by ticket id, for a caller that
// files a ticket and its body in one move (the quality pass over Grain's advisories). Appends the
// same log line `edit` does, so who wrote a body is never in doubt.
export function setTicketBody(horde, id, body, by) {
  const ticket = findTicket(horde, padId(id));
  if (!ticket) fail(`no such ticket: ${id}`);
  const text = replaceTicketBody(ticket, ticket.text, body);
  writeText(ticket.issuePath, text);
  appendLog(ticket, `body edited by ${by}`);
  return { id: ticket.id, bytes: body.replace(/\s+$/, '').length };
}

function cmdEdit(horde, positional, flags) {
  const ticket = requireTicket(horde, positional[0]);
  if (!flags.by) fail('edit requires --by <name>');
  const wantsFields = ['files', 'consumes', 'produces', 'evidence', 'depends'].some((k) => flags[k] !== undefined);

  let text = ticket.text;
  const changed = [];
  if (flags.depends !== undefined) {
    const deps = String(flags.depends).split(',').map((d) => d.trim()).filter(Boolean);
    if (deps.length === 0) fail('edit --depends takes at least one ticket number, e.g. --depends 004,007');
    const team = String(ticket.team).split('/').pop();
    for (const dep of deps) {
      const { on } = addDependency(horde, team, ticket.id, dep);
      changed.push(`depends on: ${on}`);
    }
  }
  if (wantsFields) {
    const nodes = nodesOf(text);
    if (flags.files !== undefined) {
      const files = listFlag(flags.files);
      checkFilesInBoundary(nodes, files);
      text = setHeaderField(text, 'Files', files.length ? files.join(', ') : 'none');
      changed.push(`files: ${files.length ? files.join(', ') : 'none'}`);
    }
    if (flags.consumes !== undefined) {
      const consumes = parsePortList(flags.consumes, 'Consumes');
      checkConsumesHaveProducers(horde, consumes, ticket.id);
      text = setHeaderField(text, 'Consumes', consumes.length ? consumes.map((c) => c.ref).join(', ') : 'none');
      changed.push(`consumes: ${consumes.length ? consumes.map((c) => c.ref).join(', ') : 'none'}`);
    }
    if (flags.produces !== undefined) {
      const produces = parsePortList(flags.produces, 'Produces');
      text = setHeaderField(text, 'Produces', produces.length ? produces.map((p) => p.ref).join(', ') : 'none');
      changed.push(`produces: ${produces.length ? produces.map((p) => p.ref).join(', ') : 'none'}`);
    }
    if (flags.evidence !== undefined) {
      const values = asArray(flags.evidence);
      checkEvidenceIds(horde, values);
      const { ids } = splitEvidenceValues(values);
      text = setHeaderField(text, 'Evidence', ids.length ? ids.join(', ') : 'none');
      changed.push(`evidence: ${ids.length ? ids.join(', ') : 'none'}`);
    }
  }

  const stdin = wantsFields ? '' : readStdin();
  if (!wantsFields && !stdin.trim()) fail('edit requires the new body on stdin (everything from "## What" on), or one of --files/--consumes/--produces/--evidence/--depends');

  let bytes = 0;
  if (stdin.trim()) {
    text = replaceTicketBody(ticket, text, stdin);
    bytes = stdin.replace(/\s+$/, '').length;
  }

  writeText(ticket.issuePath, text);
  if (bytes) appendLog(ticket, `body edited by ${flags.by}`);
  for (const c of changed) appendLog(ticket, `${c} — changed by ${flags.by}`);
  emit({ id: ticket.id, bytes, changed }, flags, () => (changed.length
    ? `${ticket.id}: ${changed.join(' · ')}${bytes ? ` · body updated (${bytes} bytes)` : ''}`
    : `${ticket.id}: body updated (${bytes} bytes)`));
}

function main() {
  const {
    positional: allPositional,
    flags,
  } = parseArgs(process.argv.slice(2), { flags: ['open', 'review-pending', 'log', 'from-queue', 'no-quality'] });
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
    case 'review-request': return cmdReviewRequest(horde, positional, flags);
    case 'move': return cmdMove(horde, positional, flags);
    case 'edit': return cmdEdit(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
