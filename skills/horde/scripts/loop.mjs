// horde skill — loop.mjs
//
// A mission's record is a Jarl loop. Every horde keeps one, at .horde/hordes/<h>/.jarl/, opened by
// `horde.mjs init` with Horde's own profile (jarl-profile.json beside this file): its tickets are the
// loop's issues, its rulings and the client's answers are the loop's decisions.md, its questions to the
// client are the loop's asks.md, and every move is a line in the loop's log. Jarl's own views read it as
// they read any loop — `jarl.mjs resume --root .horde/hordes/<h>` shows the live mission.
//
// It is written through Jarl's record module, vendored under a pin (vendor/jarl, vendor.mjs), and
// through nothing else: this file is the one place Horde calls it. What stays Horde's own sits beside
// the loop, never in it — the schedule and its leases (teams/<team>/queue.json), a ticket's own log with
// its millisecond stamps (teams/<team>/issues/NNN-slug/log.md), the gate and its results, the leases
// between hordes, and what the extra fields of a question to the client carry (asks.json).
//
// The profile makes the loop Horde's, as data: every status is set by the record only, so `jarl set`
// and the MCP tools cannot move a ticket past the architect's veto (proposed → queued) or anywhere else
// the scheduler decides; only merged settles a dependency; a ticket closes only on a merge the base
// holds (done-gate approve none + requires-merged), which is what land.mjs records; and Jarl's own next
// and queue name tick.mjs instead of computing a schedule of their own.
//
// A refusal from the record is a thrown Error in Jarl's own words; `rec` turns it into Horde's
// refusal (fail), so a tool reports it the way it reports its own and `tick.mjs --watch` goes on to
// its next pass instead of dying on it.

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from './vendor/jarl/skills/jarl/scripts/record.mjs';
import {
  hordePath, fail, readText, HordeError,
} from './_lib.mjs';

// The record API Horde is written against. The vendored copy's own RECORD_API is checked against it
// (vendor.mjs check, and again here before the first write): a copy that moved to another API is
// refused loudly rather than half-used.
export const RECORD_API = 'jarl-record/1';
export const PROFILE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'jarl-profile.json');

// The loop's root is the horde's own directory: .jarl/ sits inside it.
export function loopRoot(horde) { return hordePath(horde); }
export function loopDir(horde) { return hordePath(horde, '.jarl'); }
export function issuesDir(horde) { return hordePath(horde, '.jarl', 'issues'); }
export function decisionsFile(horde) { return hordePath(horde, '.jarl', 'decisions.md'); }
export function asksFile(horde) { return hordePath(horde, '.jarl', 'asks.md'); }
export function hasLoop(horde) { return R.hasLiveLoop(loopRoot(horde)); }

function checkApi() {
  if (R.RECORD_API !== RECORD_API) {
    fail(`the vendored Jarl record exports ${R.RECORD_API}, and this Horde is written against ${RECORD_API} — the copy under vendor/jarl does not belong to this release; run: node vendor.mjs check`);
  }
}

// Every call into the record, with Jarl's refusals turned into Horde's.
export function rec(fn) {
  checkApi();
  try {
    return fn();
  } catch (e) {
    if (e instanceof HordeError) throw e;
    if (e instanceof Error && !(e instanceof TypeError) && !(e instanceof ReferenceError) && !(e instanceof RangeError)) fail(e.message);
    throw e;
  }
}

// The loop a new horde starts with: the goal line and Horde's profile. The loop stays out of git like
// everything else under .horde/.
export function openLoop(horde, goal) {
  return rec(() => R.initLoop(loopRoot(horde), goal, { profile: PROFILE_FILE }));
}

// A mission opened by an earlier build of this release keeps the profile it was opened with, and a key
// added to Horde's profile since (the lifecycle that keeps Jarl's own close and archive off a mission)
// would never reach it. So the director's tick brings the stored profile up to Horde's: every top-level
// key the stored one lacks is added, as Horde's profile has it; a key the mission already holds is never
// changed, since its tickets were filed under it. The result is checked as a profile before it is
// written, and the loop's log names the keys added. Returns the keys added (none: nothing written).
export function refreshProfile(horde) {
  if (!hasLoop(horde)) return [];
  const root = loopRoot(horde);
  const stored = join(loopDir(horde), 'profile.json');
  if (!existsSync(stored)) return [];
  const added = rec(() => R.withLock(root, () => {
    const current = JSON.parse(readText(PROFILE_FILE));
    let own;
    try { own = JSON.parse(readText(stored)); } catch { return []; }
    const missing = Object.keys(current).filter((k) => !(k in own));
    if (!missing.length) return [];
    const next = { ...own };
    for (const k of missing) next[k] = current[k];
    R.validateProfile(next, stored);
    R.writeAtomic(stored, `${JSON.stringify(next, null, 2)}\n`);
    return missing;
  }));
  if (added.length) rec(() => R.appendLog(root, `profile brought up to this Horde's: added ${added.join(', ')}`));
  return added;
}

export function withLoopLock(horde, fn) {
  return rec(() => R.withLock(loopRoot(horde), fn));
}

export function writeLoopFile(path, text) { R.writeAtomic(path, text); }

// ---- tickets ------------------------------------------------------------------------------------

// The file one ticket lives in, by its number: issues/NNN-<slug>.md (the record's own layout, format 1).
// Null when the loop has no such ticket.
export function ticketFile(horde, id) {
  const dir = issuesDir(horde);
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md') && /^\d{3,}-/.test(f));
  return hit ? join(dir, hit) : null;
}

// Every ticket as the record parses it ({ id, title, status, fields, sections, file, ... }).
export function loopTickets(horde) {
  if (!hasLoop(horde)) return [];
  // A ticket's number is its file's (NNN-<slug>.md); one written by hand without the heading line is
  // still that ticket.
  return rec(() => R.loadIssues(loopRoot(horde))).map((i) => (i.id ? i : { ...i, id: (/^(\d+)-/.exec(basename(i.file)) || [])[1] || null }));
}

export function parseTicketText(text, file) { return R.parseIssue(text, file); }

// A new ticket: opts as record.newIssue takes them (kind, files, field, section, what, why, acceptance).
export function fileTicket(horde, title, opts) {
  return rec(() => R.newIssue(loopRoot(horde), title, { 'found-by': 'horde', ...opts }));
}

// A move into a status, as the record allows it for a library caller: `opts` carries branch, worker and
// worktree for running (the lease Jarl's views show), and base for merged.
export function moveTicket(horde, id, status, why, opts = {}) {
  return rec(() => R.setStatus(loopRoot(horde), id, status, why || undefined, { ...opts, caller: 'record' }));
}

// A landed merge closes the ticket: the merge as the record's own field, one evidence row naming what
// proved it, and the move into merged through the done gate — which asks for exactly that: a recorded
// merge whose commit the base holds. `base` is the branch the merge landed in (the ticket's parent,
// normally <horde>/trunk), which nobody has checked out.
export function closeMerged(horde, id, { sha, base, ran, saw, why }) {
  const root = loopRoot(horde);
  return rec(() => R.withLock(root, () => {
    R.recordMerged(root, id, { sha, ci: 'none' });
    R.addEvidence(root, id, undefined, { ran, saw });
    return R.setStatus(root, id, 'merged', why || `merged as ${sha}`, { caller: 'record', base });
  }));
}

export function roundTicket(horde, id, what) {
  return rec(() => R.addRound(loopRoot(horde), id, what));
}

export function setTicketAfter(horde, id, ids) {
  const root = loopRoot(horde);
  return rec(() => (ids.length ? R.setAfter(root, id, ids.join(',')) : R.setAfter(root, id, undefined, { clear: true })));
}

export function setTicketFiles(horde, id, files) {
  return rec(() => R.setFiles(loopRoot(horde), id, files.join(',')));
}

// A read-modify-write of one ticket's file under the loop's own lock: `change` gets the text as it
// stands now and returns the text to write. Horde's own header fields (the combined edits `tk.mjs edit`
// makes, a body replaced whole) are written this way, as Jarl writes its own.
export function editTicket(horde, id, change) {
  return rec(() => R.withLock(loopRoot(horde), () => {
    const file = ticketFile(horde, id);
    if (!file) fail(`no such ticket: ${id}`);
    const next = change(readText(file) || '');
    R.writeAtomic(file, next);
    return next;
  }));
}

export function ticketEvidence(horde, id, text, rows) {
  return rec(() => R.addEvidence(loopRoot(horde), id, text, rows || {}));
}

// ---- questions to the client -----------------------------------------------------------------------

export function loopAsks(horde) {
  if (!hasLoop(horde) || !existsSync(asksFile(horde))) return [];
  return rec(() => R.loadAsks(loopRoot(horde)));
}

export function fileLoopAsk(horde, question, { kind, target, issue } = {}) {
  return rec(() => R.ask(loopRoot(horde), question, {
    kind, ...(target ? { target } : {}), ...(issue ? { issue } : {}),
  }));
}

export function answerLoopAsk(horde, id, text) {
  return rec(() => R.answer(loopRoot(horde), id, text));
}

// ---- rulings -------------------------------------------------------------------------------------

export function loopDecisions(horde, opts = {}) {
  if (!hasLoop(horde)) return [];
  return rec(() => R.decisions(loopRoot(horde), opts));
}

export function decideLoop(horde, slug, ruling, opts = {}) {
  return rec(() => R.decide(loopRoot(horde), slug, ruling, opts));
}

export function appendLoopLog(horde, event) {
  return rec(() => R.appendLog(loopRoot(horde), event));
}

// ---- the views ------------------------------------------------------------------------------------

export function loopStatus(horde) {
  if (!hasLoop(horde)) return null;
  return rec(() => R.statusData(loopRoot(horde)));
}

export function loopResume(horde, opts = {}) {
  if (!hasLoop(horde)) return null;
  return rec(() => R.resumeData(loopRoot(horde), opts));
}

export function loopProfile(horde) {
  return rec(() => R.describeProfile(R.loadProfile(loopRoot(horde))));
}
