#!/usr/bin/env node
// horde skill — handoff.mjs
//
// The state of intent between sessions: what's in flight, who is waited on, and what should
// happen next. The mechanical state (queue items, tickets) lives elsewhere; this is the
// narrative layer a new session reads first.
//
// `--by` selects WHOSE handoff, and that alone decides the file — `--team` never does:
// `--by director` (the default) always means the mission-level hordes/<horde>/handoff.json;
// `--by steward` always means that team's teams/<team>/handoff.json (--team, default trunk).
// The two are genuinely different files side by side, not one file scoped two ways — a
// director's write must never land in the trunk steward's own handoff, and vice versa.
//
// State: handoff.json (source of truth) + handoff.md (rendered).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  hordePath, teamPath, readJSON, writeJSON, readText, git, nowIso, fail, parseArgs, emit, isMain,
  resolveHorde, asArray,
} from './_lib.mjs';

const USAGE = `usage: handoff.mjs <command> [options]

commands:
  write --summary "<s>" [--next "<a>"]... [--by director|steward] [--team t] [--horde h]
      writes a fresh handoff: head from git, inFlight from the running items of the relevant
      queue(s) (every team's queue for the director's handoff, just that team's for a steward's).
      --by director (the default) always writes the mission-level handoff; --by steward always
      writes that team's (--team, default trunk) — --team is ignored for --by director.
  read [--by director|steward] [--team t] [--horde h]
      with --by, prints that one handoff (or "fresh start — no handoff recorded" if it doesn't
      exist yet). Without --by, prints both the mission-level and the team's (--team, default
      trunk) handoff when they exist, mission first.
  add-waiting <who> "<what>" [--by director|steward] [--team t] [--horde h]
  rm-waiting <who> [--by director|steward] [--team t] [--horde h]

options: --json  --help`;

function validateBy(by) {
  if (by !== 'director' && by !== 'steward') fail('--by must be "director" or "steward"');
  return by;
}

function docPath(horde, by, team) {
  return by === 'steward' ? teamPath(horde, team, 'handoff.json') : hordePath(horde, 'handoff.json');
}

function emptyDoc() {
  return { at: null, by: null, head: null, summary: '', inFlight: [], next: [], waitingOn: [] };
}

function load(horde, by, team) {
  const doc = readJSON(docPath(horde, by, team), null);
  return doc ? { ...emptyDoc(), ...doc } : emptyDoc();
}

function save(horde, by, team, doc) {
  writeJSON(docPath(horde, by, team), doc, { render });
}

function render(doc) {
  const lines = ['# Handoff', ''];
  lines.push(`at: ${doc.at || '-'}`, `by: ${doc.by || '-'}`, `head: ${doc.head || '-'}`, '');
  lines.push('## Summary', doc.summary || '(none)', '');

  lines.push('## In flight');
  if (doc.inFlight.length === 0) lines.push('(none)');
  for (const f of doc.inFlight) {
    const bits = [f.ticket];
    if (f.team) bits.push(`team:${f.team}`);
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

function queueRunningItems(horde, by, team) {
  const out = [];
  const collect = (t) => {
    const q = readJSON(teamPath(horde, t, 'queue.json'), null);
    const items = q && Array.isArray(q.items) ? q.items : [];
    for (const it of items) {
      if (it && it.state === 'running') out.push({ ticket: it.ticket, team: t, agent: it.agent, branch: it.branch });
    }
  };
  if (by === 'steward') {
    collect(team);
    return out;
  }
  // Director view: every team under this horde, walked recursively (sub-teams nest under
  // teams/<team>/teams/<sub-team>/…).
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const name = prefix ? `${prefix}/${d.name}` : d.name;
      collect(name);
      walk(join(dir, d.name, 'teams'), name);
    }
  };
  walk(hordePath(horde, 'teams'), '');
  return out;
}

function cmdWrite(horde, positional, flags) {
  if (typeof flags.summary !== 'string' || flags.summary.length === 0) fail('write requires --summary "<s>"');
  const by = validateBy(typeof flags.by === 'string' ? flags.by : 'director');
  const team = flags.team || 'trunk';

  const doc = load(horde, by, team);
  doc.at = nowIso();
  doc.by = by;
  doc.head = gitHead();
  doc.summary = flags.summary;
  doc.inFlight = queueRunningItems(horde, by, team);
  doc.next = asArray(flags.next);
  save(horde, by, team, doc);
  emit(doc, flags, () => `handoff written · head ${doc.head} · ${doc.inFlight.length} in flight`);
}

function readOne(horde, by, team) {
  const path = docPath(horde, by, team);
  if (!existsSync(path)) return null;
  const doc = load(horde, by, team);
  return { doc, text: readText(path.replace(/\.json$/, '.md')) || render(doc) };
}

function cmdRead(horde, positional, flags) {
  const team = flags.team || 'trunk';

  if (flags.by) {
    const by = validateBy(flags.by);
    const found = readOne(horde, by, team);
    if (!found) { emit(null, flags, () => 'fresh start — no handoff recorded'); return; }
    emit(found.doc, flags, () => found.text);
    return;
  }

  // No --by: the mission-level handoff and the team's, mission first, whichever exist.
  const mission = readOne(horde, 'director', team);
  const steward = readOne(horde, 'steward', team);
  if (!mission && !steward) { emit(null, flags, () => 'fresh start — no handoff recorded'); return; }
  emit({ mission: mission && mission.doc, team: steward && steward.doc }, flags, () => {
    const parts = [];
    if (mission) parts.push(`## Director (mission)\n\n${mission.text}`);
    if (steward) parts.push(`## Steward (${team})\n\n${steward.text}`);
    return parts.join('\n\n');
  });
}

function cmdAddWaiting(horde, positional, flags) {
  const [who, what] = positional;
  if (!who || !what) fail('add-waiting requires <who> "<what>"');
  const by = validateBy(typeof flags.by === 'string' ? flags.by : 'director');
  const team = flags.team || 'trunk';
  const doc = load(horde, by, team);
  doc.at = nowIso();
  doc.waitingOn.push({ who, what, since: nowIso() });
  save(horde, by, team, doc);
  emit({ who, what }, flags, () => `waiting on ${who}: ${what}`);
}

function cmdRmWaiting(horde, positional, flags) {
  const who = positional[0];
  if (!who) fail('rm-waiting requires <who>');
  const by = validateBy(typeof flags.by === 'string' ? flags.by : 'director');
  const team = flags.team || 'trunk';
  const doc = load(horde, by, team);
  const before = doc.waitingOn.length;
  doc.waitingOn = doc.waitingOn.filter((w) => w.who !== who);
  const removed = before - doc.waitingOn.length;
  doc.at = nowIso();
  save(horde, by, team, doc);
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
