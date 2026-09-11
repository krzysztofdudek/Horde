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
// Exports `appendDecision` so ask.mjs can record the client's answer in the same format, under
// slug `ask-<id>`, without shelling out to this file.

import { join, dirname } from 'node:path';
import {
  mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import {
  hordePath, readConfig, readText, appendText, today, fail, parseArgs, emit, isMain, resolveHorde,
} from './_lib.mjs';
import { ygCommand } from './node.mjs';

const ENTRY_RE = /^## (\d{4}-\d{2}-\d{2}) · ([^\s·]+)(?: · ticket (\S+))?(?: · node (\S+))?\s*$/;

const USAGE = `usage: decide.mjs <command> [options]

commands:
  add <slug> "<ruling>" [--ticket NNN] [--node n] [--horde h]
      appends a new entry; refuses a duplicate slug. When --node is given it refuses and prints
      the "yg log add" command to run instead — a node's decisions belong in the graph's own log.
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

// A duplicate-slug check that reads, then a write some time later, is a race between two
// processes — two `ask answer` calls landing on the same item, say — that a check alone cannot
// close: both can read "no such slug" before either has written. `withDecisionsLock` closes it
// with the same exclusive-create trick land.mjs's gate lock uses (`wx` refuses when the file
// already exists), scoped to this one horde's decisions.md and held only for the check-and-append
// itself, never across a caller's own work.
function decisionsLockPath(horde) { return decisionsPath(horde) + '.lock'; }

function withDecisionsLock(horde, fn) {
  const path = decisionsLockPath(horde);
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw new Error(`decisions.md is locked by another process — timed out waiting for ${path}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try { rmSync(path, { force: true }); } catch { /* already gone */ }
  }
}

function formatHeading(entry) {
  let h = `## ${entry.date} · ${entry.slug}`;
  if (entry.ticket) h += ` · ticket ${entry.ticket}`;
  if (entry.node) h += ` · node ${entry.node}`;
  return h;
}

// appendDecision(horde, {slug, ruling, ticket, node}) — throws on a missing field, a duplicate
// slug, or (when node is given) on the graph-redirect case; the caller decides how to report that
// (decide.mjs's own CLI turns it into a fail(), while a caller like ask.mjs never passes
// node and so never sees it).
export function appendDecision(horde, { slug, ruling, ticket, node } = {}) {
  if (!slug) throw new Error('slug required');
  if (!ruling) throw new Error('ruling required');

  if (node) {
    const cfg = readConfig() || {};
    const err = new Error(
      `architectural decisions for a node live in the graph's own log, not here — run: `
      + `${ygCommand(cfg).display} log add --node ${node} --reason "${ruling}"`,
    );
    err.yggdrasilRedirect = true;
    throw err;
  }

  return withDecisionsLock(horde, () => {
    const path = decisionsPath(horde);
    const existing = readText(path) || '';
    const entries = parseEntries(existing);
    if (entries.some((e) => e.slug === slug)) throw new Error(`duplicate slug: ${slug}`);

    const entry = { date: today(), slug, ticket: ticket ? String(ticket) : null, node: node || null };
    const block = `${formatHeading(entry)}\n${ruling}\n`;
    const sep = existing.length > 0 && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
    appendText(path, sep + block);
    return { ...entry, body: ruling };
  });
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
