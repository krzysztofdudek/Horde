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
//   - how many finished pieces wait to be merged, and about how long that takes at the measured pace;
//   - what the work did to the mission's territory, measured before and after (Grain's `grain measure`,
//     grain-measure/1, from the commit the mission's trunk was cut at to the trunk's tip, scoped to the
//     components of the cut): its files, the links inside it and across its edge, the dependencies
//     between components the graph does not declare, and how often the mission's own commits reached
//     outside it against the territory's own commits just before. Measuring builds the model at two
//     commits, so it runs on a wave close, at `horde.mjs done` and when this command is run by hand;
//     a tick and a filed question carry the last measurement, saying when it was taken.
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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import {
  hordePath, hordeRoot, readJSON, writeJSON, readText, writeText, readConfig, parseArgs, emit, isMain,
  resolveHorde, runMain, nowIso, fail, asArray, git, resolveTree,
} from './_lib.mjs';
import { loadAsks } from './ask.mjs';
import { evidenceCoverage } from './wave.mjs';
import { landingLoad, readLandResult, formatDuration } from './land.mjs';
import { findTicket, allTeamPaths } from './tk.mjs';
import {
  grainJson, grainHome, GRAIN_MEASURE_SCHEMA,
} from './node.mjs';

export const USAGE = `usage: report.mjs [--out <path>] [--no-measure] [--horde h] [--json]

Writes the mission's plain-language report for the client — what waits on them, what has been
proven, what landed since the last report, what waits to be merged, and what the work did to the
mission's territory, before and after — to hordes/<horde>/report.md, and to --out (or
config.report.out) as well. Tick, a wave close and every filed question rewrite it on their own; run
this to write it now, or to write it somewhere else once.

The before-and-after reading is Grain's (grain measure, from the commit the mission's trunk was cut
at to its tip, over the components of the cut). It is taken on a wave close, at horde.mjs done, and by
this command unless --no-measure; a tick and a filed question carry the last one, with its date.

options: --out <path>  --no-measure  --horde h  --json  --help`;

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
// Every team's queue items, not only trunk's — a mission with nested teams (one started before
// 6.0.0) keeps work there too. Read straight off each team directory on disk, so a team the roster
// no longer names is still counted rather than refused.
function allItems(horde) {
  let teams = ['trunk'];
  try { teams = allTeamPaths(horde); } catch { teams = ['trunk']; }
  if (!teams.length) teams = ['trunk'];
  return teams.flatMap((team) => {
    const path = hordePath(horde, ...team.split('/').flatMap((seg) => ['teams', seg]), 'queue.json');
    const doc = readJSON(path, null);
    return asArray(doc && doc.items);
  });
}

export function buildReport(horde, { cfg = readConfig() || {}, measure = false } = {}) {
  const items = allItems(horde);
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
    measure: measureMission(horde, cfg, { fresh: measure }),
  };
}

// ---- before and after -------------------------------------------------------------------------

function measurePath(horde) { return hordePath(horde, 'measure.json'); }

// The components the mission's cut holds, in the order the cut names them.
function missionScope(horde) {
  const doc = readJSON(hordePath(horde, 'territories.json'), null);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const nodes = [];
  for (const t of Object.values(doc)) {
    for (const n of asArray(t && t.nodes)) if (n && !nodes.includes(String(n))) nodes.push(String(n));
  }
  return nodes;
}

function trunkTip(horde) {
  return git(['rev-parse', '--verify', '--quiet', `${horde}/trunk`], grainHome()) || null;
}

// The numbers one end carries, the ones the client reads.
function endOf(e) {
  if (!e) return null;
  return {
    sha: e.sha,
    files: e.files,
    importsInside: e.importsInside,
    importsOut: e.importsOut,
    importsIn: e.importsIn,
    purity: e.purity ?? null,
    undeclaredNodeDependencies: e.undeclaredNodeDependencies ?? null,
  };
}

export function summariseMeasure(doc, { from, to, scope, at = nowIso() }) {
  const range = doc.range || null;
  return {
    measured: true,
    at,
    from,
    to,
    scope,
    before: endOf(doc.from),
    after: endOf(doc.to),
    range: range ? {
      commits: range.scopeCommits,
      crossing: range.crossing,
      crossingShare: range.crossingShare ?? null,
      baseline: range.baseline ? {
        commits: range.baseline.scopeCommits, crossing: range.baseline.crossing, crossingShare: range.baseline.crossingShare ?? null,
      } : null,
    } : null,
    notes: asArray(doc.notes),
  };
}

// Grain keeps its store in `.grain/` of the tree it runs in and, the first time, writes a
// `.grain/.gitignore` that ignores only `cache/` — the rest of `.grain/` is the maintainer's to
// commit. In the mission's trunk tree nobody commits anything, so that one file would sit there
// untracked (`?? .grain/` in its status, an uncovered file to `yg check`). Where the trunk does not
// track `.grain/.gitignore` itself, one that ignores the whole store is written first, which Grain
// keeps (it writes its own only when there is none). A tracked one is the repository's, left as it is.
function quietGrainStore(tree) {
  if (git(['ls-files', '--', '.grain/.gitignore'], tree)) return;
  const gi = join(tree, '.grain', '.gitignore');
  if (existsSync(gi) && readText(gi) === '*\n') return;
  mkdirSync(dirname(gi), { recursive: true });
  writeFileSync(gi, '*\n');
}

// measureMission(horde, cfg, {fresh}) — the mission's before-and-after, or why there is none. With
// `fresh` it asks Grain when the last reading is not of this trunk tip and this scope; without, it
// hands back the last reading as it is. Never throws: a reading that could not be taken says why.
export function measureMission(horde, cfg, { fresh = false } = {}) {
  const last = readJSON(measurePath(horde), null);
  if (!fresh) return last;
  const start = readJSON(hordePath(horde, 'start.json'), null);
  const at = nowIso();
  const from = start && start.sha ? String(start.sha) : null;
  const scope = missionScope(horde);
  let result;
  if (!from) {
    result = { measured: false, at, why: 'the commit the mission started from was not recorded' };
  } else if (scope.length === 0) {
    result = { measured: false, at, why: 'the mission has no cut yet, so it has no territory to measure' };
  } else {
    const to = trunkTip(horde);
    if (!to) {
      result = { measured: false, at, why: 'the mission\'s trunk could not be read' };
    } else if (to === from) {
      result = { measured: false, at, from, to, scope, why: 'nothing has landed yet, so there is no after to measure' };
    } else if (last && last.measured && last.to === to && last.from === from && JSON.stringify(last.scope) === JSON.stringify(scope)) {
      return last;
    } else {
      // Run in the mission's trunk tree: the range is counted over the history Grain has indexed,
      // which is the history of the tree it runs in, and only the trunk's reaches the trunk's tip.
      // The components are read from the trunk's graph too, so one the mission added is in scope.
      // Grain's cache stays there between readings (a trunk resync, `reset --hard`, leaves ignored
      // files alone), and the trunk tree shows nothing for it (quietGrainStore).
      let tree;
      try {
        tree = resolveTree({ horde }).path;
        quietGrainStore(tree);
      } catch (e) {
        tree = null;
        result = { measured: false, at, from, to, scope, why: `the mission's trunk tree could not be read: ${e.message}` };
      }
      const res = tree ? grainJson(cfg, tree, [
        'measure', '--from', from, '--to', to, '--scope', scope.join(','), '--json',
      ], GRAIN_MEASURE_SCHEMA) : null;
      if (res) {
        result = res.ok ? summariseMeasure(res.doc, { from, to, scope, at }) : {
          measured: false, at, from, to, scope, why: res.why,
        };
      }
    }
  }
  writeJSON(measurePath(horde), result);
  return result;
}


function pctOf(x) { return x === null || x === undefined ? 'none' : `${Math.round(x * 100)}%`; }
function arrow(a, b) { return `${a ?? '?'} → ${b ?? '?'}`; }

// The section, in plain words: no tool names, every share with its count.
function renderMeasure(m) {
  const lines = ['## What the work did to its part of the code', ''];
  if (!m) {
    lines.push('Not measured yet. It is measured when a wave of work closes.');
    return lines;
  }
  if (!m.measured) {
    lines.push(`Not measured: ${m.why}.`);
    return lines;
  }
  const b = m.before;
  const a = m.after;
  lines.push(
    `Measured ${m.at} over the parts this mission works in, from where it started to where it stands now.`,
    '',
    `- Files: ${arrow(b.files, a.files)}.`,
    `- Links between these files: ${arrow(b.importsInside, a.importsInside)}; links from them to the rest of the code: ${arrow(b.importsOut, a.importsOut)}; links from the rest of the code into them: ${arrow(b.importsIn, a.importsIn)}.`,
    `- Share of those links that stay inside: ${arrow(pctOf(b.purity), pctOf(a.purity))}.`,
  );
  if (b.undeclaredNodeDependencies !== null || a.undeclaredNodeDependencies !== null) {
    lines.push(`- Dependencies between parts that the rules do not declare: ${arrow(b.undeclaredNodeDependencies, a.undeclaredNodeDependencies)}.`);
  }
  if (m.range) {
    const r = m.range;
    const base = r.baseline;
    lines.push(`- Changes this mission made here that also touched something outside: ${r.crossing} of ${r.commits} (${pctOf(r.crossingShare)})`
      + (base ? `; before the mission, ${base.crossing} of ${base.commits} (${pctOf(base.crossingShare)}).` : '.'));
  }
  return lines;
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
  lines.push('', ...renderMeasure(doc.measure));
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
export function writeReport(horde, { out = null, cfg = readConfig() || {}, measure = false } = {}) {
  const doc = buildReport(horde, { cfg, measure });
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
  return allItems(horde).filter((i) => i.state === 'merged').map((i) => i.ticket);
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
  const { flags } = parseArgs(process.argv.slice(2), { flags: ['no-measure'] });
  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (flags.out === true) fail('--out needs a path');
  const horde = resolveHorde(flags);
  const { paths, doc } = writeReport(horde, { out: flags.out || null, measure: !flags['no-measure'] });
  emit({ ...doc, paths }, flags, () => `report written: ${paths.join(', ')}`);
}

if (isMain(import.meta.url)) runMain(main);
