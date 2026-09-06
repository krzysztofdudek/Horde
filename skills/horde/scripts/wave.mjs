#!/usr/bin/env node
// horde skill — wave.mjs
//
// The wave journal: an append-only log of starts, notes, merges, audits and closes. The mission's
// own wave cadence lives at hordes/<horde>/plan.md; a sub-team running its own waves gets
// teams/<team>/plan.md instead — "trunk" is not a sub-team here, it IS the mission, so `--team
// trunk` (or omitting --team) both mean the mission-level file, matching the tree in
// reference/topology.md, which lists plan.md once, at the horde root, not under teams/<team>/.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  hordePath, teamPath, readText, writeText, appendText, readJSON, writeJSON, readConfig, today, fail,
  parseArgs, emit, isMain, resolveHorde, renderTemplate,
} from './_lib.mjs';
import { readCostLimit, sumEntries } from './cost.mjs';

const START_RE = /^# Wave (\S+) — start \d{4}-\d{2}-\d{2}$/;
const CLOSE_RE = /^# Wave (\S+) — close \d{4}-\d{2}-\d{2}$/;

const USAGE = `usage: wave.mjs <command> [options]

commands:
  start [n] [--team t] [--horde h]
      appends "# Wave <n> — start <date>"; n auto-increments from the last wave number in the
      journal when omitted.
  note "<text>" [--team t] [--horde h]
      appends a dated bullet.
  merged <ticket> <sha> [--team t] [--horde h]
      appends a dated "merged: <ticket> <sha>" bullet. "queue.mjs set <ticket> merged --sha" does
      this itself, so this is only for a merge the queue never saw; it never records one twice.
  audit <ticket> clean|findings "<text>" [--team t] [--horde h]
      appends a dated "audit: <ticket> <verdict> — <text>" bullet.
  close [--gate green|red] [--sha <sha>] [--evidence E5[,E6]] [--team t] [--horde h]
      renders templates/wave-close.md — counts from the team's queue.json, cost from cost.json —
      and appends it. --gate with --sha records that gate for the team's level (trunk for the
      trunk team) in cache/last-gate.json — the branch tip the gate ran on, so status can show it.
      --evidence names catalogue rows the wave gate itself proves (a green gate on the trunk is
      the usual one); they are filled with "wave <n> gate on <sha>" — refused when the gate is red.
  evidence <id> --by "<who/what>" [--horde h]
      fills one catalogue row's "reproduced by" cell by hand — for a row no ticket verdict can
      fill, such as the mission gate; the director's call. A row in the charter's evidence catalogue counts green when its "reproduced
      by" cell is filled, or when a ticket merged this wave names the row's id in its own
      acceptance checklist and carries a "reproduced" verify verdict — in which case that
      verifier's name is written into the charter's cell (the one charter edit any tool here
      makes). The audit line shows the latest audit bullet for a ticket merged this wave, or
      "pending". Refuses when no wave is open.
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

function lastWaveNumber(text) {
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

function cmdStart(horde, positional, flags) {
  const path = journalPath(horde, flags.team);
  const text = readText(path);
  const n = positional[0] || String(lastWaveNumber(text) + 1);
  append(path, `\n# Wave ${n} — start ${today()}\n`);
  emit({ n }, flags, () => `wave started: ${n}`);
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

function cmdMerged(horde, positional, flags) {
  const [ticket, sha] = positional;
  if (!ticket || !sha) fail('merged requires <ticket> <sha>');
  const { appended } = noteMerged(horde, flags.team, ticket, sha);
  emit({ ticket, sha, appended }, flags, () => (appended
    ? `merged noted: ${ticket} ${sha}`
    : `merged already noted: ${ticket} ${sha} — the queue records it when the ticket is set merged`));
}

function cmdAudit(horde, positional, flags) {
  const [ticket, verdict, text] = positional;
  if (!ticket || !verdict || !text) fail('audit requires <ticket> clean|findings "<text>"');
  if (verdict !== 'clean' && verdict !== 'findings') fail('verdict must be "clean" or "findings"');
  append(journalPath(horde, flags.team), `- ${today()} audit: ${ticket} ${verdict} — ${text}\n`);
  emit({ ticket, verdict, text }, flags, () => `audit noted: ${ticket} ${verdict}`);
}

function cmdCurrent(horde, positional, flags) {
  const n = currentWaveNumber(readText(journalPath(horde, flags.team)));
  emit({ current: n }, flags, () => n || 'none');
}

// Tickets named by "merged:" bullets within one wave's span (its start marker to the next
// start/close marker, or end of file).
function waveMergedTickets(journalText, waveStartN) {
  let inWave = false;
  const tickets = new Set();
  for (const line of journalText.split('\n')) {
    const sm = START_RE.exec(line);
    if (sm) { inWave = sm[1] === String(waveStartN); continue; }
    if (CLOSE_RE.test(line)) { inWave = false; continue; }
    if (!inWave) continue;
    const m = /^- \S+ merged: (\S+) /.exec(line);
    if (m) tickets.add(m[1]);
  }
  return tickets;
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

function mentionsEvidenceId(text, id) {
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

// The latest verify.mjs verdict block in a ticket's log.md (verdict.md's rendered heading, in
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

// The latest audit bullet in this wave's span, but only when it's for a ticket this wave
// actually merged — an audit left over from re-running `wave.mjs audit` on something else
// shouldn't stand in for this wave's own audit.
function lastAudit(journalText, waveStartN, mergedTickets) {
  let inWave = false;
  let found = null;
  for (const line of journalText.split('\n')) {
    const sm = START_RE.exec(line);
    if (sm) { inWave = sm[1] === String(waveStartN); continue; }
    if (CLOSE_RE.test(line)) { inWave = false; continue; }
    if (!inWave) continue;
    const m = /^- \S+ audit: (\S+) (clean|findings) — (.*)$/.exec(line);
    if (m && mergedTickets.has(m[1])) found = { ticket: m[1], verdict: m[2], text: m[3] };
  }
  return found;
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

  const mergedTickets = waveMergedTickets(journalText, n);
  const { total, green } = computeEvidence(horde, team, mergedTickets);
  const delta = green - previousGreen(journalText);

  const cost = readJSON(hordePath(horde, 'cost.json'), { runs: [] });
  const costRuns = Array.isArray(cost.runs) ? cost.runs : [];
  const weights = (readConfig() || {}).classes || {};
  // cost.json's runs each carry their own wave number (roster.mjs's job to stamp), so a wave's
  // cost is a direct filter — no need to cross-reference which tickets this wave merged.
  const waveRuns = costRuns.filter((r) => String(r.wave) === String(n));
  const waveSums = sumEntries(waveRuns, weights);
  const missionSums = sumEntries(costRuns, weights);
  const limit = readCostLimit(horde);

  const audit = lastAudit(journalText, n, mergedTickets);

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
    runs: waveSums.runs,
    weighted: waveSums.weighted,
    cumulative: missionSums.weighted,
    'of limit': limit === null ? '' : ` of ${limit}`,
    auditTicket: audit ? audit.ticket : 'pending',
    clean: audit ? audit.verdict : 'pending',
  };

  let rendered;
  try {
    rendered = renderTemplate('wave-close', vars);
  } catch (e) {
    fail(e.message);
  }
  append(path, `\n${rendered}`);
  emit({ n, merged, escalated, open, gate, green, total, delta }, flags, () => `wave ${n} closed — gate ${gate}, ${green}/${total} evidence green`);
}

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
    case 'audit': return cmdAudit(horde, positional, flags);
    case 'close': return cmdClose(horde, positional, flags);
    case 'evidence': return cmdEvidence(horde, positional, flags);
    case 'current': return cmdCurrent(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
