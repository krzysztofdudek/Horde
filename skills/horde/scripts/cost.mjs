#!/usr/bin/env node
// horde skill — cost.mjs
//
// Runs × class, read-only from this tool's side: `cost.json` is written exclusively by
// `roster.mjs spawn`, one entry per spawned agent — `report` and `limit-reached` only sum it.
// A missing file means zero runs, not an error (nothing has spawned yet is a normal state, not
// a broken one). The charter's own "Limit:" line is the only place a cost limit is recorded —
// this tool reads it as plain text, deliberately: charter.md has no JSON twin to read instead.
//
// State: hordes/<horde>/cost.json — `{ runs: [{name, role, class, ticket|null, team|null, wave,
// at}] }`, no rendered sibling (it's a ledger, not a document meant to be read as prose).

import {
  hordePath, readJSON, readText, readConfig, fail, parseArgs, emit, isMain, resolveHorde, git,
} from './_lib.mjs';

const USAGE = `usage: cost.mjs <command> [options]

commands:
  report [--wave n] [--ticket NNN] [--mission] [--horde h]
      runs and weighted sums, filtered to one wave or one ticket, or the whole mission
      (--mission, also the default with no filter) — against the charter's limit when it has one.
  limit-reached [--horde h]
      exits 0 when the mission's weighted cost has reached the charter's limit, 1 otherwise
      (including when no limit is set). Meant for a steward to check before dispatching.

options: --json  --help`;

function costPath(horde) { return hordePath(horde, 'cost.json'); }

function load(horde) {
  const doc = readJSON(costPath(horde), null);
  return doc && Array.isArray(doc.runs) ? doc : { runs: [] };
}

function classWeights() {
  const cfg = readConfig();
  return (cfg && cfg.classes) || {};
}

// The charter's own "Limit: <value>" line (the "runs-weighted" unit is optional: a bare number
// is the same limit) — `null` for "none" or an unparsable value, a number otherwise. Exported so wave.mjs (which needs the same figure at wave close)
// isn't forced to shell out to this file or create a circular import between the two.
export function readCostLimit(horde) {
  const text = readText(hordePath(horde, 'charter.md'));
  if (!text) return null;
  const m = /^Limit:\s*(none|\d+(?:\.\d+)?)\b/im.exec(text);
  if (!m) return null;
  const raw = m[1].trim();
  if (/^none$/i.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// sum(runs, weights) — {runs, weighted}: each entry is one run, weighted by its class. Exported
// for wave.mjs's own wave-close computation.
// Reviewer calls are a cost the roster never sees: `yg check --approve` run by a landing worker
// bills a model once per prose pair. Yggdrasil appends one line per call to its committed
// `.yggdrasil/yg-events.llm.jsonl`, so the calls a mission caused are the lines that file gained
// between the mission's base and its trunk tip — counted from git, never from the file on disk,
// so a stale checkout cannot under-report. Only whole-mission: an event names a pair, not a ticket.
export function reviewerCalls(horde) {
  const cfg = readConfig() || {};
  const base = cfg.base;
  const trunk = `${horde}/trunk`;
  if (!base) return { calls: 0, why: 'no base branch in config' };
  const out = git(['diff', '--unified=0', `${base}...${trunk}`, '--', '.yggdrasil/yg-events.llm.jsonl']);
  if (out === null) return { calls: 0, why: `cannot diff ${base}...${trunk}` };
  let calls = 0;
  for (const line of out.split('\n')) {
    if (!line.startsWith('+{')) continue;
    try {
      const e = JSON.parse(line.slice(1));
      if (e.source === 'fill' && e.kind === 'llm') calls += 1;
    } catch { /* a diff line that is not an event */ }
  }
  return { calls, why: null };
}
export function sumEntries(runs, weights) {
  let weighted = 0;
  for (const r of runs) weighted += weights[r.class] ?? 1;
  return { runs: runs.length, weighted };
}

function cmdReport(horde, positional, flags) {
  const doc = load(horde);
  let runs = doc.runs;
  let scope = 'mission';
  if (flags.wave !== undefined) {
    runs = runs.filter((r) => String(r.wave) === String(flags.wave));
    scope = `wave ${flags.wave}`;
  } else if (flags.ticket !== undefined) {
    runs = runs.filter((r) => r.ticket !== null && r.ticket !== undefined && String(r.ticket) === String(flags.ticket));
    scope = `ticket ${flags.ticket}`;
  }
  const weights = classWeights();
  const { runs: runCount, weighted } = sumEntries(runs, weights);
  const limit = readCostLimit(horde);
  const reviewers = scope === 'mission' ? reviewerCalls(horde) : { calls: null, why: 'reviewer calls are counted per mission, not per wave or ticket' };
  const result = {
    scope, runs: runCount, weighted, limit, reached: limit !== null && weighted >= limit,
    reviewerCalls: reviewers.calls, reviewerCallsNote: reviewers.why,
  };
  emit(result, flags, () => {
    const limitText = limit === null ? 'no limit' : `limit ${limit}${result.reached ? ' — REACHED' : ''}`;
    const reviewerText = reviewers.calls === null ? '' : ` · ${reviewers.calls} reviewer call(s)${reviewers.why ? ` (${reviewers.why})` : ''}`;
    return `${scope}: ${runCount} runs · weighted ${weighted}${reviewerText} · ${limitText}`;
  });
}

function cmdLimitReached(horde, positional, flags) {
  const limit = readCostLimit(horde);
  if (limit === null) {
    emit({ limit: null, reached: false }, flags, () => 'no limit set');
    process.exit(1);
  }
  const doc = load(horde);
  const weights = classWeights();
  const { weighted } = sumEntries(doc.runs, weights);
  const reached = weighted >= limit;
  emit({ limit, weighted, reached }, flags, () => (reached ? `limit reached: ${weighted}/${limit}` : `under limit: ${weighted}/${limit}`));
  process.exit(reached ? 0 : 1);
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'report': return cmdReport(horde, positional, flags);
    case 'limit-reached': return cmdLimitReached(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
