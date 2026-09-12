#!/usr/bin/env node
// horde skill — retro.mjs
//
// The last run of a mission, and the only one that reads what nobody read twice. A mission leaves
// two kinds of writing behind: what the landing gate refused, with the note each refusal wrote,
// and the remarks workers left in their tickets' own logs. Both are read once, by whoever was
// there, and then they go where logs go. This reads all of it at the end and sorts every piece
// into exactly one of three piles.
//
//   rule            the law could have said this, so a rule proposal is written here and now —
//                   its text, the component it attaches to, whether a script can decide it, and
//                   the line of log or refusal that is its evidence. This is legislation done
//                   once over the whole mission rather than once per wave.
//   taste           naming, ordering, a comment, an optimisation nobody measured. The review
//                   discipline sends a Minor to the ticket's log and nowhere else; this is the
//                   same move one level up — it goes to the COMPONENT's log, through
//                   `yg log add`, and nowhere else.
//   inexpressible   the law will not say this. It stays on a list the client reads, beside the
//                   law document the mission close writes, so the two answer the same question
//                   from both sides: what the law gained, and what it still cannot say.
//
// Two runs, the way `refine --step cut` works. The first run gathers the input and says to spawn
// the retrospective one-shot (`brief.mjs retro`); that one-shot writes its classification to
// `retro-classes.json`; the second run validates that file against the same input and writes the
// document. The script never writes prose of its own for a client, here or anywhere: it hands
// back the ticket, the source and the words that were actually written, and the session under
// Ratatoskr says what any of it means to whoever is paying for the work.
//
// The judge measurement is a measurement and never a gate. At a configured rate
// (`config.retro.judgeSampleRate`, 0 by default, so nothing is re-judged until somebody asks for
// it) a sample of landed tickets has its prose pairs re-packaged and put to a second judge, and
// the disagreement between the two comes back with a Wilson interval at that sample size.
// Nothing is refused over it.

import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  hordePath, readJSON, writeJSON, nowIso, fail, parseArgs, emit, isMain,
  resolveHorde, resolveTree, readConfig, asArray,
} from './_lib.mjs';
import { ygCommand, ygJson } from './node.mjs';
import { sumEntries, readCostLimit, reviewerCalls } from './cost.mjs';

export const RETRO_SCHEMA = 'horde-retro/1';
export const CLASSES = ['rule', 'taste', 'inexpressible'];
export const RULE_KINDS = ['check', 'prose'];

const USAGE = `usage: retro.mjs [--horde h] [--tree p] [--json]

The mission's retrospective, in two runs.

  1. With no ${classesFileName()} on file, this gathers what the mission wrote and nobody read
     twice — every gate refusal from .horde/hordes/<h>/land/<ticket>.json, and every remark in a
     ticket's log.md that is not a state entry — and prints the one-shot to spawn over it:
     brief.mjs retro --name <n>. Nothing is written to the document.
  2. Once that one-shot has written ${classesFileName()}, this validates it against the same
     input and writes .horde/hordes/<h>/retro.json (with retro.md beside it): the rule proposals,
     the items the law will not express, the mission's cost, and the judge measurement.

A "taste" item leaves one line in its component's own log through \`yg log add\` and goes nowhere
else. An item already logged by an earlier run is never logged twice.

options: --json  --help`;

// ---- where things live ------------------------------------------------------------------

export function retroPath(horde) { return hordePath(horde, 'retro.json'); }
export function classesPath(horde) { return hordePath(horde, 'retro-classes.json'); }
function classesFileName() { return 'retro-classes.json'; }
function lockPath(horde) { return hordePath(horde, 'retro.lock'); }

// ---- the interval a disagreement is reported at -------------------------------------------
//
// The Wilson score interval for k disagreements in n samples at 95% — the standard small-sample
// interval for a proportion, chosen over the textbook normal one because it stays inside [0, 1]
// and stays honest at k = 0, which is the case a horde whose two judges agree is in most of the
// time. The arithmetic below is unchanged, to the bit, from where it used to live: a measurement
// that moved file and changed its answer would not be the same measurement.
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

// ---- reading what the mission wrote ---------------------------------------------------------

// Every team directory the horde has. Its own copy rather than an import: this tool needs the
// issue directories and nothing else about a team, and two tools that are refused for merge
// independently of one another should not be coupled over ten lines.
function walkTeams(horde, visit, teamDir = hordePath(horde, 'teams'), teamName = null) {
  if (!existsSync(teamDir)) return;
  for (const d of readdirSync(teamDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const full = join(teamDir, d.name);
    if (teamName !== null) visit(`${teamName}/${d.name}`, full);
    else visit(d.name, full);
    walkTeams(horde, visit, join(full, 'teams'), d.name);
  }
}

// The line `transitionStatus` writes, and the whole of what tells a state entry apart from a
// remark: `- <iso> status: <state>…`. Everything else in a ticket's log was written by
// `appendLog`, which prepends the stamp and nothing more. The distinction is the SHAPE of the
// line, never its words — a remark that happens to talk about a status is still a remark.
const STATUS_LINE = /^-\s+\S+\s+status:\s/;

// collectRetroInput(horde) — {tickets, items, notes, landed}. Every gate refusal and every
// remark, in ticket order, each with a key stable across runs so a classification written against
// one gathering still lines up with the next. A ticket that cannot be read is a note on the
// document, never a stop: a retrospective that refuses to run is a retrospective nobody has.
export function collectRetroInput(horde) {
  const tickets = [];
  walkTeams(horde, (teamName, teamDir) => {
    const issuesDir = join(teamDir, 'issues');
    if (!existsSync(issuesDir)) return;
    for (const e of readdirSync(issuesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      tickets.push({
        id: e.name.split('-')[0],
        team: teamName,
        dir: join(issuesDir, e.name),
        logPath: join(issuesDir, e.name, 'log.md'),
      });
    }
  });
  tickets.sort((a, b) => a.id.localeCompare(b.id));

  const items = [];
  const notes = [];
  const landed = [];

  for (const t of tickets) {
    const resultFile = hordePath(horde, 'land', `${t.id}.json`);
    if (existsSync(resultFile)) {
      let doc = null;
      try { doc = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { doc = null; }
      if (!doc || typeof doc !== 'object') {
        notes.push(`ticket ${t.id}: ${resultFile} would not parse, so what the gate refused on it was not read. Nothing else on this document was affected.`);
      } else {
        if (doc.landed && doc.landed.sha) landed.push({ ticket: t.id, sha: String(doc.landed.sha) });
        asArray(doc.checks).forEach((c, i) => {
          if (!c || c.ok) return;
          items.push({
            key: `gate:${t.id}:${i}`,
            source: 'gate',
            ticket: t.id,
            text: `${c.name} — ${c.note || '(the check left no note)'}`,
          });
        });
      }
    }

    if (!existsSync(t.logPath)) {
      notes.push(`ticket ${t.id}: its directory exists and ${t.logPath} does not, so none of its own remarks were read.`);
      continue;
    }
    const log = readFileSync(t.logPath, 'utf8');
    log.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (!line.startsWith('- ')) return;
      if (STATUS_LINE.test(line)) return;
      items.push({
        key: `log:${t.id}:${i}`,
        source: 'log',
        ticket: t.id,
        text: line.replace(/^-\s+/, ''),
      });
    });
  }

  return { tickets, items, notes, landed };
}

// What the mission had landed when a retrospective ran, as one string. `done` recomputes it and
// refuses a retrospective taken before the last thing landed: one that never saw a ticket has
// nothing to say about it.
export function missionState(landed) {
  return asArray(landed).map((l) => `${l.ticket}@${l.sha}`).sort().join(' ');
}

// ---- the classification the one-shot writes ---------------------------------------------------

// The file is the one-shot's whole answer, so every refusal below names the key it is about and
// what that key was supposed to carry. A classification that covers some of the items is not a
// smaller answer than one that covers all of them; it is an answer to a different question, and
// the document would silently drop whatever it missed.
function readClasses(horde, items) {
  const path = classesPath(horde);
  if (!existsSync(path)) return null;
  let doc = null;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch {
    fail(`${path} will not parse — the retrospective one-shot writes it as {"items": {"<key>": {"class": "…", …}}}; rewrite it, or delete it and run this again to get the input and the spawn back`);
  }
  const byKey = doc && typeof doc === 'object' && doc.items && typeof doc.items === 'object' ? doc.items : null;
  if (!byKey) fail(`${path} is not {"items": {"<key>": {…}}} — that is the shape the retrospective one-shot writes`);

  const missing = items.filter((it) => !byKey[it.key]).map((it) => it.key);
  if (missing.length) {
    fail(`${path} classifies ${Object.keys(byKey).length} of ${items.length} item(s) — ${missing.length} unclassified: ${missing.join(', ')}. `
      + 'Every refusal and every remark gets exactly one class; an item left out is an item the document would drop without saying so.');
  }
  const unknown = Object.keys(byKey).filter((k) => !items.some((it) => it.key === k));
  if (unknown.length) {
    fail(`${path} classifies key(s) this mission has no item for: ${unknown.join(', ')}. The keys come from the input this command printed; a key that is not in it was guessed.`);
  }

  return items.map((it) => {
    const given = byKey[it.key] || {};
    const cls = String(given.class || '');
    if (!CLASSES.includes(cls)) {
      fail(`${path}: item ${it.key} has class "${given.class === undefined ? '(none)' : given.class}" — one of: ${CLASSES.join(', ')}`);
    }
    if (cls === 'rule') {
      const rule = String(given.rule || '').trim();
      if (!rule) fail(`${path}: item ${it.key} is class "rule" and says no rule — one sentence about what this repository must do or must never do. If it cannot be written as one sentence, it is not one rule and the item is "inexpressible".`);
      if (!given.node) fail(`${path}: item ${it.key} is class "rule" and names no component to attach the rule to`);
      const kind = String(given.kind || '');
      if (!RULE_KINDS.includes(kind)) {
        fail(`${path}: item ${it.key} is class "rule" and says kind "${given.kind === undefined ? '(none)' : given.kind}" — "check" if a check.mjs can decide it (free, every worktree, no reader) or "prose" if none can`);
      }
      return {
        ...it,
        class: cls,
        node: String(given.node),
        proposal: {
          rule,
          node: String(given.node),
          kind,
          evidence: String(given.evidence || it.text),
        },
      };
    }
    if (given.rule) fail(`${path}: item ${it.key} is class "${cls}" and carries a rule — only a "rule" item proposes one`);
    if (cls === 'taste') {
      if (!given.node) fail(`${path}: item ${it.key} is class "taste" and names no component — taste goes to that component's own log through \`yg log add\`, so there is nowhere to put it without one`);
      return {
        ...it, class: cls, node: String(given.node), proposal: null,
      };
    }
    if (given.node) fail(`${path}: item ${it.key} is class "inexpressible" and names a component — the law says nothing about it, so there is nothing to attach anywhere`);
    return {
      ...it, class: cls, node: null, proposal: null,
    };
  });
}

// ---- taste goes to the component's log, once -------------------------------------------------

// `yg log add --node <p> --reason "<the words that were written>"`, run for real, best effort:
// a component whose graph object does not exist has nothing to append to, and a retrospective
// that stopped over one missing node would lose the whole document over the smallest of its three
// piles. Keys already on the previous document are skipped, so two runs — or two processes that
// took the lock in turn — never leave the same line twice.
function logTaste(root, cfg, items, alreadyLogged) {
  const yg = ygCommand(cfg);
  const logged = [];
  const missed = [];
  for (const it of items) {
    if (alreadyLogged.has(it.key)) continue;
    try {
      execFileSync(yg.cmd, [...yg.prefix, 'log', 'add', '--node', it.node, '--reason', it.text], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      });
      logged.push(it.key);
    } catch {
      missed.push({ key: it.key, node: it.node });
    }
  }
  return { logged, missed };
}

// ---- the judge measurement --------------------------------------------------------------------

function sampleRate(cfg) {
  const raw = Number(cfg && cfg.retro && cfg.retro.judgeSampleRate);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw);
}

// A verdict's unit belongs to a ticket when the ticket declared that component or that file. The
// declarations are the ticket's own, read from its issue.md the way every other tool reads them.
function ticketDeclares(dir, unit) {
  const text = (() => {
    try { return readFileSync(join(dir, 'issue.md'), 'utf8'); } catch { return ''; }
  })();
  return text.includes(unit);
}

// Which landed tickets are re-judged, and what came back. Nothing here refuses: every way this can
// fail to answer — no rate, nothing landed, a CLI that will not package a pair — is a reason
// recorded on the document beside the numbers it could take.
function measureJudge(horde, root, cfg, tickets, landed) {
  const rate = sampleRate(cfg);
  const tier = (cfg && cfg.retro && cfg.retro.judgeTier) || null;
  if (rate === 0) {
    return {
      sampled: 0, tickets: [], pairs: [], disagreements: 0, interval: null, tier, skipped: [], pending: [],
      note: 'config.retro.judgeSampleRate is 0 — nothing was put to a second judge. Set a fraction between 0 and 1 to measure how far two judges agree on this repository.',
    };
  }
  if (landed.length === 0) {
    return {
      sampled: 0, tickets: [], pairs: [], disagreements: 0, interval: null, tier, skipped: [], pending: [],
      note: 'nothing landed on this mission, so there is no judged work to put to a second judge.',
    };
  }

  const size = Math.min(landed.length, Math.max(1, Math.round(rate * landed.length)));
  // Sampled without replacement from the landed tickets alone, in the order they landed — the
  // sample is declared by size and by which tickets are in it, so it can be read back and argued
  // with rather than taken on the tool's word.
  const pool = [...landed];
  const picked = [];
  for (let i = 0; i < size; i += 1) {
    const at = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(at, 1)[0]);
  }

  const inventory = ygJson(root, cfg, ['verdict', 'read', '--json'], 'yg-verdicts/1');
  if (inventory.state !== 'ok') {
    return {
      sampled: size,
      tickets: picked.map((p) => p.ticket),
      pairs: [],
      disagreements: 0,
      interval: null,
      tier,
      skipped: [{ why: `\`${inventory.command}\` answered nothing this could read (${inventory.state})` }],
      pending: [],
      note: 'the sample was drawn and the verdicts already on file could not be read, so no pair was compared.',
    };
  }

  const verdicts = asArray(inventory.doc && inventory.doc.verdicts);
  const yg = ygCommand(cfg);
  const pairs = [];
  const skipped = [];
  const pending = [];
  let disagreements = 0;

  for (const p of picked) {
    const ticket = tickets.find((t) => t.id === p.ticket);
    const mine = verdicts.filter((v) => v && v.unit && ticket && ticketDeclares(ticket.dir, v.unit.path));
    if (mine.length === 0) {
      skipped.push({ ticket: p.ticket, why: 'no prose pair on this ticket\'s own files or components carries a recorded verdict' });
      continue;
    }
    for (const v of mine) {
      const unitFlag = v.unit.kind === 'node' ? '--node' : '--file';
      const args = ['verdict', 'package', '--aspect', v.aspect, unitFlag, v.unit.path];
      let packaged = true;
      let why = null;
      try {
        execFileSync(yg.cmd, [...yg.prefix, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        packaged = false;
        why = (e.stderr ? String(e.stderr) : e.message).trim().split('\n')[0];
      }
      if (!packaged) {
        skipped.push({
          ticket: p.ticket, aspect: v.aspect, unit: `${v.unit.kind}:${v.unit.path}`, why: `\`${yg.display} ${args.join(' ')}\` refused — ${why}`,
        });
        continue;
      }
      const second = tier
        ? verdicts.find((o) => o && o.judge === tier && o.aspect === v.aspect && o.unit && o.unit.path === v.unit.path && o.unit.kind === v.unit.kind)
        : null;
      if (!second || second.judge === v.judge) {
        pending.push({
          ticket: p.ticket,
          aspect: v.aspect,
          unit: `${v.unit.kind}:${v.unit.path}`,
          record: `${yg.display} verdict record --aspect ${v.aspect} ${unitFlag} ${v.unit.path} --by ${tier || '<the second judge>'} `
            + '--verdict pass|refused --hash <hashes.pass or hashes.refused from the package>',
        });
        continue;
      }
      const agrees = second.verdict === v.verdict;
      if (!agrees) disagreements += 1;
      pairs.push({
        ticket: p.ticket,
        aspect: v.aspect,
        unit: `${v.unit.kind}:${v.unit.path}`,
        held: v.verdict,
        second: second.verdict,
        agrees,
      });
    }
  }

  return {
    sampled: size,
    tickets: picked.map((p) => p.ticket),
    pairs,
    disagreements,
    interval: wilson(disagreements, pairs.length),
    tier,
    skipped,
    pending,
    note: pairs.length === 0
      ? 'the sample was drawn and no pair in it had a second judgement to compare against yet — the commands that take one are on `pending`.'
      : null,
  };
}

// ---- the mission's cost ---------------------------------------------------------------------

// The whole mission's cost, at mission scope, which is the only scope this document has: `--wave`
// and `--ticket` narrow that figure and neither applies at a close. The reviewer-call count is
// counted per mission by construction, so this is exactly the scope it answers for.
function measureCost(horde, cfg) {
  const doc = readJSON(hordePath(horde, 'cost.json'), null);
  const limit = readCostLimit(horde);
  const runs = doc && Array.isArray(doc.runs) ? doc.runs : null;
  if (runs === null) {
    return {
      scope: 'mission',
      runs: 0,
      weighted: 0,
      limit,
      reached: false,
      reviewerCalls: 0,
      reviewerCallsNote: 'no cost has ever been recorded for this mission — nothing has run against it, so every figure here is zero rather than unknown',
    };
  }
  const { runs: runCount, weighted } = sumEntries(runs, (cfg && cfg.classes) || {});
  const reviewers = reviewerCalls(horde);
  return {
    scope: 'mission',
    runs: runCount,
    weighted,
    limit,
    reached: limit !== null && weighted >= limit,
    reviewerCalls: reviewers.calls,
    reviewerCallsNote: reviewers.why,
  };
}

// ---- the bar this mission is held to ---------------------------------------------------------

// The share of everything the mission wrote down that the law turned out unable to express. The
// bar it is compared against is set before a mission runs, never after it, which is the whole
// point of printing the two side by side: a bar moved once the number is known measures nothing.
function measureThreshold(cfg, items, inexpressible) {
  const raw = cfg && cfg.retro && cfg.retro.inexpressibleThreshold;
  const threshold = Number.isFinite(Number(raw)) && raw !== null && raw !== undefined ? Number(raw) : null;
  const share = items.length ? inexpressible.length / items.length : 0;
  return {
    count: inexpressible.length,
    of: items.length,
    share,
    threshold,
    over: threshold === null ? null : share > threshold,
    note: threshold === null
      ? 'no bar is set for this repository — set one before the next mission starts, not after this number is known: horde.mjs config set retro.inexpressibleThreshold <fraction>'
      : null,
  };
}

// ---- one retrospective at a time ---------------------------------------------------------------
//
// Two of these running together would each write the document and each append the same taste line
// to the same component's log. The lock makes them consecutive; the previous document's own list
// of logged keys makes the second one append nothing.

const LOCK_WAIT_MS = 60000;
const LOCK_POLL_MS = 200;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireRetroLock(horde, waitMs = LOCK_WAIT_MS) {
  const path = lockPath(horde);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, horde, at: nowIso() }, null, 2)}\n`, { flag: 'wx' });
      return {
        release: () => {
          try {
            if (JSON.parse(readFileSync(path, 'utf8')).pid !== process.pid) return;
          } catch { /* unreadable: ours to clear either way */ }
          try { rmSync(path, { force: true }); } catch { /* already gone */ }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let held = null;
    try { held = JSON.parse(readFileSync(path, 'utf8')); } catch { held = null; }
    if (!held || !processAlive(held.pid)) {
      try { rmSync(path, { force: true }); } catch { /* someone else got there first */ }
      continue;
    }
    if (Date.now() >= deadline) {
      fail(`another retrospective holds ${path}: pid ${held.pid}, taken ${held.at || 'at an unrecorded time'}. One runs at a time — two would write the same line into the same component's log twice.`);
    }
    sleepSync(LOCK_POLL_MS);
  }
}

// ---- the document ------------------------------------------------------------------------------

function render(doc) {
  const lines = [`# Retrospective — ${doc.horde}`, '', `at: ${doc.at}`, ''];

  lines.push('## What the law could say', '');
  if (doc.law.length === 0) lines.push('(nothing — no refusal and no remark on this mission turned out to be a rule)');
  for (const p of doc.law) {
    lines.push(`- **${p.node}** · ${p.kind === 'check' ? 'a script can decide it' : 'a reader has to judge it'}`);
    lines.push(`  ${p.rule}`);
    lines.push(`  evidence: ${p.evidence}`);
  }
  lines.push('');

  lines.push('## What the law will not say', '');
  if (doc.inexpressible.length === 0) lines.push('(nothing — every item this mission wrote down fell into a rule or into taste)');
  for (const it of doc.inexpressible) lines.push(`- ticket ${it.ticket} · ${it.source} — ${it.text}`);
  lines.push('');
  lines.push(`${doc.threshold.count} of ${doc.threshold.of} item(s), a share of ${doc.threshold.share.toFixed(3)}`
    + `${doc.threshold.threshold === null ? '' : ` against a bar of ${doc.threshold.threshold}${doc.threshold.over ? ' — OVER' : ''}`}.`);
  if (doc.threshold.note) lines.push(doc.threshold.note);
  lines.push('');

  lines.push('## Taste', '');
  if (doc.taste.length === 0) lines.push('(nothing)');
  for (const it of doc.taste) lines.push(`- ticket ${it.ticket} · ${it.node} — ${it.text}`);
  lines.push('', `Written to ${doc.logged.length} component log(s) this run; nowhere else.`, '');

  lines.push('## Cost', '');
  lines.push(`${doc.cost.runs} run(s), weighted ${doc.cost.weighted}`
    + `${doc.cost.limit === null ? ', no limit set' : ` of a limit of ${doc.cost.limit}${doc.cost.reached ? ' — REACHED' : ''}`}`
    + `, ${doc.cost.reviewerCalls} reviewer call(s).`);
  if (doc.cost.reviewerCallsNote) lines.push(doc.cost.reviewerCallsNote);
  lines.push('');

  lines.push('## Two judges', '');
  if (doc.judge.note) lines.push(doc.judge.note);
  if (doc.judge.sampled) {
    lines.push(`sample ${doc.judge.sampled} ticket(s): ${doc.judge.tickets.join(', ')} — ${doc.judge.pairs.length} pair(s) compared, ${doc.judge.disagreements} disagreement(s)`
      + `${doc.judge.interval ? `, 95% interval [${doc.judge.interval.low.toFixed(3)}, ${doc.judge.interval.high.toFixed(3)}]` : ''}.`);
    for (const s of doc.judge.skipped) lines.push(`- skipped${s.ticket ? ` ticket ${s.ticket}` : ''}: ${s.why}`);
    for (const p of doc.judge.pending) lines.push(`- waiting on a second judgement: ${p.aspect} on ${p.unit} — ${p.record}`);
  }
  lines.push('', 'This is a measurement. Nothing was refused over it.', '');

  if (doc.notes.length) {
    lines.push('## What could not be read', '');
    for (const n of doc.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function cmdRetro(flags) {
  const horde = resolveHorde(flags);
  const cfg = readConfig() || {};
  const input = collectRetroInput(horde);

  // The gathering run reads .horde/ and nothing else, so it resolves no tree: a first run that
  // provisioned trunk's worktree would make "what did this mission write down" cost a checkout.
  if (!existsSync(classesPath(horde))) {
    emit({
      horde,
      state: 'input',
      items: input.items,
      notes: input.notes,
      classesPath: classesPath(horde),
      spawn: `brief.mjs retro --name <n> --horde ${horde}`,
    }, flags, () => [
      `${input.items.length} item(s) nobody read twice — ${input.items.filter((i) => i.source === 'gate').length} gate refusal(s), `
        + `${input.items.filter((i) => i.source === 'log').length} remark(s) across ${input.tickets.length} ticket(s).`,
      '',
      `Spawn ONE retrospective one-shot over all of it: brief.mjs retro --name <n> --horde ${horde}`,
      `It writes ${classesPath(horde)}; run this again once it has, and the document gets written.`,
      ...(input.notes.length ? ['', 'Could not be read:', ...input.notes.map((n) => `- ${n}`)] : []),
    ].join('\n'));
    return;
  }

  const classified = readClasses(horde, input.items);
  const info = resolveTree({ tree: flags.tree, horde });
  const lock = acquireRetroLock(horde);
  try {
    const previous = readJSON(retroPath(horde), null);
    const alreadyLogged = new Set(previous ? asArray(previous.logged) : []);

    const taste = classified.filter((it) => it.class === 'taste');
    const logging = logTaste(info.path, cfg, taste, alreadyLogged);
    const notes = [...input.notes];
    for (const m of logging.missed) {
      notes.push(`taste item ${m.key}: \`yg log add --node ${m.node}\` would not append — that component has no log to write to from this tree, and the item stands on this document instead.`);
    }

    const inexpressible = classified.filter((it) => it.class === 'inexpressible')
      .map((it) => ({ ticket: it.ticket, source: it.source, text: it.text }));

    const doc = {
      schema: RETRO_SCHEMA,
      horde,
      at: nowIso(),
      state: missionState(input.landed),
      items: classified.map((it) => ({
        key: it.key, source: it.source, ticket: it.ticket, text: it.text, class: it.class, node: it.node, proposal: it.proposal,
      })),
      law: classified.filter((it) => it.class === 'rule').map((it) => it.proposal),
      taste: taste.map((it) => ({ ticket: it.ticket, node: it.node, text: it.text })),
      inexpressible,
      logged: [...alreadyLogged, ...logging.logged],
      cost: measureCost(horde, cfg),
      judge: measureJudge(horde, info.path, cfg, input.tickets, input.landed),
      threshold: measureThreshold(cfg, classified, inexpressible),
      notes,
    };
    writeJSON(retroPath(horde), doc, { render });

    emit(doc, flags, () => [
      `${doc.law.length} rule proposal(s), ${doc.taste.length} taste item(s), ${doc.inexpressible.length} the law will not say `
        + `— ${doc.threshold.count} of ${doc.threshold.of}, a share of ${doc.threshold.share.toFixed(3)}`
        + `${doc.threshold.threshold === null ? '' : ` against a bar of ${doc.threshold.threshold}${doc.threshold.over ? ' — OVER' : ''}`}.`,
      ...(doc.threshold.note ? [doc.threshold.note] : []),
      `cost: ${doc.cost.runs} run(s), weighted ${doc.cost.weighted}, ${doc.cost.reviewerCalls} reviewer call(s).`,
      doc.judge.note || `two judges: ${doc.judge.pairs.length} pair(s), ${doc.judge.disagreements} disagreement(s).`,
      `${retroPath(horde)}`,
    ].join('\n'));
  } finally {
    lock.release();
  }
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); process.exit(0); }
  cmdRetro(flags);
}

if (isMain(import.meta.url)) main();
