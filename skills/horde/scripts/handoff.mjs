#!/usr/bin/env node
// horde skill — handoff.mjs
//
// The state of intent between sessions: what's in flight, who is waited on, and what should
// happen next. The mechanical state (queue items, tickets) lives elsewhere; this is the
// narrative layer a new session reads first.
//
// One file per horde: hordes/<horde>/handoff.json (source of truth) + handoff.md (rendered) — a
// session that returns to a mission boots from this, whatever it was doing when it left off.

import {
  hordePath, teamPath, readJSON, writeJSON, readText, git, nowIso, fail, parseArgs, emit, isMain,
  resolveHorde, asArray,
} from './_lib.mjs';

const USAGE = `usage: handoff.mjs <command> [options]

commands:
  write --summary "<s>" [--next "<a>"]... [--horde h]
      writes a fresh handoff: head from git, inFlight from the running items of the queue.
  read [--horde h]
      prints the handoff, or "fresh start — no handoff recorded" if none exists yet.
  add-waiting <who> "<what>" [--horde h]
  rm-waiting <who> [--horde h]

options: --json  --help`;

// --by and --team addressed the director/steward split a sub-team's own handoff needed; there is
// only ever one handoff per horde now, so both are refused rather than silently accepted and
// ignored — a flag that used to change which file was written must never quietly stop mattering.
function rejectStaleFlags(flags) {
  if (flags.by !== undefined) fail('--by no longer exists — there is only one handoff per horde now, always director-level');
  if (flags.team !== undefined) fail('unknown flag: --team — there is only one handoff per horde now, never scoped to a team');
}

function docPath(horde) {
  return hordePath(horde, 'handoff.json');
}

function emptyDoc() {
  return {
    at: null, head: null, summary: '', inFlight: [], next: [], waitingOn: [],
  };
}

function load(horde) {
  const doc = readJSON(docPath(horde), null);
  return doc ? { ...emptyDoc(), ...doc } : emptyDoc();
}

function save(horde, doc) {
  writeJSON(docPath(horde), doc, { render });
}

function render(doc) {
  const lines = ['# Handoff', ''];
  lines.push(`at: ${doc.at || '-'}`, `head: ${doc.head || '-'}`, '');
  lines.push('## Summary', doc.summary || '(none)', '');

  lines.push('## In flight');
  if (doc.inFlight.length === 0) lines.push('(none)');
  for (const f of doc.inFlight) {
    const bits = [f.ticket];
    if (f.agent) bits.push(`agent:${f.agent}`);
    if (f.branch) bits.push(`branch:${f.branch}`);
    lines.push(`- ${bits.join(' ')}`);
  }
  lines.push('');

  lines.push('## Next');
  if (doc.next.length === 0) lines.push('(none)');
  for (const n of doc.next) lines.push(`- ${n}`);
  lines.push('');

  lines.push('## Waiting on');
  if (doc.waitingOn.length === 0) lines.push('(none)');
  for (const w of doc.waitingOn) lines.push(`- ${w.who}: ${w.what} (since ${w.since})`);
  lines.push('');

  return lines.join('\n');
}

function gitHead() {
  const sha = git(['rev-parse', '--short', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!sha && !branch) return 'unknown';
  return `${branch || '?'}@${sha || '?'}`;
}

function queueRunningItems(horde) {
  const out = [];
  const q = readJSON(teamPath(horde, 'trunk', 'queue.json'), null);
  const items = q && Array.isArray(q.items) ? q.items : [];
  for (const it of items) {
    if (it && it.state === 'running') out.push({ ticket: it.ticket, agent: it.agent, branch: it.branch });
  }
  return out;
}

function cmdWrite(horde, positional, flags) {
  rejectStaleFlags(flags);
  if (typeof flags.summary !== 'string' || flags.summary.length === 0) fail('write requires --summary "<s>"');
  const doc = load(horde);
  doc.at = nowIso();
  doc.head = gitHead();
  doc.summary = flags.summary;
  doc.inFlight = queueRunningItems(horde);
  doc.next = asArray(flags.next);
  save(horde, doc);
  emit(doc, flags, () => `handoff written · head ${doc.head} · ${doc.inFlight.length} in flight`);
}

function cmdRead(horde, positional, flags) {
  rejectStaleFlags(flags);
  const path = docPath(horde);
  const doc = load(horde);
  const text = readText(path.replace(/\.json$/, '.md')) || render(doc);
  if (doc.at === null) { emit(null, flags, () => 'fresh start — no handoff recorded'); return; }
  emit(doc, flags, () => text);
}

function cmdAddWaiting(horde, positional, flags) {
  rejectStaleFlags(flags);
  const [who, what] = positional;
  if (!who || !what) fail('add-waiting requires <who> "<what>"');
  const doc = load(horde);
  doc.at = nowIso();
  doc.waitingOn.push({ who, what, since: nowIso() });
  save(horde, doc);
  emit({ who, what }, flags, () => `waiting on ${who}: ${what}`);
}

function cmdRmWaiting(horde, positional, flags) {
  rejectStaleFlags(flags);
  const who = positional[0];
  if (!who) fail('rm-waiting requires <who>');
  const doc = load(horde);
  const before = doc.waitingOn.length;
  doc.waitingOn = doc.waitingOn.filter((w) => w.who !== who);
  const removed = before - doc.waitingOn.length;
  doc.at = nowIso();
  save(horde, doc);
  emit({ removed }, flags, () => `removed ${removed} waiting-on entr${removed === 1 ? 'y' : 'ies'} for ${who}`);
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'write': return cmdWrite(horde, positional, flags);
    case 'read': return cmdRead(horde, positional, flags);
    case 'add-waiting': return cmdAddWaiting(horde, positional, flags);
    case 'rm-waiting': return cmdRmWaiting(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
