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
     what came back after landing, and the items the law will not express.

The first run resolves no tree at all — it reads only .horde/. The second run's own graph reads
(the taste log) run against the tree --tree names; without it, cwd, same
as an ordinary read anywhere else in this tool set, not this horde's trunk just because a horde was
resolvable. --horde h WRITTEN OUT (no --tree) is what changes that, exactly as queue.mjs
plan/quality, tick.mjs, land.mjs and horde.mjs done already read it.

A "taste" item leaves one line in its component's own log through \`yg log add\` and goes nowhere
else. An item already logged by an earlier run is never logged twice.


options: --json  --help`;

// ---- where things live ------------------------------------------------------------------

export function retroPath(horde) { return hordePath(horde, 'retro.json'); }
export function classesPath(horde) { return hordePath(horde, 'retro-classes.json'); }
function classesFileName() { return 'retro-classes.json'; }
function lockPath(horde) { return hordePath(horde, 'retro.lock'); }

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

if (isMain(import.meta.url)) runMain(main);
