// record.mjs — Jarl's record as a library: the one stable surface another tool may vendor (with jarl-lib.mjs, the
// implementation it stands on). Nothing else in this directory is a contract: jarl.mjs is the command line over this
// module, jarl-mcp.mjs the MCP adapter over the command line, and jarl-lib.mjs changes without notice.
//
// The contract is RECORD_API and the exports below, each with its arity, enumerated by hand — never `export *`. The
// suite's contract test (tests/record-contract.test.mjs) holds the exact list; adding, removing or re-shaping an export
// fails it until RECORD_API is bumped (jarl-record/2, …) and the new version's table is written beside the old one.
//
// How to call it:
// - `root` is the directory holding .jarl/ (resolveRoot turns a --root value, or nothing, into one).
// - `ids` is one id ('7', '007', '#7') or several, as the CLI takes them: '12,13', '203-206,209', or an array. One id
//   gives back one result object; several give back an array of them.
// - `opts` carries what the CLI's flags carry, under the flags' own names ({ branch, worker, worktree }, { ran, saw },
//   { sha, ci, repo }, { by, supersedes, settles }, …), plus caller on setStatus and setField. The opts keys named at
//   each function below are part of the contract, as much as the parameters: renaming or dropping one bumps
//   RECORD_API; a new optional key does not. The result of every call is what the command's --json prints.
// - A refusal is a thrown Error whose message is the CLI's refusal, word for word; nothing is written then.
// - Every call that writes holds .jarl/.lock for its whole length, and every file is written whole (writeAtomic). The
//   lock is re-entrant per loop (a call inside withLock on the same loop keeps that lock; one on another loop takes
//   that loop's own). withLock runs synchronous work only: a function that is async or returns a promise is refused.
// - Waiting for a lock held by another process blocks the thread (Atomics.wait) for up to 20 s before the call is
//   refused; a caller with an event loop to keep responsive runs these calls off it (a worker or a child process).
// - Every call first empties the per-call caches (git refs, resolved repositories, branch tips), so a process that lives
//   long sees git as it is now. The profile is the one thing kept: it is re-read whenever .jarl/profile.json changes
//   its modification time or size, so a rewrite that keeps both is not seen until one of them changes.
// Zero dependencies, Node 22+.
import { resolve } from 'node:path';
import * as L from './jarl-lib.mjs';

export const RECORD_API = 'jarl-record/1';

const read = (fn) => { L.resetCaches(); return fn(); };
const write = (root, fn) => { L.resetCaches(); return L.withLock(root, fn); };

// ---- the loop: where it is, opening it, reading it ----------------------------------------------

// The loop's root as the CLI finds it: an explicit root (a --root value, read against `from`, else the working
// directory), else the nearest checkout's root — or the main checkout's, when a worktree holds no loop of its own.
export function resolveRoot(root, from) { return root ? resolve(from ?? process.cwd(), root) : L.findRoot(from); }
export function jarlDir(root) { return L.jarlDir(root); }
export function hasLiveLoop(root) { return L.hasLiveLoop(root); }
// init: opts { committed, permanent, profile } (profile: the path of a profile file).
export function initLoop(root, goal, opts = {}) { return write(root, () => L.cmdInit(root, goal, opts)); }
export function loadIssues(root) { return read(() => L.loadIssues(root)); }
export function findIssue(root, id) { return read(() => L.findIssue(root, id)); }
// opts { live }: live leaves out the superseded rulings.
export function decisions(root, opts = {}) { return read(() => L.cmdDecisions(root, opts)); }
export function loadAsks(root) { return read(() => L.loadAsks(root)); }

// ---- an issue as text -----------------------------------------------------------------------------

export function parseIssue(text, file) { return L.parseIssue(text, file); }
export function renderIssue(spec) { return L.renderIssue(spec); }
export function mergedOf(issue) { return L.mergedOf(issue); }
export function evidenceRows(issue) { return L.evidenceRows(issue); }

// ---- the profile ----------------------------------------------------------------------------------

// A profile, as loadProfile, validateProfile, readProfileFile and DEFAULT_PROFILE give it, is contract in these fields:
//   name, declared (false for the built-in one), initial, statuses (in order), kinds, kindDefault, tiers, tierDefault,
//   fields (the extra header fields: [{ name, key, enum, default, required }]), sections (extra headings), acceptance
//   (the acceptance heading, or null for "Acceptance"), format (the record format, 1), scheduler (the external
//   scheduler's command, or null), doneGate ({ approve: 'fresh'|'none', 'requires-merged': boolean }), and the questions
//   is(status, flag), with(flag), flagsOf(status), setBy(status) ('any' or 'record'), active(status),
//   unfinished(status), field(name). Any other key is not. describeProfile gives the plain-data form.
// DEFAULT_PROFILE and STATUS_FLAGS (the six flags, in order) are frozen, lists included; treat every profile as read-only.
export const PROFILE_VERSION = L.PROFILE_VERSION;
export const STATUS_FLAGS = L.STATUS_FLAGS;
export const DEFAULT_PROFILE = L.DEFAULT_PROFILE;
export function validateProfile(json, where) { return L.validateProfile(json, where); }
export function readProfileFile(file) { return L.readProfileFile(file); }
export function loadProfile(root) { return L.loadProfile(root); }
export function describeProfile(profile) { return L.describeProfile(profile); }

// ---- one writer at a time -------------------------------------------------------------------------

export function withLock(root, fn) { return L.withLock(root, fn); }
export function writeAtomic(path, text) { return L.writeAtomic(path, text); }

// ---- operations on the record (each under the lock) ---------------------------------------------

// new: opts { kind, prio, tier, tags, files, repo, 'found-by', where, what, why, acceptance, source, after, changelog,
// template, field, section }.
export function newIssue(root, title, opts = {}) { return write(root, () => L.cmdNew(root, title, opts)); }
// A move into a status, checked against the profile: needs-reason wants `why`, closes-record passes the done gate,
// holds-claim writes the lease from opts { branch, worker, worktree }, leaving it removes the lease.
// opts.caller says who asks: 'record' (the default for a library call) or 'cli' (what the command line and the MCP tools
// always pass). A status the profile marks "set-by": "record" refuses 'cli'; a library caller that acts for a person at
// the command line passes 'cli' too. setField takes the same opts.caller. The profile's done-gate decides what a move
// into closes-record asks for (requires-merged: a recorded merge the base holds; approve: 'none': no approve). The base
// is the branch checked out in the merge's repository, or opts.base (a branch or ref, library callers only) when the
// composer landed the merge into a branch that is not checked out there.
export function setStatus(root, ids, status, why, opts = {}) {
  return write(root, () => {
    const profile = L.loadProfile(root);
    L.need(profile.statuses.includes(status) || !profile.field(status), `${status} is a field this loop's profile declares, not a status — setField writes it`);
    return L.cmdSet(root, ids, status, why, opts);
  });
}
// A field the profile declares (Kind and Tier too, when it declares them), checked against its values.
export function setField(root, ids, field, value, opts = {}) {
  return write(root, () => {
    const profile = L.loadProfile(root);
    L.need(profile.field(field) && !profile.statuses.includes(field), `${field} is not a field this loop's profile declares${profile.declaredFields.length ? ` — it declares ${profile.declaredFields.map((f) => f.name).join(', ')}` : ''}`);
    return L.cmdSet(root, ids, field, value, opts);
  });
}
// The sections: opts { where, what, why, acceptance, changelog, section } (section: "<Heading>=<text>", repeatable).
export function setBody(root, id, opts = {}) { return write(root, () => L.cmdBody(root, id, opts)); }
// tags: ['+name', '-name', …].
export function setTags(root, ids, ops) { return write(root, () => L.cmdTag(root, ids, ops)); }
export function setPriority(root, ids, priority) { return write(root, () => L.cmdPrio(root, ids, priority)); }
export function setFiles(root, id, files) { return write(root, () => L.cmdFiles(root, id, files)); }
// opts { clear }.
export function setRepo(root, id, path, opts = {}) { return write(root, () => L.cmdRepo(root, id, path, { clear: opts.clear === true })); }
export function setAfter(root, id, ids, opts = {}) { return write(root, () => L.cmdAfter(root, id, ids, { clear: opts.clear === true })); }
export function setSource(root, id, refs) { return write(root, () => L.cmdSource(root, id, refs)); }
// Free text, or opts { ran, saw } (one row per pair; text then undefined).
export function addEvidence(root, ids, text, opts = {}) { return write(root, () => L.cmdEvidence(root, ids, text, opts)); }
// verdict: approve | changes; opts { by }.
export function review(root, ids, verdict, findings, opts = {}) { return write(root, () => L.cmdReview(root, ids, verdict, findings, opts)); }
// opts { sha, ci, repo }.
export function recordMerged(root, ids, opts = {}) { return write(root, () => L.cmdMerged(root, ids, opts)); }
export function addRound(root, id, what) { return write(root, () => L.cmdRound(root, id, what)); }
// opts { by, supersedes, settles, area, reach, rule }.
export function decide(root, slug, ruling, opts = {}) { return write(root, () => L.cmdDecide(root, slug, ruling, opts)); }
// opts { kind, target, issue }.
export function ask(root, question, opts = {}) { return write(root, () => L.cmdAsk(root, question, opts)); }
// A ratify item from the close's batch names an area ruling: its answer starts with yes or reject and marks that ruling
// Ratified or Rejected; the result then carries { ruling, verdict, typeDecision, typeLog, ruleRatification, ruleLog }.
// A ratified area ruling's typeDecision ({ type, text, supersedes }) is the entry for the type's decision log, and its
// ruleRatification ({ rule, text }, when the ruling names a rule) the ratification for that rule's own log: the command
// line writes both (yg-edge.mjs); this library never does, so a composer writes them with its own code or leaves them.
export function answer(root, id, text) { return write(root, () => L.cmdAnswer(root, id, text)); }
export function appendLog(root, event) {
  return write(root, () => { L.need(event, 'log requires "<event>"'); L.appendLog(root, event); return { logged: event }; });
}

// ---- the views' data ------------------------------------------------------------------------------

// status --json: opts { 'stale-hours', by }.
export function statusData(root, opts = {}) { return read(() => L.cmdStatus(root, opts)); }
// resume --json: opts { log, ready, ci }.
export function resumeData(root, opts = {}) { return read(() => L.cmdResume(root, opts)); }
