#!/usr/bin/env node
// horde skill — decide.mjs
//
// Durable rulings and lessons, appended to hordes/<horde>/decisions.md. Architectural decisions
// (ones tied to a node, in a repository with Yggdrasil) belong in the graph's own log instead —
// this tool refuses to store those and prints the `yg log add` command to run in their place.
//
// Entry format (exact):
//   ## <YYYY-MM-DD> · <slug> [· ticket NNN] [· node n]
//   <ruling text, may be multi-line>
//
// Exports `appendDecision` so escalate.mjs and dissent.mjs can record a ruling/answer in the
// same format without shelling out to this file.

import { join } from 'node:path';
import {
  hordePath, readConfig, readText, appendText, today, fail, parseArgs, emit, isMain, resolveHorde,
} from './_lib.mjs';

const ENTRY_RE = /^## (\d{4}-\d{2}-\d{2}) · ([^\s·]+)(?: · ticket (\S+))?(?: · node (\S+))?\s*$/;

const USAGE = `usage: decide.mjs <command> [options]

commands:
  add <slug> "<ruling>" [--ticket NNN] [--node n] [--horde h]
      appends a new entry; refuses a duplicate slug. When --node is given and the repository's
      nodeSource is "yggdrasil", refuses and prints the "yg log add" command to run instead.
  list [--grep <re>] [--node n] [--horde h]
      prints "date slug ticket node first-line" rows, newest first.
  show <slug> [--horde h]
      prints the full entry.

options: --json  --help`;

function decisionsPath(horde) {
  return hordePath(horde, 'decisions.md');
}

// Parse decisions.md content into entries { date, slug, ticket, node, body }. Any `## ` heading
// that doesn't match the date-slug pattern (a stray preamble, a lessons banner) is skipped along
// with its body, so free text can live in the file without confusing the parser.
export function parseEntries(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const [, date, slug, ticket, node] = m;
    i++;
    const bodyLines = [];
    while (i < lines.length && !lines[i].startsWith('## ')) { bodyLines.push(lines[i]); i++; }
    while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
    entries.push({ date, slug, ticket: ticket || null, node: node || null, body: bodyLines.join('\n') });
  }
  return entries;
}

function formatHeading(entry) {
  let h = `## ${entry.date} · ${entry.slug}`;
  if (entry.ticket) h += ` · ticket ${entry.ticket}`;
  if (entry.node) h += ` · node ${entry.node}`;
  return h;
}

// appendDecision(horde, {slug, ruling, ticket, node}) — throws on a missing field, a duplicate
// slug, or (when node is given and nodeSource is "yggdrasil") on the yggdrasil-redirect case;
// the caller decides how to report that (decide.mjs's own CLI turns it into a fail(), while a
// caller like escalate.mjs never passes node and so never sees it).
export function appendDecision(horde, { slug, ruling, ticket, node } = {}) {
  if (!slug) throw new Error('slug required');
  if (!ruling) throw new Error('ruling required');
  const path = decisionsPath(horde);
  const existing = readText(path) || '';
  const entries = parseEntries(existing);
  if (entries.some((e) => e.slug === slug)) throw new Error(`duplicate slug: ${slug}`);

  if (node) {
    const cfg = readConfig();
    if (cfg && cfg.nodeSource === 'yggdrasil') {
      const err = new Error(
        `architectural decisions for a node live in the graph's own log, not here — run: `
        + `yg log add --node ${node} --reason "${ruling}"`,
      );
      err.yggdrasilRedirect = true;
      throw err;
    }
  }

  const entry = { date: today(), slug, ticket: ticket ? String(ticket) : null, node: node || null };
  const block = `${formatHeading(entry)}\n${ruling}\n`;
  const sep = existing.length > 0 && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  appendText(path, sep + block);
  return { ...entry, body: ruling };
}

function cmdAdd(horde, positional, flags) {
  const [slug, ruling] = positional;
  if (!slug || !ruling) fail('add requires <slug> "<ruling>"');
  let entry;
  try {
    entry = appendDecision(horde, { slug, ruling, ticket: flags.ticket, node: flags.node });
  } catch (e) {
    fail(e.message);
  }
  emit(entry, flags, () => `decision added: ${slug}`);
}

function cmdList(horde, positional, flags) {
  let entries = parseEntries(readText(decisionsPath(horde))).slice().reverse();
  if (flags.node) entries = entries.filter((e) => e.node === flags.node);
  if (flags.grep) {
    const re = new RegExp(flags.grep, 'i');
    entries = entries.filter((e) => re.test(e.slug) || re.test(e.body));
  }
  emit(entries, flags, () => {
    if (entries.length === 0) return '(no decisions)';
    return entries
      .map((e) => [e.date, e.slug, e.ticket || '-', e.node || '-', (e.body.split('\n')[0] || '').trim()].join(' '))
      .join('\n');
  });
}

function cmdShow(horde, positional, flags) {
  const slug = positional[0];
  if (!slug) fail('show requires <slug>');
  const entries = parseEntries(readText(decisionsPath(horde)));
  const e = entries.find((x) => x.slug === slug);
  if (!e) fail(`no such decision: ${slug}`);
  emit(e, flags, () => `${formatHeading(e)}\n${e.body}`);
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
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
