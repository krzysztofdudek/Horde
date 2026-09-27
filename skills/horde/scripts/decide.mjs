#!/usr/bin/env node
// horde skill — decide.mjs
//
// Durable rulings and lessons, in the mission's own record: the Jarl loop's decisions.md
// (.horde/hordes/<horde>/.jarl/decisions.md, loop.mjs). The loop writes and numbers nothing here but
// the ruling itself — its date and slug heading, its text, who ruled, what it supersedes and the ticket
// it settles — so Jarl's own views (`jarl.mjs decisions --live --root .horde/hordes/<h>`) read every
// ruling this writes. Architectural decisions (ones tied to a node, in a repository with Yggdrasil)
// belong in the graph's own log instead — this tool refuses to store those and prints the `yg log add`
// command to run in their place.
//
// Entry format, as the loop writes it:
//   ## <YYYY-MM-DD> · <slug>
//   <ruling text, may be multi-line>
//
//   **Settles:** NNN       (with --ticket: the ticket the ruling is about; its Evidence carries the ruling too)
//   **By:** <who>
//   **Supersedes:** <slug> (with --supersedes; the earlier ruling is marked Superseded by in place)

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  fail, parseArgs, emit, isMain, resolveHorde, readConfig, readText, parseDecisionEntries, runMain,
  hordePath, createLockFile, processAlive, readLockText, removeStaleLock, sleepSync, nowIso,
} from './_lib.mjs';
import { ygCommand } from './node.mjs';
import { decideLoop, decisionsFile, ticketFile } from './loop.mjs';
import { loadAsks } from './ask.mjs';

const USAGE = `usage: decide.mjs <command> [options]

commands:
  add <slug> "<ruling>" [--ticket NNN] [--node n] [--by who] [--supersedes <slug>] [--horde h]
      appends a new ruling to the mission's record; refuses a duplicate slug. --ticket names the
      ticket the ruling settles (written on the ticket too). --supersedes names an earlier ruling
      this one replaces (marked as superseded in place). --by says who ruled (default: director).
      When --node is given it refuses and prints the "yg log add" command to run instead — a node's
      decisions belong in the graph's own log.
  list [--grep <re>] [--node n] [--horde h]
      prints "date slug ticket node first-line" rows, newest first.
  show <slug> [--horde h]
      prints the full entry.

options: --json  --help`;

// The rulings this record holds: { date, slug, ticket, node, body }. Any `## ` heading that doesn't
// match the date-slug pattern is skipped along with its body.
export function parseEntries(text, horde) {
  // A ruling that answers a question (ask-NNN) is about the ticket the question was asked on.
  let askTickets = new Map();
  if (horde) {
    try { askTickets = new Map(loadAsks(horde).items.filter((a) => a.ticket).map((a) => [a.id.slice(2), a.ticket])); } catch { askTickets = new Map(); }
  }
  return parseDecisionEntries(text)
    .filter((e) => e.slug)
    .map(({
      date, slug, ticket, node, body,
    }) => {
      const asked = /^ask-(\d+)$/.exec(slug);
      return {
        date, slug, ticket: ticket || (asked ? askTickets.get(asked[1]) || null : null), node, body,
      };
    });
}

// The Horde side of the mission's rulings: one lock, held by whatever spends a client's answer. The
// loop's own lock guards every single write to decisions.md; this one guards the longer protocol a
// one-time answer is spent by — read it, merge the branch it lets through, mark it spent — so two
// landings leaning on one answer cannot both pass on it. It is Horde's alone (hordes/<h>/decisions.lock),
// held across a merge that runs the repository's own hooks, which the loop's lock is never held across.
//
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
function decisionsLockPath(horde) { return hordePath(horde, 'decisions.lock'); }

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
    const seen = readLockText(path);
    let held = null;
    try { held = JSON.parse(seen); } catch { held = null; }
    // An unreadable or half-written lock file names no pid to wait on, so it is treated exactly
    // like a dead one: taken over rather than waited on.
    if (!held || !processAlive(held.pid)) {
      removeStaleLock(path, seen);
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

// appendDecision(horde, {slug, ruling, ticket, node, by, supersedes}) — throws on a missing field, a
// duplicate slug, or (when node is given) on the graph-redirect case; the caller decides how to report
// it. The loop holds its own lock for the check and the write.
export function appendDecision(horde, {
  slug, ruling, ticket, node, by, supersedes,
} = {}) {
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

  const settles = ticket ? String(ticket).replace(/^t-/, '').padStart(3, '0') : null;
  if (settles && !ticketFile(horde, settles)) throw new Error(`no such ticket: ${settles} — a ruling names a ticket of this mission (tk.mjs list)`);
  const done = decideLoop(horde, slug, ruling, {
    by: by || 'director', ...(settles ? { settles } : {}), ...(supersedes ? { supersedes } : {}),
  });
  return {
    date: new Date().toISOString().slice(0, 10), slug, ticket: settles, node: null, body: ruling, by: done.by, supersedes: done.supersedes,
  };
}

function cmdAdd(horde, positional, flags) {
  const [slug, ruling] = positional;
  if (!slug || !ruling) fail('add requires <slug> "<ruling>"');
  let entry;
  try {
    entry = appendDecision(horde, {
      slug, ruling, ticket: flags.ticket, node: flags.node, by: flags.by, supersedes: flags.supersedes,
    });
  } catch (e) {
    fail(e.message);
  }
  emit(entry, flags, () => `decision added: ${slug}`);
}

function cmdList(horde, positional, flags) {
  let entries = parseEntries(readText(decisionsFile(horde)), horde).slice().reverse();
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
  const entries = parseEntries(readText(decisionsFile(horde)), horde);
  const e = entries.find((x) => x.slug === slug);
  if (!e) fail(`no such decision: ${slug}`);
  emit(e, flags, () => `## ${e.date} · ${e.slug}\n${e.body}`);
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
