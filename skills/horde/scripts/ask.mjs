#!/usr/bin/env node
// horde skill — ask.mjs
//
// One channel to the client, and exactly four things travel down it. `stop` — a worker ran out of
// spec and wrote down the question instead of guessing; the ticket stays where it was. `stuck` — a
// ticket exhausted its fix rounds and tick (017) put it on "blocked"; tick files this one, not an
// agent, and it carries the gate's last words and the ticket's log path. `lower` — a request to
// weaken a rule: demote, an added yg-suppress marker, a moved review_by, an aspect detached from a
// node. `charter` — a mission-card change: the goal, an exclusion, an evidence-catalogue row.
//
// State: hordes/<horde>/asks.json (source of truth) + asks.md (rendered) — same writeJSON(path,
// doc, {render}) mechanism escalations.json and dissents.json used, which is the only thing that
// survives from either.
//
// "ask answer" is the one place a client's word gets recorded: it appends the answer to
// decisions.md (decide.mjs's appendDecision, slug "ask-<id>") BEFORE marking the item answered, so
// a decision that failed to record — a duplicate slug, a read-only file — never leaves an item
// silently closed with nothing durable behind it. The ruling body is one line of bold fields
// (Kind, Territory, Aspect, Scope where they apply) followed by the question and the client's own
// answer — the exact shape land.mjs's law guard already reads to decide whether a "lower" ask lets
// a landing through.

import {
  hordePath, readJSON, writeJSON, allocateId, nowIso, fail, parseArgs, emit, isMain, resolveHorde,
} from './_lib.mjs';
import { appendDecision } from './decide.mjs';

export const KINDS = ['stop', 'stuck', 'lower', 'charter'];

const USAGE = `usage: ask.mjs <command> [options]

commands:
  add "<why>" --kind <${KINDS.join('|')}> [--ticket NNN] [--territory t] [--aspect a] [--horde h]
      --aspect is required for kind "lower" (there is nothing to lower without naming it) and
      illegal for the other three kinds.
  list [--open] [--horde h]
      open first, newest first.
  show <id> [--horde h]
  answer <id> "<answer>" [--scope once|mission] [--horde h]
      records the client's answer, closes the item, and appends it to decisions.md as "ask-<id>".
      --scope is accepted only for kind "lower": "once" (the default) spends the grant on the
      landing that uses it; "mission" stands until "horde done". land.mjs's law guard reads this
      decision, not the raw item, to decide whether a branch that weakens a rule may land; a
      "stuck" ticket returns to the queue or closes as not-done only through an answer here.

options: --json  --help`;

export function asksPath(horde) { return hordePath(horde, 'asks.json'); }

export function loadAsks(horde) {
  const doc = readJSON(asksPath(horde), null);
  return doc && Array.isArray(doc.items) ? doc : { items: [] };
}

function save(horde, doc) {
  writeJSON(asksPath(horde), doc, { render });
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const aOpen = a.state !== 'answered';
    const bOpen = b.state !== 'answered';
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return (b.at || '').localeCompare(a.at || '');
  });
}

function render(doc) {
  const items = sortItems(doc.items);
  const lines = ['# Asks', ''];
  if (items.length === 0) lines.push('(none)');
  for (const it of items) {
    const head = [`[${it.id}] ${it.kind}`];
    if (it.ticket) head.push(`ticket ${it.ticket}`);
    if (it.territory) head.push(it.territory);
    head.push(it.state);
    lines.push(`## ${head.join(' · ')}`);
    lines.push(`at: ${it.at}`);
    if (it.aspect) lines.push(`aspect: ${it.aspect}`);
    lines.push(it.why);
    if (it.log) lines.push('', `log: ${it.log}`);
    if (it.state === 'answered') {
      lines.push('', `answer (${it.answeredAt}${it.answerScope ? `, scope ${it.answerScope}` : ''}): ${it.answer}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// addAsk(horde, {kind, why, ticket, territory, aspect, log}) — opens one ask and returns it.
// Exported so tick.mjs (017's "stuck") can file one without shelling out to this file; throws
// rather than exiting, so its caller decides how to report it. `log` carries a ticket's log path
// (tick's own use, "stuck" only) — it has no meaning tick doesn't give it, but nothing here
// restricts which kind may carry one, since a fifth field is not a fifth kind.
export function addAsk(horde, {
  kind, why, ticket, territory, aspect, log,
} = {}) {
  if (!why) throw new Error('why required');
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join('|')}`);
  if (kind === 'lower' && !aspect) throw new Error('--aspect is required for kind "lower" — nothing to lower without naming it');
  if (kind !== 'lower' && aspect) throw new Error(`--aspect has no meaning for kind "${kind}" — only "lower" names a rule to weaken`);
  const doc = loadAsks(horde);
  const { id } = allocateId(horde, 'ask');
  const item = {
    id, kind, why, state: 'open', at: nowIso(),
  };
  if (ticket) item.ticket = String(ticket);
  if (territory) item.territory = String(territory);
  if (aspect) item.aspect = String(aspect);
  if (log) item.log = String(log);
  doc.items.push(item);
  save(horde, doc);
  return item;
}

// The decision body land.mjs's law guard already knows how to read: one line of bold fields, the
// question, the client's own answer — in that order, so a multi-line answer never reaches back
// into the fields above it.
function buildRulingBody(item, answer, answerScope) {
  const head = [`**Kind:** ${item.kind}`];
  if (item.territory) head.push(`**Territory:** ${item.territory}`);
  if (item.aspect) head.push(`**Aspect:** ${item.aspect}`);
  if (item.kind === 'lower') head.push(`**Scope:** ${answerScope}`);
  const lines = [head.join(' · ')];
  if (item.why) lines.push(`**Question:** ${item.why}`);
  lines.push(`**Answer:** ${answer}`);
  lines.push(`**By:** client · **At:** ${nowIso()}`);
  return lines.join('\n');
}

// answerAsk(horde, id, {answer, scope}) — records the client's answer as a decision first, and
// only marks the item answered once that succeeds: a decision that could not be written (a
// duplicate slug, a read-only decisions.md) leaves the item exactly as open as it was, because
// answering it and recording why must never come apart in that direction.
export function answerAsk(horde, id, { answer, scope } = {}) {
  if (!answer) throw new Error('answer required');
  const doc = loadAsks(horde);
  const item = doc.items.find((x) => x.id === id);
  if (!item) throw new Error(`no such ask: ${id}`);
  if (item.state === 'answered') throw new Error(`already answered: ${id}`);
  if (scope !== undefined && item.kind !== 'lower') {
    throw new Error(`--scope is only accepted for kind "lower" (this ask is "${item.kind}")`);
  }
  if (scope !== undefined && scope !== 'once' && scope !== 'mission') {
    throw new Error('--scope must be "once" or "mission"');
  }
  const answerScope = item.kind === 'lower' ? (scope || 'once') : undefined;
  const ruling = buildRulingBody(item, answer, answerScope);
  appendDecision(horde, { slug: `ask-${id}`, ruling, ticket: item.ticket });

  const fresh = loadAsks(horde);
  const freshItem = fresh.items.find((x) => x.id === id);
  freshItem.state = 'answered';
  freshItem.answer = answer;
  if (answerScope) freshItem.answerScope = answerScope;
  freshItem.answeredAt = nowIso();
  save(horde, fresh);
  return freshItem;
}

function cmdAdd(horde, positional, flags) {
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
  emit(item, flags, () => `ask ${item.id} opened (${item.kind})`);
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
  const doc = loadAsks(horde);
  const it = doc.items.find((x) => x.id === id);
  if (!it) fail(`no such ask: ${id}`);
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
  emit(item, flags, () => `ask ${id} answered — recorded as ask-${id}`);
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

if (isMain(import.meta.url)) main();
