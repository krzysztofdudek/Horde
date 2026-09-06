#!/usr/bin/env node
// horde skill — escalate.mjs
//
// The channel up: a steward, owner or architect opens an escalation when it hits something
// outside its decision rights; the director rules on it, which records a durable decision (via
// decide.mjs's appendDecision — imported, not shelled out) under slug `esc-<id>`.
//
// `rule --to-user` marks the item "forwarded" instead of ruling it outright: the director has
// relayed it to the chairman and is waiting on their answer. The item stays open (it is not
// "ruled" — no decision is recorded yet) until `rule` is called again, without --to-user, with
// the chairman's actual answer.
//
// State: hordes/<horde>/escalations.json (source of truth) + escalations.md (rendered).

import { hordePath, readJSON, writeJSON, nowIso, fail, parseArgs, emit, isMain, resolveHorde } from './_lib.mjs';
import { appendDecision } from './decide.mjs';
import { trace as traceRoster } from './roster.mjs';

// "adjudicate" is not a finding to rule on so much as a ticket the fix-loop breaker gave up on:
// tk.mjs status <ticket> changes refuses past config.fixRounds' cap and names this exact command
// as the next step, so the director rules a way forward instead of another round.
const KINDS = ['charter', 'contract', 'claim', 'conflict', 'boundary', 'cost', 'unverifiable', 'rules', 'structure', 'adjudicate'];

const USAGE = `usage: escalate.mjs <command> [options]

commands:
  add "<why>" --kind <${KINDS.join('|')}> [--ticket NNN] [--by steward|architect|owner] [--horde h]
  list [--open] [--horde h]
      open and forwarded first, newest first.
  rule <id> "<ruling>" [--to-user] [--by <name>] [--horde h]
      without --to-user: rules the escalation, recording the ruling as a decision (esc-<id>) and
      closing it. With --to-user: marks it "forwarded" to the chairman — still open, no decision
      recorded yet — until rule is called again on the same id with the chairman's answer.
      --by traces that name in the roster when it is one (optional; a director ruling directly
      often isn't).
  show <id> [--horde h]

options: --json  --help`;

function jsonPath(horde) { return hordePath(horde, 'escalations.json'); }

function load(horde) {
  const doc = readJSON(jsonPath(horde), null);
  return doc && Array.isArray(doc.items) ? doc : { items: [] };
}

function save(horde, doc) {
  writeJSON(jsonPath(horde), doc, { render });
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const aOpen = a.state !== 'ruled';
    const bOpen = b.state !== 'ruled';
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return (b.at || '').localeCompare(a.at || '');
  });
}

function render(doc) {
  const items = sortItems(doc.items);
  const lines = ['# Escalations', ''];
  if (items.length === 0) lines.push('(none)');
  for (const it of items) {
    const head = [`[${it.id}] ${it.kind}`];
    if (it.ticket) head.push(`ticket ${it.ticket}`);
    head.push(it.state);
    lines.push(`## ${head.join(' · ')}`);
    lines.push(`by: ${it.by} · at: ${it.at}`);
    lines.push(it.why);
    if (it.state === 'forwarded') {
      lines.push('');
      lines.push(`forwarded to the chairman (${it.forwardedAt}): ${it.ruling}`);
    } else if (it.state === 'ruled') {
      lines.push('');
      lines.push(`ruling (${it.ruledAt}): ${it.ruling}`);
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
  if (typeof flags.kind !== 'string' || !KINDS.includes(flags.kind)) fail(`--kind is required, one of: ${KINDS.join('|')}`);
  const doc = load(horde);
  const id = nextId(doc);
  const item = { id, kind: flags.kind, why, by: flags.by || 'steward', at: nowIso(), state: 'open' };
  if (flags.ticket) item.ticket = String(flags.ticket);
  doc.items.push(item);
  save(horde, doc);
  emit(item, flags, () => `escalation ${id} opened (${item.kind})`);
}

function cmdList(horde, positional, flags) {
  const doc = load(horde);
  let items = sortItems(doc.items);
  if (flags.open) items = items.filter((it) => it.state !== 'ruled');
  emit(items, flags, () => {
    if (items.length === 0) return '(no escalations)';
    return items.map((it) => [it.id, it.state, it.kind, it.ticket || '-', it.why.split('\n')[0]].join(' ')).join('\n');
  });
}

function cmdShow(horde, positional, flags) {
  const id = positional[0];
  if (!id) fail('show requires <id>');
  const doc = load(horde);
  const it = doc.items.find((x) => x.id === id);
  if (!it) fail(`no such escalation: ${id}`);
  emit(it, flags, () => {
    const head = [`[${it.id}] ${it.kind}`];
    if (it.ticket) head.push(`ticket ${it.ticket}`);
    head.push(it.state);
    const lines = [head.join(' · '), `by ${it.by} at ${it.at}`, it.why];
    if (it.state === 'forwarded') lines.push(`forwarded to the chairman (${it.forwardedAt}): ${it.ruling}`);
    if (it.state === 'ruled') lines.push(`ruling (${it.ruledAt}): ${it.ruling}`);
    return lines.join('\n');
  });
}

function cmdRule(horde, positional, flags) {
  const [id, ruling] = positional;
  if (!id || !ruling) fail('rule requires <id> "<ruling>"');
  const doc = load(horde);
  const it = doc.items.find((x) => x.id === id);
  if (!it) fail(`no such escalation: ${id}`);
  if (it.state === 'ruled') fail(`already ruled: ${id}`);

  if (flags['to-user']) {
    it.state = 'forwarded';
    it.ruling = ruling;
    it.forwardedAt = nowIso();
    save(horde, doc);
    if (flags.by) traceRoster(horde, flags.by);
    emit(it, flags, () => `escalation ${id} forwarded to the chairman`);
    return;
  }

  it.state = 'ruled';
  it.ruling = ruling;
  it.ruledAt = nowIso();
  delete it.forwardedAt;
  save(horde, doc);
  try {
    appendDecision(horde, { slug: `esc-${id}`, ruling, ticket: it.ticket });
  } catch (e) {
    fail(`escalation ${id} marked ruled, but recording the decision failed: ${e.message}`);
  }
  if (flags.by) traceRoster(horde, flags.by);
  emit(it, flags, () => `escalation ${id} ruled — recorded as esc-${id}`);
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
    case 'rule': return cmdRule(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
