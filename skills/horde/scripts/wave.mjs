#!/usr/bin/env node
// horde skill — wave.mjs
//
// The wave journal: an append-only log of starts, notes, merges, key transfers and closes. The
// mission's own wave cadence lives at hordes/<horde>/plan.md — matching the tree in
// reference/model.md, which lists plan.md once, at the horde root.
//
// The close is where the journal stops being a record and becomes a report: it reads its own
// bullets back — what the wave planned, what it merged and when, whose keys travelled — and
// states the figures a chairman judges a horde by. Everything it prints is derived from state
// some other tool wrote while doing its job; nothing here is entered by hand, which is the point:
// a KPI somebody types in is a KPI somebody can flatter.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  hordePath, teamPath, readText, writeText, appendText, readJSON, writeJSON, readConfig, today,
  nowIso, fail, parseArgs, emit, isMain, resolveHorde, renderTemplate, qualityPolicy, resolveTree,
} from './_lib.mjs';
import { readCostLimit, sumEntries } from './cost.mjs';
// queue.mjs imports this file too (noteMerged, parseEvidenceRows). The cycle is deliberate and
// safe — every binding on both sides is a hoisted function declaration and neither module calls
// the other while it is still being evaluated. The alternative, a second derivation of the DAG
// here, is the thing worth avoiding: the parallelism a wave close reports as "planned" has to be
// the plan's own layers.
import { buildPlan } from './queue.mjs';
import { loadAsks } from './ask.mjs';
import { writeLawDiff } from './law.mjs';
import {
  ygQualityIndex, observeAspects, pendingPromotions, markPromotionsReported,
} from './node.mjs';
import { findTicket, ticketKind, parseField } from './tk.mjs';

const START_RE = /^# Wave (\S+) — start \d{4}-\d{2}-\d{2}$/;
const CLOSE_RE = /^# Wave (\S+) — close \d{4}-\d{2}-\d{2}$/;

const USAGE = `usage: wave.mjs <command> [options]

commands:
  start [n] [--team t] [--horde h]
      appends "# Wave <n> — start <date>"; n auto-increments from the last wave number in the
      journal when omitted. Records the plan's own layers and the parallelism they allow, so the
      close can report what the wave planned against what it achieved.
  note "<text>" [--team t] [--horde h]
      appends a dated bullet.
  merged <ticket> <sha> [--team t] [--horde h]
      appends a dated "merged: <ticket> <sha>" bullet. "queue.mjs set <ticket> merged --sha" does
      this itself, so this is only for a merge the queue never saw; it never records one twice.
  close [--gate green|red] [--sha <sha>] [--evidence E5[,E6]] [--team t] [--horde h]
      renders templates/wave-close.md — counts from the team's queue.json, cost from cost.json —
      and appends it. --gate with --sha records that gate for the team's level (trunk for the
      trunk team) in cache/last-gate.json — the branch tip the gate ran on, so status can show it.
      --evidence names catalogue rows the wave gate itself proves (a green gate on the trunk is
      the usual one); they are filled with "wave <n> gate on <sha>" — refused when the gate is red.
      Also states, from the wave's own record: planned against achieved parallelism, the keys
      that carried over without a second reading, human decisions per merged ticket with its
      trend, and — where the nodes come from a graph — the quality index with its delta since
      the last wave. A quality index that fell is a line in this report naming what fell; it does
      not open anything of its own — provisional, pending the same "quality" ask-kind question
      019 left open.
      It also closes the loop on the quality ruling: it takes each watched rule's reading for
      this wave (what the two-wave test for enforcement counts), and prints one block naming
      every rule the horde raised this wave with the evidence that earned it, every improvement
      of its own it finished, and the sentence telling the chairman that undoing any of it is
      theirs to ask for. Under a charter set to only-the-work the block says none of it ran.
  evidence <id> --by "<who/what>" [--horde h]
      fills one catalogue row's "reproduced by" cell by hand — for a row no ticket verdict can
      fill, such as the mission gate; the director's call. A row in the charter's evidence
      catalogue counts green when its "reproduced by" cell is filled, or (on a ticket logged
      before this migration) when a ticket merged this wave names the row's id in its own
      acceptance checklist and carries a "reproduced" verdict — in which case that verifier's
      name is written into the charter's cell (the one charter edit any tool here makes). Refuses
      when no wave is open.
  current [--team t] [--horde h]
      prints the open wave number, or "none".

options: --json  --help`;

function isTrunk(team) { return !team || team === 'trunk'; }

function journalPath(horde, team) {
  return isTrunk(team) ? hordePath(horde, 'plan.md') : teamPath(horde, team, 'plan.md');
}

// Exported so horde.mjs (list) and status.mjs (digest) can show the open wave without re-parsing
// the journal themselves.
export function currentWaveNumber(text) {
  if (!text) return null;
  let current = null;
  for (const line of text.split('\n')) {
    const sm = START_RE.exec(line);
    if (sm) { current = sm[1]; continue; }
    const cm = CLOSE_RE.exec(line);
    if (cm && cm[1] === current) current = null;
  }
  return current;
}

export function lastWaveNumber(text) {
  if (!text) return 0;
  let max = 0;
  for (const line of text.split('\n')) {
    const m = START_RE.exec(line) || CLOSE_RE.exec(line);
    if (m && /^\d+$/.test(m[1])) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function append(path, text) {
  const existing = readText(path) || '';
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  appendText(path, sep + text);
}

// The plan bullet a wave opens with — the layers `queue.mjs plan` derives from the tickets right
// now, the parallelism the widest startable layer allows within config.parallelism, and the
// instant the wave opened. All three are read back at the close: the first two to say what the
// wave planned against what it achieved, the third to attribute a ruling to the wave it was made
// in (an escalation carries a timestamp; a journal heading carries only a date).
const PLAN_RE = /^- \S+ plan: layers (\S+) · planned parallelism (\d+) · opened (\S+)$/;

function planAtStart(horde, team) {
  const cfg = readConfig() || {};
  const cap = Number(cfg.parallelism) > 0 ? Math.trunc(Number(cfg.parallelism)) : 6;
  let sizes = [];
  try {
    sizes = buildPlan(horde, team || 'trunk', cfg).layers.map((l) => l.length);
  } catch {
    // A plan that cannot be built (a ticket in an unreadable shape, a circle of dependencies)
    // must not stop a wave from opening; the close then reports a planned parallelism of 0,
    // which is exactly what the journal knows.
    sizes = [];
  }
  return {
    sizes,
    layers: sizes.length ? sizes.join('/') : 'none',
    parallelism: Math.min(sizes[0] || 0, cap),
    opened: nowIso(),
  };
}

function cmdStart(horde, positional, flags) {
  const path = journalPath(horde, flags.team);
  const text = readText(path);
  const n = positional[0] || String(lastWaveNumber(text) + 1);
  append(path, `\n# Wave ${n} — start ${today()}\n`);
  const plan = planAtStart(horde, flags.team);
  append(path, `- ${today()} plan: layers ${plan.layers} · planned parallelism ${plan.parallelism} · opened ${plan.opened}\n`);
  emit({ n, layers: plan.sizes, plannedParallelism: plan.parallelism, opened: plan.opened }, flags,
    () => `wave started: ${n} — layers ${plan.layers}, planned parallelism ${plan.parallelism}`);
}

function cmdNote(horde, positional, flags) {
  const text = positional[0];
  if (!text) fail('note requires "<text>"');
  append(journalPath(horde, flags.team), `- ${today()} ${text}\n`);
  emit({ note: text }, flags, () => 'note added');
}

// The journal bullet that says a ticket merged. Exported because a merge is one event and must
// cost one write: `queue.mjs set <t> merged` calls this itself, so the evidence catalogue — which
// reads the journal to find what this wave merged — turns green without the caller having to
// remember a second, independent command. Idempotent, so the older two-call habit still works and
// records the merge once.
export function noteMerged(horde, team, ticket, sha) {
  const path = journalPath(horde, team);
  const bullet = `merged: ${ticket} ${sha}`;
  const existing = readText(path) || '';
  if (existing.includes(bullet)) return { path, bullet, appended: false };
  append(path, `- ${today()} ${bullet}\n`);
  return { path, bullet, appended: true };
}

// The keys this wave carried over without a second reading — summed from the bullets a
// pre-migration checklist left in the journal. Nothing writes a new one any more; kept for a
// wave whose journal still carries them from before this migration.
function waveKeysTransferred(spanText) {
  let total = 0;
  for (const line of spanText.split('\n')) {
    const m = /^- \S+ keys transferred: \S+ (\d+) at diff \S+$/.exec(line);
    if (m) total += Number(m[1]);
  }
  return total;
}

function cmdMerged(horde, positional, flags) {
  const [ticket, sha] = positional;
  if (!ticket || !sha) fail('merged requires <ticket> <sha>');
  const { appended } = noteMerged(horde, flags.team, ticket, sha);
  emit({ ticket, sha, appended }, flags, () => (appended
    ? `merged noted: ${ticket} ${sha}`
    : `merged already noted: ${ticket} ${sha} — the queue records it when the ticket is set merged`));
}

function cmdCurrent(horde, positional, flags) {
  const n = currentWaveNumber(readText(journalPath(horde, flags.team)));
  emit({ current: n }, flags, () => n || 'none');
}

// One wave's own span: the lines between its start marker and the next start/close marker (or
// the end of the file). Every per-wave reading below — what merged, what was audited, when the
// wave opened — is taken from this one extraction rather than each walking the journal itself.
function waveSpan(journalText, waveStartN) {
  const lines = [];
  let inWave = false;
  for (const line of (journalText || '').split('\n')) {
    const sm = START_RE.exec(line);
    if (sm) { inWave = sm[1] === String(waveStartN); continue; }
    if (CLOSE_RE.test(line)) { inWave = false; continue; }
    if (inWave) lines.push(line);
  }
  return lines.join('\n');
}

// Every "merged:" bullet of one wave, with the date it carries — the wave's merge timeline.
function waveMerges(spanText) {
  const out = [];
  for (const line of spanText.split('\n')) {
    const m = /^- (\S+) merged: (\S+) /.exec(line);
    if (m) out.push({ date: m[1], ticket: m[2] });
  }
  return out;
}

// Achieved parallelism, read off the merge timeline the journal actually holds: the most
// tickets this wave landed on any one day. A journal bullet is dated, not stamped to the
// second, so the day is the finest grain the record supports — and it is the grain that
// answers the question the planned figure asks, which is how many pieces of work were moving
// beside each other rather than one after another.
function achievedParallelism(merges) {
  const byDate = new Map();
  for (const m of merges) byDate.set(m.date, (byDate.get(m.date) || 0) + 1);
  return byDate.size === 0 ? 0 : Math.max(...byDate.values());
}

// A ticket's folder is "NNN-slug"; only NNN is known at the call site.
function findTicketDir(horde, team, ticket) {
  const issuesDir = teamPath(horde, team, 'issues');
  if (!existsSync(issuesDir)) return null;
  const match = readdirSync(issuesDir, { withFileTypes: true })
    .find((d) => d.isDirectory() && d.name.startsWith(`${ticket}-`));
  return match ? join(issuesDir, match.name) : null;
}

// The "## Acceptance" section of a ticket's issue.md — the checklist tk.mjs wrote from `--evidence`.
function acceptanceSection(issueText) {
  const idx = issueText.indexOf('## Acceptance');
  if (idx === -1) return '';
  const rest = issueText.slice(idx);
  const nextHeading = rest.indexOf('\n## ', 1);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

// Exported so horde.mjs's charter edit can hold a ruled escalation's own text to the same test it
// holds a ticket's acceptance checklist to: does this text actually name the row it's cited for.
export function mentionsEvidenceId(text, id) {
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

// Has wave 1 of the mission (the trunk-level journal — "trunk" IS the mission, see the header
// note above) ever started, open or since closed. Exported for horde.mjs's charter edit: a row
// drop is free before the mission's first wave, and needs a ruled escalation after it — a
// mission that never started a wave has nothing yet for a drop to cost.
export function wave1Started(journalText) {
  if (!journalText) return false;
  return journalText.split('\n').some((line) => {
    const sm = START_RE.exec(line);
    if (sm && sm[1] === '1') return true;
    const cm = CLOSE_RE.exec(line);
    return !!(cm && cm[1] === '1');
  });
}

// The latest pre-migration verdict block in a ticket's log.md (verdict.md's rendered heading, in
// order — log.md is append-only, so the last match is the most recent verdict).
function latestVerdict(logText) {
  if (!logText) return null;
  const lines = logText.split('\n');
  const headingRe = /^## Verdict · (\S+) · (\d{4}-\d{2}-\d{2}) · by (\S+) \(([^)]+)\)$/;
  let latest = null;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    let result = null;
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('## '); j++) {
      const rm = /^\*\*Result:\*\* (\S+)/.exec(lines[j]);
      if (rm) { result = rm[1]; break; }
    }
    latest = { verifier: m[3], result };
  }
  return latest;
}

// The evidence catalogue table in charter.md: | id | evidence | node | reproduced by |. A row
// counts once any cell holds text (the template ships one all-empty row). Exported so horde.mjs
// can tell a rewritten charter what it just did to the catalogue.
export function parseEvidenceRows(charterText) {
  const headingIdx = charterText.indexOf('## Acceptance');
  if (headingIdx === -1) return [];
  const rest = charterText.slice(headingIdx);
  const nextHeading = rest.indexOf('\n## ', 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const lines = section.split('\n').filter((l) => l.trim().startsWith('|'));
  // lines[0] = header, lines[1] = --- separator, lines[2..] = data
  return lines.slice(2)
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.some((c) => c.length > 0))
    .map(([id, evidence, node, reproducedBy]) => ({ id, evidence, node, reproducedBy: reproducedBy || '' }));
}

// ---- the charter's own shape, where a tool writes into it -------------------------------------
//
// The section naming what counts as evidence in THIS repository — refine writes it once per
// mission, a person reads it, and every catalogue row above is reproduced through what it names.
// It lives here, beside the catalogue's own reader, because the one thing that must never happen
// to it is standing INSIDE the catalogue's section: parseEvidenceRows (and tk.mjs's own copy of
// that read) slices "## Acceptance" up to the next "## " heading, so a heading dropped into the
// middle of that table makes every row below it stop existing for both readers, silently and with
// nothing wrong to see in the file.

export const EVIDENCE_SECTION = 'Evidence in this repository';

const CATALOGUE_HEADER = ['id', 'evidence', 'node', 'reproduced by'];

// Every line anywhere in the charter that looks like a catalogue row — four cells, at least one
// filled, and neither the header nor its separator. The same filters parseEvidenceRows applies
// inside the section, applied to the whole document.
function catalogueRowsAnywhere(charterText) {
  return String(charterText || '').split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length === 4)
    .filter((cells) => !cells.every((c, i) => c.toLowerCase() === CATALOGUE_HEADER[i]))
    .filter((cells) => !cells.every((c) => c === '' || /^-+$/.test(c)))
    .filter((cells) => cells.some((c) => c.length > 0));
}

// Null when the charter's catalogue is whole; otherwise how many rows the document holds, how many
// the readers actually see, and the heading that cut it. A direct measure of the damage rather
// than a guess at which heading is allowed where: any heading standing in the catalogue's table
// hides the rows below it, whatever the heading is called.
export function catalogueCut(charterText) {
  const text = String(charterText || '');
  const acceptance = text.indexOf('## Acceptance');
  if (acceptance === -1) return null;
  const read = parseEvidenceRows(text).length;
  const present = catalogueRowsAnywhere(text).length;
  if (present <= read) return null;
  const rest = text.slice(acceptance);
  const next = rest.indexOf('\n## ', 1);
  const m = next === -1 ? null : /^## (.+)$/m.exec(rest.slice(next + 1));
  return {
    heading: m ? m[1].trim() : '(unknown)', read, present, lost: present - read,
  };
}

// Replaces one "## <heading>" section's body, or adds the whole section when the charter has
// none — a mission started before the section existed gains it rather than being refused. `before`
// names the heading text the new section is placed above; without it (or when that anchor is
// missing) the section goes at the end, which is always outside every machine-read section.
export function upsertCharterSection(charterText, heading, body, { before = null } = {}) {
  const text = String(charterText || '');
  const block = `## ${heading}\n\n${String(body).trim()}\n`;
  const at = text.search(new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
  if (at !== -1) {
    const rest = text.slice(at);
    const end = rest.indexOf('\n## ', 1);
    return end === -1 ? `${text.slice(0, at)}${block}` : `${text.slice(0, at)}${block}\n${rest.slice(end + 1)}`;
  }
  if (before) {
    const anchor = text.indexOf(before);
    if (anchor !== -1) return `${text.slice(0, anchor)}${block}\n${text.slice(anchor)}`;
  }
  return `${text.replace(/\s+$/, '')}\n\n${block}`;
}

// Writes a name into a row's "reproduced by" cell, matched by its id — the one edit any tool in
// this skill is allowed to make to the charter, since it's recording evidence the mission itself
// produced (a merged ticket's reproduced verdict), not a decision about the mission.
function setReproducedBy(charterText, id, name) {
  const lines = charterText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|');
    if (cells.length < 6) continue; // '' | id | evidence | node | reproduced by | ''
    if (cells[1].trim() !== id) continue;
    cells[4] = ` ${name} `;
    lines[i] = cells.join('|');
    return lines.join('\n');
  }
  return charterText;
}

// A row is green when the charter already names who reproduced it, or — when it doesn't yet —
// when a ticket merged this wave both claims the row's id in its own acceptance checklist and
// carries a verifier's "reproduced" verdict; that verifier's name is then written into the
// charter so the row stays green without the director having to transcribe it by hand.
function computeEvidence(horde, team, mergedTickets) {
  const charterPath = hordePath(horde, 'charter.md');
  let charterText = readText(charterPath) || '';
  const rows = parseEvidenceRows(charterText);
  let green = 0;
  let changed = false;
  for (const row of rows) {
    if (row.reproducedBy) { green++; continue; }
    let verifier = null;
    for (const ticket of mergedTickets) {
      const dir = findTicketDir(horde, team, ticket);
      if (!dir) continue;
      const issueText = readText(join(dir, 'issue.md')) || '';
      if (!mentionsEvidenceId(acceptanceSection(issueText), row.id)) continue;
      const verdict = latestVerdict(readText(join(dir, 'log.md')));
      if (verdict && verdict.result === 'reproduced') { verifier = verdict.verifier; break; }
    }
    if (verifier) {
      green++;
      charterText = setReproducedBy(charterText, row.id, verifier);
      changed = true;
    }
  }
  if (changed) writeText(charterPath, charterText);
  return { total: rows.length, green };
}

// ---- mission-wide, all-time evidence coverage --------------------------------------
//
// computeEvidence above turns rows green for one wave close: one team, one wave's own merged
// tickets, mutating the charter as it finds a match. status.mjs's five-state digest and
// horde.mjs's done gate both need the same judgement stretched over the whole mission's history
// instead — this section is that shared reading, so neither reimplements "does a ticket's
// acceptance checklist name this row, and did its verifier reproduce it".

// Every non-dropped ticket of the horde, whatever its state — {id, team, text, status, logText}.
// Only "trunk" exists.
function allHordeTickets(horde) {
  const out = [];
  const team = 'trunk';
  const issuesDir = teamPath(horde, team, 'issues');
  if (!existsSync(issuesDir)) return out;
  for (const d of readdirSync(issuesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(issuesDir, d.name);
    const text = readText(join(dir, 'issue.md')) || '';
    const status = (/^\*\*Status:\*\*\s*(\S+)/m.exec(text) || [])[1] || '';
    if (status === 'dropped') continue;
    out.push({
      id: d.name.slice(0, 3), team, text, status, logText: readText(join(dir, 'log.md')) || '',
    });
  }
  return out;
}

// A ticket's own **Status:** rank toward a row it names — the strongest one wins when more than
// one ticket claims the same row. "merged" here does not yet mean the charter is stamped
// (queue.mjs's own merge refusal already requires a reproduced verdict to reach it, but
// computeEvidence's own charter write only happens at a wave close, or here); every other active
// state reads as "running" — in flight, neither filed-and-waiting nor done.
const ROW_STATE_RANK = { proposed: 1, queued: 1, merged: 3 };

// The state of one charter row against every ticket in the horde, without writing anything:
// 'reproduced' when the charter cell already names who reproduced it; otherwise the strongest
// state reached by a ticket whose own acceptance checklist names this row's id — 'merged' (a
// merged ticket already carrying a reproduced verdict, per queue.mjs's own merge refusal, but not
// yet written into the charter), 'running' (filed and in flight), 'queued' (filed, not started),
// or 'no-ticket' (nothing claims it at all).
function deriveRowState(row, tickets) {
  if (row.reproducedBy) return { state: 'reproduced', ticket: null, verifier: null };
  const naming = tickets.filter((t) => mentionsEvidenceId(acceptanceSection(t.text), row.id));
  if (naming.length === 0) return { state: 'no-ticket', ticket: null, verifier: null };
  let best = { rank: 0, ticket: null, verifier: null };
  for (const t of naming) {
    const rank = ROW_STATE_RANK[t.status] ?? 2;
    if (rank <= best.rank) continue;
    const verdict = rank >= 3 ? latestVerdict(t.logText) : null;
    best = {
      rank, ticket: t.id, verifier: verdict && verdict.result === 'reproduced' ? verdict.verifier : null,
    };
  }
  const state = best.rank >= 3 ? 'merged' : best.rank === 2 ? 'running' : 'queued';
  return { state, ticket: best.ticket, verifier: best.verifier };
}

// Read-only: every charter row with its mission-wide state — what status.mjs's evidence block
// shows. Exported so status.mjs never re-derives what "does a ticket prove this row" means.
export function evidenceCoverage(horde) {
  const charterText = readText(hordePath(horde, 'charter.md')) || '';
  const rows = parseEvidenceRows(charterText);
  const tickets = allHordeTickets(horde);
  return rows.map((row) => {
    const { state, ticket } = deriveRowState(row, tickets);
    return { ...row, state, ticket };
  });
}

// Mutating: promotes every row currently at 'merged' (a merged ticket already reproduced it, but
// the charter was never stamped — computeEvidence's own write only fires at that ticket's own
// wave's close) into the charter's "reproduced by" cell, mission-wide and regardless of wave or
// team. What horde.mjs done calls before judging whether every row is green, so the mission's
// final gate does not depend on the director having remembered to close a wave for it. Returns
// the coverage read back afterwards.
export function stampMissionEvidence(horde) {
  const charterPath = hordePath(horde, 'charter.md');
  let charterText = readText(charterPath) || '';
  const rows = parseEvidenceRows(charterText);
  const tickets = allHordeTickets(horde);
  let changed = false;
  for (const row of rows) {
    if (row.reproducedBy) continue;
    const { state, verifier } = deriveRowState(row, tickets);
    if (state === 'merged' && verifier) {
      charterText = setReproducedBy(charterText, row.id, verifier);
      changed = true;
    }
  }
  if (changed) writeText(charterPath, charterText);
  return evidenceCoverage(horde);
}

function cmdEvidence(horde, positional, flags) {
  const [id] = positional;
  if (!id || !flags.by) fail('evidence requires <id> --by "<who/what>"');
  const charterPath = hordePath(horde, 'charter.md');
  const charterText = readText(charterPath) || '';
  if (!parseEvidenceRows(charterText).some((r) => r.id === id)) fail(`evidence id ${id} is not in the charter's catalogue`);
  writeText(charterPath, setReproducedBy(charterText, id, String(flags.by)));
  emit({ id, by: flags.by }, flags, () => `evidence ${id} reproduced by: ${flags.by}`);
}

function previousGreen(journalText) {
  const re = /\*\*Evidence catalogue:\*\* (\d+)\/\d+ green/g;
  let last = null;
  let m;
  while ((m = re.exec(journalText)) !== null) last = Number(m[1]);
  return last ?? 0;
}

// ---- human decisions per merged ticket -------------------------------------------------------
//
// The learning KPI (ruling escalations-become-rules): how often a human had to answer a question
// for each ticket that landed. It is supposed to fall from wave to wave — a horde that needs the
// same number of answers per ticket in wave six as in wave one has learned nothing.
//
// A wave's decisions are the asks answered since the wave opened, which is why the start bullet
// stamps the instant. A journal written before that stamp existed falls back to subtracting what
// earlier closes already counted — the answer that is at worst coarse, never double-counted.

const DECISIONS_RE = /\*\*Decisions per merged ticket:\*\* (\S+) \((\d+) ruled \/ (\d+) merged\)/g;

function previousDecisions(journalText) {
  const out = [];
  DECISIONS_RE.lastIndex = 0;
  let m;
  while ((m = DECISIONS_RE.exec(journalText)) !== null) {
    out.push({ ratio: m[1], ruled: Number(m[2]), merged: Number(m[3]) });
  }
  return out;
}

function answeredAsks(horde) {
  return loadAsks(horde).items.filter((it) => it.state === 'answered');
}

function decisionsKpi(horde, journalText, openedAt, mergedThisWave) {
  const ruled = answeredAsks(horde);
  const earlier = previousDecisions(journalText);
  const thisWave = openedAt
    ? ruled.filter((it) => String(it.answeredAt || it.at || '') >= openedAt).length
    : Math.max(0, ruled.length - earlier.reduce((sum, e) => sum + e.ruled, 0));
  const ratio = mergedThisWave > 0 ? (thisWave / mergedThisWave).toFixed(2) : '—';
  const series = [...earlier.map((e) => e.ratio), ratio];
  const trend = series.length > 1 ? ` · trend ${series.slice(-5).join(' → ')}` : '';
  return {
    ruled: thisWave,
    merged: mergedThisWave,
    ratio,
    line: `${ratio} (${thisWave} ruled / ${mergedThisWave} merged)${trend}`,
  };
}

// ---- the quality index (ruling quality-always-authorised) ------------------------------------
//
// Five numbers read from the graph's own CLI at the tree this close is run on, printed with the
// delta from the wave before, plus a sixth (judges) shown for the record but never part of what
// "fell" means. The ruling says the index must not fall: raising enforcement is the horde's to do
// on its own, lowering it is the chairman's call — so a fall is not something this tool argues
// with, it is something it escalates.

// The trailing "· judges N" is optional in the pattern: a journal entry a close wrote before this
// figure existed has none, and that is a missing delta to fall back on, not a parse failure.
const QUALITY_RE = /\*\*Quality index:\*\* enforced (\d+) · advisory clean (\d+)\/(\d+) · baseline (\d+) · noise floor (\d+) · coverage (\d+)\/(\d+)(?: · judges (\d+))?/g;

function previousQuality(journalText) {
  QUALITY_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = QUALITY_RE.exec(journalText)) !== null) {
    last = {
      enforced: Number(m[1]),
      advisoryClean: Number(m[2]),
      advisoryTotal: Number(m[3]),
      baseline: Number(m[4]),
      noiseFloor: Number(m[5]),
      coveredFiles: Number(m[6]),
      totalFiles: Number(m[7]),
      judges: m[8] !== undefined ? Number(m[8]) : null,
    };
  }
  return last;
}

function coverageRatio(q) {
  return q && q.totalFiles ? q.coveredFiles / q.totalFiles : null;
}

function measureQuality(cfg) {
  const cwd = resolveTree({}).path;
  const idx = ygQualityIndex(cfg, cwd);
  if (!idx.available) {
    return { measured: false, why: `${idx.why} — install it, or point config.ygCommand at it` };
  }
  return { measured: true, ...idx };
}

// What fell, in the words a chairman reads. Empty when nothing fell — including every case where
// there is nothing to compare against yet.
function qualityDecline(now, prev) {
  if (!now.measured || !prev) return [];
  const out = [];
  if (now.enforced < prev.enforced) out.push(`enforced rules ${prev.enforced} → ${now.enforced}`);
  if (now.advisoryClean < prev.advisoryClean) {
    out.push(`advisory rules with nothing against them ${prev.advisoryClean} → ${now.advisoryClean}`);
  }
  if (now.baseline > prev.baseline) out.push(`blocking violations ${prev.baseline} → ${now.baseline}`);
  if (now.noiseFloor > prev.noiseFloor) out.push(`noise floor ${prev.noiseFloor} → ${now.noiseFloor}`);
  const a = coverageRatio(now);
  const b = coverageRatio(prev);
  if (a !== null && b !== null && a < b) {
    out.push(`coverage ${prev.coveredFiles}/${prev.totalFiles} → ${now.coveredFiles}/${now.totalFiles}`);
  }
  return out;
}

function qualityLine(now, prev) {
  if (!now.measured) return `not measured — ${now.why}`;
  const coverage = now.totalFiles === null ? '0/0' : `${now.coveredFiles}/${now.totalFiles}`;
  const base = `enforced ${now.enforced} · advisory clean ${now.advisoryClean}/${now.advisoryTotal}`
    + ` · baseline ${now.baseline} · noise floor ${now.noiseFloor} · coverage ${coverage} · judges ${now.judges}`;
  if (!prev) return `${base} (first reading)`;
  const sign = (d) => (d >= 0 ? `+${d}` : String(d));
  const deltas = [
    `enforced ${sign(now.enforced - prev.enforced)}`,
    `advisory clean ${sign(now.advisoryClean - prev.advisoryClean)}`,
    `baseline ${sign(now.baseline - prev.baseline)}`,
    `noise floor ${sign(now.noiseFloor - prev.noiseFloor)}`,
    `coverage ${sign((now.coveredFiles || 0) - prev.coveredFiles)}`,
  ];
  if (prev.judges !== null && prev.judges !== undefined) deltas.push(`judges ${sign(now.judges - prev.judges)}`);
  return `${base} (Δ ${deltas.join(' · ')})`;
}

// ---- what the horde raised on its own, and how the chairman undoes it -------------------------
//
// The other half of the quality ruling. The index line above says whether the graph got stronger;
// this block says WHAT the horde did to make it so, in the words of somebody who might want it
// undone: which rules were raised and on what evidence, which improvements it filed and finished,
// and the one sentence that says a lowering is theirs to ask for. It is the veto, and it only
// works if it is legible — so it names rules and components, never files or commands the chairman
// would have to be taught.

// A rule promoted out of advisory stops being counted among "advisory rules with nothing against
// them" — not because anything went wrong with it, but because it got stronger and now blocks. Read
// literally that is a smaller number, and the close would file a `quality` escalation telling the
// chairman the graph got weaker on the very wave the horde made it stricter. So a drop no larger
// than the number of rules raised out of advisory this wave is accounted for and dropped from the
// list; anything beyond it is a real fall and still goes up.
function withoutPromotionEffects(declined, promotions, now, prev) {
  const raised = promotions.filter((p) => p.from === 'advisory').length;
  if (raised === 0 || !prev || !now.measured) return declined;
  const drop = prev.advisoryClean - now.advisoryClean;
  if (drop <= 0 || drop > raised) return declined;
  return declined.filter((d) => !/^advisory rules with nothing against them/.test(d));
}

const RUNG_WORDS = {
  draft: 'inert',
  advisory: 'a warning',
  enforced: 'blocking',
};

function rungPhrase(from, to) {
  return `${RUNG_WORDS[from] || from} → ${RUNG_WORDS[to] || to}`;
}

// The quality tickets among this wave's merges, with what each was about.
function qualityMergesIn(horde, mergedTickets) {
  const out = [];
  for (const id of mergedTickets) {
    let found = null;
    try { found = findTicket(horde, id); } catch { found = null; }
    if (!found || ticketKind(found.text) !== 'quality') continue;
    const title = (/^#\s*\S+\s*·\s*(.*)$/.exec((found.text.split('\n')[0] || '').trim()) || [])[1] || '';
    out.push({ ticket: found.id, node: parseField(found.text, 'Node'), title });
  }
  return out;
}

function qualityBlock({
  policy, promotions, qualityMerges, indexLine, observed, declined = [],
}) {
  const declineLine = declined.length
    ? `\n\nThe quality index fell this wave: ${declined.join('; ')} — nobody asked for this, and it is not the horde's `
      + 'to accept lower. If it should stand, that is your call to make, not this report\'s.'
    : '';
  if (policy === 'only-the-work') {
    return [
      'This mission is set to only-the-work: the horde raised no rule and filed no improvement of its own this',
      'wave, and it will not until the charter says otherwise.',
      '',
      `Quality index: ${indexLine}${declineLine}`,
    ].join('\n');
  }
  const lines = [];
  if (promotions.length === 0) {
    lines.push('Rules raised this wave: none — no rule had earned the next step yet.');
  } else {
    lines.push('Rules raised this wave, and what earned it:');
    for (const p of promotions) {
      lines.push(`- **${p.aspect}** — ${rungPhrase(p.from, p.to)}. ${p.evidence}`);
    }
  }
  if (observed.length) {
    lines.push('', `Rules being watched: ${observed.map((o) => `${o.aspect} (${o.new} new)`).join(' · ')}`);
  }
  lines.push('');
  if (qualityMerges.length === 0) {
    lines.push('Improvements finished this wave: none.');
  } else {
    lines.push('Improvements finished this wave (filed by the horde, worked after everything the mission asked for):');
    for (const q of qualityMerges) lines.push(`- ${q.ticket} · ${q.node} — ${q.title}`);
  }
  lines.push('', `Quality index: ${indexLine}${declineLine}`);
  lines.push(
    '',
    'Nothing above was asked for and nothing above was made weaker — a rule only ever moved up. If you want any',
    'of it undone, say so: lowering a rule, waiving one or moving its review date is yours alone, and the horde',
    'has no way to do it without you.',
  );
  return lines.join('\n');
}

function cmdClose(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const path = journalPath(horde, flags.team);
  const journalText = readText(path) || '';
  const n = currentWaveNumber(journalText);
  if (!n) fail('no open wave to close');

  if (flags.gate !== undefined && flags.gate !== 'green' && flags.gate !== 'red') {
    fail('--gate must be "green" or "red"');
  }
  // cache/last-gate.json is keyed by level (commit, team, trunk); a team's own close cares
  // about its own merge gate, the trunk's about the trunk merge gate.
  const lastGate = readJSON(hordePath(horde, 'cache', 'last-gate.json'), null);
  const levelGate = lastGate && lastGate[team === 'trunk' ? 'trunk' : 'team'];
  const gate = flags.gate || (levelGate && levelGate.result) || 'unrecorded';
  const level = team === 'trunk' ? 'trunk' : 'team';
  if (flags.gate && flags.sha) {
    const cache = lastGate || {};
    cache[level] = { result: flags.gate, sha: String(flags.sha), count: null, at: new Date().toISOString(), by: `wave ${n} close` };
    writeJSON(hordePath(horde, 'cache', 'last-gate.json'), cache);
  }
  const gateEvidence = flags.evidence ? String(flags.evidence).split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (gateEvidence.length && gate !== 'green') fail('--evidence names rows the wave gate proves; the gate is not green');
  if (gateEvidence.length) {
    const charterPath = hordePath(horde, 'charter.md');
    let charterText = readText(charterPath) || '';
    const ids = new Set(parseEvidenceRows(charterText).map((r) => r.id));
    for (const id of gateEvidence) {
      if (!ids.has(id)) fail(`evidence id ${id} is not in the charter's catalogue`);
      charterText = setReproducedBy(charterText, id, `wave ${n} gate on ${flags.sha || 'unrecorded sha'}`);
    }
    writeText(charterPath, charterText);
  }

  const queue = readJSON(teamPath(horde, team, 'queue.json'), { items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];
  const merged = items.filter((i) => i.state === 'merged').length;
  const escalated = items.filter((i) => i.state === 'escalated').length;
  const dropped = items.filter((i) => i.state === 'dropped').length;
  const open = items.length - merged - escalated - dropped;

  const span = waveSpan(journalText, n);
  const merges = waveMerges(span);
  const mergedTickets = new Set(merges.map((m) => m.ticket));
  const { total, green } = computeEvidence(horde, team, mergedTickets);
  const delta = green - previousGreen(journalText);

  const planned = PLAN_RE.exec(span.split('\n').find((l) => PLAN_RE.test(l)) || '');
  const plannedParallelism = planned ? Number(planned[2]) : 0;
  const openedAt = planned ? planned[3] : null;
  const keysTransferred = waveKeysTransferred(span);

  const decisions = decisionsKpi(horde, journalText, openedAt, mergedTickets.size);

  const cfg = readConfig() || {};

  // The ladder's own reading for this wave, taken before the index is measured: the two-wave test
  // for enforcement counts CLOSED waves, so a wave close is the only thing that may record one,
  // and the free, keyless fill it runs first is what makes the index below a reading of the code
  // as it stands rather than of whatever was last looked at.
  const policy = qualityPolicy(horde);
  let observed = [];
  try {
    observed = observeAspects(horde, resolveTree({}).path, cfg, n).observed;
  } catch {
    // A graph that cannot be read right now still gets its close; the rules simply gain no
    // observation from a wave nobody could measure.
    observed = [];
  }
  const promotions = policy === 'only-the-work' ? [] : pendingPromotions(horde);

  const quality = measureQuality(cfg);
  const prevQuality = previousQuality(journalText);
  // A fallen quality index used to open a "quality" escalation; escalations are gone (019), and
  // "quality" is not one of ask.mjs's four kinds — inventing a fifth was explicitly out of scope,
  // so this is a rendering line only (see the delta already carried in qualityLine below and
  // named again here) until a later task decides whether it needs an ask kind of its own.
  // Provisional — flagged, not a settled design.
  const declined = withoutPromotionEffects(qualityDecline(quality, prevQuality), promotions, quality, prevQuality);

  const cost = readJSON(hordePath(horde, 'cost.json'), { runs: [] });
  const costRuns = Array.isArray(cost.runs) ? cost.runs : [];
  const weights = cfg.classes || {};
  // cost.json's runs each carry their own wave number, so a wave's cost is a direct filter — no
  // need to cross-reference which tickets this wave merged.
  const waveRuns = costRuns.filter((r) => String(r.wave) === String(n));
  const waveSums = sumEntries(waveRuns, weights);
  const missionSums = sumEntries(costRuns, weights);
  const limit = readCostLimit(horde);

  const qualityMerges = qualityMergesIn(horde, mergedTickets);
  const indexLine = qualityLine(quality, prevQuality);

  // What this mission has done to the law, as a document: the graph on the branch the mission was
  // cut from against the graph on the trunk it has built. Written every close, at the wave's own
  // path, so a second close of the same wave replaces it rather than writing a second one. Whoever
  // renders it into sentences the client can veto reads it from there; this never renders prose.
  const law = writeLawDiff(horde, cfg, n);

  const vars = {
    n,
    date: today(),
    merged,
    escalated,
    open,
    gate,
    green,
    total,
    delta: delta >= 0 ? `+${delta}` : String(delta),
    'n-1': String(Number(n) - 1),
    plannedParallelism,
    achievedParallelism: achievedParallelism(merges),
    keysTransferred,
    decisionsLine: decisions.line,
    qualityLine: indexLine,
    qualityBlock: qualityBlock({
      policy, promotions, qualityMerges, indexLine, observed, declined,
    }),
    runs: waveSums.runs,
    weighted: waveSums.weighted,
    cumulative: missionSums.weighted,
    'of limit': limit === null ? '' : ` of ${limit}`,
  };

  let rendered;
  try {
    rendered = renderTemplate('wave-close', vars);
  } catch (e) {
    fail(e.message);
  }
  append(path, `\n${rendered}`);
  // Shown to the chairman now, so the next close does not list them again and none is ever missed
  // by falling between one wave's close and the next one's start.
  markPromotionsReported(horde, promotions);
  emit({
    n,
    merged,
    escalated,
    open,
    gate,
    green,
    total,
    delta,
    plannedParallelism,
    achievedParallelism: vars.achievedParallelism,
    keysTransferred,
    decisions: { ruled: decisions.ruled, merged: decisions.merged, perMergedTicket: decisions.ratio },
    quality,
    qualityDeclined: declined,
    qualityPolicy: policy,
    promoted: promotions.map((p) => ({
      aspect: p.aspect, from: p.from, to: p.to, at: p.at, evidence: p.evidence,
    })),
    qualityMerged: qualityMerges,
    aspectsObserved: observed,
    law: { path: law.path, added: law.doc.added.length, raised: law.doc.raised.length, attached: law.doc.attached.length },
  }, flags, () => {
    const lines = [`wave ${n} closed — gate ${gate}, ${green}/${total} evidence green`];
    for (const p of promotions) lines.push(`rule raised: ${p.aspect} ${p.from} → ${p.to}`);
    if (qualityMerges.length) lines.push(`improvements finished: ${qualityMerges.map((q) => q.ticket).join(', ')}`);
    if (declined.length) {
      lines.push(`the quality index fell: ${declined.join('; ')} — nobody asked for this; it is the client's call, not the horde's, to let it stand`);
    }
    lines.push(
      `what this mission has done to the law so far — ${law.doc.added.length} rule(s) added, `
      + `${law.doc.raised.length} raised, ${law.doc.attached.length} newly attached: ${law.path}`,
    );
    return lines.join('\n');
  });
}

// mulberry32 — a tiny, self-contained PRNG so a draw can be reproduced from a seed. Only ever
// used to pick which tickets to audit; without --seed the draw is Math.random's, as a sample
// should be.
function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'start': return cmdStart(horde, positional, flags);
    case 'note': return cmdNote(horde, positional, flags);
    case 'merged': return cmdMerged(horde, positional, flags);
    case 'close': return cmdClose(horde, positional, flags);
    case 'evidence': return cmdEvidence(horde, positional, flags);
    case 'current': return cmdCurrent(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
