#!/usr/bin/env node
// horde skill — dissent.mjs
//
// The channel of disagreement: an owner may file a dissent against a ruling without it blocking
// anything. It is recorded, answered exactly once (via decide.mjs's appendDecision — imported,
// not shelled out — under slug `dissent-<id>`), and then closed for good.
//
// State: hordes/<horde>/dissents.json (source of truth) + dissents.md (rendered).

import { hordePath, readJSON, writeJSON, nowIso, fail, parseArgs, emit, isMain, resolveHorde } from './_lib.mjs';
import { appendDecision } from './decide.mjs';
import { trace as traceRoster } from './roster.mjs';

const USAGE = `usage: dissent.mjs <command> [options]

commands:
  add "<why>" --ticket NNN --by <owner> [--against <decision-slug>] [--horde h]
  list [--open] [--horde h]
      open first, newest first.
  answer <id> "<answer>" --by <name> [--horde h]
      records the answer and who gave it (the director or architect who made the disputed
      ruling), closes the dissent, and appends the answer to decisions.md as dissent-<id>.
      Refuses an already-answered dissent.
  show <id> [--horde h]

options: --json  --help`;

function jsonPath(horde) { return hordePath(horde, 'dissents.json'); }

function load(horde) {
  const doc = readJSON(jsonPath(horde), null);
  return doc && Array.isArray(doc.items) ? doc : { items: [] };
}

function save(horde, doc) {
  writeJSON(jsonPath(horde), doc, { render });
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'open' ? -1 : 1;
    return (b.at || '').localeCompare(a.at || '');
  });
}

function render(doc) {
  const items = sortItems(doc.items);
  const lines = ['# Dissents', ''];
  if (items.length === 0) lines.push('(none)');
  for (const it of items) {
    const head = [`[${it.id}] ticket ${it.ticket}`];
    if (it.against) head.push(`against ${it.against}`);
    head.push(it.state);
    lines.push(`## ${head.join(' · ')}`);
    lines.push(`by: ${it.by} · at: ${it.at}`);
    lines.push(it.why);
    if (it.state === 'closed') {
      lines.push('');
      lines.push(`answer (${it.answeredAt}, by ${it.answeredBy}): ${it.answer}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function nextId(doc) {
  let max = 0;
  for (const it of doc.items) {
    const n = Number(it.id);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return String(max + 1);
}

function cmdAdd(horde, positional, flags) {
  const why = positional[0];
  if (!why) fail('add requires "<why>"');
  if (!flags.ticket) fail('add requires --ticket NNN');
  if (!flags.by) fail('add requires --by <owner>');
  const doc = load(horde);
  const id = nextId(doc);
  const item = { id, ticket: String(flags.ticket), by: flags.by, why, at: nowIso(), state: 'open' };
  if (flags.against) item.against = flags.against;
  doc.items.push(item);
  save(horde, doc);
  emit(item, flags, () => `dissent ${id} opened (ticket ${item.ticket})`);
}

function cmdList(horde, positional, flags) {
  const doc = load(horde);
  let items = sortItems(doc.items);
  if (flags.open) items = items.filter((it) => it.state === 'open');
  emit(items, flags, () => {
    if (items.length === 0) return '(no dissents)';
    return items.map((it) => [it.id, it.state, it.ticket, it.by, it.why.split('\n')[0]].join(' ')).join('\n');
  });
}

function cmdShow(horde, positional, flags) {
  const id = positional[0];
  if (!id) fail('show requires <id>');
  const doc = load(horde);
  const it = doc.items.find((x) => x.id === id);
  if (!it) fail(`no such dissent: ${id}`);
  emit(it, flags, () => {
    const head = [`[${it.id}] ticket ${it.ticket}`];
    if (it.against) head.push(`against ${it.against}`);
    head.push(it.state);
    const lines = [head.join(' · '), `by ${it.by} at ${it.at}`, it.why];
    if (it.state === 'closed') lines.push(`answer (${it.answeredAt}, by ${it.answeredBy}): ${it.answer}`);
    return lines.join('\n');
  });
}

function cmdAnswer(horde, positional, flags) {
  const [id, answer] = positional;
  if (!id || !answer) fail('answer requires <id> "<answer>"');
  if (!flags.by) fail('answer requires --by <name>');
  const doc = load(horde);
  const it = doc.items.find((x) => x.id === id);
  if (!it) fail(`no such dissent: ${id}`);
  if (it.state === 'closed') fail(`already answered: ${id}`);
  it.state = 'closed';
  it.answer = answer;
  it.answeredBy = flags.by;
  it.answeredAt = nowIso();
  save(horde, doc);
  try {
    appendDecision(horde, { slug: `dissent-${id}`, ruling: `${answer} — by ${flags.by}`, ticket: it.ticket });
  } catch (e) {
    fail(`dissent ${id} marked answered, but recording the decision failed: ${e.message}`);
  }
  traceRoster(horde, flags.by);
  emit(it, flags, () => `dissent ${id} answered by ${flags.by} — recorded as dissent-${id}`);
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
