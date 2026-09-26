#!/usr/bin/env node
// horde skill — report.mjs
//
// The mission as the client sees it, outside the director's chat. One page of plain language — the
// same rule as the frame: no tool names, no command lines, no branch names — that answers the two
// questions a client who never opens the terminal asks: what is waiting on me, and what has been
// proven. It is rewritten, never appended to: by every tick, by every wave close, and whenever a
// question is filed, so the file on disk is always the mission as the last of those left it.
//
// What it holds, per horde:
//   - the questions waiting on the client, each in its own words, with when it was asked;
//   - every row of the charter's evidence catalogue with its state, in the client's words: not
//     started, planned, being worked on, tried as a prototype, landed (not yet proven), proven —
//     and "came back" for a row whose landed work was reverted or reopened;
//   - what landed since the last report was written, and how much has landed in all;
//   - how many finished pieces wait to be merged, and about how long that takes at the measured pace.
//
// Where: `hordes/<horde>/report.md` always, and also `config.report.out` when set (a path with
// `<horde>` in it names one file per horde; a relative path is from the repository root) — a place
// the client can open or a loop can pick up. `hordes/<horde>/report.json` keeps only which tickets
// the last report had already counted as landed, so "since the last report" means exactly that.
//
// A report that cannot be written is never a reason for the caller to stop: tick, a wave close and
// a filed question all go on, and the failure is theirs to print. Nothing here decides anything.
//
// The hook point beside it is `config.notify` (see notifyClient in _lib.mjs): a command run when a
// question is filed and when a wave closes, for whatever outer loop reaches the client.

import { join, isAbsolute, dirname } from 'node:path';
import {
  hordePath, hordeRoot, readJSON, writeJSON, readText, writeText, readConfig, parseArgs, emit, isMain,
  resolveHorde, runMain, nowIso, fail, asArray,
} from './_lib.mjs';
import { loadAsks } from './ask.mjs';
import { evidenceCoverage } from './wave.mjs';
import { landingLoad, readLandResult, formatDuration } from './land.mjs';
import { findTicket } from './tk.mjs';
import { loadQueue } from './queue.mjs';

const USAGE = `usage: report.mjs [--out <path>] [--horde h] [--json]

Writes the mission's plain-language report for the client — what waits on them, what has been
proven, what landed since the last report, what waits to be merged — to hordes/<horde>/report.md,
and to --out (or config.report.out) as well. Tick, a wave close and every filed question rewrite it
on their own; run this to write it now, or to write it somewhere else once.

options: --out <path>  --horde h  --json  --help`;

// The client's words for each state an evidence row can be in (wave.mjs evidenceCoverage).
const ROW_STATE = {
  'no-ticket': 'not started',
  prototyping: 'being tried out as a prototype',
  queued: 'planned',
  running: 'being worked on',
  merged: 'landed, not yet proven',
  reproduced: 'proven',
};

// The client's words for each kind of question (ask.mjs KINDS).
const ASK_KIND = {
  stop: 'the work cannot go on without your decision',
  stuck: 'a piece of work is stuck and needs your call',
  lower: 'permission to relax a safeguard',
  charter: 'a change to what the mission promises',
};

function ticketTitle(horde, id) {
  try {
    const t = findTicket(horde, id);
    const m = t && /^#\s+\S+\s+·\s+(.+)$/m.exec(t.text);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function missionTitle(horde) {
  const charter = readText(hordePath(horde, 'charter.md')) || '';
  const m = /^#\s+Mission\s+·\s+(.+)$/m.exec(charter);
  return m ? m[1].trim() : horde;
}

// Every ticket whose landed work came back: a revert or a reopening recorded on its landing result.
function cameBack(horde, items) {
  const out = new Map();
  for (const it of items) {
    const res = readLandResult(horde, it.ticket);
    for (const f of asArray(res && res.fates)) {
      if (f && (f.fate === 'reverted' || f.fate === 'reopened')) out.set(it.ticket, f.fate);
    }
  }
  return out;
}

// buildReport(horde) — the report as data. Read-only.
export function buildReport(horde) {
  const items = asArray(loadQueue(horde, 'trunk').items);
  const asks = asArray(loadAsks(horde).items).filter((a) => a && a.state === 'open');
  let rows = [];
  try { rows = evidenceCoverage(horde); } catch { rows = []; }
  const back = cameBack(horde, items.filter((i) => i.state === 'merged'));
  const merged = items.filter((i) => i.state === 'merged').map((i) => i.ticket);
  const previous = readJSON(hordePath(horde, 'report.json'), null);
  const seen = new Set(asArray(previous && previous.merged));
  const landedSince = merged.filter((t) => !seen.has(t));
  const load = landingLoad(horde, items);
  return {
    schema: 'horde-report/1',
    horde,
    title: missionTitle(horde),
    at: nowIso(),
    waiting: asks.map((a) => ({
      id: a.id, kind: a.kind, question: a.why, at: a.at, ...(a.ticket ? { ticket: a.ticket } : {}),
    })),
    evidence: rows.map((r) => ({
      id: r.id,
      behaviour: r.evidence || null,
      state: r.ticket && back.has(r.ticket) ? 'came-back' : r.state,
      ...(r.ticket && back.has(r.ticket) ? { cameBack: back.get(r.ticket) } : {}),
    })),
    landed: { total: merged.length, sinceLastReport: landedSince.map((t) => ({ ticket: t, title: ticketTitle(horde, t) })) },
    inWork: items.filter((i) => i.state === 'running').length,
    waitingToMerge: { count: load.ready, forecastMs: load.measured ? load.forecastMs : null },
    previousAt: (previous && previous.at) || null,
  };
}

// renderReport(doc) — one page, plain language, no tool names.
export function renderReport(doc) {
  const lines = [`# ${doc.title} — where the mission stands`, '', `As of ${doc.at}.`, ''];
  lines.push('## Waiting on you', '');
  if (!doc.waiting.length) lines.push('Nothing. No question is open.');
  for (const a of doc.waiting) {
    lines.push(`- **Question ${a.id}** (asked ${a.at}; ${ASK_KIND[a.kind] || a.kind}): ${a.question}`);
  }
  lines.push('', '## What has been proven', '');
  if (!doc.evidence.length) lines.push('The mission card lists nothing to prove yet.');
  const proven = doc.evidence.filter((r) => r.state === 'reproduced').length;
  if (doc.evidence.length) lines.push(`${proven} of ${doc.evidence.length} proven.`, '');
  for (const r of doc.evidence) {
    const state = r.state === 'came-back'
      ? `came back — the work that landed for it was ${r.cameBack === 'reverted' ? 'undone' : 'reopened'}`
      : (ROW_STATE[r.state] || r.state);
    lines.push(`- ${r.behaviour || r.id} — **${state}**`);
  }
  lines.push('', '## Landed since the last report', '');
  if (!doc.landed.sinceLastReport.length) lines.push(doc.previousAt ? `Nothing new since ${doc.previousAt}.` : 'Nothing yet.');
  for (const l of doc.landed.sinceLastReport) lines.push(`- ${l.title || `piece ${l.ticket}`}`);
  lines.push('', `${doc.landed.total} piece(s) of work landed in all.`);
  lines.push('', '## Still moving', '');
  lines.push(`${doc.inWork} piece(s) of work in progress.`);
  const wait = doc.waitingToMerge;
  lines.push(wait.count
    ? `${wait.count} finished piece(s) waiting to be merged${wait.forecastMs ? `, about ${formatDuration(wait.forecastMs)} at the pace measured so far` : ''}.`
    : 'Nothing finished is waiting to be merged.');
  lines.push('');
  return lines.join('\n');
}

// Where config.report.out puts this horde's copy, or null.
function configuredOut(cfg, horde) {
  const out = cfg && cfg.report && cfg.report.out;
  if (!out || typeof out !== 'string') return null;
  const path = out.replace(/<horde>/g, horde);
  return isAbsolute(path) ? path : join(dirname(hordeRoot()), path);
}

// writeReport(horde, {out}) — builds, renders and writes it; returns {paths, doc}. Throws on a write
// that fails; refreshReport below is the caller-safe form.
export function writeReport(horde, { out = null, cfg = readConfig() || {} } = {}) {
  const doc = buildReport(horde);
  const text = renderReport(doc);
  const paths = [hordePath(horde, 'report.md')];
  const configured = configuredOut(cfg, horde);
  if (configured) paths.push(configured);
  if (out) paths.push(isAbsolute(out) ? out : join(process.cwd(), out));
  for (const p of [...new Set(paths)]) writeText(p, text);
  writeJSON(hordePath(horde, 'report.json'), {
    at: doc.at, merged: [...new Set([...doc.landed.sinceLastReport.map((l) => l.ticket), ...readMerged(horde)])],
  });
  return { paths: [...new Set(paths)], doc };
}

function readMerged(horde) {
  return asArray(loadQueue(horde, 'trunk').items).filter((i) => i.state === 'merged').map((i) => i.ticket);
}

// The form tick, a wave close and a filed question call: never throws, and says what went wrong.
export function refreshReport(horde, opts = {}) {
  try {
    return { ok: true, ...writeReport(horde, opts) };
  } catch (e) {
    return { ok: false, note: `the client report could not be written: ${e && e.message ? e.message : e}` };
  }
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (flags.out === true) fail('--out needs a path');
  const horde = resolveHorde(flags);
  const { paths, doc } = writeReport(horde, { out: flags.out || null });
  emit({ ...doc, paths }, flags, () => `report written: ${paths.join(', ')}`);
}

if (isMain(import.meta.url)) runMain(main);
