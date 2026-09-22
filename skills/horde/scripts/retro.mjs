#!/usr/bin/env node
// horde skill — retro.mjs
//
// The last run of a mission, and the only one that reads what nobody read twice. A mission leaves
// three kinds of writing behind: what the landing gate refused, with the note each refusal wrote;
// what became of a ticket after it landed, where a merge was reverted or a ticket reopened; and the
// remarks workers left in their tickets' own logs. All three are read once, by whoever was there,
// and then they go where logs go. This reads all of it at the end and sorts every piece into
// exactly one of three piles.
//
// The returns are their own source and stay named as one, all the way to the document: a refusal is
// the law catching something before it landed, and a return is the evidence failing after everyone
// had agreed it was enough. Reading the second as more of the first would lose the only signal a
// mission gives about whether its own bar was high enough.
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
// the disagreement between the two comes back with a Wilson interval at that sample size. It
// takes two runs to say anything, because a graph holds one verdict per pair and recording the
// second judge's is what destroys the first: the first run writes the first judgement down here,
// the second run reads what replaced it and puts the two side by side. Nothing is refused over it.

import {
  existsSync, readdirSync, readFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  hordePath, readJSON, writeJSON, nowIso, fail, parseArgs, emit, isMain,
  resolveHorde, resolveTree, readConfig, asArray, parseLogEntries, noEvidenceLayerNote,
  createLockFile, processAlive, readLockText, removeStaleLock, sleepSync,
  runMain,
} from './_lib.mjs';
import {
  ygCommand, ygJson, ticketNodes, ticketBoundary, pathInBoundary,
} from './node.mjs';
import { ticketFiles } from './tk.mjs';

export const RETRO_SCHEMA = 'horde-retro/1';
export const CLASSES = ['rule', 'taste', 'inexpressible'];
export const RULE_KINDS = ['check', 'prose'];
// The sources that are a return — an item about what happened to a ticket AFTER it landed, as
// against a gate refusal ("gate") or a worker's remark ("log").
export const RETURN_SOURCES = new Set(['revert', 'reopen']);

const USAGE = `usage: retro.mjs [--horde h] [--tree p] [--json]

The mission's retrospective, in two runs.

  1. With no ${classesFileName()} on file, this gathers what the mission wrote and nobody read
     twice — every gate refusal and every return after landing (a merge reverted, a ticket
     reopened) from .horde/hordes/<h>/land/<ticket>.json, and every remark in a ticket's log.md
     that is not a state entry — and prints the one-shot to spawn over it:
     brief.mjs retro --name <n>. Nothing is written to the document.
  2. Once that one-shot has written ${classesFileName()}, this validates it against the same
     input and writes .horde/hordes/<h>/retro.json (with retro.md beside it): the rule proposals,
     what came back after landing, the items the law will not express, and the judge measurement.

The first run resolves no tree at all — it reads only .horde/. The second run's own graph reads
(the taste log and the judge measurement) run against the tree --tree names; without it, cwd, same
as an ordinary read anywhere else in this tool set, not this horde's trunk just because a horde was
resolvable. --horde h WRITTEN OUT (no --tree) is what changes that, exactly as queue.mjs
plan/quality, tick.mjs, land.mjs and horde.mjs done already read it.

A "taste" item leaves one line in its component's own log through \`yg log add\` and goes nowhere
else. An item already logged by an earlier run is never logged twice.

retro.mjs --second --aspect <id> --node <path>|--file <path> --by <name> --verdict pass|refused
  --hash <sha> [--report "<what is wrong and where>"] records a second judgement on a pair whose first
  was a pass still in force: the graph will not take a second verdict over it, so it is kept beside
  the first in this horde's own copy. The document prints this command for exactly those pairs.

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

// The two fates a landing can turn out to have had, as retro reads them. They are a source of
// their own, beside the gate's refusals and the workers' remarks, and deliberately not folded into
// either: a refusal is the law catching something BEFORE it landed, a remark is somebody's aside,
// and a return is the mission's own evidence failing AFTER everyone had agreed it was enough. That
// is the strongest thing a mission writes down about itself, and it was the one thing nothing read.
const FATE_SOURCES = {
  reverted: {
    source: 'revert',
    text: (by) => `reverted at ${by} — the merge this ticket landed was undone`,
  },
  reopened: {
    source: 'reopen',
    text: (by) => `reopened by ${by} — the evidence this ticket claimed went red again, and that ticket was filed to earn it back`,
  },
};

// collectRetroInput(horde) — {tickets, items, notes, landed}. Every gate refusal, every return
// after landing and every remark, in ticket order, each with a key stable across runs so a
// classification written against one gathering still lines up with the next. A ticket that cannot
// be read is a note on the document, never a stop: a retrospective that refuses to run is a
// retrospective nobody has.
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
        asArray(doc.fates).forEach((f, i) => {
          const kind = f && FATE_SOURCES[f.fate];
          if (!kind) return;
          items.push({
            key: `${kind.source}:${t.id}:${i}`,
            source: kind.source,
            ticket: t.id,
            text: kind.text(f.by || '(nothing was named)'),
          });
        });
      }
    }

    if (!existsSync(t.logPath)) {
      notes.push(`ticket ${t.id}: its directory exists and ${t.logPath} does not, so none of its own remarks were read.`);
      continue;
    }
    // Every remark on the ticket, and no state line: what `transitionStatus` writes is the
    // mission's own bookkeeping, not something a retrospective has anything to say about. The
    // distinction is the shape of the line, never its words — a remark that happens to talk
    // about a status is still a remark, which is why this asks the log's own parser.
    for (const entry of parseLogEntries(readFileSync(t.logPath, 'utf8'))) {
      if (entry.isStatus) continue;
      items.push({
        key: `log:${t.id}:${entry.index}`,
        source: 'log',
        ticket: t.id,
        text: entry.text,
      });
    }
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

// A seed derived deterministically from the mission's own state (`missionState`, the sorted
// "ticket@sha" list), so two runs against the same landed set draw the same sample — the sample
// can be read back and argued with, which a seed pulled from the clock or the process could never
// support. FNV-1a turns the state string into a 32-bit integer; mulberry32 turns that integer into
// a repeatable stream of [0, 1) draws with no dependency beyond the two numbers it starts from.
function seedFromState(state) {
  let h = 0x811c9dc5;
  for (let i = 0; i < state.length; i += 1) {
    h ^= state.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleRate(cfg) {
  const raw = Number(cfg && cfg.retro && cfg.retro.judgeSampleRate);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw);
}

// A verdict's unit belongs to a ticket when the ticket declared that component or that file. The
// declarations are the ticket's own, read from its issue.md the way every other tool reads them —
// the same two-step bound the merge checklist uses (land.mjs's checkScope): the declared **Files**
// win when there are any, else the **Node** field's own boundary, matched whole-path or
// whole-glob through pathInBoundary, never by substring. A ticket that declares `src/ab` must
// never also claim a verdict against `src/a`.
export function ticketDeclares(root, cfg, dir, unit) {
  const text = (() => {
    try { return readFileSync(join(dir, 'issue.md'), 'utf8'); } catch { return ''; }
  })();
  const declared = ticketFiles(text);
  const boundary = declared.length ? declared : ticketBoundary(root, cfg, ticketNodes(text));
  return boundary.length ? pathInBoundary(unit, boundary) : false;
}

// ---- two judgements, one slot ------------------------------------------------------------------
//
// A graph holds at most ONE verdict for an (aspect, unit) pair. Every write puts its entry in that
// slot and whatever was there is gone — a judge's `yg verdict record` and the reviewer's own fill
// alike — and `yg verdict read` narrows what comes back further still, to the entries a judge
// recorded by hand. So the two opinions this measurement is about can never be on disk together,
// and no single read can ever see both: recording the second judgement is the act that destroys
// the first. Asking one read for both is what this used to do, and it is why it could only ever
// find the one entry twice and report every pair as waiting, however many times the command it
// suggested was actually run.
//
// The measurement therefore takes two runs and keeps its own copy of the half that would be lost.
// The first run writes down what the slot holds — who judged, what they said, and the two hashes
// the package binds a pass and a refusal to — and hands the pair back with the command that puts
// it to the second judge. The second run, after somebody has run that command, reads the slot
// again: it now holds the second judge's answer, and the first judge's is on file here. That is
// the comparison, and it is the only way there is to reach it.
//
// What answers "are these two judgements about the same code?" is NOT the recorded entry's own
// hash. A verdict is bound to the hash of its inputs WITH THE VERDICT WORD FOLDED IN, so two
// judges who disagree about code that never moved necessarily record two different hashes, and
// reading that difference as "the code changed" would throw away every disagreement there is —
// the only rows this measurement exists to count. The pair of hashes `yg verdict package` prints
// does answer it: `pass` and `refused` come from the same rule, the same files, the same
// references and the same tier, and differ only in that last word. So the first run keeps both,
// and the second run asks whether the entry it now sees is bound to the hash that pair names for
// the verdict it carries. If it is, the two judges were looking at the same thing.
//
// One pair whose first judgement is superseded by its OWN judge over changed code stays on
// `pending` until a second judge reaches it, and is then a skip rather than a recount: the copy is
// never refreshed once taken. That is deliberate. A measurement that re-took its own baseline
// whenever the ground moved would answer differently on every run over the same mission, and a
// number nobody can reproduce is not evidence.
function judgeSamplesPath(horde) { return hordePath(horde, 'cache', 'judge-samples.json'); }

// One (aspect, unit) pair as one key — the shape a graph keys its own verdicts by.
function pairKey(aspect, unit) { return `${aspect} ${unit.kind}:${unit.path}`; }

// Why a `yg` call asked for one document did not answer with one, in a single line.
function ygWhy(res) {
  if (res.state === 'no-cli') return 'there is no Yggdrasil CLI on this repository to package it with';
  if (res.state === 'absent') return 'the graph no longer has that rule or that unit';
  if (res.state === 'stale') return res.saw;
  return String(res.detail === undefined || res.detail === null ? '' : res.detail).trim().split('\n')[0];
}

// Which landed tickets are re-judged, and what came back. Nothing here refuses: every way this can
// fail to answer — no rate, nothing landed, a CLI that will not package a pair — is a reason
// recorded on the document beside the numbers it could take.
function measureJudge(horde, root, cfg, tickets, landed) {
  const rate = sampleRate(cfg);
  const tier = (cfg && cfg.retro && cfg.retro.judgeTier) || null;
  const seed = seedFromState(missionState(landed));
  if (rate === 0) {
    return {
      sampled: 0, seed, tickets: [], pairs: [], disagreements: 0, interval: null, tier, skipped: [], pending: [], passInForce: [],
      note: 'config.retro.judgeSampleRate is 0 — nothing was put to a second judge. Set a fraction between 0 and 1 to measure how far two judges agree on this repository.',
    };
  }
  if (landed.length === 0) {
    return {
      sampled: 0, seed, tickets: [], pairs: [], disagreements: 0, interval: null, tier, skipped: [], pending: [], passInForce: [],
      note: 'nothing landed on this mission, so there is no judged work to put to a second judge.',
    };
  }

  const size = Math.min(landed.length, Math.max(1, Math.round(rate * landed.length)));
  // Sampled without replacement from the landed tickets alone, in the order they landed, drawn by
  // a seed derived from the mission's own state — the sample is declared by size, by which tickets
  // are in it, and by the seed that drew it, so it can be reproduced, read back and argued with
  // rather than taken on the tool's word.
  const draw = mulberry32(seed);
  const pool = [...landed];
  const picked = [];
  for (let i = 0; i < size; i += 1) {
    const at = Math.floor(draw() * pool.length);
    picked.push(pool.splice(at, 1)[0]);
  }

  const inventory = ygJson(root, cfg, ['verdict', 'read', '--json'], 'yg-verdicts/1');
  if (inventory.state !== 'ok') {
    return {
      sampled: size,
      seed,
      tickets: picked.map((p) => p.ticket),
      pairs: [],
      disagreements: 0,
      interval: null,
      tier,
      skipped: [{ why: `\`${inventory.command}\` answered nothing this could read (${inventory.state})` }],
      pending: [],
      passInForce: [],
      note: 'the sample was drawn and the verdicts already on file could not be read, so no pair was compared.',
    };
  }

  const verdicts = asArray(inventory.doc && inventory.doc.verdicts);
  const yg = ygCommand(cfg);
  const pairs = [];
  const skipped = [];
  const pending = [];
  // Pairs whose first judgement is a pass that still holds — structurally out of reach, never a
  // command that merely failed this once. See the `!held` branch below for why this is its own
  // list and never folded into `skipped`.
  const passInForce = [];
  let disagreements = 0;

  // What an earlier run wrote down. A file that will not parse is a note on the document and a
  // fresh start, never a stop: this is a copy of something a graph holds elsewhere, and a
  // retrospective that refuses to run is a retrospective nobody has. The retrospective's own lock
  // is held around all of this, so two runs never write it at once.
  const samplesFile = judgeSamplesPath(horde);
  let samples = {};
  try {
    samples = readJSON(samplesFile, {}) || {};
  } catch {
    samples = {};
    skipped.push({
      why: `${samplesFile} would not parse, so no first judgement an earlier run wrote down was read — every `
        + 'pair in this sample was written down again from scratch, and each is waiting on a second judgement again',
    });
  }
  let wrote = false;

  for (const p of picked) {
    const ticket = tickets.find((t) => t.id === p.ticket);
    const mine = verdicts.filter((v) => v && v.unit && ticket && ticketDeclares(root, cfg, ticket.dir, v.unit.path));
    if (mine.length === 0) {
      skipped.push({ ticket: p.ticket, why: 'no prose pair on this ticket\'s own files or components carries a recorded verdict' });
      continue;
    }
    for (const v of mine) {
      const key = pairKey(v.aspect, v.unit);
      const unit = `${v.unit.kind}:${v.unit.path}`;
      const unitFlag = v.unit.kind === 'node' ? '--node' : '--file';
      const held = samples[key] || null;

      // Both opinions in hand, the second one kept here rather than in the graph. A pair whose first
      // judgement is a pass still in force can be packaged for a second judge, but `yg verdict
      // record` still refuses to write a second verdict over it — the lock holds one verdict per
      // pair, and replacing one that still applies would erase it with no evidence anything
      // changed. So that second judgement is written into the same slot as the first, by
      // `retro.mjs --second`, bound to a hash the first's package named, and read back here.
      if (held && held.second) {
        const s = held.second;
        const bound = held.hashes ? held.hashes[s.verdict] : null;
        if (!bound || bound !== s.hash) {
          skipped.push({
            ticket: p.ticket,
            aspect: v.aspect,
            unit,
            why: `${held.judge} and ${s.judge} both judged this pair, and not the same code — the second judgement `
              + `is not bound to the hash the package named when ${held.judge}'s was written down`,
          });
          continue;
        }
        const agrees = held.verdict === s.verdict;
        if (!agrees) disagreements += 1;
        pairs.push({
          ticket: p.ticket,
          aspect: v.aspect,
          unit,
          held: held.verdict,
          heldBy: held.judge,
          heldAt: held.at || null,
          second: s.verdict,
          secondBy: s.judge,
          agrees,
        });
        continue;
      }

      // Both opinions in hand: one on file from an earlier run, the other in the slot now. Nothing
      // is packaged on this path — packaging here would throw away the very comparison this run
      // came back for.
      if (held && tier && v.judge === tier) {
        if (held.judge === v.judge) {
          skipped.push({
            ticket: p.ticket,
            aspect: v.aspect,
            unit,
            why: `both the judgement on file for this pair and the one recorded on it now are ${tier}'s own, and `
              + `${tier} is the second judge — there is nobody else's opinion here to put beside it`,
          });
          continue;
        }
        const bound = held.hashes ? held.hashes[v.verdict] : null;
        if (!bound || bound !== v.hash) {
          skipped.push({
            ticket: p.ticket,
            aspect: v.aspect,
            unit,
            why: `${held.judge} and ${v.judge} both judged this pair, and not the same code — the verdict recorded `
              + `on it now is not bound to the hash its package named when ${held.judge}'s was written down, so `
              + 'neither agreement nor disagreement between the two would mean anything',
          });
          continue;
        }
        const agrees = held.verdict === v.verdict;
        if (!agrees) disagreements += 1;
        pairs.push({
          ticket: p.ticket,
          aspect: v.aspect,
          unit,
          held: held.verdict,
          heldBy: held.judge,
          heldAt: held.at || null,
          second: v.verdict,
          secondBy: v.judge,
          agrees,
        });
        continue;
      }

      if (!held) {
        // The second judge's own verdict and nothing else is what this pair carries. Writing it
        // down as the first judgement would set a judge up to be compared against themselves,
        // which is the whole of what this measurement used to do.
        if (tier && v.judge === tier) {
          skipped.push({
            ticket: p.ticket,
            aspect: v.aspect,
            unit,
            why: `the only verdict recorded on this pair is ${tier}'s own, and ${tier} is the second judge — there `
              + 'is no first judgement here for it to be compared against',
          });
          continue;
        }
        // Packaging is both halves of a first run: it is what proves the pair can still be handed
        // to a judge at all, and it is where the two hashes that say whether the code moved
        // afterwards come from. A pass still in force is packaged too — Yggdrasil 6.1.0 and newer
        // hands its package over marked `inForce: true` — so the measurement is not drawn only
        // from pairs whose first judge refused. A Yggdrasil before that refuses to package such a
        // pair at all; that pair is counted apart from `skipped`, on `passInForce`, so the count
        // and the interval are read against the population they actually cover.
        const passHolds = v.verdict === 'pass' && !!v.inForce;
        const args = ['verdict', 'package', '--aspect', v.aspect, unitFlag, v.unit.path];
        const pkg = ygJson(root, cfg, args, 'yg-review/1');
        if (pkg.state !== 'ok') {
          if (passHolds) {
            passInForce.push({
              ticket: p.ticket,
              aspect: v.aspect,
              unit,
              why: `${v.judge || 'the first judge'} passed this pair and that pass still holds, and \`${pkg.command}\` `
                + 'refused to package it — a Yggdrasil before 6.1.0 will not package a pair whose verdict is in force, '
                + 'so on this CLI the pair cannot reach a second judge',
            });
            continue;
          }
          skipped.push({
            ticket: p.ticket, aspect: v.aspect, unit, why: `\`${pkg.command}\` refused — ${ygWhy(pkg)}`,
          });
          continue;
        }
        const hashes = pkg.doc && pkg.doc.hashes;
        samples[key] = {
          aspect: v.aspect,
          unit: { kind: v.unit.kind, path: v.unit.path },
          judge: v.judge === undefined ? null : v.judge,
          verdict: v.verdict,
          inForce: passHolds,
          hash: v.hash === undefined ? null : v.hash,
          hashes: hashes && typeof hashes === 'object'
            ? { pass: hashes.pass || null, refused: hashes.refused || null }
            : null,
          at: nowIso(),
        };
        wrote = true;
      }

      // Written down and waiting. The command is the same one it has always been — running it
      // replaces what is in the slot, which is exactly why the copy above is taken first.
      const first = samples[key] || held;
      const judgeFlags = `--aspect ${v.aspect} ${unitFlag} ${v.unit.path} --by ${tier || '<the second judge>'} `
        // A refusal is recorded with its report on both channels, so the command carries the flag.
        + '--verdict pass|refused --hash <hashes.pass or hashes.refused from the package> [--report "<what is wrong and where> — required with refused"]';
      pending.push({
        ticket: p.ticket,
        aspect: v.aspect,
        unit,
        held: first ? first.verdict : v.verdict,
        heldBy: first ? first.judge : (v.judge === undefined ? null : v.judge),
        // A pass still in force cannot be recorded over in the graph, so its second judgement is
        // written into this horde's own copy instead.
        record: first && first.inForce
          ? `retro.mjs --second --horde ${horde} ${judgeFlags}`
          : `${yg.display} verdict record ${judgeFlags}`,
      });
    }
  }

  if (wrote) writeJSON(samplesFile, samples);

  // What the count and interval above actually cover, so a reader never mistakes a sub-population
  // for the whole sample. A figure exists only once `pairs` holds something — that is the one
  // case worth a caveat about what it does and does not include. Short of that, the sample has
  // nothing to show yet: still waiting on a second judgement where one is on `pending`, or, where
  // nothing in it could reach that stage at all this run, a pointer to why each one couldn't.
  const note = pairs.length > 0
    ? (passInForce.length > 0
      ? `the count and interval above leave out ${passInForce.length} pair(s) whose first judge PASSED and whose `
        + 'pass still holds: the Yggdrasil CLI here will not package a pair in force (6.1.0 and newer does), so those '
        + 'could not reach a second judge; see `passInForce`.'
      : 'the count and interval above cover every pair in this sample that has two judgements; a pair still on '
        + '`pending` is not in them yet.')
    : pending.length > 0
      ? 'the sample was drawn and no pair in it has two judgements to put side by side yet — every pair on '
        + '`pending` has its first written down here, and is waiting for the command beside it to leave a second.'
      : 'the sample was drawn and nothing in it reached a second judge this run — see `skipped` and '
        + '`passInForce` for why each one couldn\'t.';

  return {
    sampled: size,
    seed,
    tickets: picked.map((p) => p.ticket),
    pairs,
    disagreements,
    interval: wilson(disagreements, pairs.length),
    tier,
    skipped,
    passInForce,
    pending,
    note,
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

// createLockFile, processAlive and sleepSync are shared with land.mjs's own lock and _lib.mjs's
// queue and worktree locks (imported above) — see createLockFile's own comment in _lib.mjs for why
// the file is written beside its name and only then linked into place.

// Exported under its full name so the regression that guards it can put two real processes
// against this function itself rather than against a copy — a copy drifts away from the code it
// is meant to be proving.
export function acquireRetroLock(horde, waitMs = LOCK_WAIT_MS) {
  const path = lockPath(horde);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      createLockFile(path, `${JSON.stringify({ pid: process.pid, horde, at: nowIso() }, null, 2)}\n`);
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
    const seen = readLockText(path);
    let held = null;
    try { held = JSON.parse(seen); } catch { held = null; }
    if (!held || !processAlive(held.pid)) {
      removeStaleLock(path, seen);
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

  // Before anything the mission wrote down is read back: what the mission had to prove itself
  // with. A retrospective on a mission with no evidence layer is read differently from one on a
  // mission with a suite behind it, and nobody should have to work out which this was.
  if (doc.noEvidenceLayer) lines.push(doc.noEvidenceLayer, '');

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

  // Its own section, whatever each item was classified as: a return is a fact about the mission's
  // own bar, and it is worth reading whether or not the law turned out to have anything to say
  // about it.
  lines.push('## What came back after landing', '');
  if (doc.returns.length === 0) {
    lines.push('(nothing — no merge on this mission was undone, and no ticket was filed to earn back what another had claimed)');
  }
  for (const it of doc.returns) lines.push(`- ticket ${it.ticket} · ${it.source} — ${it.text}`);
  lines.push('');

  lines.push('## Taste', '');
  if (doc.taste.length === 0) lines.push('(nothing)');
  for (const it of doc.taste) lines.push(`- ticket ${it.ticket} · ${it.node} — ${it.text}`);
  lines.push('', `Written to ${doc.logged.length} component log(s) this run; nowhere else.`, '');

  lines.push('## Two judges', '');
  if (doc.judge.note) lines.push(doc.judge.note);
  if (doc.judge.sampled) {
    lines.push(`sample ${doc.judge.sampled} ticket(s): ${doc.judge.tickets.join(', ')} — ${doc.judge.pairs.length} pair(s) compared, ${doc.judge.disagreements} disagreement(s)`
      + `${doc.judge.interval ? `, 95% interval [${doc.judge.interval.low.toFixed(3)}, ${doc.judge.interval.high.toFixed(3)}]` : ''}.`);
    for (const s of doc.judge.skipped) lines.push(`- skipped${s.ticket ? ` ticket ${s.ticket}` : ''}: ${s.why}`);
    for (const s of doc.judge.passInForce) lines.push(`- out of reach${s.ticket ? ` ticket ${s.ticket}` : ''}: ${s.why}`);
    for (const p of doc.judge.pending) {
      lines.push(`- waiting on a second judgement: ${p.aspect} on ${p.unit}`
        + `${p.heldBy ? ` (${p.heldBy} said ${p.held}, written down here)` : ''} — ${p.record}`);
    }
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
        + `${input.items.filter((i) => i.source === 'reopen').length} reopen(s), `
        + `${input.items.filter((i) => i.source === 'revert').length} revert(s), `
        + `${input.items.filter((i) => i.source === 'log').length} remark(s) across ${input.tickets.length} ticket(s).`,
      '',
      `Spawn ONE retrospective one-shot over all of it: brief.mjs retro --name <n> --horde ${horde}`,
      `It writes ${classesPath(horde)}; run this again once it has, and the document gets written.`,
      ...(input.notes.length ? ['', 'Could not be read:', ...input.notes.map((n) => `- ${n}`)] : []),
    ].join('\n'));
    return;
  }

  const classified = readClasses(horde, input.items);
  // No --tree: cwd, same as an ordinary read anywhere else in this tool set — NOT this horde's
  // trunk just because a horde was resolvable (ask a-002, decisions.md: always cwd, full stop,
  // however many hordes the repository runs). What this DOES honor is --horde typed explicitly:
  // `flags.horde`, never `horde` above (main()'s own resolveHorde(flags), which defaults to the
  // sole horde in a single-horde repository even with nothing typed at all) — the same distinction
  // tick.mjs (041), land.mjs (109) and horde.mjs done (113) already draw. Only logTaste's
  // `yg log add` and measureJudge's own reads below actually touch this tree; the gathering run
  // above (collectRetroInput) reads only .horde/ and resolves no tree at all, on purpose (see its
  // own comment) — issue 114 caught this command's tree resolution up to the same rule.
  const info = resolveTree({ tree: flags.tree, horde: flags.horde });
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

    // Kept as a list of its own on the document, not only as a source tag inside `items`: the
    // question "what came back on this mission" has to be answerable without filtering anything.
    const returns = classified.filter((it) => RETURN_SOURCES.has(it.source))
      .map((it) => ({
        ticket: it.ticket, source: it.source, text: it.text, class: it.class,
      }));

    const doc = {
      schema: RETRO_SCHEMA,
      horde,
      at: nowIso(),
      noEvidenceLayer: noEvidenceLayerNote(horde),
      state: missionState(input.landed),
      items: classified.map((it) => ({
        key: it.key, source: it.source, ticket: it.ticket, text: it.text, class: it.class, node: it.node, proposal: it.proposal,
      })),
      law: classified.filter((it) => it.class === 'rule').map((it) => it.proposal),
      returns,
      taste: taste.map((it) => ({ ticket: it.ticket, node: it.node, text: it.text })),
      inexpressible,
      logged: [...alreadyLogged, ...logging.logged],
      judge: measureJudge(horde, info.path, cfg, input.tickets, input.landed),
      threshold: measureThreshold(cfg, classified, inexpressible),
      notes,
    };
    writeJSON(retroPath(horde), doc, { render });

    emit(doc, flags, () => [
      ...(doc.noEvidenceLayer ? [doc.noEvidenceLayer] : []),
      `${doc.returns.length} return(s) after landing — ${doc.returns.filter((r) => r.source === 'reopen').length} reopened, `
        + `${doc.returns.filter((r) => r.source === 'revert').length} reverted.`,
      `${doc.law.length} rule proposal(s), ${doc.taste.length} taste item(s), ${doc.inexpressible.length} the law will not say `
        + `— ${doc.threshold.count} of ${doc.threshold.of}, a share of ${doc.threshold.share.toFixed(3)}`
        + `${doc.threshold.threshold === null ? '' : ` against a bar of ${doc.threshold.threshold}${doc.threshold.over ? ' — OVER' : ''}`}.`,
      ...(doc.threshold.note ? [doc.threshold.note] : []),
      doc.judge.note || `two judges: ${doc.judge.pairs.length} pair(s), ${doc.judge.disagreements} disagreement(s).`,
      `${retroPath(horde)}`,
    ].join('\n'));
  } finally {
    lock.release();
  }
}

// The second judgement on a pair whose first was a pass still in force. The graph will not take a
// second verdict over one that still applies, so it is kept beside the first in this horde's own
// copy, bound to a hash that pair's package named when the first was written down: a hash for other
// code, or for the other verdict word, is refused, because a comparison between judgements of two
// different things means nothing.
function cmdSecond(flags) {
  const horde = resolveHorde(flags);
  const aspect = typeof flags.aspect === 'string' ? flags.aspect.trim() : '';
  const node = typeof flags.node === 'string' ? flags.node.trim() : '';
  const file = typeof flags.file === 'string' ? flags.file.trim() : '';
  const by = typeof flags.by === 'string' ? flags.by.trim() : '';
  const verdict = typeof flags.verdict === 'string' ? flags.verdict.trim() : '';
  const hash = typeof flags.hash === 'string' ? flags.hash.trim() : '';
  const report = typeof flags.report === 'string' ? flags.report.trim() : '';
  if (!aspect || (!node === !file) || !by || !hash) {
    fail('usage: retro.mjs --second --aspect <id> --node <path>|--file <path> --by <name> --verdict pass|refused --hash <sha> [--report "<what is wrong and where>"]');
  }
  if (verdict !== 'pass' && verdict !== 'refused') fail(`'${verdict}' is not a verdict — use --verdict pass or --verdict refused`);
  if (verdict === 'refused' && !report) fail('a refusal is recorded with its report: pass --report "<what is wrong and where>"');
  const unit = node ? { kind: 'node', path: node } : { kind: 'file', path: file };
  const key = pairKey(aspect, unit);
  const lock = acquireRetroLock(horde);
  try {
    const samplesFile = judgeSamplesPath(horde);
    const samples = readJSON(samplesFile, {}) || {};
    const held = samples[key];
    if (!held) {
      fail(`no first judgement is written down for ${aspect} on ${unit.kind}:${unit.path} — run retro.mjs first; it `
        + 'writes the first one down and prints this command for the pairs that need it');
    }
    const bound = held.hashes ? held.hashes[verdict] : null;
    if (!bound || bound !== hash) {
      fail(`${hash} is not the hash the package named for "${verdict}" when ${held.judge || 'the first judge'}'s judgement was `
        + 'written down — either the code moved since, or the hash is the one for the other verdict');
    }
    held.second = { judge: by, verdict, hash, report: report || null, at: nowIso() };
    writeJSON(samplesFile, samples);
    emit({ horde, aspect, unit, second: held.second }, flags, () => `${by} judged ${aspect} on ${unit.kind}:${unit.path}: ${verdict}. `
      + 'Kept beside the first judgement; the next retro.mjs run puts the two side by side.');
  } finally {
    lock.release();
  }
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (flags.second) { cmdSecond(flags); return; }
  cmdRetro(flags);
}

if (isMain(import.meta.url)) runMain(main);
