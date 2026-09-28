#!/usr/bin/env node
// horde skill — ask.mjs
//
// One channel to the client, and exactly four things travel down it. `stop` — a worker ran out of
// spec and wrote down the question instead of guessing; the ticket stays where it was. `stuck` — a
// ticket exhausted its fix rounds, or its catch-up merge stopped on the same files twice, and tick put
// it on "blocked"; tick files this one, not an agent, and it carries the gate's last words (or the
// files) and the ticket's log path. One `stuck` names no ticket: a landing that waits on a decision
// only the user can make (no reviewer for the prose rules), asked once for the whole horde however
// many tickets meet it — each of them points at it from its own queue item. `lower` — a request to
// weaken something that protects the work: a rule (demote, an added yg-suppress marker, a moved
// review_by, an aspect detached from a node), the proof (a promise put back to planned, a test
// file or an assertion taken out, a skip marker added), or a gate (the script a gate command runs,
// a commit or push hook, a CI workflow). `charter` — a mission-card change: the goal, an
// exclusion, an evidence-catalogue row.
//
// Filing one never touches the queue, and an open one holds only what depends on the answer:
// "stop" everything — nothing new goes out, nothing merges, no wave closes — "stuck" that ticket,
// "charter" the tickets earning the evidence rows the question names, "lower" that branch's
// landing. Everything else keeps moving. The four readings live where they are acted on (tick.mjs,
// "what an open question holds up"), not here, so there is one statement of them rather than two
// that can drift apart.
//
// State: the mission's Jarl loop (loop.mjs). A question is a line of the loop's asks.md — its number
// (a-NNN, numbered by the loop), its kind, what it would lower (target) and the ticket it is about
// (issue) — and its answer is the loop's ruling ask-NNN in decisions.md. What the loop's line has no room
// for stays beside it in hordes/<horde>/asks.json, keyed by the question's id: the whole question (the
// line holds it on one line), the territory it was asked about, the log it points at, when it was asked,
// and the scope an answer was given. The state of a question is never there: open or answered is the
// loop's. So a question answered with Jarl's own command (`jarl.mjs answer a-NNN "…" --root
// .horde/hordes/<h>`) is answered here too, and its guards read it (with the scope "once").
//
// "ask answer" is the one place a client's word gets recorded here: the loop writes the ruling ask-NNN
// and marks the question answered in one move, under its own lock, and the fields land.mjs's guards read
// (Kind, Territory, Aspect, Scope where they apply) go into that same ruling before the lock lets go.
//
// `--aspect` names WHAT is being weakened, and it has never been more than a string those guards
// match on exactly. Three spellings share it, one per guard, chosen so no two can ever collide:
//
//   <rule id>          a rule in the graph, e.g. "no-marker"
//   evidence:<name>    a promise's own id, or a test file's path
//   gate:<path>        a file a gate command, a hook or CI actually runs
//
// A rule id is its directory's path under `.yggdrasil/aspects/` — it may hold `/` (a nested or an
// installed rule), never the `:` the other two open with. One answer lets one of these through and never a category: a mission that
// means to lower three things files three questions.

import {
  hordePath, readJSON, writeJSON, nowIso, fail, parseArgs, emit, isMain, resolveHorde,
  runMain, withAsksLock, notifyClient, readConfig, parseDecisionEntries, decisionField, readText,
} from './_lib.mjs';
import {
  loopAsks, fileLoopAsk, answerLoopAsk, withLoopLock, decisionsFile, writeLoopFile, ticketFile,
} from './loop.mjs';

export const KINDS = ['stop', 'stuck', 'lower', 'charter'];

export const USAGE = `usage: ask.mjs <command> [options]

commands:
  add "<why>" --kind <${KINDS.join('|')}> [--ticket NNN] [--territory t] [--aspect a] [--horde h]
      --aspect is required for kind "lower" (there is nothing to lower without naming it) and
      illegal for the other three kinds. It names the one thing being weakened, in whichever of
      three spellings says which: a rule's own id ("no-marker"), a promise or a test file
      ("evidence:adds-two-numbers", "evidence:tests/second.test.mjs"), or a gate, hook or CI file
      ("gate:scripts/gate.sh", "gate:.husky/pre-commit"). One answer lets exactly that one thing
      through and never a category.
  list [--open] [--horde h]
      open first, newest first.
  show <id> [--horde h]
  answer <id> "<answer>" [--scope once|mission] [--horde h]
      records the client's answer, closes the item, and appends it to the mission's decisions as
      "ask-NNN". --scope is accepted only for kind "lower": "once" (the default) spends the grant on
      the landing that uses it; "mission" stands until "horde done". land.mjs's guards read this
      decision, not the raw item, to decide whether a branch that weakens a rule, the proof or a
      gate may land; a "stuck" ticket returns to the queue or closes as not-done only through an
      answer here.

options: --json  --help`;

// What a question carries beyond what the loop's asks.md holds on its line: the whole question (the
// line is one line of it), the territory it was asked about, the log it points at, when it was asked,
// and the scope an answer was given. Keyed by the question's id; written only by this file. Nothing in
// it is the question's state — open or answered is the loop's, and so is the answer itself.
export function extrasPath(horde) { return hordePath(horde, 'asks.json'); }

function loadExtras(horde) {
  const doc = readJSON(extrasPath(horde), null);
  return doc && doc.questions && typeof doc.questions === 'object' ? doc : { questions: {} };
}

function saveExtras(horde, doc) {
  writeJSON(extrasPath(horde), doc);
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const aOpen = a.state !== 'answered';
    const bOpen = b.state !== 'answered';
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return (b.at || '').localeCompare(a.at || '') || b.id.localeCompare(a.id);
  });
}

// The answer a ruling ask-NNN records: the text after **Answer:** up to the fields a landing or this file
// add below it.
function answerOf(block) {
  const m = /\*\*Answer:\*\*[ \t]*([\s\S]*?)(?=\n\*\*(?:Scope|Consumed|By|Kind|Territory|Aspect|At):\*\*|\n\s*\n\*\*By:\*\*|$)/.exec(String(block || ''));
  return m ? m[1].trim() : '';
}

// The rulings that answer a question, by the question's number: ask-NNN.
function answerRulings(horde) {
  const out = new Map();
  for (const e of parseDecisionEntries(readText(decisionsFile(horde)) || '')) {
    const m = /^ask-(?:a-)?(\d+)$/.exec(e.slug || '');
    if (m) out.set(m[1].padStart(3, '0'), e);
  }
  return out;
}

// loadAsks(horde) — every question to the client, as {items}: the loop's own record (its state, kind,
// target and ticket, and the answer its ruling holds) with Horde's extras beside it. `id` reads a-NNN.
export function loadAsks(horde) {
  const extras = loadExtras(horde).questions;
  const rulings = answerRulings(horde);
  const items = loopAsks(horde).filter((a) => a.kind !== 'ratify').map((a) => {
    const id = `a-${a.id}`;
    const x = extras[id] || {};
    const item = {
      id, kind: a.kind || 'stuck', why: x.why || a.question, state: a.state === 'answered' ? 'answered' : 'open', at: x.at || null,
    };
    if (a.issue) item.ticket = a.issue;
    else if (x.ticket) item.ticket = x.ticket;
    if (x.territory) item.territory = x.territory;
    if (a.target) item.aspect = a.target;
    if (x.log) item.log = x.log;
    if (item.state === 'answered') {
      const ruling = rulings.get(a.id);
      item.answer = ruling ? answerOf(ruling.block) : '';
      const scope = ruling ? decisionField(ruling.block, 'Scope').toLowerCase() : '';
      if (item.kind === 'lower') item.answerScope = x.answerScope || scope || 'once';
      item.answeredAt = x.answeredAt || (ruling && ruling.date) || null;
    }
    return item;
  });
  return { items };
}

// addAsk(horde, {kind, why, ticket, territory, aspect, log}) — opens one question in the loop and
// returns it. Exported so tick.mjs (017's "stuck") can file one without shelling out to this file;
// throws rather than exiting, so its caller decides how to report it. `log` carries a ticket's log
// path (tick's own use, "stuck" only). The loop numbers the question (a-NNN, a sequence of its own:
// a ticket is t-NNN and a graph item g-NNN, so the prefix is what tells them apart).
export function addAsk(horde, {
  kind, why, ticket, territory, aspect, log,
} = {}) {
  if (!why) throw new Error('why required');
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join('|')}`);
  if (kind === 'lower' && !aspect) throw new Error('--aspect is required for kind "lower" — nothing to lower without naming it');
  if (kind !== 'lower' && aspect) throw new Error(`--aspect has no meaning for kind "${kind}" — only "lower" names something to weaken`);
  if (aspect && /\s/.test(String(aspect))) throw new Error(`--aspect names one thing, with no spaces in it (got "${aspect}")`);
  const ticketId = ticket ? String(ticket).replace(/^t-/, '').padStart(3, '0') : null;
  const filed = withAsksLock(horde, () => withLoopLock(horde, () => {
    // The loop keeps a question on one line; the whole of it stays in the extras.
    const line = String(why).replace(/\s+/g, ' ').trim();
    // The loop ties a question to a ticket it holds; a ticket number it does not hold (one named by a
    // worker before it was filed, say) stays with the question in the extras.
    const onTicket = ticketId && ticketFile(horde, ticketId) ? ticketId : undefined;
    const asked = fileLoopAsk(horde, line, { kind, target: aspect ? String(aspect) : undefined, issue: onTicket });
    const id = `a-${asked.id}`;
    const doc = loadExtras(horde);
    const x = { why: String(why), at: nowIso() };
    if (ticketId && !onTicket) x.ticket = ticketId;
    if (territory) x.territory = String(territory);
    if (log) x.log = String(log);
    doc.questions[id] = x;
    saveExtras(horde, doc);
    const item = {
      id, kind, why: String(why), state: 'open', at: x.at,
    };
    if (ticketId) item.ticket = ticketId;
    if (territory) item.territory = String(territory);
    if (aspect) item.aspect = String(aspect);
    if (log) item.log = String(log);
    return item;
  }));
  // Every question filed reaches the client's own hook, whoever filed it — a worker, tick, the wave
  // close's audit — once, as it is filed. Its outcome is returned beside the item, never stored.
  const notified = notifyClient(horde, readConfig() || {}, {
    event: 'ask', kind: filed.kind, id: filed.id, text: filed.why,
  });
  return notified ? Object.defineProperty(filed, 'notified', { value: notified, enumerable: false }) : filed;
}

// The fields land.mjs's guards read, written into the answer's own ruling as its first line: what kind
// of question it answered, the one thing it lets through, and for how long. A question answered with
// Jarl's own command carries none of them; the guards then read the kind and the target off the
// question and the scope as "once".
function answerFields(item, answerScope) {
  const head = [`**Kind:** ${item.kind}`];
  if (item.territory) head.push(`**Territory:** ${item.territory}`);
  if (item.aspect) head.push(`**Aspect:** ${item.aspect}`);
  if (item.kind === 'lower') head.push(`**Scope:** ${answerScope}`);
  return head.join(' · ');
}

// Puts `line` as the first line of ruling `slug`'s text in the loop's decisions.md. The caller holds the
// loop's lock.
function prefixRuling(horde, slug, line) {
  const path = decisionsFile(horde);
  const lines = (readText(path) || '').split('\n');
  const at = lines.findIndex((l) => new RegExp(`^## \\d{4}-\\d{2}-\\d{2} · ${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l));
  if (at === -1) return;
  lines.splice(at + 1, 0, line);
  writeLoopFile(path, lines.join('\n'));
}

// answerAsk(horde, id, {answer, scope}) — records the client's answer: the loop writes the ruling
// ask-NNN and marks the question answered in one move, under its own lock, and the fields the guards
// read go into that same ruling before the lock lets go — a question is never answered with nothing
// durable behind it, and never recorded half.
export function answerAsk(horde, id, { answer, scope } = {}) {
  if (!answer) throw new Error('answer required');
  const ref = String(id).startsWith('a-') ? String(id) : `a-${String(id).padStart(3, '0')}`;
  return withAsksLock(horde, () => withLoopLock(horde, () => {
    const item = loadAsks(horde).items.find((x) => x.id === ref);
    if (!item) throw new Error(`no such ask: ${ref}`);
    if (item.state === 'answered') throw new Error(`already answered: ${ref}`);
    if (scope !== undefined && item.kind !== 'lower') {
      throw new Error(`--scope is only accepted for kind "lower" (this ask is "${item.kind}")`);
    }
    if (scope !== undefined && scope !== 'once' && scope !== 'mission') {
      throw new Error('--scope must be "once" or "mission"');
    }
    const answerScope = item.kind === 'lower' ? (scope || 'once') : undefined;
    answerLoopAsk(horde, ref, answer);
    prefixRuling(horde, `ask-${ref.slice(2)}`, answerFields(item, answerScope));
    const doc = loadExtras(horde);
    const x = doc.questions[ref] || { why: item.why, at: item.at };
    x.answeredAt = nowIso();
    if (answerScope) x.answerScope = answerScope;
    doc.questions[ref] = x;
    saveExtras(horde, doc);
    return {
      ...item, state: 'answered', answer, ...(answerScope ? { answerScope } : {}), answeredAt: x.answeredAt,
    };
  }));
}

async function cmdAdd(horde, positional, flags) {
  const why = positional[0];
  if (!why) fail('add requires "<why>"');
  if (typeof flags.kind !== 'string' || !KINDS.includes(flags.kind)) fail(`--kind is required, one of: ${KINDS.join('|')}`);
  let item;
  try {
    item = addAsk(horde, {
      kind: flags.kind, why, ticket: flags.ticket, territory: flags.territory, aspect: flags.aspect,
    });
  } catch (e) {
    fail(e.message);
  }
  // The client's report names the new question at once, not only at the next tick.
  const { refreshReport } = await import('./report.mjs');
  const report = refreshReport(horde);
  const notified = item.notified || null;
  emit({ ...item, ...(notified ? { notified } : {}), report: report.ok ? report.paths[0] : report.note }, flags, () => [
    `ask ${item.id} opened (${item.kind})`,
    ...(notified && !notified.ok ? [`the client was not notified: ${notified.note}`] : []),
    ...(report.ok ? [] : [report.note]),
  ].join('\n'));
}

function cmdList(horde, positional, flags) {
  const doc = loadAsks(horde);
  let items = sortItems(doc.items);
  if (flags.open) items = items.filter((it) => it.state === 'open');
  emit(items, flags, () => {
    if (items.length === 0) return '(no asks)';
    return items.map((it) => [it.id, it.state, it.kind, it.ticket || '-', it.territory || '-', it.why.split('\n')[0]].join(' ')).join('\n');
  });
}

function cmdShow(horde, positional, flags) {
  const id = positional[0];
  if (!id) fail('show requires <id>');
  const ref = String(id).startsWith('a-') ? String(id) : `a-${String(id).padStart(3, '0')}`;
  const doc = loadAsks(horde);
  const it = doc.items.find((x) => x.id === ref);
  if (!it) fail(`no such ask: ${ref}`);
  emit(it, flags, () => {
    const head = [`[${it.id}] ${it.kind}`];
    if (it.ticket) head.push(`ticket ${it.ticket}`);
    if (it.territory) head.push(it.territory);
    head.push(it.state);
    const lines = [head.join(' · ')];
    if (it.aspect) lines.push(`aspect: ${it.aspect}`);
    lines.push(it.why);
    if (it.log) lines.push(`log: ${it.log}`);
    if (it.state === 'answered') lines.push(`answer (${it.answeredAt}${it.answerScope ? `, scope ${it.answerScope}` : ''}): ${it.answer}`);
    return lines.join('\n');
  });
}

function cmdAnswer(horde, positional, flags) {
  const [id, answer] = positional;
  if (!id || !answer) fail('answer requires <id> "<answer>"');
  let item;
  try {
    item = answerAsk(horde, id, { answer, scope: flags.scope });
  } catch (e) {
    fail(e.message);
  }
  emit(item, flags, () => `ask ${item.id} answered — recorded as ask-${item.id.slice(2)}`);
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'add': return cmdAdd(horde, positional, flags);
    case 'list': return cmdList(horde, positional, flags);
    case 'show': return cmdShow(horde, positional, flags);
    case 'answer': return cmdAnswer(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) runMain(main);
