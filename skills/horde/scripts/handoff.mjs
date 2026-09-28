#!/usr/bin/env node
// horde skill — handoff.mjs
//
// The state a session picks a mission up from. There is no hand-written handoff any more: the mission's
// record is a Jarl loop (loop.mjs), and everything a new session needs is already in it — the goal, the
// tickets with their status and the lease of every one a worker holds, the questions waiting on the
// client, the rulings in force, the last lines of the journal. `read` assembles that live, the way
// `jarl.mjs resume --root .horde/hordes/<h>` does (the same data), so nothing can be stale and nothing
// has to be written before a session ends: a session that gets cut leaves nothing half-said.
//
// `write`, `add-waiting` and `rm-waiting` are retired and refused by name, saying where intent lives
// now: order in the plan and the dependencies, reasons in rulings (decide.mjs) and ticket bodies, what
// the client owes in the questions (ask.mjs). The scheduler's own view — what is ready, running,
// waiting to land — is tick.mjs's and status.mjs's.

import {
  fail, parseArgs, emit, isMain, resolveHorde, runMain,
} from './_lib.mjs';
import { loopResume } from './loop.mjs';

export const USAGE = `usage: handoff.mjs <command> [options]

commands:
  read [--horde h]
      the state a session resumes the mission from, assembled live from its loop: the goal, tickets in
      flight with their leases, questions waiting on the client, rulings in force, the journal's last
      lines. The same data as: jarl.mjs resume --root .horde/hordes/<h>
  write | add-waiting | rm-waiting
      retired: nothing is written by hand any more (see read).

options: --json  --help`;

const RETIRED = 'handoff write is retired: nothing written. The state a session resumes from is assembled live from the mission\'s loop — run handoff.mjs read (or jarl.mjs resume --root .horde/hordes/<h>). Put intent where it lives: order in the plan and the dependencies, reasons in rulings (decide.mjs add) and ticket bodies (tk.mjs edit), what the client owes in a question (ask.mjs add).';

function render(o) {
  const lines = [`goal: ${o.goal || '(none)'}`];
  if (o.scheduler) lines.push(`schedule: ${o.scheduler}`);
  const flight = o.inFlight || [];
  lines.push('', `in flight (${flight.length}):`);
  for (const i of flight) lines.push(`  t-${i.id}${i.branch ? ` · ${i.branch}` : ''}${i.worker ? ` · ${i.worker}` : ''} · ${i.title}`);
  const questions = o.questions || [];
  lines.push('', `questions waiting on the client (${questions.length}):`);
  for (const q of questions) lines.push(`  a-${q.id} ${q.kind || ''} · ${q.question}`);
  const rulings = o.rulings || [];
  lines.push('', `rulings in force (${rulings.length}):`);
  for (const r of rulings.slice(-10)) lines.push(`  ${r.date} ${r.slug}${r.line ? ` — ${r.line}` : ''}`);
  const log = o.log || [];
  if (log.length) lines.push('', 'last journal lines:', ...log.map((l) => `  ${typeof l === 'string' ? l : `${l.at || ''} ${l.text || ''}`.trim()}`));
  return lines.join('\n');
}

function cmdRead(horde, flags) {
  const data = loopResume(horde);
  emit(data, flags, () => render(data || {}));
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd] = positional;
  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');
  if (cmd === 'write' || cmd === 'add-waiting' || cmd === 'rm-waiting') fail(RETIRED);
  if (cmd !== 'read') fail(`unknown command: ${cmd} (see --help)`);
  return cmdRead(resolveHorde(flags), flags);
}

if (isMain(import.meta.url)) runMain(main);
