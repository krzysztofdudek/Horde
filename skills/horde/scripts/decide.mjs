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
  mkdirSync, readFileSync, rmSync,
} from 'node:fs';
import {
  hordePath, readConfig, readText, appendText, today, fail, parseArgs, emit, isMain, resolveHorde,
  parseDecisionEntries, createLockFile, processAlive, sleepSync, nowIso,
  runMain,
} from './_lib.mjs';
import { ygCommand } from './node.mjs';

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

// The decisions this file records: { date, slug, ticket, node, body }. Any `## ` heading that
// doesn't match the date-slug pattern (a stray preamble, a lessons banner) is skipped along with
// its body, so free text can live in the file without confusing anything that reads it by slug.
export function parseEntries(text) {
  return parseDecisionEntries(text)
    .filter((e) => e.slug)
    .map(({
      date, slug, ticket, node, body,
    }) => ({
      date, slug, ticket, node, body,
    }));
}

// A duplicate-slug check that reads, then a write some time later, is a race between two
// processes — two `ask answer` calls landing on the same item, say — that a check alone cannot
// close: both can read "no such slug" before either has written. `withDecisionsLock` closes it,
// scoped to this one horde's decisions.md and held only for the check-and-append itself, never
// across a caller's own work.
//
// Built on `_lib.mjs`'s shared lock primitives — `createLockFile` (content written whole to a
// name nobody is watching and only then linked into place, so a racing caller can never read a
// lock still being written as an abandoned one), `processAlive` and `sleepSync` — the same three
// land.mjs's gate lock, retro.mjs's own lock and `_lib.mjs`'s own tree and queue locks already
// use, rather than a lock of its own that knows nothing of any of that. A process that dies
// holding this lock (killed outright, a container recycled) must not wedge every decision and
// answer on this horde forever, so the lock file names the pid that took it, and a lock whose pid
// is no longer running is taken over immediately rather than waited out.
function decisionsLockPath(horde) { return decisionsPath(horde) + '.lock'; }

const DECISIONS_LOCK_WAIT_MS = 10000;
const DECISIONS_LOCK_POLL_MS = 20;

export function withDecisionsLock(horde, fn, { waitMs = DECISIONS_LOCK_WAIT_MS } = {}) {
  const path = decisionsLockPath(horde);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      createLockFile(path, `${JSON.stringify({ pid: process.pid, horde, at: nowIso() }, null, 2)}\n`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let held = null;
    try { held = JSON.parse(readFileSync(path, 'utf8')); } catch { held = null; }
    // An unreadable or half-written lock file names no pid to wait on, so it is treated exactly
    // like a dead one: taken over rather than waited on.
    if (!held || !processAlive(held.pid)) {
      try { rmSync(path, { force: true }); } catch { /* someone else got there first */ }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`decisions.md for "${horde}" is locked by another process (pid ${held.pid}, taken ${held.at || 'at an unrecorded time'}) — timed out waiting for ${path}`);
    }
    sleepSync(DECISIONS_LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8'));
      if (holder.pid !== process.pid) throw new Error('not ours');
      rmSync(path, { force: true });
    } catch { /* unreadable, already gone, or already taken over by someone else: nothing to do */ }
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

if (isMain(import.meta.url)) runMain(main);
