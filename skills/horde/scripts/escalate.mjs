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

import {
  hordePath, readConfig, readJSON, writeJSON, nowIso, fail, parseArgs, emit, isMain, resolveHorde,
} from './_lib.mjs';
import { appendDecision } from './decide.mjs';
import { findTicket, nodesOf } from './tk.mjs';
import { ygCommand } from './node.mjs';

// "quality" is the one kind nobody files by hand: wave.mjs close opens it when the wave's quality
// index came out lower than the wave before it, because a graph that got weaker is the chairman's
// business (ruling quality-always-authorised — raising enforcement is autonomous, lowering it is
// not).
const KINDS = ['charter', 'contract', 'claim', 'conflict', 'boundary', 'cost', 'unverifiable', 'rules', 'quality'];

const USAGE = `usage: escalate.mjs <command> [options]

commands:
  add "<why>" --kind <${KINDS.join('|')}> [--ticket NNN] [--by steward|architect|owner]
      [--horde h]
  list [--open] [--horde h]
      open and forwarded first, newest first.
  rule <id> "<ruling>" [--to-user] [--by <name>] [--horde h]
      without --to-user: rules the escalation, recording the ruling as a decision (esc-<id>) and
      closing it. With --to-user: marks it "forwarded" to the chairman — still open, no decision
      recorded yet — until rule is called again on the same id with the chairman's answer.
  show <id> [--horde h]
  recurring [--min <n>] [--horde h]
      the ruled escalations grouped by kind and by the node their ticket names; a group of
      <n> (default 3) or more is an answer this horde keeps giving by hand, so it prints the
      rule proposal: the rulings as evidence, one line of rule text, and — where the group has a
      node — the steps that file it: create the rule in the graph, then record why in its own
      log. It prints those steps rather than running them — filing a rule is the architect's
      move, not this tool's.

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
    if (Array.isArray(it.next) && it.next.length) {
      lines.push('');
      lines.push('the director raises it with:');
      for (const cmd of it.next) lines.push(`- ${cmd}`);
    }
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

// addEscalation(horde, {why, kind, ticket, by}) — opens one escalation and returns it. Exported so
// wave.mjs's close can open the `quality` escalation a fallen quality index owes without shelling
// out to this file; throws rather than exiting, so its caller decides how to report it.
export function addEscalation(horde, {
  why, kind, ticket, by,
} = {}) {
  if (!why) throw new Error('why required');
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join('|')}`);
  const doc = load(horde);
  const id = nextId(doc);
  const item = { id, kind, why, by: by || 'steward', at: nowIso(), state: 'open' };
  if (ticket) item.ticket = String(ticket);
  doc.items.push(item);
  save(horde, doc);
  return item;
}

function cmdAdd(horde, positional, flags) {
  const why = positional[0];
  if (!why) fail('add requires "<why>"');
  if (typeof flags.kind !== 'string' || !KINDS.includes(flags.kind)) fail(`--kind is required, one of: ${KINDS.join('|')}`);
  let item;
  try {
    item = addEscalation(horde, {
      why, kind: flags.kind, ticket: flags.ticket, by: flags.by,
    });
  } catch (e) {
    fail(e.message);
  }
  emit(item, flags, () => `escalation ${item.id} opened (${item.kind})`);
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
    if (Array.isArray(it.next) && it.next.length) {
      lines.push('the director raises it with:');
      for (const cmd of it.next) lines.push(`  ${cmd}`);
    }
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
  emit(it, flags, () => `escalation ${id} ruled — recorded as esc-${id}`);
}

// ---- recurring rulings become rule proposals -------------------------------------------------
//
// A ruling answers one escalation; the same ruling given three times over the same node answers
// a question nobody should have to ask again. That is what a rule IS, so the third one is not
// another decision, it is a proposal to write the answer down where the graph enforces it
// (ruling escalations-become-rules). This groups the ruled escalations by (kind, node) and hands
// a group past the threshold to the architect as a proposal with its own evidence.
//
// The node comes from the escalation's ticket — an escalation carries no node of its own — so an
// escalation with no ticket, or one whose ticket names no node, groups under "(no node)" and can
// still recur; it just has nowhere in the graph to be filed, and the proposal says so instead of
// naming a target it made up.

const NO_NODE = '(no node)';

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

function nodeOfEscalation(horde, it) {
  if (!it.ticket) return NO_NODE;
  let found = null;
  try { found = findTicket(horde, it.ticket); } catch { found = null; }
  if (!found) return NO_NODE;
  const nodes = nodesOf(found.text);
  return nodes.length ? nodes[0] : NO_NODE;
}

// The command that files the proposal. Where the group has a node, this IS proposing a rule — the
// answer nobody should have to give a fourth time — and once it exists, its own reasoning belongs
// in its own log (152/153), not the node's: the node only earns a line once the rule reaches a
// rung that changes what its code is held to, which nothing here has granted yet. So the step is
// two: the architect names and files the rule (an edit this tool does not make), then records why
// in its own history — through config.ygCommand, so a checkout running a local build gets its own
// binary named. A group with no node has nowhere in the graph to go, and the horde's own decision
// record is the honest target.
function fileItCommand(cfg, node, rule) {
  const quoted = rule.replace(/"/g, '\\"');
  if (node !== NO_NODE) {
    return `file the rule (.yggdrasil/aspects/<id>/yg-aspect.yaml, attached to ${node}), then `
      + `${ygCommand(cfg).display} aspects log add --aspect <id> --reason "${quoted}" — its own log is `
      + 'where the reasoning belongs, not the node\'s';
  }
  return `decide.mjs add <slug> "${quoted}"`;
}

function cmdRecurring(horde, positional, flags) {
  const min = flags.min === undefined ? 3 : Number(flags.min);
  if (!Number.isFinite(min) || min < 2) fail('--min must be a whole number of at least 2');
  const cfg = readConfig() || {};
  const ruled = load(horde).items.filter((it) => it.state === 'ruled');

  const byKey = new Map();
  for (const it of ruled) {
    const node = nodeOfEscalation(horde, it);
    const key = `${it.kind} ${node}`;
    if (!byKey.has(key)) byKey.set(key, { kind: it.kind, node, escalations: [] });
    byKey.get(key).escalations.push({
      id: it.id, at: it.ruledAt || it.at, ticket: it.ticket || null, ruling: firstLine(it.ruling),
    });
  }

  const groups = [...byKey.values()]
    .filter((g) => g.escalations.length >= min)
    .map((g) => {
      const ordered = [...g.escalations].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const latest = ordered[ordered.length - 1];
      const where = g.node === NO_NODE ? 'this horde' : g.node;
      const rule = `${g.kind} on ${where}: answered the same way ${ordered.length} times `
        + `(${ordered.map((e) => `esc-${e.id}`).join(', ')}) — ${latest.ruling}`;
      return {
        kind: g.kind,
        node: g.node,
        count: ordered.length,
        escalations: ordered,
        rule,
        command: fileItCommand(cfg, g.node, rule),
      };
    })
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.node.localeCompare(b.node));

  emit({ min, groups }, flags, () => {
    if (groups.length === 0) return `no ruling has recurred ${min} times yet — nothing to propose as a rule`;
    const lines = [];
    for (const g of groups) {
      lines.push(`${g.kind} · node ${g.node} — ${g.count} rulings`);
      lines.push('  evidence:');
      for (const e of g.escalations) {
        lines.push(`    esc-${e.id} · ${String(e.at).slice(0, 10)} · ticket ${e.ticket || '-'} — ${e.ruling}`);
      }
      lines.push(`  rule: ${g.rule}`);
      lines.push(`  file it: ${g.command}`);
      lines.push('');
    }
    lines.push('The architect does that filing — this tool proposes, it never files.');
    return lines.join('\n');
  });
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
    case 'recurring': return cmdRecurring(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
