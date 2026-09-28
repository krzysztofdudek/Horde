// jarl-lib.mjs — the implementation behind jarl.mjs and record.mjs. Internal: its exports are not a contract and
// change without notice. The stable surface other tools may vendor is record.mjs (RECORD_API), and only that;
// the command line is jarl.mjs, a CLI over this module.
//
// Markdown is the source of truth: .jarl/goal.md, .jarl/decisions.md, .jarl/log.md and one
// .jarl/issues/NNN-slug.md per issue. This module only reads and writes those files, so anything
// it does can be checked by opening them. Zero dependencies, Node 22+.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, realpathSync, statSync, renameSync, openSync, closeSync, writeSync, unlinkSync, linkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';

// The built-in statuses, kinds and tiers: what a loop with no profile uses (see "the profile" below).
export const STATUSES = ['open', 'in-progress', 'done', 'dropped', 'deferred'];
export const KINDS = ['bug', 'gap', 'cleanup', 'docs', 'test', 'research', 'process'];
export const PRIORITIES = ['1', '2', '3'];
export const TIERS = ['standard', 'strong'];
export const ASK_KINDS = ['stop', 'stuck', 'lower', 'charter', 'ratify'];
export const CI_STATES = ['pending', 'green', 'red', 'none'];
export const ROUNDS_BEFORE_TAKEOVER = 3;
// A lease (Worker, Worktree, Since on an in-progress issue) whose branch saw no commit for this long is shown
// as idle; --stale-hours on status and branches changes it. It is only ever shown, never acted on.
export const STALE_HOURS = 6;
// A legacy handoff file older than the loop's last log line by more than this is read as stale (status --json).
export const HANDOFF_STALE_MS = 60 * 60_000;
// The lease fields: written by set in-progress, removed when the issue leaves in-progress. Branch stays: it
// is where the work was, which branches and check --branch still read after done.
const LEASE_FIELDS = ['Worker', 'Worktree', 'Since'];


// ---- where -------------------------------------------------------------------------------------

// The checkout a run belongs to: the nearest directory with a `.git`. In the default mode the loop is out of
// git and lives only in the main checkout, which a worktree cannot see; so when that directory is a worktree
// (its `.git` is a file) that holds no loop of its own, and the repository's main checkout does, the main
// checkout is the root. An explicit --root never comes through here.
export function findRoot(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return mainCheckoutWithLoop(dir) || dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}
function mainCheckoutWithLoop(dir) {
  if (existsSync(jarlDir(dir))) return null;
  let common;
  try {
    common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
  const commonDir = resolve(dir, common);
  const main = basename(commonDir) === '.git' ? dirname(commonDir) : null;
  // canonical on both sides: git prints C:/x/.git where the path module spells C:\x, and a drive letter's case may differ.
  return main && canonical(main) !== canonical(dir) && existsSync(jarlDir(main)) ? main : null;
}
export function jarlDir(root) { return join(root, '.jarl'); }
export function issuesDir(root) { return join(jarlDir(root), 'issues'); }

function today() { return new Date().toISOString().slice(0, 10); }
function stamp() { return new Date().toISOString().replace('T', ' ').slice(0, 16); }

// ---- one writer at a time ------------------------------------------------------------------------

// Workers, reviewers and the merger all write through this tool with the same --root, often at the same
// moment. Every command that writes therefore runs under .jarl/.lock, taken with the exclusive-create flag
// so exactly one process holds it; the holder's pid, host and start time are written inside it. A lock
// whose holder is gone is broken and taken over (see lockIsStale); a caller that cannot get it within
// LOCK_WAIT_MS fails loudly, naming the holder, rather than writing without it. And every file is written
// whole to a temporary file beside it and renamed into place, so a reader that takes no lock (list, show)
// never sees half a file.
export const LOCK_STALE_MS = 30_000;          // a lock from another host, or one whose holder cannot be read
export const LOCK_REUSED_PID_MS = 10 * 60_000; // a lock on this host whose pid runs, against pid reuse
export const LOCK_EMPTY_MS = 2_000;            // a lock with nothing in it: its holder died between create and write
export const LOCK_BREAK_STALE_MS = 5_000;      // a breaker's own lock (below), left by a breaker that died
export const LOCK_WAIT_MS = Number(process.env.JARL_LOCK_WAIT_MS) || 20_000;   // the variable is a test knob
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) { Atomics.wait(SLEEPER, 0, 0, ms); }
function lockPath(root) { return join(jarlDir(root), '.lock'); }
// Re-entrant per loop, never across loops: a command that calls another write on the same loop takes that loop's lock
// once, and a write to another loop from inside it takes the other loop's own lock. Keyed by the loop's directory
// with symlinks resolved, so two spellings of one root are one lock.
const HELD = new Map();
function lockKey(root) { try { return realpathSync.native(jarlDir(root)); } catch { return resolve(jarlDir(root)); } }
// fn runs synchronously under the lock. A function that returns a promise would run its awaited part after the lock
// is released, so it is refused: an async function before it runs, any other that hands back a promise when it does.
const ASYNC_REFUSAL = 'withLock takes a synchronous function: the lock is released when it returns, so an async function (or one returning a promise) would write after the release — do the async work first, then call withLock with the writes';
function isThenable(v) { return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function'; }
function runSync(fn) {
  const out = fn();
  if (isThenable(out)) throw new Error(ASYNC_REFUSAL);
  return out;
}

// Stale: empty and older than LOCK_EMPTY_MS; on this host, a holder whose pid no longer runs (or, against pid
// reuse, one older than LOCK_REUSED_PID_MS); from another host (a shared checkout) or with an unreadable
// holder, one older than LOCK_STALE_MS.
function lockIsStale(text, mtimeMs) {
  const age = Date.now() - mtimeMs;
  if (!text.trim()) return age > LOCK_EMPTY_MS;
  const [pid, host] = text.split('\n')[0].split(' ');
  if (host === hostname() && Number(pid) > 0) {
    try { process.kill(Number(pid), 0); } catch (e) { if (e.code === 'ESRCH') return true; }
    return age > LOCK_REUSED_PID_MS;
  }
  return age > LOCK_STALE_MS;
}

// Breaking a stale lock is itself serialized, behind .jarl/.lock.break (exclusive create): only its holder
// may remove .lock, and only when .lock still holds exactly the content judged stale. A live lock is never
// moved or renamed, so a fresh holder that took the lock meanwhile keeps it. A breaker that died leaves
// .lock.break behind; it is removed once older than LOCK_BREAK_STALE_MS (breaking takes milliseconds).
function breakStaleLock(root, stale) {
  const brk = join(jarlDir(root), '.lock.break');
  const mine = `${process.pid} ${hostname()} ${new Date().toISOString()}\n`;
  try {
    const fd = openSync(brk, 'wx');
    try { writeSync(fd, mine); } finally { closeSync(fd); }
  } catch (e) {
    if (e.code !== 'EEXIST') return;
    try { if (Date.now() - statSync(brk).mtimeMs > LOCK_BREAK_STALE_MS) unlinkSync(brk); } catch { /* gone */ }
    return;
  }
  try {
    let now = null;
    try { now = readText(lockPath(root)); } catch { /* released meanwhile */ }
    if (now === stale) unlinkSync(lockPath(root));
  } catch { /* released meanwhile */ } finally {
    try { if (readText(brk) === mine) unlinkSync(brk); } catch { /* gone */ }
  }
}

// Waiting for a lock held elsewhere blocks the whole thread (Atomics.wait), for up to LOCK_WAIT_MS (20 s): the
// tool is synchronous by design, so a caller with an event loop to keep alive should call it off that loop.
export function withLock(root, fn) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new Error(ASYNC_REFUSAL);
  // Before init there is no .jarl/ to guard and nothing in it to lose: init runs unguarded.
  if (!existsSync(jarlDir(root))) return runSync(fn);
  const key = lockKey(root);
  if (HELD.get(key) > 0) return runSync(fn);
  const path = lockPath(root);
  const mine = `${process.pid} ${hostname()} ${new Date().toISOString()}\n`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try { writeSync(fd, mine); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`no .jarl/ here any more — the loop was closed or archived while this command waited (${jarlDir(root)})`);
      // Windows: a lock just released is "delete pending" while another process still has it open (a waiter reading
      // it), and creating it again is refused with EPERM until that handle closes — a busy lock, not an error.
      if (!(e.code === 'EEXIST' || (process.platform === 'win32' && RENAME_BUSY.has(e.code)))) throw e;
    }
    let text = ''; let mtimeMs = Date.now();
    try { text = readText(path); mtimeMs = statSync(path).mtimeMs; } catch {   // released meanwhile
      if (Date.now() > until) throw new Error(`.jarl/.lock could not be taken within ${LOCK_WAIT_MS} ms — nothing was written; retry`);
      sleep(1 + Math.floor(Math.random() * 5));
      continue;
    }
    if (lockIsStale(text, mtimeMs)) { breakStaleLock(root, text); sleep(1 + Math.floor(Math.random() * 5)); continue; }
    if (Date.now() > until) throw new Error(`.jarl/.lock is held by another jarl.mjs (${text.trim() || 'holder unknown'}) — nothing was written; retry, or remove ${path} if that process is gone`);
    sleep(10 + Math.floor(Math.random() * 40));
  }
  HELD.set(key, 1);
  try {
    const out = runSync(fn);
    // A committed loop from before the narrow ignore file existed gets it here: under the lock, and only
    // after a command that wrote (a refused one writes nothing). close may have removed .jarl/ meanwhile.
    const ignore = join(jarlDir(root), '.gitignore');
    if (existsSync(jarlDir(root)) && !existsSync(ignore)) writeAtomic(ignore, JARL_GITIGNORE_COMMITTED);
    // Likewise the merge setup (.jarl/.gitattributes and the decisions driver), once: a loop that has the file is set.
    if (existsSync(jarlDir(root)) && !existsSync(join(jarlDir(root), '.gitattributes'))) ensureLoopMerge(root);
    return out;
  } finally {
    HELD.delete(key);
    // Release only a lock that is still this one: close removes .jarl/ with it, and a lock broken as stale
    // may already belong to someone else.
    try { if (readText(path) === mine) unlinkSync(path); } catch { /* removed with .jarl/ */ }
  }
}

// Whether argv1 (process.argv[1]) names the script self: compared as real paths, and without case on Windows, so a
// plugin root spelled with another drive-letter case (c:\ against C:\), or reached through a symlink or a junction,
// still counts as this script. The CLI and the MCP server both start only when this holds.
export function isEntry(argv1, self, platform = process.platform) {
  if (!argv1) return false;
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const [a, b] = [real(resolve(argv1)), real(self)];
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Every text file the loop keeps is read with its line endings as LF: a loop is committed, and a Windows checkout
// with core.autocrlf (or an editor there) hands it back with CRLF, which every line-based parser here would misread.
export function readText(path) { return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n'); }

// Windows refuses a rename onto (or of) a file another process holds open — a reader without the lock, a virus
// scanner, the search indexer — with EPERM, EACCES or EBUSY, for the moment that handle stays open. Such a rename
// is retried for up to RENAME_RETRY_MS before the error is let through; everywhere else the first error is final.
export const RENAME_RETRY_MS = 2_000;
const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
export function renameRetry(from, to, rename = renameSync, platform = process.platform) {
  const until = Date.now() + RENAME_RETRY_MS;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try { rename(from, to); return; } catch (e) {
      if (platform !== 'win32' || !RENAME_BUSY.has(e.code) || Date.now() > until) throw e;
      sleep(wait);
    }
  }
}

// Written whole beside the target, then renamed over it: a reader sees the old file or the new one.
export function writeAtomic(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, text);
  try { renameRetry(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
function appendAtomic(path, header, text) {
  writeAtomic(path, (existsSync(path) ? readText(path) : header) + text);
}

// ---- the profile: what a loop's issues carry and what its statuses mean ----------------------------

// A loop may be opened with a profile (init --profile <file>), stored as .jarl/profile.json. It is data only: the
// statuses an issue moves through and what each one means to the tool, the header fields its issues carry (with
// the values each may take), extra sections, and the heading its acceptance lives under. Jarl reads the profile's
// keys and flags; it never reads meaning into a name the profile chose. A loop with no profile runs on the built-in
// one below, which is exactly how Jarl behaved before profiles existed.
//
// What a status means is said by its flags, never by its name:
// - dispatchable        next offers an issue in it (built-in: open);
// - holds-claim         an issue in it holds its files against the others, and carries the lease: set writes Since
//                       (and Branch, Worker, Worktree when given) on a move into it, and leaving it removes the lease
//                       (built-in: in-progress);
// - settles-dependents  an issue in it no longer holds back the issues that wait on it with After (built-in: done,
//                       dropped);
// - terminal            the issue is finished business for the loop: list hides it by default, and close and archive
//                       do not wait for it (built-in: done, dropped, deferred);
// - closes-record       moving into it passes the done gate — evidence and a live approve — and review, report and
//                       status count it as done work (built-in: done);
// - needs-reason        a move into it needs a reason, written under Evidence as "<Status>: <why>" (built-in: dropped,
//                       deferred).
// A status is at most one of dispatchable, holds-claim and terminal; closes-record is terminal too.
export const STATUS_FLAGS = Object.freeze(['dispatchable', 'holds-claim', 'settles-dependents', 'terminal', 'closes-record', 'needs-reason']);
export const BUILTIN_STATUSES = {
  open: ['dispatchable'],
  'in-progress': ['holds-claim'],
  done: ['settles-dependents', 'terminal', 'closes-record'],
  dropped: ['settles-dependents', 'terminal', 'needs-reason'],
  deferred: ['terminal', 'needs-reason'],
};
export const PROFILE_VERSION = 1;
// The keys a profile file may hold. A key this list does not name is refused, so a profile written for a later
// Jarl fails loudly here instead of being half-read.
export const PROFILE_KEYS = ['jarl-profile', 'format', 'name', 'statuses', 'initial', 'fields', 'sections', 'acceptance-heading', 'external-scheduler', 'done-gate', 'lifecycle'];
export const PROFILE_FIELD_KEYS = ['enum', 'default', 'required'];
// A status written as an object instead of a list of flags: { "flags": [...], "set-by": "record" | "any" }.
export const PROFILE_STATUS_KEYS = ['flags', 'set-by'];
// Who may move an issue into a status: anyone ('any', the default), or only a library call through record.mjs
// ('record') — the command line and the MCP tools are refused, so a composer's own gate (a veto held by one of its roles) cannot
// be walked around with a set.
export const SET_BY = ['any', 'record'];
// Who may end the loop itself: "lifecycle": { "close": "any" | "record", "archive": "any" | "record", "command": "<the
// composer's own command>" }. 'record' refuses jarl close / jarl archive and their MCP tools (caller 'cli') and names the
// command, so the record of a loop a composer keeps (Horde's mission) is never removed or moved out from under it by
// Jarl's own lifecycle; a library caller (caller 'record') still may. The same two words as "set-by".
export const LIFECYCLE_KEYS = ['close', 'archive', 'command'];
export const LIFECYCLE_OPS = ['close', 'archive'];
export const DEFAULT_LIFECYCLE = Object.freeze({ close: 'any', archive: 'any', command: null });
// The format of the record (the issue files, the log, the rulings) this Jarl reads and writes. A profile may state the
// format it was written for; one this Jarl does not know is refused before anything else, so a vendored copy and an
// installed Jarl that drifted apart stop loudly instead of half-reading each other's loop.
export const RECORD_FORMAT = 1;
export const RECORD_FORMATS = Object.freeze([1]);
// The done gate a loop runs on: the built-in one (approve: fresh — a live approve by someone other than the worker,
// from a fresh reviewer when the issue carries code) and no merge required. A profile may ask for a landed merge
// (requires-merged) and, only with it, give up the approve (approve: none): the merge gate that landed it is then the
// check, and Jarl records what it did.
export const DONE_GATE_KEYS = ['approve', 'requires-merged'];
export const DONE_GATE_APPROVE = ['fresh', 'none'];
export const DEFAULT_DONE_GATE = Object.freeze({ approve: 'fresh', 'requires-merged': false });
// Header fields the tool itself writes and reads: a profile cannot declare them. Kind and Tier are built in too, but
// a profile may declare them to replace their values (an enum, and a default).
export const TOOL_FIELDS = ['Status', 'Priority', 'Tags', 'Files', 'Repo', 'After', 'Found by', 'Source', 'Where', 'Branch', 'Worker', 'Worktree', 'Since', 'Merged', 'CI'];
export const BUILTIN_SECTIONS = ['What', 'Why', 'Acceptance', 'Changelog', 'Evidence'];
export const PROFILE_FIELD_RE = /^[A-Za-z][A-Za-z0-9 -]{0,39}$/;
export const PROFILE_STATUS_RE = /^[a-z][a-z0-9-]{0,39}$/;
// Names a status may not take: the words status and resume already print for something else (the counts line's
// "waiting", "ready", "in flight", "questions", "to ratify") and the lower-case keys of status --json, so a count and a
// view can never be read for one another.
export const RESERVED_STATUS_NAMES = ['waiting', 'ready', 'in-flight', 'questions', 'ratify', 'to-ratify', 'goal', 'opened', 'archived', 'stale', 'handoff', 'reviews', 'uncommitted', 'by', 'statuses'];
const PROFILE_SECTION_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,59}$/;
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export function profilePath(root) { return join(jarlDir(root), 'profile.json'); }

// A profile file checked whole against the schema above; every problem is named at once. Returns the profile as
// the tool uses it (see makeProfile).
export function validateProfile(json, where = 'the profile') {
  const bad = [];
  const say = (m) => bad.push(m);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const oneLine = (v) => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v);
  if (!isObj(json)) throw new Error(`${where} is not a JSON object`);
  // The record format first, and alone: a profile written for another format may mean anything by its other keys.
  if (json.format !== undefined && !RECORD_FORMATS.includes(json.format)) {
    throw new Error(`${where} is written for record format ${JSON.stringify(json.format)}, and this Jarl reads format ${RECORD_FORMATS.join(', ')} — use the Jarl the loop was opened with (a vendored copy and the installed one must agree), or upgrade this one`);
  }
  for (const k of Object.keys(json)) if (!PROFILE_KEYS.includes(k)) say(`unknown key "${k}" — a profile takes ${PROFILE_KEYS.join(', ')}`);
  if (json['jarl-profile'] !== PROFILE_VERSION) say(`"jarl-profile" must be ${PROFILE_VERSION} (the profile format this Jarl reads)`);
  if (json.name !== undefined && !(typeof json.name === 'string' && PROFILE_NAME_RE.test(json.name))) say('"name" is letters, digits and . _ - (starting with a letter or digit, at most 80 characters)');
  // statuses: { "<name>": ["<flag>", ...] }, in the order they are shown.
  // A status is a list of flags, or { "flags": [...], "set-by": "record" } when it says who may move an issue into it.
  const statuses = [];
  const flagsOf = new Map();
  const setBy = new Map();
  if (!isObj(json.statuses) || !Object.keys(json.statuses).length) say('"statuses" must be an object naming at least one status: { "<status>": ["<flag>", ...] }');
  else {
    for (const [name, spec] of Object.entries(json.statuses)) {
      if (!PROFILE_STATUS_RE.test(name)) { say(`status "${name}" must be lower-case letters, digits and - (starting with a letter, at most 40 characters)`); continue; }
      if (RESERVED_STATUS_NAMES.includes(name)) { say(`status "${name}" is a name the views use for something else — the reserved names are ${RESERVED_STATUS_NAMES.join(', ')}`); continue; }
      let flags = spec;
      if (isObj(spec)) {
        const unknown = Object.keys(spec).filter((k) => !PROFILE_STATUS_KEYS.includes(k));
        if (unknown.length) { say(`status "${name}": unknown key "${unknown[0]}" — a status written as an object takes ${PROFILE_STATUS_KEYS.join(', ')}`); continue; }
        if (spec['set-by'] !== undefined && !SET_BY.includes(spec['set-by'])) { say(`status "${name}": "set-by" is one of ${SET_BY.join(', ')} (record: only a library call through record.mjs moves an issue into it, never jarl set)`); continue; }
        flags = spec.flags === undefined ? [] : spec.flags;
        setBy.set(name, spec['set-by'] || 'any');
      }
      if (!Array.isArray(flags) || !flags.every((f) => typeof f === 'string')) { say(`status "${name}" takes a list of flags (${STATUS_FLAGS.join(', ')}), [] for none — or { "flags": [...], "set-by": "record" }`); continue; }
      for (const f of flags) if (!STATUS_FLAGS.includes(f)) say(`status "${name}": unknown flag "${f}" — the flags are ${STATUS_FLAGS.join(', ')}`);
      if (new Set(flags).size !== flags.length) say(`status "${name}" names a flag twice`);
      const set = new Set(flags);
      if (['dispatchable', 'holds-claim', 'terminal'].filter((f) => set.has(f)).length > 1) say(`status "${name}" is at most one of dispatchable, holds-claim and terminal`);
      if (set.has('closes-record') && !set.has('terminal')) say(`status "${name}" is closes-record, so it must be terminal too`);
      statuses.push(name);
      flagsOf.set(name, set);
    }
    const some = (f) => statuses.some((s) => flagsOf.get(s).has(f));
    if (statuses.length && !some('dispatchable')) say('no status is dispatchable — next would never offer anything');
    if (statuses.length && !some('holds-claim')) say('no status holds-claim — no issue could ever be worked on');
    if (statuses.length && !some('terminal')) say('no status is terminal — the loop could never close');
    if (statuses.length && !some('settles-dependents')) say('no status settles-dependents — an issue waiting on another with After would wait for good');
  }
  let initial = statuses[0];
  if (json.initial !== undefined) {
    if (!statuses.includes(json.initial)) say(`"initial" must name one of the statuses (${statuses.join(', ')})`);
    else initial = json.initial;
  }
  if (initial && flagsOf.get(initial) && (flagsOf.get(initial).has('terminal') || flagsOf.get(initial).has('holds-claim'))) say(`a new issue starts in "${initial}", which is ${flagsOf.get(initial).has('terminal') ? 'terminal' : 'holds-claim'} — name another with "initial"`);
  // fields: { "<Name>": { enum?, default?, required? } }
  const fields = [];
  if (json.fields !== undefined && !isObj(json.fields)) say('"fields" must be an object: { "<Field>": { "enum": [...], "default": "...", "required": true } }');
  for (const [name, spec] of Object.entries(isObj(json.fields) ? json.fields : {})) {
    if (!PROFILE_FIELD_RE.test(name) || name !== name.trim()) { say(`field "${name}" must be letters, digits, spaces and - (starting with a letter, at most 40 characters)`); continue; }
    if (TOOL_FIELDS.some((t) => t.toLowerCase() === name.toLowerCase())) { say(`field "${name}" is one the tool writes itself — a profile cannot declare it`); continue; }
    if (statuses.includes(name.toLowerCase())) { say(`field "${name}" has the name of a status — set <id> ${name.toLowerCase()} would be ambiguous`); continue; }
    if (fields.some((f) => f.key === name.toLowerCase())) { say(`field "${name}" is declared twice (names are compared without case)`); continue; }
    if (!isObj(spec)) { say(`field "${name}" takes an object: { "enum": [...], "default": "...", "required": true } ({} for a free one-line value)`); continue; }
    for (const k of Object.keys(spec)) if (!PROFILE_FIELD_KEYS.includes(k)) say(`field "${name}": unknown key "${k}" — a field takes ${PROFILE_FIELD_KEYS.join(', ')}`);
    const builtin = ['kind', 'tier'].includes(name.toLowerCase());
    let values = null;
    if (spec.enum !== undefined) {
      if (!Array.isArray(spec.enum) || !spec.enum.length || !spec.enum.every(oneLine) || spec.enum.some((v) => v.includes(','))) say(`field "${name}": "enum" is a non-empty list of one-line values without commas`);
      else if (new Set(spec.enum).size !== spec.enum.length) say(`field "${name}": "enum" names a value twice`);
      else values = spec.enum.map((v) => v.trim());
    } else if (builtin) say(`field "${name}" is built in: declaring it means giving its values — "enum": [...]`);
    if (spec.default !== undefined) {
      if (!oneLine(spec.default)) say(`field "${name}": "default" is a one-line value`);
      else if (values && !values.includes(spec.default.trim())) say(`field "${name}": "default" "${spec.default}" is not one of its enum values`);
    }
    if (spec.required !== undefined && typeof spec.required !== 'boolean') say(`field "${name}": "required" is true or false`);
    if (builtin && spec.required !== undefined) say(`field "${name}" is built in and always written — "required" has no meaning for it`);
    fields.push({ name: builtin ? name.charAt(0).toUpperCase() + name.slice(1).toLowerCase() : name, key: name.toLowerCase(), enum: values, default: oneLine(spec.default) ? spec.default.trim() : null, required: spec.required === true, builtin });
  }
  // sections: ["<Heading>", ...] beyond What, Why, Acceptance, Changelog and Evidence.
  const sections = [];
  if (json.sections !== undefined && !(Array.isArray(json.sections) && json.sections.every((s) => typeof s === 'string'))) say('"sections" must be a list of headings');
  for (const s of Array.isArray(json.sections) ? json.sections.filter((x) => typeof x === 'string') : []) {
    if (!PROFILE_SECTION_RE.test(s) || s !== s.trim()) say(`section "${s}" must be letters, digits, spaces, _ and - (starting with a letter, at most 60 characters)`);
    else if (BUILTIN_SECTIONS.some((b) => b.toLowerCase() === s.toLowerCase())) say(`section "${s}" is built in — declare only the extra ones`);
    else if (sections.some((x) => x.toLowerCase() === s.toLowerCase())) say(`section "${s}" is declared twice (headings are compared without case)`);
    else sections.push(s);
  }
  // acceptance-heading: the heading this loop's issues keep their acceptance under, read as ## Acceptance is.
  let acceptance = null;
  if (json['acceptance-heading'] !== undefined) {
    const h = json['acceptance-heading'];
    if (!oneLine(h) || h !== h.trim() || /^#/.test(h) || h.length > 80) say('"acceptance-heading" is a one-line heading (without the ##, at most 80 characters)');
    else if ([...BUILTIN_SECTIONS.filter((b) => b !== 'Acceptance'), ...sections].some((b) => b.toLowerCase() === h.toLowerCase())) say(`"acceptance-heading" "${h}" is already the heading of another section`);
    else if (h.toLowerCase() !== 'acceptance') acceptance = h;
  }
  // external-scheduler: the command the loop's own scheduler is run by, shown in place of what next and queue compute.
  let scheduler = null;
  if (json['external-scheduler'] !== undefined) {
    const x = json['external-scheduler'];
    if (!oneLine(x) || x.length > 200) say('"external-scheduler" is the one-line command that schedules this loop\'s work (at most 200 characters), shown by next, queue, status and resume in place of their own ready list');
    else scheduler = x.trim();
  }
  // done-gate: { "approve": "fresh" | "none", "requires-merged": true | false }.
  let doneGate = DEFAULT_DONE_GATE;
  if (json['done-gate'] !== undefined) {
    const g = json['done-gate'];
    if (!isObj(g)) say('"done-gate" is an object: { "approve": "fresh" | "none", "requires-merged": true | false }');
    else {
      const before = bad.length;
      for (const k of Object.keys(g)) if (!DONE_GATE_KEYS.includes(k)) say(`"done-gate": unknown key "${k}" — it takes ${DONE_GATE_KEYS.join(', ')}`);
      if (g.approve !== undefined && !DONE_GATE_APPROVE.includes(g.approve)) say(`"done-gate": "approve" is one of ${DONE_GATE_APPROVE.join(', ')}`);
      if (g['requires-merged'] !== undefined && typeof g['requires-merged'] !== 'boolean') say('"done-gate": "requires-merged" is true or false');
      const gate = { approve: g.approve ?? DEFAULT_DONE_GATE.approve, 'requires-merged': g['requires-merged'] ?? DEFAULT_DONE_GATE['requires-merged'] };
      if (gate.approve === 'none' && gate['requires-merged'] !== true) say('"done-gate": "approve": "none" is allowed only with "requires-merged": true — with neither an approve nor a landed merge, nothing would stand behind a closed issue');
      if (bad.length === before) doneGate = Object.freeze(gate);
    }
  }
  // lifecycle: { "close": "any" | "record", "archive": "any" | "record", "command": "<one line>" }.
  let lifecycle = DEFAULT_LIFECYCLE;
  if (json.lifecycle !== undefined) {
    const l = json.lifecycle;
    if (!isObj(l)) say('"lifecycle" is an object: { "close": "any" | "record", "archive": "any" | "record", "command": "<the composer\'s command that closes or archives this loop>" }');
    else {
      const before = bad.length;
      for (const k of Object.keys(l)) if (!LIFECYCLE_KEYS.includes(k)) say(`"lifecycle": unknown key "${k}" — it takes ${LIFECYCLE_KEYS.join(', ')}`);
      for (const op of LIFECYCLE_OPS) if (l[op] !== undefined && !SET_BY.includes(l[op])) say(`"lifecycle": "${op}" is one of ${SET_BY.join(', ')} (record: jarl ${op} and its MCP tool refuse, and the composer does it with its own command)`);
      if (l.command !== undefined && (!oneLine(l.command) || l.command.length > 200)) say('"lifecycle": "command" is the one-line command (at most 200 characters) that closes or archives this loop instead, named by the refusal');
      if (bad.length === before) lifecycle = Object.freeze({ close: l.close ?? 'any', archive: l.archive ?? 'any', command: l.command === undefined ? null : l.command.trim() });
    }
  }
  if (bad.length) throw new Error(`${where} is not a valid profile:\n- ${bad.join('\n- ')}`);
  return makeProfile({ name: json.name || 'custom', statuses: statuses.map((s) => [s, [...flagsOf.get(s)]]), initial, fields, sections, acceptance, declared: true, setBy, scheduler, doneGate, lifecycle, format: json.format ?? RECORD_FORMAT });
}

// The profile as the tool reads it: flags looked up by status, the values Kind and Tier may take and their defaults,
// the declared fields in order.
function makeProfile({ name, statuses, initial, fields = [], sections = [], acceptance = null, declared, setBy = new Map(), scheduler = null, doneGate = DEFAULT_DONE_GATE, lifecycle = DEFAULT_LIFECYCLE, format = RECORD_FORMAT }) {
  const flags = new Map(statuses.map(([s, f]) => [s, new Set(f)]));
  const kind = fields.find((f) => f.key === 'kind');
  const tier = fields.find((f) => f.key === 'tier');
  const kinds = kind ? kind.enum : KINDS;
  const tiers = tier ? tier.enum : TIERS;
  const p = {
    name, declared, initial, sections, acceptance,
    // The record format, the command of an external scheduler (null: next and queue compute their own), the done gate.
    format, scheduler, doneGate,
    // Who may close and archive the loop ('any', or 'record': never jarl close / archive), and the composer's command.
    lifecycle,
    statuses: statuses.map(([s]) => s),
    kinds, kindDefault: kind && kind.default ? kind.default : kinds[0],
    tiers, tierDefault: tier && tier.default ? tier.default : tiers[0],
    // The fields the profile adds to the header (Kind and Tier are written where they always were).
    fields: fields.filter((f) => !f.builtin),
    declaredFields: fields,
    is: (status, flag) => Boolean(flags.get(status)?.has(flag)),
    with: (flag) => statuses.map(([s]) => s).filter((s) => flags.get(s).has(flag)),
    flagsOf: (status) => [...(flags.get(status) || [])],
    // Who may move an issue into the status: 'any', or 'record' (a library call only, never jarl set).
    setBy: (status) => setBy.get(status) || 'any',
  };
  // In play: offered or worked on (built-in: open, in-progress).
  p.active = (s) => p.is(s, 'dispatchable') || p.is(s, 'holds-claim');
  // Not finished: a status the profile names that is not terminal — in play, or one an issue waits in (a proposal
  // not yet accepted, a block). A status the profile does not name (a hand-edited file) is neither.
  p.unfinished = (s) => flags.has(s) && !flags.get(s).has('terminal');
  p.field = (name) => fields.find((f) => f.key === String(name).toLowerCase()) || null;
  return p;
}

// Frozen, with every list it holds: it is shared by every loop without a profile, and record.mjs hands it out.
export const DEFAULT_PROFILE = freezeProfile(makeProfile({ name: 'built-in', statuses: Object.entries(BUILTIN_STATUSES), initial: 'open', declared: false }));
function freezeProfile(p) {
  for (const v of Object.values(p)) if (Array.isArray(v)) { v.forEach((x) => (x && typeof x === 'object' ? Object.freeze(x) : x)); Object.freeze(v); }
  return Object.freeze(p);
}

// The loop's profile: .jarl/profile.json when there is one, else the built-in. Read once per state of the file (a
// command reads it many times). A profile file that does not validate is a refusal, never a silent fallback.
const PROFILES = new Map();
export function loadProfile(root) {
  const path = profilePath(root);
  let st;
  try { st = statSync(path); } catch { return DEFAULT_PROFILE; }
  const key = `${st.mtimeMs} ${st.size}`;
  const hit = PROFILES.get(path);
  if (hit && hit.key === key) return hit.profile;
  let json;
  try { json = JSON.parse(readText(path)); } catch (e) { throw new Error(`${path} is not JSON: ${e.message}`); }
  const profile = validateProfile(json, path);
  PROFILES.set(path, { key, profile });
  return profile;
}
export function readProfileFile(file) {
  need(typeof file === 'string' && file.trim(), '--profile needs the path of a profile file');
  need(existsSync(file), `no such profile file: ${file}`);
  let json;
  try { json = JSON.parse(readText(file)); } catch (e) { throw new Error(`${file} is not JSON: ${e.message}`); }
  return { json, profile: validateProfile(json, file) };
}

// The profile described, for `profile` and for a reader deciding whether a file is right.
export function describeProfile(p) {
  return {
    name: p.name, declared: p.declared, initial: p.initial,
    statuses: p.statuses.map((s) => ({ name: s, flags: p.flagsOf(s), ...(p.setBy(s) !== 'any' ? { setBy: p.setBy(s) } : {}) })),
    fields: p.declaredFields ? p.declaredFields.map((f) => ({ name: f.name, enum: f.enum, default: f.default, required: f.required })) : [],
    kinds: p.kinds, tiers: p.tiers, sections: p.sections, acceptanceHeading: p.acceptance || 'Acceptance',
    format: p.format, externalScheduler: p.scheduler, doneGate: { ...p.doneGate }, lifecycle: { ...p.lifecycle },
  };
}
export function renderProfile(d) {
  const lines = [`profile ${d.name}${d.declared ? '' : ' (no .jarl/profile.json: the built-in one)'}`, 'statuses:'];
  for (const s of d.statuses) lines.push(`  ${s.name}${s.name === d.initial ? ' (initial)' : ''}${s.flags.length ? `  ${s.flags.join(', ')}` : ''}${s.setBy === 'record' ? '  (set by the record only, never jarl set)' : ''}`);
  lines.push(`kind: ${d.kinds.join(' | ')}`, `tier: ${d.tiers.join(' | ')}`);
  const own = d.fields.filter((f) => !['kind', 'tier'].includes(f.name.toLowerCase()));
  if (own.length) lines.push('fields:', ...own.map((f) => `  ${f.name}${f.enum ? `: ${f.enum.join(' | ')}` : ''}${f.default ? ` (default ${f.default})` : ''}${f.required ? ' (required)' : ''}`));
  if (d.sections.length) lines.push(`sections: ${d.sections.join(', ')}`);
  if (d.acceptanceHeading !== 'Acceptance') lines.push(`acceptance heading: ${d.acceptanceHeading}`);
  if (d.externalScheduler) lines.push(`external scheduler: ${d.externalScheduler} (next and queue show it instead of their own list)`);
  if (d.doneGate.approve !== 'fresh' || d.doneGate['requires-merged']) lines.push(`done gate: approve ${d.doneGate.approve}${d.doneGate['requires-merged'] ? ' · requires a merge in the base' : ''}`);
  const kept = LIFECYCLE_OPS.filter((op) => d.lifecycle[op] === 'record');
  if (kept.length) lines.push(`lifecycle: ${kept.join(' and ')} by the record only, never jarl ${kept.join(' / ')}${d.lifecycle.command ? ` — ${d.lifecycle.command}` : ''}`);
  lines.push(`record format: ${d.format}`);
  return lines.join('\n');
}
export function cmdProfile(root, file) {
  if (file !== undefined) return { file, ...describeProfile(readProfileFile(file).profile) };
  return describeProfile(existsSync(jarlDir(root)) ? loadProfile(root) : DEFAULT_PROFILE);
}

// ---- issues ------------------------------------------------------------------------------------

// Letters Unicode does not decompose into a base letter and an accent (ł, ø, đ, ß, æ, þ...) would be
// dropped as punctuation and leave a hole in the name ("gałęzi" -> "ga-ezi"), so they are spelled out first.
const UNDECOMPOSED = {
  'ł': 'l', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'ħ': 'h', 'ı': 'i', 'ŧ': 't', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'þ': 'th',
};
export function slugify(title) {
  return title.toLowerCase().replace(/[łøđðħıŧßæœþ]/g, (c) => UNDECOMPOSED[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'issue';
}

// A header field: **Name:** value. A name is letters, digits, spaces and dashes, so a profile's fields (Area-2) read
// as fields; the built-in ones are letters and spaces only.
const FIELD_RE = /^\*\*([A-Za-z0-9 -]+):\*\*\s*(.*)$/;

export function parseIssue(text, file) {
  const lines = text.split('\n');
  const head = /^#\s+(\d{3})\s+·\s+(.*)$/.exec(lines[0] || '');
  const issue = { file, id: head ? head[1] : null, title: head ? head[2].trim() : '', fields: {}, sections: {} };
  let section = null;
  for (const line of lines.slice(1)) {
    const f = FIELD_RE.exec(line);
    if (f && section === null) { issue.fields[f[1].toLowerCase()] = f[2].trim(); continue; }
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { section = h[1].trim().toLowerCase(); issue.sections[section] = ''; continue; }
    if (section !== null) issue.sections[section] += line + '\n';
  }
  issue.status = issue.fields.status || 'open';
  issue.kind = issue.fields.kind || '';
  issue.priority = issue.fields.priority || '2';
  issue.tier = issue.fields.tier || 'standard';
  issue.tags = (issue.fields.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  issue.files = (issue.fields.files || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Both fields are newer than most loops: an issue without them reads as waiting on nothing and filed from no finding.
  issue.after = splitList(issue.fields.after).map((x) => x.replace(/^#/, '').padStart(3, '0'));
  issue.sources = splitList(issue.fields.source);
  return issue;
}

export function loadIssues(root) {
  const dir = issuesDir(root);
  if (!existsSync(dir)) return [];
  const profile = loadProfile(root);
  return readdirSync(dir).filter((f) => /^\d{3}-.*\.md$/.test(f)).sort()
    .map((f) => withProfile(parseIssue(readText(join(dir, f)), join(dir, f)), profile));
}
// An issue read under the loop's profile: one written with no Status starts where the profile's issues start.
// Its acceptance is read under the profile's heading as under ## Acceptance, so every view that counts acceptance
// lines (next, status, done, review) sees it.
function withProfile(issue, profile) {
  if (!profile.declared) return issue;
  if (issue.fields.status === undefined) issue.status = profile.initial;
  const alias = profile.acceptance && profile.acceptance.toLowerCase();
  if (alias && issue.sections[alias] !== undefined && issue.sections.acceptance === undefined) issue.sections.acceptance = issue.sections[alias];
  return issue;
}
// The heading an issue's acceptance is written under: the one the file already has, else the profile's.
function acceptanceHeading(issue, profile) {
  if (profile.acceptance && issue.sections[profile.acceptance.toLowerCase()] !== undefined) return profile.acceptance;
  if (/^##\s+Acceptance\s*$/m.test(readText(issue.file))) return 'Acceptance';
  return profile.acceptance || 'Acceptance';
}

// A declared field's value, checked: one line, one of its enum values when it has them. Kind and Tier are checked
// against the profile's values the same way.
export function fieldValue(profile, field, raw) {
  const v = fieldText(raw);
  const f = typeof field === 'string' ? profile.field(field) : field;
  if (f && f.enum && v !== '') need(f.enum.includes(v), `${f.name} must be one of: ${f.enum.join(', ')} (got "${v}")`);
  return v;
}
// Name=value pairs from a repeatable flag (--field, --section), each name one the profile declares.
function namedPairs(list, flag, known, what) {
  const out = new Map();
  for (const item of [].concat(list ?? [])) {
    const at = String(item).indexOf('=');
    need(at > 0, `--${flag} takes <name>=<value> (got "${item}")`);
    const name = String(item).slice(0, at).trim();
    const hit = known.find((k) => k.toLowerCase() === name.toLowerCase());
    need(hit, known.length ? `${name} is not a ${what} this loop's profile declares — it declares ${known.join(', ')}` : `this loop's profile declares no ${what}s — --${flag} names one (see: jarl.mjs profile)`);
    need(!out.has(hit), `--${flag} names ${hit} twice`);
    out.set(hit, String(item).slice(at + 1));
  }
  return out;
}

export function findIssue(root, rawId) {
  const id = String(rawId).replace(/^#/, '').padStart(3, '0');
  return loadIssues(root).find((i) => i.id === id) || null;
}

function setField(text, name, value) {
  // Only the header holds fields: a line in a section body that looks like one (a pasted finding) is text.
  const lines = text.split('\n');
  let last = 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    const f = FIELD_RE.exec(lines[i]);
    if (!f) continue;
    // Compared without case, as parseIssue reads names: **status:** written by hand is the Status field, not a second one.
    if (f[1].toLowerCase() === name.toLowerCase()) { lines[i] = `**${name}:** ${value}`; return lines.join('\n'); }
    last = i;
  }
  // insert after the last field line of the header
  lines.splice(last + 1, 0, `**${name}:** ${value}`);
  return lines.join('\n');
}

// Remove header fields (only the header: a section line that looks like a field is text). A field that is
// not there is left alone.
function removeFields(text, names) {
  const lines = text.split('\n');
  const out = [lines[0]];
  let inHeader = true;
  for (const line of lines.slice(1)) {
    if (line.startsWith('## ')) inHeader = false;
    const f = inHeader ? FIELD_RE.exec(line) : null;
    if (f && names.some((n) => n.toLowerCase() === f[1].toLowerCase())) continue;
    out.push(line);
  }
  return out.join('\n');
}

function setSection(text, name, body) {
  // A heading may hold any character (a profile's "Acceptance — evidence"): it is matched as it is written.
  const re = new RegExp(`(^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$\\n)([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi');
  // A function replacer: user text is inserted as it is, never read for $1, $& or $' patterns.
  if (re.test(text)) return text.replace(re, (_, head) => `${head}${body.trim()}\n\n`);
  // A new section other than Evidence goes before Evidence, which stays last: the record of the work.
  const evidence = /^## Evidence\s*$/m.exec(text);
  if (name !== 'Evidence' && evidence) return `${text.slice(0, evidence.index)}## ${name}\n${body.trim()}\n\n${text.slice(evidence.index)}`;
  return `${text.replace(/\s*$/, '')}\n\n## ${name}\n${body.trim()}\n`;
}

// A body written into a section must not open a section of its own: a line starting with ## would end it
// early and the rest would land under a heading nobody reads. Such a line is escaped (\##), which renders
// the same and parses as text.
export function bodyText(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^(\s*)(#+)(?=\s|$)/, (_, sp, h) => `${sp}\\${h}`)).join('\n').trim();
}
// A header field is one line.
function fieldText(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
// --acceptance repeats, one checkable line each; several become a list.
export function acceptanceText(v) {
  const lines = [].concat(v ?? []).map(bodyText).filter(Boolean);
  return lines.length > 1 ? lines.map((l) => `- ${l}`).join('\n') : (lines[0] || '');
}

// --changelog repeats, one entry each: the line the repository's changelog gets for this issue, optionally opened by
// its Keep a Changelog section (`Added: …`). An entry is one line, like a changelog bullet; several become a list.
export const CHANGELOG_SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
export function changelogText(v) {
  const lines = [].concat(v ?? []).map(fieldText).filter(Boolean).map((l) => l.replace(/^-\s+/, ''));
  // A section with nothing after it would print an empty bullet under that heading: refused, not guessed at.
  for (const l of lines) need(!new RegExp(`^(${CHANGELOG_SECTIONS.join('|')}):\\s*$`, 'i').test(l), `changelog entry "${l}" has no text — write the line after the section: --changelog "${l.replace(/:\s*$/, '')}: <what changed>"`);
  return lines.map((l) => `- ${l}`).join('\n');
}
// The entries of an issue's ## Changelog section, each with its section: the one it opens with, else Fixed for a bug
// and Changed for anything else.
export function changelogEntries(issue) {
  const fallback = issue.kind === 'bug' ? 'Fixed' : 'Changed';
  return (issue.sections.changelog || '').split('\n').map((l) => l.trim().replace(/^-\s+/, '')).filter(Boolean).map((l) => {
    const m = new RegExp(`^(${CHANGELOG_SECTIONS.join('|')}):\\s*(.*)$`, 'i').exec(l);
    return m && m[2] ? { section: CHANGELOG_SECTIONS.find((x) => x.toLowerCase() === m[1].toLowerCase()), text: m[2] } : { section: fallback, text: l };
  });
}

// fields: the profile's declared fields, [name, value] in its order, each written after Where (empty when not given).
// sections: the profile's extra sections, [heading, body], written after Acceptance. acceptanceHeading: the heading the
// acceptance goes under. Without them the file is what it always was.
export function renderIssue({ id, title, status = 'open', kind, priority, tier, tags, files, repo, foundBy, where = '', what = '', why = '', acceptance = '', source = [], after = [], changelog = '', fields = [], sections = [], acceptanceHeading = 'Acceptance' }) {
  const body = (t) => (t ? `${t}\n` : '\n');
  const declared = fields.map(([n, v]) => `**${n}:**${v ? ` ${v}` : ''}\n`).join('');
  const extra = sections.map(([h, t]) => `## ${h}\n${body(t)}\n`).join('');
  return `# ${id} · ${fieldText(title)}

**Status:** ${status}
**Kind:** ${kind}
**Priority:** ${priority}
**Tier:** ${tier}
**Tags:** ${tags.join(', ')}
**Files:** ${files.join(', ')}
${repo ? `**Repo:** ${repo}\n` : ''}${after.length ? `**After:** ${after.join(', ')}\n` : ''}**Found by:** ${fieldText(foundBy)}
${source.length ? `**Source:** ${source.join(', ')}\n` : ''}**Where:**${where ? ` ${fieldText(where)}` : ''}
${declared}
## What
${body(what)}
## Why
${body(why)}
## ${acceptanceHeading}
${body(acceptance)}
${extra}${changelog ? `## Changelog\n${changelog}\n\n` : ''}## Evidence

`;
}

// ---- journal and decisions ----------------------------------------------------------------------

export function appendLog(root, event) {
  appendLogLines(root, [event]);
}
// Several lines in one write: a bulk command's lines land together or not at all.
export function appendLogLines(root, events) {
  const at = stamp();
  appendAtomic(join(jarlDir(root), 'log.md'), '# Log\n\n', events.map((e) => `- ${at} · ${e}\n`).join(''));
}

// A ruling's slug names it for good: letters, digits, and . _ - inside, at most 80 characters. It is compared
// as a string, never read as a pattern, so `q.r` and `qxr` are two slugs and a slug with any character in it
// cannot break the reading.
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DECISION_HEAD = /^## (\d{4}-\d{2}-\d{2}) · (.+?)\s*$/;

// decisions.md read back: one entry per `## <date> · <slug>` heading, with its ruling, who ruled (**By:**, none
// on rulings from before the field), what it supersedes and what superseded it.
export function loadDecisions(root) {
  const path = join(jarlDir(root), 'decisions.md');
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readText(path).split('\n')) {
    const h = DECISION_HEAD.exec(line);
    if (h) { out.push({ date: h[1], slug: h[2], body: [] }); continue; }
    if (out.length) out[out.length - 1].body.push(line);
  }
  // A ruling's own fields (By, Supersedes, Superseded by, Settles) are the block the tool writes at the end of its
  // section — the trailing lines that are such a field or blank. A line of the ruling's text that happens to start
  // with **By:** is text.
  const META = DECISION_META;
  return out.map((d) => {
    let cut = d.body.length;
    while (cut > 0 && (d.body[cut - 1].trim() === '' || META.test(d.body[cut - 1]))) cut -= 1;
    const meta = d.body.slice(cut).map((l) => META.exec(l)).filter(Boolean);
    const field = (name) => meta.filter((m) => m[1] === name).map((m) => m[2].trim());
    const ruling = d.body.slice(0, cut).join('\n').trim();
    const sup = field('Superseded by').pop();
    const reach = field('Reach').pop();
    const typeLog = /^(\S+) · (\S+)/.exec(field('Type log').pop() || '');
    const ruleLog = /^(\S+) · (\S+)/.exec(field('Rule log').pop() || '');
    const first = (name) => (field(name).pop() || '').split(/\s/)[0] || null;
    return {
      date: d.date, slug: d.slug, ruling, by: field('By').pop() || null, supersedes: field('Supersedes').pop() || null, supersededBy: sup ? sup.split(/\s/)[0] : null, settles: splitList(field('Settles').pop()),
      area: field('Area').pop() || null, reach: reach !== undefined && /^\d+$/.test(reach) ? Number(reach) : null, rule: field('Rule').pop() || null,
      ratified: first('Ratified'), rejected: first('Rejected'), typeLog: typeLog ? { type: typeLog[1], datetime: typeLog[2] } : null,
      ruleLog: ruleLog ? { rule: ruleLog[1], datetime: ruleLog[2] } : null,
    };
  });
}
// The fields the tool writes into a ruling's closing block. Area, Reach and Rule come with the ruling (decide --area,
// --reach, --rule); Superseded by, Ratified, Rejected, Type log and Rule log are added to an earlier ruling in place, later.
const DECISION_META = /^\*\*(By|Supersedes|Superseded by|Settles|Area|Reach|Rule|Ratified|Rejected|Type log|Rule log):\*\*\s*(.*)$/;

// A field line added at the end of one ruling's own section, by lines: the text is never read as a pattern.
function markDecision(root, slug, line) {
  const path = join(jarlDir(root), 'decisions.md');
  const lines = readText(path).split('\n');
  const at = lines.findIndex((l) => { const h = DECISION_HEAD.exec(l); return h && h[2] === slug; });
  need(at !== -1, `no ruling ${slug} in decisions.md`);
  let end = lines.findIndex((l, n) => n > at && l.startsWith('## '));
  if (end === -1) end = lines.length;
  while (end - 1 > at && lines[end - 1].trim() === '') end -= 1;
  lines.splice(end, 0, line);
  writeAtomic(path, lines.join('\n'));
}

export function appendDecision(root, slug, ruling, { by, supersedes, area, reach, rule } = {}) {
  need(typeof slug === 'string' && SLUG_RE.test(slug), `a ruling's slug is letters, digits and . _ - (starting with a letter or digit, at most 80 characters) — not "${slug}"; e.g. ${slugify(String(slug || 'ruling'))}`);
  const path = join(jarlDir(root), 'decisions.md');
  const existing = existsSync(path) ? readText(path) : '# Decisions\n';
  const all = loadDecisions(root);
  need(!all.some((d) => d.slug === slug), `duplicate slug: ${slug} — a ruling that replaces it takes a new slug and --supersedes ${slug}`);
  let text = existing;
  if (supersedes !== undefined) {
    need(typeof supersedes === 'string' && supersedes !== slug, '--supersedes names the slug of an earlier ruling');
    const old = all.find((d) => d.slug === supersedes);
    need(old, `no ruling ${supersedes} in decisions.md to supersede`);
    need(!old.supersededBy, `${supersedes} is already superseded by ${old.supersededBy} — supersede that one instead`);
    // The mark goes at the end of the old ruling's own section, by lines: the text is never read as a pattern.
    const lines = text.split('\n');
    const at = lines.findIndex((l) => { const h = DECISION_HEAD.exec(l); return h && h[2] === supersedes; });
    let end = lines.findIndex((l, n) => n > at && l.startsWith('## '));
    if (end === -1) end = lines.length;
    while (end - 1 > at && lines[end - 1].trim() === '') end -= 1;
    lines.splice(end, 0, `**Superseded by:** ${slug} (${today()})`);
    text = lines.join('\n');
  }
  const meta = [by ? `**By:** ${fieldText(by)}` : null, supersedes !== undefined ? `**Supersedes:** ${supersedes}` : null, area ? `**Area:** ${area}` : null, reach !== undefined && reach !== null ? `**Reach:** ${reach}` : null, rule ? `**Rule:** ${rule}` : null].filter(Boolean).join('\n');
  writeAtomic(path, `${text.replace(/\s*$/, '')}\n\n## ${today()} · ${slug}\n${bodyText(ruling)}\n${meta ? `\n${meta}\n` : ''}`);
}

// ---- commands ----------------------------------------------------------------------------------

export function need(cond, msg) { if (!cond) throw new Error(msg); }

// By default the loop stays out of git: .jarl/.gitignore ignores everything under .jarl/, itself
// included, so the loop never shows in the branch's history, diffs or merges. --committed writes the
// narrow ignore file below instead and the loop is committed with the work. --permanent is committed the
// same way — a permanent record must be committed to survive — and additionally writes .jarl/.permanent, so a
// later session can tell the mode from the loop itself without being told: close (below) reads that
// marker and keeps the directory instead of removing it. Only init decides any of this, so a loop opened
// before a mode existed keeps behaving as it did.
//
// A committed or permanent loop still gets a narrow .jarl/.gitignore: it ignores only the lock and the
// temporary files a write leaves for a moment (see withLock), so a `git add .jarl` made while a call runs
// never commits them. init writes it; a committed loop opened before it existed is given it by its first
// write under the lock. The mode is read from what the file ignores, not from whether it exists: only the
// default mode's file ignores everything (a line `*`).
export const JARL_GITIGNORE = '*\n**/*\n';
export const JARL_GITIGNORE_COMMITTED = '# jarl: the loop is committed; only the write lock and half-written temporary files stay out of git\n/.lock\n/.lock.break\n.*.tmp\n';
export function outOfGit(root) {
  const path = join(jarlDir(root), '.gitignore');
  return existsSync(path) && readText(path).split('\n').some((l) => l.trim() === '*');
}
export const PERMANENT_MARKER = 'This loop is a permanent record: it is not tied to a feature branch, and `close` never removes this directory. See SKILL.md.\n';

export function cmdInit(root, goal, flags = {}) {
  need(flags.committed === undefined || flags.committed === true, '--committed takes no value — put the goal first: init "<goal>" --committed');
  need(flags.permanent === undefined || flags.permanent === true, '--permanent takes no value — put the goal first: init "<goal>" --permanent');
  need(goal, 'init requires "<goal>"');
  need(!hasLiveLoop(root), '.jarl/ already exists here with a live loop — resume it, or archive it first: jarl.mjs archive "<slug>"');
  // The profile is read and checked before anything is written: a bad one leaves no half-opened loop behind.
  const prof = flags.profile !== undefined ? readProfileFile(flags.profile) : null;
  // A .jarl/ left behind by `archive` holds only archive/ and the mode markers, and the new loop
  // keeps that mode: the markers are the loop's own record of how it lives in git.
  const archived = existsSync(jarlDir(root));
  let permanent = flags.permanent === true;
  let committed = flags.committed === true || permanent;
  if (archived) {
    const kept = existsSync(join(jarlDir(root), '.permanent')) ? 'permanent' : outOfGit(root) ? 'default' : 'committed';
    const asked = permanent ? 'permanent' : committed ? 'committed' : null;
    need(asked === null || asked === kept, `this .jarl/ keeps its archived loops in the ${kept} mode, and a new loop here keeps that mode — run init without --${asked}`);
    permanent = kept === 'permanent';
    committed = kept !== 'default';
  }
  mkdirSync(issuesDir(root), { recursive: true });
  if (!archived) writeAtomic(join(jarlDir(root), '.gitignore'), committed ? JARL_GITIGNORE_COMMITTED : JARL_GITIGNORE);
  if (!archived && permanent) writeAtomic(join(jarlDir(root), '.permanent'), PERMANENT_MARKER);
  writeAtomic(join(jarlDir(root), 'goal.md'), `# Goal\n\n${goal.trim()}\n\n## Assumptions\n\n## Rules that apply here\n`);
  writeAtomic(join(jarlDir(root), 'decisions.md'), '# Decisions\n');
  writeAtomic(join(jarlDir(root), 'log.md'), '# Log\n\n');
  if (prof) writeAtomic(profilePath(root), `${JSON.stringify(prof.json, null, 2)}\n`);
  if (committed) ensureLoopMerge(root);
  appendLog(root, `opened · ${goal.trim()}${prof ? ` · profile ${prof.profile.name}` : ''}`);
  return { dir: jarlDir(root), committed, permanent, ...(prof ? { profile: prof.profile.name } : {}) };
}

// A live loop is one with a goal; a .jarl/ holding only archive/ and the mode markers has none.
export function hasLiveLoop(root) {
  return existsSync(join(jarlDir(root), 'goal.md'));
}

// The refusal for a command that needs a live loop: no .jarl/ at all, or one holding only archives.
function needLiveLoop(root, next) {
  need(existsSync(jarlDir(root)), `no .jarl/ here${next}`);
  need(hasLiveLoop(root), `no live loop here — .jarl/ holds only archived loops${next}`);
}

// What stays in .jarl/ when a loop is archived: the archive itself, the markers that say how the loop lives in
// git, so the next loop opened here keeps the same mode, and the issue templates, which belong to the place, not
// to one loop.
const ARCHIVE_KEEPS = new Set(['archive', 'templates', '.gitignore', '.gitattributes', '.permanent', '.lock', '.lock.break']);

// archive "<slug>" — put the current loop away under .jarl/archive/<yyyy.mm.dd>-<slug>/ so a new one
// can be opened here with init. Everything but the archive and the mode markers moves: issues, goal,
// decisions, log, handoff. Open work is not a refusal (archiving is how a session sets old work
// aside), but the result names it, and the loop's own log records the move before it goes.
export function cmdArchive(root, slug, flags = {}) {
  need(slug, 'archive requires "<slug>" — a short name for the loop being put away');
  need(hasLiveLoop(root), existsSync(jarlDir(root)) ? 'no loop to archive here — .jarl/ holds only earlier archives; open one with: jarl.mjs init "<goal>"' : 'no .jarl/ here');
  needLifecycle(root, 'archive', flags.caller);
  const name = `${today().replace(/-/g, '.')}-${slugify(slug)}`;
  const dest = join(jarlDir(root), 'archive', name);
  need(!existsSync(dest), `.jarl/archive/${name} already exists — pick another slug`);
  const profile = loadProfile(root);
  const left = loadIssues(root).filter((i) => profile.unfinished(i.status)).map((i) => i.id);
  appendLog(root, `archived → .jarl/archive/${name}${left.length ? ` · ${left.length} still open or in progress: ${left.join(', ')}` : ''}`);
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(jarlDir(root))) {
    if (ARCHIVE_KEEPS.has(entry)) continue;
    renameRetry(join(jarlDir(root), entry), join(dest, entry));
  }
  return { archived: dest, leftOpen: left };
}

// Put a written temporary file in place under a name that must not exist yet: a hard link never overwrites,
// so it is the claim. On a file system without hard links, an exclusive create and a copy of the content
// do the same (the lock already keeps other writers out; readers may see the file an instant before it
// is complete). False when the name is taken.
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
export function claimFile(tmp, file, link = linkSync) {
  try { link(tmp, file); return true; } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (!NO_LINKS.has(e.code)) throw e;
  }
  let fd;
  try { fd = openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { writeSync(fd, readFileSync(tmp)); } finally { closeSync(fd); }
  return true;
}

// A template is .jarl/templates/<name>.md: an issue file without a number — header fields (Kind, Priority, Tier, Tags,
// Files) as defaults and What, Why, Acceptance and Changelog sections as the body. A flag given on the call wins over
// the template, field by field and section by section. Templates are the loop's own and outlive it: archive keeps them.
export const TEMPLATE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export function templatesDir(root) { return join(jarlDir(root), 'templates'); }
export function readTemplate(root, name) {
  need(typeof name === 'string' && TEMPLATE_RE.test(name), `a template is named by letters, digits and . _ - (the file .jarl/templates/<name>.md) — not "${name}"`);
  const path = join(templatesDir(root), `${name}.md`);
  if (!existsSync(path)) {
    const have = existsSync(templatesDir(root)) ? readdirSync(templatesDir(root)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : [];
    throw new Error(`no template ${name} in ${templatesDir(root)} — ${have.length ? `templates here: ${have.join(', ')}` : 'none here yet; write one as an issue file without a number (see SKILL.md, "Templates")'}`);
  }
  // The template is read as an issue whose title line may be anything: only its fields and sections count. A template
  // that starts straight with a field has no title line, so that first field is read as a field, not dropped.
  const raw = readText(path);
  const t = parseIssue(FIELD_RE.test(raw.split('\n')[0]) ? `# template\n${raw}` : raw, path);
  const section = (k) => (t.sections[k] !== undefined && t.sections[k].trim() ? t.sections[k].trim() : undefined);
  return {
    kind: t.fields.kind || undefined, prio: t.fields.priority || undefined, tier: t.fields.tier || undefined,
    tags: t.fields.tags || undefined, files: t.fields.files || undefined,
    what: section('what'), why: section('why'), acceptance: section('acceptance'), changelog: section('changelog'),
    // Every field and section as read, for the ones a loop's profile declares (see cmdNew).
    allFields: t.fields, section,
  };
}

export function cmdNew(root, title, rawFlags) {
  need(title, 'new requires "<title>"');
  needLiveLoop(root, ' — run: jarl.mjs init "<goal>"');
  let flags = rawFlags;
  let fromTemplate = {};
  if (rawFlags.template !== undefined) {
    const t = readTemplate(root, rawFlags.template);
    fromTemplate = t;
    flags = { ...rawFlags };
    for (const k of ['kind', 'prio', 'tier', 'tags', 'files', 'what', 'why']) if (flags[k] === undefined && t[k] !== undefined) flags[k] = t[k];
  }
  const profile = loadProfile(root);
  // The profile's fields and sections: a flag's value, else the template's, else the field's default. A required
  // field with none of them is refused; a value outside a field's enum is refused.
  const given = namedPairs(flags.field, 'field', profile.fields.map((f) => f.name), 'field');
  const fields = profile.fields.map((f) => {
    const raw = given.has(f.name) ? given.get(f.name) : fromTemplate.allFields?.[f.key] || f.default || '';
    const v = fieldValue(profile, f, raw);
    need(!f.required || v, `${f.name} is required by this loop's profile — give it: --field "${f.name}=<value>"${f.enum ? ` (one of: ${f.enum.join(', ')})` : ''}`);
    return [f.name, v];
  });
  const givenSections = namedPairs(flags.section, 'section', profile.sections, 'section');
  const sections = profile.sections.map((h) => [h, givenSections.has(h) ? bodyText(givenSections.get(h)) : bodyText(fromTemplate.section?.(h.toLowerCase()))]);
  if (profile.acceptance && fromTemplate.acceptance === undefined && fromTemplate.section) fromTemplate.acceptance = fromTemplate.section(profile.acceptance.toLowerCase());
  const kind = flags.kind || profile.kindDefault;
  need(profile.kinds.includes(kind), `--kind must be one of: ${profile.kinds.join(', ')}`);
  const priority = String(flags.prio || '2');
  need(PRIORITIES.includes(priority), '--prio must be 1, 2 or 3');
  const tier = String(flags.tier || profile.tierDefault);
  need(profile.tiers.includes(tier), `--tier must be one of: ${profile.tiers.join(', ')} — the tier of model the worker is raised on, mapped to a model by the platform running the loop`);
  const repos = flags.repo !== undefined ? repoList(root, flags.repo) : [];
  const source = sourceList(flags.source);
  const after = flags.after !== undefined ? afterList(root, null, flags.after) : [];
  // The number is claimed by creating the file with a link, which never overwrites: when another
  // writer got there first (the lock makes that rare, not impossible — a hand-made file, a stale
  // lock broken early), the next number is tried instead of two issues sharing one.
  const dir = issuesDir(root);
  const taken = () => readdirSync(dir).map((f) => /^(\d{3,})-.*\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
  let n = taken().reduce((m, x) => Math.max(m, x), 0) + 1;
  for (let tries = 0; ; tries += 1) {
    const id = String(n).padStart(3, '0');
    const file = join(dir, `${id}-${slugify(title)}.md`);
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, renderIssue({
      id, title, status: profile.initial, kind, priority, tier, fields, sections, acceptanceHeading: profile.acceptance || 'Acceptance',
      tags: splitList(flags.tags), files: pathList(flags.files), repo: repos.join(', '), foundBy: flags['found-by'] || 'jarl',
      where: flags.where, what: bodyText(flags.what), why: bodyText(flags.why), source, after,
      // A template's Acceptance and Changelog are taken as written (a list already); a flag replaces them.
      acceptance: flags.acceptance !== undefined ? acceptanceText(flags.acceptance) : bodyText(fromTemplate.acceptance),
      changelog: flags.changelog !== undefined ? changelogText(flags.changelog) : bodyText(fromTemplate.changelog),
    }));
    let claimed = !taken().includes(n);
    if (claimed) { try { claimed = claimFile(tmp, file); } catch (e) { unlinkSync(tmp); throw e; } }
    unlinkSync(tmp);
    if (claimed) { appendLog(root, `filed ${id} · ${title}${rawFlags.template !== undefined ? ` · template ${rawFlags.template}` : ''}`); return { id, file, ...(rawFlags.template !== undefined ? { template: rawFlags.template } : {}) }; }
    need(tries < 100, 'could not claim a free issue number after 100 tries');
    n = Math.max(n + 1, taken().reduce((m, x) => Math.max(m, x), 0) + 1);
  }
}

function splitList(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }
// A path written into an issue (Files, Repo) is read on every OS the loop is checked out on, and git names files with
// '/' everywhere: a path given on Windows is stored with '/' (C:\a\b → C:/a/b, which Windows reads the same). Elsewhere a
// backslash is an ordinary file-name character and is kept.
export function portablePath(p, platform = process.platform) { return platform === 'win32' ? p.replace(/\\/g, '/') : p; }
function pathList(v) { return splitList(v).map((p) => portablePath(p)); }

// A Source entry names one finding for good: the report's directory (dated, so unique) and the finding's id
// inside it, <dir>#<id>. Several are one comma list.
export function sourceList(v) {
  const list = splitList(v);
  for (const s of list) need(/^[^#\s]+#[^#\s]+$/.test(s), `a source is <report dir>#<finding id>, e.g. core/research/2026-09-25-jarl#jarl-2-B2 — not "${s}"`);
  return list;
}

// The issues one waits on: each must exist and not be the issue itself, and the chain must not come back to
// it — a cycle would leave every issue in it waiting for good with nothing to say so.
function afterList(root, selfId, raw) {
  const ids = expandIds(raw);
  const all = loadIssues(root);
  const missing = ids.filter((id) => !all.some((i) => i.id === id));
  need(missing.length === 0, `no such issue: ${missing.join(', ')}`);
  need(!selfId || !ids.includes(selfId), `${selfId} cannot wait on itself`);
  if (selfId) {
    const byId = new Map(all.map((i) => [i.id, i]));
    const seen = new Set();
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop();
      need(id !== selfId, `${selfId} after ${ids.join(', ')} would close a cycle: that chain of After already leads back to ${selfId}, so none of them would ever be offered`);
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(byId.get(id)?.after || []));
    }
  }
  return ids;
}

// The After issues not yet settled: an issue in a settles-dependents status settles (built-in: done and dropped);
// any other does not (open, in progress, deferred). An After id with no issue behind it (removed by hand) holds
// nothing back.
export function waitingOn(issue, byId, profile = DEFAULT_PROFILE) {
  return issue.after.filter((id) => byId.has(id) && !profile.is(byId.get(id).status, 'settles-dependents'));
}

// body <id> — the Where field and the What, Why and Acceptance sections, set or replaced. Evidence is never
// written here: it is the record of what was done, appended by evidence, never replaced.
export function cmdBody(root, rawId, flags) {
  const issue = findIssue(root, rawId);
  need(issue, `no such issue: ${rawId}`);
  const profile = loadProfile(root);
  const parts = ['where', 'what', 'why', 'acceptance', 'changelog', 'section'].filter((k) => flags[k] !== undefined);
  need(parts.length, 'body needs at least one of --where, --what, --why, --acceptance, --changelog, --section');
  const sections = namedPairs(flags.section, 'section', profile.sections, 'section');
  let text = readText(issue.file);
  if (flags.where !== undefined) text = setField(text, 'Where', fieldText(flags.where));
  if (flags.what !== undefined) text = setSection(text, 'What', bodyText(flags.what));
  if (flags.why !== undefined) text = setSection(text, 'Why', bodyText(flags.why));
  if (flags.acceptance !== undefined) text = setSection(text, acceptanceHeading(issue, profile), acceptanceText(flags.acceptance));
  for (const [h, v] of sections) text = setSection(text, h, bodyText(v));
  if (flags.changelog !== undefined) text = setSection(text, 'Changelog', changelogText(flags.changelog));
  writeAtomic(issue.file, text);
  const named = parts.flatMap((k) => (k === 'section' ? [...sections.keys()] : [k]));
  appendLog(root, `${issue.id} body · ${named.join(', ')}`);
  return { id: issue.id, set: named };
}

export function cmdSource(root, rawId, list) {
  const issue = findIssue(root, rawId);
  need(issue, `no such issue: ${rawId}`);
  const sources = sourceList(list);
  need(sources.length, 'source requires <report dir>#<finding id>[,...]');
  writeAtomic(issue.file, setField(readText(issue.file), 'Source', sources.join(', ')));
  appendLog(root, `${issue.id} source · ${sources.join(', ')}`);
  return { id: issue.id, sources };
}

export function cmdAfter(root, rawId, raw, { clear = false } = {}) {
  const issue = findIssue(root, rawId);
  need(issue, `no such issue: ${rawId}`);
  if (clear) {
    need(raw === undefined, 'after takes either <ids> or --clear, not both');
    need(issue.fields.after !== undefined, `${issue.id} has no After field to clear`);
    writeAtomic(issue.file, readText(issue.file).replace(/^\*\*After:\*\*.*\n/m, ''));
    appendLog(root, `${issue.id} after · cleared`);
    return { id: issue.id, after: [], cleared: true };
  }
  need(raw !== undefined, 'after requires <ids> — the issues this one waits on (or --clear)');
  const ids = afterList(root, issue.id, raw);
  writeAtomic(issue.file, setField(readText(issue.file), 'After', ids.join(', ')));
  appendLog(root, `${issue.id} after ${ids.join(', ')}`);
  return { id: issue.id, after: ids };
}

export function cmdList(root, flags) {
  const profile = loadProfile(root);
  let rows = loadIssues(root);
  // Finished business (terminal: done, dropped, and deferred work, which waits) is not in the default list:
  // --status or --all shows it.
  if (!flags.all && !flags.status) rows = rows.filter((i) => profile.unfinished(i.status));
  if (flags.status) rows = rows.filter((i) => i.status === flags.status);
  if (flags.kind) rows = rows.filter((i) => i.kind === flags.kind);
  if (flags.tag) rows = rows.filter((i) => i.tags.includes(flags.tag));
  if (flags.prio) rows = rows.filter((i) => i.priority === String(flags.prio));
  // --match <field>=<value> (repeatable, all must hold): any header field — the tool's own, Kind, Tier or one the
  // profile declares — compared as written, without case in the name. An empty value matches an empty field.
  for (const w of [].concat(flags.match ?? [])) {
    const at = String(w).indexOf('=');
    need(at > 0, `--match takes <field>=<value> (got "${w}")`);
    const name = String(w).slice(0, at).trim().toLowerCase();
    const known = [...TOOL_FIELDS, 'Kind', 'Tier', ...profile.fields.map((f) => f.name)];
    need(known.some((k) => k.toLowerCase() === name), `--match names a header field — one of: ${known.join(', ')} (got "${name}")`);
    const value = fieldText(String(w).slice(at + 1));
    rows = rows.filter((i) => (name === 'status' ? i.status : fieldText(i.fields[name])) === value);
  }
  if (flags.grep) {
    const re = new RegExp(flags.grep, 'i');
    rows = rows.filter((i) => re.test(readText(i.file)));
  }
  return rows.sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id));
}

// Bulk ids: evidence, review, set, tag and prio take one id or several — a comma list with ranges,
// `12,13,14` or `203-206,209` (no spaces: one argument, like --tags a,b). Every id is resolved and every
// precondition checked before anything is written, so a call either lands on all of them or on none;
// each issue still gets its own log line.
const MAX_BULK = 200;
export function expandIds(raw) {
  need(raw !== undefined && String(raw).trim() !== '', 'an issue id is required — one id, or several as a comma list with ranges: 12,13 or 203-206,209');
  const out = [];
  for (const part of String(raw).split(',').map((p) => p.trim().replace(/^#/, ''))) {
    const range = /^(\d+)-#?(\d+)$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      need(a <= b, `range ${part} runs backwards — write it low-high`);
      need(b - a < MAX_BULK, `range ${part} spans more than ${MAX_BULK} issues`);
      for (let n = a; n <= b; n += 1) out.push(String(n).padStart(3, '0'));
    } else {
      need(/^\d+$/.test(part), `not an issue id: "${part}" — ids are numbers, several as a comma list with ranges: 12,13 or 203-206,209`);
      out.push(part.padStart(3, '0'));
    }
  }
  return [...new Set(out)];
}
function isBulk(raw) { return /[,-]/.test(String(raw ?? '')); }
function issuesFor(root, rawIds) {
  const ids = expandIds(rawIds);
  const all = loadIssues(root);
  const missing = ids.filter((id) => !all.some((i) => i.id === id));
  need(missing.length === 0, `no such issue: ${missing.join(', ')}${ids.length > 1 ? ' — nothing was written' : ''}`);
  return ids.map((id) => all.find((i) => i.id === id));
}
// One id in, the same object as always out; a list in, an array of them.
function oneOrMany(rawIds, results) { return isBulk(rawIds) ? results : results[0]; }

// The refusal for a move into a needs-reason status given without one; the built-in two say what the status is for.
const REASON_TEXT = {
  dropped: 'dropped needs a reason: jarl.mjs set <id> dropped "<why>"',
  deferred: 'deferred needs a reason: jarl.mjs set <id> deferred "<why>" — work that waits, not work that is gone',
};
// The line a needs-reason status writes under Evidence: its name with a capital, then the reason (Dropped: …).
export function reasonWord(status) { return status.charAt(0).toUpperCase() + status.slice(1); }

// Who asked for the move: 'cli' — the command line and the MCP tools over it, which always say so — or 'record', a
// library call through record.mjs (the default). A status the profile marks "set-by": "record" refuses 'cli'.
export const SET_CALLERS = ['cli', 'record'];
let lastCaller = null;
// The caller the last set ran as, refused or not: for the suite, which checks that the command line says 'cli'.
export function lastSetCaller() { return lastCaller; }

export function cmdSet(root, rawIds, status, why, flags = {}) {
  const caller = flags.caller ?? 'record';
  need(SET_CALLERS.includes(caller), `caller must be one of: ${SET_CALLERS.join(', ')} (got "${caller}")`);
  lastCaller = caller;
  const profile = loadProfile(root);
  // set <ids> <field> <value>: a field the profile declares (Kind and Tier too, when it declares them), not a status.
  if (!profile.statuses.includes(status) && status !== undefined && profile.field(status)) return setDeclaredField(root, rawIds, profile.field(status), why, flags);
  need(profile.statuses.includes(status), `status must be one of: ${profile.statuses.join(', ')}${profile.declaredFields.length ? ` — or a field this loop's profile declares: ${profile.declaredFields.map((f) => f.name).join(', ')}` : ''}`);
  need(caller !== 'cli' || profile.setBy(status) !== 'record', `${status} is set by the record only — this loop's profile (${profile.name}) marks it "set-by": "record", so jarl set and the MCP tools cannot move an issue into it; the tool that runs the loop does${profile.scheduler ? ` (${profile.scheduler})` : ''}`);
  const holds = profile.is(status, 'holds-claim');
  const lease = ['branch', 'worker', 'worktree'].filter((k) => flags[k] !== undefined);
  need(!lease.length || holds, `--${lease[0]} goes with ${profile.with('holds-claim').join(' or ')} only — it records who works on the issue and where`);
  for (const k of lease) need(typeof flags[k] === 'string' && fieldText(flags[k]), `--${k} needs a value`);
  const issues = issuesFor(root, rawIds);
  need(!profile.is(status, 'needs-reason') || why, REASON_TEXT[status] || `${status} needs a reason: jarl.mjs set <id> ${status} "<why>"`);
  const nothing = issues.length > 1 ? ' — nothing was written' : '';
  // base: the branch the composer landed the merge into, for the done gate's requires-merged (else the branch checked
  // out). A library call only: the command line has no --base, and dispatch never passes one through.
  need(flags.base === undefined || caller === 'record', 'base is named by a library call through record.mjs only — the command line checks against the branch checked out');
  need(flags.base === undefined || (typeof flags.base === 'string' && fieldText(flags.base) !== '' && !flags.base.startsWith('-')), 'base names a branch or ref — the one the merge landed in');
  if (profile.is(status, 'closes-record')) {
    const journal = journalById(root);
    const allIssues = loadIssues(root);
    for (const issue of issues) { const refusal = doneRefusal(root, issue, journal, allIssues, { base: flags.base }); need(!refusal, `${refusal}${nothing}`); }
  }
  // One lease for the whole call: every issue in a package gets the same Branch, Worker, Worktree and Since.
  // A relative worktree path is read from the loop's root, like --repo, so it means the same from anywhere.
  const since = stamp();
  const worktree = flags.worktree !== undefined ? resolve(root, fieldText(flags.worktree)) : undefined;
  const writes = issues.map((issue) => {
    let text = readText(issue.file);
    text = setField(text, 'Status', status);
    if (holds) {
      if (flags.branch !== undefined) text = setField(text, 'Branch', fieldText(flags.branch));
      if (flags.worker !== undefined) text = setField(text, 'Worker', fieldText(flags.worker));
      if (worktree !== undefined) text = setField(text, 'Worktree', worktree);
      text = setField(text, 'Since', since);
    } else {
      text = removeFields(text, LEASE_FIELDS);
    }
    // What was already written under Evidence stays: a drop or a deferral is one more line in the history,
    // not a reset of it.
    if (profile.is(status, 'needs-reason')) {
      const written = (issue.sections.evidence || '').trim();
      const line = `${reasonWord(status)}: ${why}`;
      text = setSection(text, 'Evidence', written ? `${written}\n\n${line}` : line);
    }
    return { issue, text };
  });
  for (const w of writes) writeAtomic(w.issue.file, w.text);
  const leaseNote = [flags.branch !== undefined && `branch ${fieldText(flags.branch)}`, flags.worker !== undefined && `worker ${fieldText(flags.worker)}`, worktree !== undefined && `worktree ${worktree}`].filter(Boolean).join(' · ');
  appendLogLines(root, issues.map((issue) => `${issue.id} → ${status}${why ? ` · ${why}` : ''}${leaseNote ? ` · ${leaseNote}` : ''}`));
  return oneOrMany(rawIds, issues.map((issue) => ({ id: issue.id, status, ...(holds ? { since, ...(flags.branch !== undefined ? { branch: fieldText(flags.branch) } : {}), ...(flags.worker !== undefined ? { worker: fieldText(flags.worker) } : {}), ...(worktree !== undefined ? { worktree } : {}) } : {}), ...(profile.is(status, 'closes-record') ? doneNote(issue) : {}) })));
}

// set <ids> <field> <value>: one declared field written on every issue in the call (checked against its enum first),
// with one log line each. An empty value clears it, unless the field is required (or is Kind or Tier).
function setDeclaredField(root, rawIds, field, value, flags) {
  const lease = ['branch', 'worker', 'worktree'].filter((k) => flags[k] !== undefined);
  need(!lease.length, `--${lease[0]} goes with a status, not with the field ${field.name}`);
  need(value !== undefined, `set <ids> ${field.name} "<value>" — the value is required${field.enum ? ` (one of: ${field.enum.join(', ')})` : ''}`);
  const profile = loadProfile(root);
  const v = fieldValue(profile, field, value);
  need(v || (!field.required && !field.builtin), `${field.name} cannot be empty${field.enum ? ` — one of: ${field.enum.join(', ')}` : ''}`);
  const issues = issuesFor(root, rawIds);
  for (const issue of issues) writeAtomic(issue.file, setField(readText(issue.file), field.name, v));
  appendLogLines(root, issues.map((issue) => `${issue.id} field ${field.name} · ${v || '(cleared)'}`));
  return oneOrMany(rawIds, issues.map((issue) => ({ id: issue.id, field: field.name, value: v })));
}

// Why an issue may not go done, or null when it may: at least one --ran/--saw evidence row logged since the issue
// last went in progress (or was reopened, or — never in progress — was filed; free-text notes never count alone), and a live approve by someone
// other than its worker (see gateState) — by a fresh reviewer when the issue carries code (a Branch or Merged field;
// see carriesCode). It gates only the record: nothing here stops code from landing.
// A profile's done-gate changes the last two: requires-merged also asks for a recorded merge whose sha is in the base
// (see mergeRefusal), and approve: none (allowed only with requires-merged) drops the approve — the gate that landed
// the merge stands behind the issue instead of a reviewer. The evidence rows are asked for either way.
export function doneRefusal(root, issue, journal = journalById(root), issues = loadIssues(root), { base } = {}) {
  const profile = loadProfile(root);
  const g = gateState(root, issue.id, journal.get(issue.id) || [], coordinatorNames(root), issues, journal);
  const how = `jarl.mjs evidence ${issue.id} --ran "<command>" --saw "<what it printed>"`;
  if (!workEvidence(issue, profile)) return `${issue.id} has no evidence yet — record it first: ${how}`;
  if (!g.tracked && !evidenceRows(issue).length) return `${issue.id} has no --ran/--saw evidence row — a free-text note alone is not proof of the work: ${how}`;
  if (g.tracked && !g.rowsSince) return `${issue.id} has no --ran/--saw evidence row recorded since it was ${g.anchor.what === 'filed' ? 'filed' : `moved → ${g.anchor.what}`} (${g.anchor.at}) — a free-text note, or a row written before that (before a start or a reopen), is not proof of the work: ${how}`;
  if (profile.doneGate['requires-merged']) { const m = mergeRefusal(root, issue, base); if (m) return m; }
  if (profile.doneGate.approve === 'none') return null;
  const code = carriesCode(issue);
  if (g.selfApproved) return `${issue.id}'s live approve is by a worker of this issue or its branch — a self-approve does not count as review: jarl.mjs review ${issue.id} approve --by <${code ? 'fresh reviewer' : 'fresh reviewer|jarl'}> "<findings>"`;
  if (!g.approved) return `${issue.id} has no approving review newer than its last round${g.tracked ? ' or reopen' : ''} — a fresh reviewer reads the issue and the diff first: jarl.mjs review ${issue.id} approve|changes --by <reviewer> "<findings>"`;
  if (code && !g.fresh) return `${issue.id} ${freshRuleText(issue, g.live)}: jarl.mjs review ${issue.id} approve|changes --by <fresh reviewer> "<findings>"`;
  return null;
}

// The done gate's requires-merged: the issue records a merge (merged --sha) and that commit is in the base — the branch
// checked out where the merge was recorded (Merged's "in <repo>", else the issue's Repo, else the loop's own
// repository), or the branch a library caller names as opts.base (a composer that lands into a branch nobody has
// checked out, such as a team branch, names it). A sha the repository does not know, or one not reachable from the
// base, is refused: a merge recorded is not a merge landed until the base holds it.
function mergeRefusal(root, issue, base) {
  const m = mergedOf(issue);
  const gate = 'this loop\'s profile closes an issue only on a landed merge (done-gate "requires-merged": true)';
  if (!m) return `${issue.id} records no merge — ${gate}: jarl.mjs merged ${issue.id} --sha <sha> once it has landed`;
  let repos = [];
  for (const n of m.repo ? [m.repo] : (reposNamed(issue).length ? reposNamed(issue) : [undefined])) { try { repos.push(repoOf(root, n)); } catch { /* not a repository here */ } }
  repos = repos.filter((r) => isGitRepo(r));
  if (!repos.length) return `${issue.id} records Merged ${m.sha}, but no repository it names is a git repository here — ${gate}, and the merge cannot be checked`;
  const ref = base === undefined ? 'HEAD' : base;
  if (base !== undefined && repos.every((r) => git(r, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) === null)) return `${issue.id}: the base ${base} is not a branch or commit in ${repos.join(' or ')} — ${gate}, and the merge cannot be checked`;
  const landed = repos.some((r) => git(r, ['merge-base', '--is-ancestor', m.sha, ref]) !== null);
  if (landed) return null;
  const where = repos.map((r) => `${base === undefined ? defaultBase(r) : base} in ${r}`).join(' or ');
  return `${issue.id} records Merged ${m.sha}, which is not in the base (${where}) — ${gate}; merge it, or record the sha that landed: jarl.mjs merged ${issue.id} --sha <sha>`;
}

// The fresh-review rule, said the same way by done, review and merged: an issue that carries code (a Branch or a
// Merged field) needs its live approve from a fresh reviewer — an agent that neither wrote the code nor runs the loop.
function freshRuleText(issue, live) {
  const who = live && live.by ? `${live.by} (${live.kind})` : 'a reviewer not recorded (an approve from before --by)';
  return `carries code (${issue.fields.merged ? 'Merged' : 'Branch'} is recorded) and its live approve is by ${who} — the fresh-review rule: a code issue needs an approve from a fresh reviewer, an agent that neither wrote the code nor runs the loop; a coordinator's approve does not clear it`;
}

// Said, never refused: done closes an issue whose acceptance is missing, or has more lines than the
// --ran/--saw rows recorded, or that was merged while its CI is not green yet, but the output says so, so
// the gap is seen by whoever closed it.
function doneNote(issue) {
  const notes = [];
  const lines = acceptanceLineCount(issue);
  if (!lines) notes.push('no acceptance line on file');
  else {
    const rows = evidenceRows(issue).length;
    if (rows < lines) notes.push(`${lines} acceptance line(s), ${rows} --ran/--saw row(s)`);
  }
  const m = mergedOf(issue);
  if (m && m.ci !== 'green' && m.ci !== 'none') notes.push(`merged ${m.sha}, CI ${m.ci || 'not recorded'} — record it when known: jarl.mjs merged ${issue.id} --ci green|red`);
  return notes.length ? { note: notes.join('; ') } : {};
}

// The merge an issue records: **Merged:** <sha>[ in <repo>] and **CI:** pending|green|red|none. Null when
// the issue records none (every issue from before the field).
export function mergedOf(issue) {
  const m = /^(\S+)(?: in (.+))?$/.exec(issue.fields.merged || '');
  if (!m) return null;
  const ci = CI_STATES.includes(issue.fields.ci) ? issue.fields.ci : null;
  return { sha: m[1], repo: m[2] || null, ci };
}

// merged <ids> --sha <sha> [--ci pending|green|red|none] [--repo <path>] — the merge as a field, not as prose:
// the sha, where it landed and the CI state. --ci alone, on issues that already record a merge, moves only
// the CI state. A sha the repository does not know is noted, never refused (the merge may be in a clone not
// fetched here). It records; it never decides whether anything may land.
export function cmdMerged(root, rawIds, flags) {
  need(flags.sha !== undefined || flags.ci !== undefined, 'merged needs --sha <sha> (and optionally --ci), or --ci alone on issues that already record a merge');
  if (flags.sha !== undefined) need(/^[0-9a-f]{4,64}$/i.test(String(flags.sha)), `--sha is a commit id, 4 to 64 hex characters (got "${flags.sha}")`);
  if (flags.ci !== undefined) need(CI_STATES.includes(flags.ci), `--ci must be one of: ${CI_STATES.join(', ')} — none means the repository has no CI to wait for`);
  need(flags.repo === undefined || flags.sha !== undefined, '--repo names where --sha landed; give it with --sha');
  const issues = issuesFor(root, rawIds);
  const nothing = issues.length > 1 ? ' — nothing was written' : '';
  if (flags.sha === undefined) for (const issue of issues) need(mergedOf(issue), `${issue.id} records no merge yet — give --sha: jarl.mjs merged ${issue.id} --sha <sha> --ci ${flags.ci}${nothing}`);
  const repoPath = flags.repo !== undefined ? repoOf(root, flags.repo) : null;
  const sha = flags.sha !== undefined ? String(flags.sha).toLowerCase() : null;
  const ci = flags.ci ?? (sha ? 'pending' : undefined);
  const notes = [];
  if (sha) {
    // Where the sha should be: --repo, else each issue's Repo, else the loop's own repository.
    // An issue naming several repositories is noted only when the sha is in none of them.
    const checked = new Set();
    for (const issue of issues) {
      let repos = repoPath ? [repoPath] : [];
      if (!repoPath) for (const n of (reposNamed(issue).length ? reposNamed(issue) : [undefined])) { try { repos.push(repoOf(root, n)); } catch { /* gone */ } }
      repos = repos.filter((r) => git(r, ['rev-parse', '--git-dir']) !== null);
      const key = repos.join('\n');
      if (!repos.length || checked.has(key)) continue;
      checked.add(key);
      if (repos.every((r) => git(r, ['cat-file', '-e', `${sha}^{commit}`]) === null)) notes.push(`${sha} is not a commit in ${repos.join(' or ')} (yet) — recorded as given`);
    }
  }
  // Said, never refused: a merge is a fact, and recording it is not the place to stop it. A merge whose issue holds
  // no fresh approve went in without the fresh review the rule asks for, and the note says so loudly.
  // Under a done gate with no approve (approve: none), the merge gate stands behind the issue, and no reviewer is owed.
  if (sha && loadProfile(root).doneGate.approve !== 'none') {
    const journal = journalById(root);
    const coordinators = coordinatorNames(root);
    const allIssues = loadIssues(root);
    for (const issue of issues) {
      const g = gateState(root, issue.id, journal.get(issue.id) || [], coordinators, allIssues, journal);
      if (!g.fresh) notes.push(`MERGED WITHOUT A FRESH REVIEW — ${issue.id} ${g.live ? freshRuleText({ fields: { merged: sha } }, g.live) : 'holds no live approve at all (none, or spent by a later round, restart or reopen) — the fresh-review rule: a code issue needs an approve from a fresh reviewer before it merges'}; recorded as given, get the fresh review now: jarl.mjs review ${issue.id} approve|changes --by <fresh reviewer> "<findings>"`);
    }
  }
  for (const issue of issues) {
    let text = readText(issue.file);
    if (sha) text = setField(text, 'Merged', `${sha}${flags.repo !== undefined ? ` in ${fieldText(flags.repo)}` : ''}`);
    text = setField(text, 'CI', ci);
    writeAtomic(issue.file, text);
  }
  appendLogLines(root, issues.map((issue) => (sha ? `${issue.id} merged ${sha}${flags.repo !== undefined ? ` in ${fieldText(flags.repo)}` : ''} · CI ${ci}` : `${issue.id} CI ${ci}`)));
  return { ids: issues.map((i) => i.id), sha: sha || null, ci, notes };
}

export function cmdTag(root, rawIds, ops) {
  const issues = issuesFor(root, rawIds);
  for (const op of ops) need(/^[+-]./.test(op), `tags are +name or -name, not "${op}"`);
  const results = issues.map((issue) => {
    const tags = new Set(issue.tags);
    for (const op of ops) { if (op.startsWith('+')) tags.add(op.slice(1)); else tags.delete(op.slice(1)); }
    return { issue, tags: [...tags].sort() };
  });
  for (const r of results) writeAtomic(r.issue.file, setField(readText(r.issue.file), 'Tags', r.tags.join(', ')));
  return oneOrMany(rawIds, results.map((r) => ({ id: r.issue.id, tags: r.tags })));
}

export function cmdPrio(root, rawIds, prio) {
  need(PRIORITIES.includes(String(prio)), 'priority is 1, 2 or 3');
  const issues = issuesFor(root, rawIds);
  for (const issue of issues) writeAtomic(issue.file, setField(readText(issue.file), 'Priority', String(prio)));
  return oneOrMany(rawIds, issues.map((issue) => ({ id: issue.id, priority: String(prio) })));
}

export function cmdFiles(root, rawId, list) {
  const issue = findIssue(root, rawId);
  need(issue, `no such issue: ${rawId}`);
  const files = pathList(list);
  writeAtomic(issue.file, setField(readText(issue.file), 'Files', files.join(', ')));
  return { id: issue.id, files };
}

export function cmdRepo(root, rawId, path, { clear = false } = {}) {
  const issue = findIssue(root, rawId);
  need(issue, `no such issue: ${rawId}`);
  if (clear) {
    need(issue.fields.repo, `${issue.id} has no Repo field to clear`);
    const text = readText(issue.file).replace(/^\*\*Repo:\*\*.*\n/m, '');
    writeAtomic(issue.file, text);
    return { id: issue.id, repo: null, cleared: true };
  }
  need(path !== undefined, 'repo requires <path> — the checkout of the repository the issue\'s code lives in, several as one comma list (or --clear to remove the field)');
  const repos = repoList(root, path);
  writeAtomic(issue.file, setField(readText(issue.file), 'Repo', repos.join(', ')));
  return { id: issue.id, repo: repos.join(', '), repos };
}

export function evidenceRows(issue) {
  const text = (issue.sections.evidence || '');
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^- \*\*ran:\*\*\s*(.*?)\s*·\s*\*\*saw:\*\*\s*(.*)$/.exec(line.trim());
    if (m) rows.push({ ran: m[1], saw: m[2] });
  }
  return rows;
}

// A finding's proposal copied in by import is not yet an acceptance line: it waits to be made checkable.
export const PROPOSED = 'Proposed by the finding';
export function acceptanceLineCount(issue) {
  const text = issue.sections.acceptance || '';
  return text.split('\n').map((l) => l.trim().replace(/^- /, '')).filter((l) => l.length > 0 && !l.startsWith(PROPOSED)).length;
}

// What counts as evidence of the work for done: not a ruling written in by decide or answer, and not the
// reason of an earlier move into a needs-reason status (a drop or a deferral).
export function workEvidence(issue, profile = DEFAULT_PROFILE) {
  // Status names are lower-case letters, digits and dashes: nothing in them is read as a pattern.
  const skip = new RegExp(`^\\s*(Ruling\\b${profile.with('needs-reason').map((st) => `|${reasonWord(st)}:`).join('')})`);
  return (issue.sections.evidence || '').split('\n').filter((l) => !skip.test(l)).join('\n').trim();
}

// evidence <id> "<text>" appends free text (a merge sha, a one-line note); evidence <id> --ran
// "<command>" --saw "<what it printed>" appends one checkable row per pair instead — repeat the pair,
// in one call or across calls, one row per acceptance line. Both append to the same section, never
// replace it: the merger's free-text note lands after the worker's rows. `set done` needs the section
// non-empty, rows or not (not every issue's proof is a command).
export function cmdEvidence(root, rawIds, text, flags) {
  let rows = null;
  if (flags && (flags.ran !== undefined || flags.saw !== undefined)) {
    const rans = [].concat(flags.ran ?? []);
    const saws = [].concat(flags.saw ?? []);
    need(rans.length && saws.length && [...rans, ...saws].every((v) => typeof v === 'string' && v.trim()), 'a row needs both --ran "<command>" and --saw "<what it printed>", each with a value');
    need(rans.length === saws.length, `--ran and --saw must repeat the same number of times (got ${rans.length} --ran, ${saws.length} --saw)`);
    need(text === undefined, `evidence takes free text or --ran/--saw rows, not both (got "${text}" as well) — a value starting with -- goes after a bare --`);
    rows = rans.map((ran, i) => ({ ran, saw: saws[i] }));
  } else {
    need(text, 'evidence requires "<what was run and what it printed>", or --ran "<command>" --saw "<what it printed>"');
  }
  const issues = issuesFor(root, rawIds);
  const added = rows ? rows.map((r) => `- **ran:** ${r.ran} · **saw:** ${r.saw}`).join('\n') : text;
  for (const issue of issues) {
    const current = (issue.sections.evidence || '').trim();
    writeAtomic(issue.file, setSection(readText(issue.file), 'Evidence', current ? `${current}${rows ? '\n' : '\n\n'}${added}` : added));
  }
  appendLogLines(root, issues.flatMap((issue) => (rows ? rows.map((r) => `${issue.id} evidence row · ${r.ran}`) : [`${issue.id} evidence · ${text.split('\n')[0]}`])));
  return oneOrMany(rawIds, issues.map((issue) => (rows ? { id: issue.id, rows } : { id: issue.id })));
}

// A declared file is a repository and a path inside it. An issue that names no repository declares
// paths in the loop's own, as a single-repository loop always has. An issue that names one writes
// each file with that repository's directory name first — tool/src/a.mjs for Repo ../tool — so a
// reader of the Files line sees where each file lives and the same path in two repositories reads
// as two files; the name is dropped to get the path inside the repository. An entry that does not
// start with the name is taken as a path inside the repository already, so two spellings of one
// file still meet in next rather than passing each other.
//
// One case is ambiguous and is decided by a rule, not by a guess: a repository that has a directory of
// its own name inside it (repository `app` with `app/x.mjs`). There `app/x.mjs` already IS the path
// inside the repository, so the prefix is required — `app/app/x.mjs` is the same file written with it —
// and an entry starting with `app/` but not `app/app/` is never stripped.
//
// A repository is one repository however its path is spelled: the pair's repository is its canonical
// path (symlinks resolved, and the case the file system holds where it ignores case).
export function canonical(path) {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

export function fileAt(root, issue, declared) {
  const named = splitList(issue.fields.repo);
  if (!named.length) return { repo: root, path: declared };
  // Several repositories: the one whose name the entry starts with; an entry that starts with none of them is
  // a path in the first one named.
  for (const r of named) { const hit = prefixedIn(root, r, declared); if (hit) return hit; }
  return { repo: canonical(resolve(root, named[0])), path: declared };
}
function prefixedIn(root, named, declared) {
  const spelled = resolve(root, named);
  const repo = canonical(spelled);
  // The name written in front of a path is the repository's own directory name, or the name its Repo path
  // spells (a symlink or another case of it): either reads as the same prefix.
  const names = [...new Set([basename(repo), basename(spelled)].filter(Boolean))];
  for (const name of names) {
    let inner = false;
    try { inner = statSync(join(repo, name)).isDirectory(); } catch { inner = false; }
    if (inner) { if (declared.startsWith(`${name}/${name}/`)) return { repo, path: declared.slice(name.length + 1) }; continue; }
    if (declared.startsWith(`${name}/`)) return { repo, path: declared.slice(name.length + 1) };
  }
  return null;
}

// The repositories an issue names, as written: its Repo field, one path or a comma list. Empty for an issue
// whose code lives in the loop's own repository.
export function reposNamed(issue) { return splitList(issue.fields.repo); }
// A --repo value on new, import and repo: one path or a comma list, each the root of a git repository.
function repoList(root, v) {
  need(typeof v === 'string', '--repo takes one path, or several as one comma list');
  const list = pathList(v);
  need(list.length, '--repo needs a path');
  for (const r of list) repoOf(root, r);
  return list;
}

// The words next, queue, status and resume say in place of what they would compute, on a loop whose profile names an
// external scheduler: Jarl does not know that scheduler's edges (ports, leases, holds), so a ready list of its own would
// offer work the loop's real scheduler holds back.
export function schedulerNote(cmd) { return `scheduling is led by the composer: ${cmd}`; }

// next — on a loop with an external scheduler, { scheduler, note } and no list: Jarl computes nothing it cannot know.
export function cmdNext(root, flags) {
  const profile = loadProfile(root);
  if (profile.scheduler) return { scheduler: profile.scheduler, note: schedulerNote(profile.scheduler) };
  const issues = loadIssues(root);
  // Files are compared as (repository, path) pairs: the same path in two repositories never holds
  // an issue back, the same file in one repository always does, however its Repo path is spelled.
  const keysOf = (i) => i.files.map((f) => { const at = fileAt(root, i, f); return { f, key: `${at.repo}\n${at.path}` }; });
  // Each taken file with the issue holding it: one in a holds-claim status (in progress), or a dispatchable (open)
  // one offered earlier in this list.
  const taken = new Map(issues.filter((i) => profile.is(i.status, 'holds-claim')).flatMap((i) => keysOf(i).map((k) => [k.key, i.id])));
  const byId = new Map(issues.map((i) => [i.id, i]));
  const out = [];
  for (const i of issues.filter((x) => profile.is(x.status, 'dispatchable')).sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id))) {
    // An issue whose After issues are not all settled (done or dropped) is never offered, whatever its files.
    const after = waitingOn(i, byId, profile);
    if (after.length) { out.push({ id: i.id, title: i.title, priority: i.priority, after, waitsOn: [] }); continue; }
    const keys = keysOf(i);
    const held = keys.filter((k) => taken.has(k.key));
    if (held.length) { out.push({ id: i.id, title: i.title, priority: i.priority, waitsOn: held.map((k) => k.f), heldBy: [...new Set(held.map((k) => taken.get(k.key)))], after: [] }); continue; }
    keys.forEach((k) => taken.set(k.key, i.id));
    // Offered, but flagged: a worker raised on an issue with no acceptance line has nothing to prove, and
    // the reviewer nothing to check it against. Fill it with body --acceptance before raising one.
    out.push({ id: i.id, title: i.title, priority: i.priority, files: i.files, ready: true, waitsOn: [], after: [], ...(acceptanceLineCount(i) ? {} : { noAcceptance: true }) });
  }
  const limit = Number(flags.limit) || Infinity;
  let n = 0;
  return out.filter((r) => { if (!r.ready) return true; n += 1; return n <= limit; });
}

// The loop's own files git has not committed: in the committed and permanent modes the loop is part of the
// record, and a loop whose code lives in another repository has no merge in its own to ride on, so nothing
// commits it unless someone does. Null — and silent — in the default mode (git never sees the loop) and
// outside a git repository.
export function uncommittedLoopFiles(root) {
  if (!existsSync(jarlDir(root)) || outOfGit(root)) return null;
  if (git(root, ['rev-parse', '--git-dir']) === null) return null;
  const out = git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.jarl']);
  if (out === null) return null;
  // Each line is "XY path"; the output comes back trimmed, so the first line may have lost X's leading space.
  return out.split('\n').filter(Boolean).map((l) => l.replace(/^[ MTADRCU?!]{1,2} /, '')).sort();
}

export function cmdStatus(root, flags = {}) {
  const hours = staleHours(flags);
  const profile = loadProfile(root);
  // The count per status. Without a profile the five built-in counts are top-level keys, as they always were; under a
  // profile they live under their own key, statuses, so no status name can overwrite a key of the view (waiting,
  // ready, stale...). countOf reads either.
  const counts = Object.fromEntries(profile.statuses.map((st) => [st, 0]));
  const c = profile.declared ? { statuses: counts } : counts;
  const issues = loadIssues(root);
  for (const i of issues) counts[i.status] = (counts[i.status] || 0) + 1;
  // Each status keeps its own count; waiting is the part of those in play (open, in progress) whose After issues
  // are not settled yet, so "in flight" in the text line means someone is working on it.
  const byId = new Map(issues.map((i) => [i.id, i]));
  const unfinished = issues.filter((i) => profile.active(i.status));
  c.waitingIds = unfinished.filter((i) => waitingOn(i, byId, profile).length).map((i) => i.id);
  c.waiting = c.waitingIds.length;
  c.inFlight = unfinished.filter((i) => profile.is(i.status, 'holds-claim') && !c.waitingIds.includes(i.id)).length;
  // Ready is Jarl's own reckoning (dispatchable, After settled); under an external scheduler it is not Jarl's to count:
  // null, and scheduler names who counts it.
  c.ready = profile.scheduler ? null : unfinished.filter((i) => profile.is(i.status, 'dispatchable') && !c.waitingIds.includes(i.id)).length;
  if (profile.scheduler) c.scheduler = profile.scheduler;
  c.noAcceptance = issues.filter((i) => profile.is(i.status, 'holds-claim') && !acceptanceLineCount(i)).map((i) => i.id);
  const asks = loadAsks(root).filter((a) => a.state === 'open');
  // A ratify item blocks nothing, so it is not counted among the questions the loop waits on.
  c.questions = asks.filter((a) => a.kind !== 'ratify').length;
  c.toRatify = asks.filter((a) => a.kind === 'ratify');
  c.ratify = c.toRatify.length;
  // What a session needs to decide between continuing this loop and archiving it: the goal, when the
  // loop was opened, and when anything last happened in it — all read from its own files.
  const goalPath = join(jarlDir(root), 'goal.md');
  c.goal = existsSync(goalPath) ? (readText(goalPath).split('\n').slice(2).find((l) => l.trim()) || '').trim() : null;
  const logPath = join(jarlDir(root), 'log.md');
  const stamps = existsSync(logPath) ? [...readText(logPath).matchAll(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · /gm)].map((m) => m[1]) : [];
  c.opened = stamps[0] || null;
  c.lastActivity = stamps[stamps.length - 1] || null;
  const archiveDir = join(jarlDir(root), 'archive');
  c.archived = existsSync(archiveDir) ? readdirSync(archiveDir).length : 0;
  // Leases that look wrong (worktree gone, branch gone, idle), merges waiting on CI, the legacy handoff file's age (JSON only) and the
  // loop files nobody committed: all shown, none acted on.
  c.stale = issues.filter((i) => profile.is(i.status, 'holds-claim')).map((i) => ({ id: i.id, problems: leaseProblems(root, i, hours) })).filter((x) => x.problems.length);
  const live = issues.filter((i) => i.status !== 'dropped');
  c.ciPending = live.filter((i) => mergedOf(i)?.ci === 'pending').map((i) => i.id);
  c.ciRed = live.filter((i) => mergedOf(i)?.ci === 'red').map((i) => i.id);
  c.handoff = handoffAge(root, c.lastActivity);
  c.reviews = reviewSplit(root, issues);
  const files = uncommittedLoopFiles(root);
  c.uncommitted = files === null ? null : files.length;
  // --by: the same five counts per repository, tag, kind or priority — a dashboard's table, read from the issues.
  if (flags.by !== undefined) {
    // Or a field the profile declares: one group per value it holds.
    const declared = profile.fields.find((f) => f.key === String(flags.by).toLowerCase());
    need(STATUS_BY.includes(flags.by) || declared, `--by is one of: ${[...STATUS_BY, ...profile.fields.map((f) => f.key)].join(', ')} (got "${flags.by}")`);
    const keysOf = declared ? (i) => [fieldText(i.fields[declared.key]) || '(none)'] : { repo: (i) => repoNames(root, i), tag: (i) => (i.tags.length ? i.tags : ['(none)']), kind: (i) => [i.kind || '(none)'], prio: (i) => [i.priority] }[flags.by];
    const groups = {};
    for (const i of issues) for (const k of keysOf(i)) {
      const g = (groups[k] = groups[k] || Object.fromEntries(profile.statuses.map((st) => [st, 0])));
      if (Object.hasOwn(g, i.status)) g[i.status] += 1;
    }
    c.by = { key: declared ? declared.key : flags.by, groups: Object.fromEntries(Object.keys(groups).sort().map((k) => [k, groups[k]])) };
  }
  // Last, so every key status --json carried before keeps its place.
  c.check = checkState(root);
  return c;
}
export const STATUS_BY = ['repo', 'tag', 'kind', 'prio'];

// A loop opened before the permanent mode existed, or opened --committed, has no way to become the
// permanent record other than this: init is the only command that writes .jarl/.permanent for a new
// loop, and mode is the only other one, for an existing one — it never turns the default mode's ignore-everything
// .jarl/.gitignore into the committed one, so a
// default-mode loop (out of git) cannot be switched in place: a permanent record must be committed,
// and only init decides that. Idempotent it is not: running it twice on an already-permanent loop
// refuses clearly instead of silently doing nothing, so a session never mistakes a no-op for a check.
export function cmdMode(root, mode) {
  need(mode, 'mode requires a target: jarl.mjs mode permanent');
  need(mode === 'permanent', `mode only supports "permanent" today: jarl.mjs mode permanent (got "${mode}")`);
  needLiveLoop(root, '');
  need(!outOfGit(root), 'this loop is out of git (default mode) — a permanent record must be committed, and only init decides .jarl/.gitignore, so there is no in-place switch. Start a fresh loop with: jarl.mjs init "<goal>" --permanent');
  need(!existsSync(join(jarlDir(root), '.permanent')), 'already a permanent record (.jarl/.permanent exists) — nothing to do');
  writeAtomic(join(jarlDir(root), '.permanent'), PERMANENT_MARKER);
  appendLog(root, 'mode → permanent · no longer tied to a feature branch; close now keeps the directory instead of removing it');
  return { permanent: true };
}

// A loop whose profile keeps close or archive to the record ("lifecycle") refuses them from the command line and the
// MCP tools (caller 'cli'), naming the composer's command; a library caller ('record', the default) passes.
export function needLifecycle(root, op, caller = 'record') {
  need(SET_CALLERS.includes(caller), `caller must be one of: ${SET_CALLERS.join(', ')} (got "${caller}")`);
  if (caller !== 'cli') return;
  const profile = loadProfile(root);
  need(profile.lifecycle[op] !== 'record', `this loop is ${op === 'close' ? 'closed' : 'archived'} by the tool that runs it, never by jarl ${op} — its profile (${profile.name}) marks "lifecycle": { "${op}": "record" }, so jarl ${op} and the MCP tools refuse, and nothing was ${op === 'close' ? 'closed or removed' : 'moved'}${profile.lifecycle.command ? `; run: ${profile.lifecycle.command}` : ''}`);
}

export function cmdClose(root, flags = {}) {
  needLiveLoop(root, '');
  needLifecycle(root, 'close', flags.caller);
  // --batch files the ratification batch and closes nothing, so the user can answer it before the loop goes.
  if (flags.batch) return { closed: false, batch: ratificationBatch(root) };
  const profile = loadProfile(root);
  const left = loadIssues(root).filter((i) => profile.unfinished(i.status));
  need(flags.force || left.length === 0, `${left.length} issue(s) still open or in progress: ${left.map((i) => i.id).join(', ')} — set each ${profile.with('terminal').filter((st) => profile.is(st, 'settles-dependents') || profile.is(st, 'closes-record')).join(' or ') || profile.with('terminal').join(' or ')}, or report them to the user and run with --force`);
  // A permanent loop is a record, not a stage cleared before a merge: close leaves the directory in
  // place and logs the close instead of removing it, so --root still finds the loop afterwards.
  // Deferred work is not open, so it does not hold the close — but the close says it leaves it waiting.
  const deferred = loadIssues(root).filter((i) => i.status === 'deferred').map((i) => i.id);
  // The ratification batch is assembled here and never holds the close: in a permanent loop its items stay open for
  // the user's word; in a loop on a branch the rulings no one ratified leave with the directory, rulings of that loop.
  const batch = ratificationBatch(root);
  // A committed loop's files git never saw are named, not refused: in the permanent mode they (and the closing
  // line) wait for a commit; in the committed mode the removal below is itself the change to commit.
  if (existsSync(join(jarlDir(root), '.permanent'))) {
    appendLog(root, `closed · kept as a permanent record${deferred.length ? ` · ${deferred.length} deferred still waiting: ${deferred.join(', ')}` : ''}`);
    const files = uncommittedLoopFiles(root);
    return { closed: true, removed: null, kept: jarlDir(root), leftOpen: left.map((i) => i.id), deferred, uncommitted: files === null ? null : files.length, batch };
  }
  const files = uncommittedLoopFiles(root);
  rmSync(jarlDir(root), { recursive: true, force: true });
  return { closed: true, removed: jarlDir(root), kept: null, leftOpen: left.map((i) => i.id), deferred, uncommitted: files === null ? null : files.length, batch };
}


// ---- review and the done gate --------------------------------------------------------------------

// The journal, one event per dated line, grouped by the issue each line is about (`NNN …`, or `filed NNN …`).
// Read once per command: the done gate, the review split and tips all read it.
export function journalById(root) {
  const path = join(jarlDir(root), 'log.md');
  const map = new Map();
  if (!existsSync(path)) return map;
  readText(path).split('\n').forEach((l, n) => {
    const m = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (.*)$/.exec(l);
    if (!m) return;
    const id = /^(?:filed )?(\d{3})\b/.exec(m[2])?.[1];
    if (!id) return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push({ n, at: m[1], text: m[2] });
  });
  return map;
}

// Who reviewed, as a kind: the word self, or anyone who has ever held the issue's lease — its own worker across
// every takeover, and the worker of any other issue sharing its Branch (a package, or an issue folded into the
// same branch later) — is self too; the loop's own director — coordinator, jarl, reeve, the loop's own name (the
// directory holding .jarl/) and any name goal.md declares on a `Coordinators: a, b` line (coordinator); anyone
// else (fresh). A name is compared without case and surrounding space. `worker` is a name, or a set of them.
export const REVIEWER_KINDS = ['fresh', 'coordinator', 'self'];
export const BASE_COORDINATORS = ['coordinator', 'jarl', 'reeve'];
export function reviewerKind(by, worker, coordinators = BASE_COORDINATORS) {
  const b = fieldText(by).toLowerCase();
  const workers = worker == null ? [] : typeof worker === 'string' ? [worker] : [...worker];
  if (b === 'self' || workers.some((w) => b === fieldText(w).toLowerCase())) return 'self';
  if (coordinators.some((c) => fieldText(c).toLowerCase() === b)) return 'coordinator';
  return 'fresh';
}
// The names that review as the loop's director in this loop: the fixed three, the loop's own name, and the names
// a `Coordinators:` line in goal.md lists (comma separated; as a plain line, a list item, or in bold).
export function coordinatorNames(root) {
  const names = [...BASE_COORDINATORS, basename(resolve(root))];
  const goal = join(jarlDir(root), 'goal.md');
  if (existsSync(goal)) {
    for (const line of readText(goal).split('\n')) {
      const m = /^\s*(?:[-*]\s+)?(?:\*\*)?coordinators:(?:\*\*)?\s*(.+)$/i.exec(line);
      if (m) names.push(...m[1].split(',').map((n) => fieldText(n.replace(/\*\*/g, ''))).filter(Boolean));
    }
  }
  return names;
}
const KIND_WEIGHT = { fresh: 0, coordinator: 1, self: 2 };
// An issue carries code when it records a branch or a merge. Only then does done (and the merge queue) need a
// fresh approve; an issue with neither — a ruling, a note, a hub document — is still cleared by the coordinator.
export function carriesCode(issue) { return Boolean(fieldText(issue.fields.branch) || fieldText(issue.fields.merged)); }
const REVIEW_LINE = /^\d{3} review (approve|changes) · (?:by (.+?) \((fresh|coordinator|self)\) · )?/;

// A journal line that moves an issue (the one with that id, or any) into one of the statuses named: `NNN → <status>`,
// the status followed by the end of the line or a space. Longest names first, so no status is read as a shorter one.
function movesInto(statuses, id = '\\d{3}') {
  const names = [...statuses].sort((a, b) => b.length - a.length);
  return new RegExp(`^${id} → (${names.join('|')})(?= |$)`);
}

// Every worker one issue's own journal has ever named on an in-progress move — a takeover replaces Worker but
// is still the same issue, so every lease across every round counts, not only the latest.
function leaseWorkers(events, profile = DEFAULT_PROFILE) {
  const workers = new Set();
  const into = movesInto(profile.with('holds-claim'));
  for (const e of events) {
    if (!into.test(e.text)) continue;
    const w = / · worker (.+?)(?: · worktree |$)/.exec(e.text);
    if (w) workers.add(fieldText(w[1]));
  }
  return workers;
}

// Every worker ever leased on a Branch, across every issue that records it — built once per set of issues (a
// package leased once for several issues, or one folded into the branch later by a bare `set <ids> in-progress
// --branch <b>` with no --worker of its own, is still one branch). Cached by the `issues` array's identity, so a
// caller that loads the issues once and hands the same array to every gateState call in a loop (status, report,
// queue) builds this exactly once, not once per issue — the earlier version rebuilt it (and reloaded every issue
// file and the whole journal) on every call, making a scan over N issues cost O(N²).
const BRANCH_WORKERS = new WeakMap();
function branchWorkers(issues, journal, profile = DEFAULT_PROFILE) {
  let map = BRANCH_WORKERS.get(issues);
  if (map) return map;
  map = new Map();
  for (const i of issues) {
    const branch = fieldText(i.fields.branch);
    if (!branch) continue;
    const set = map.get(branch) || new Set();
    for (const w of leaseWorkers(journal.get(i.id) || [], profile)) set.add(w);
    if (i.fields.worker) set.add(fieldText(i.fields.worker));
    map.set(branch, set);
  }
  BRANCH_WORKERS.set(issues, map);
  return map;
}

// The full self scope for one issue: everyone its own lease has ever named, plus everyone named on another issue
// that shares its Branch (see branchWorkers). Self-review is refused for any of them, not only the id's own
// latest lease. Pure and cheap: no I/O, so it costs nothing extra when called once per issue in a loop.
function selfWorkers(events, issue, branches, profile = DEFAULT_PROFILE) {
  const self = leaseWorkers(events, profile);
  if (issue && issue.fields.worker) self.add(fieldText(issue.fields.worker));
  const branch = issue && fieldText(issue.fields.branch);
  if (branch && branches.has(branch)) for (const w of branches.get(branch)) self.add(w);
  return self;
}

// The done gate, read from the journal for one issue. Replaying its lines in order:
// - the evidence anchor is the last move into in-progress from another status, or a reopen (done or
//   in-progress back to open), or — for an issue that never went in progress — its filing; only --ran/--saw
//   rows logged after it count for done (a free-text note never does), so nothing written when the issue was
//   filed, or before a restart or a reopen, is proof of the work;
// - an approve by anyone who has ever held the issue's lease (self — see selfWorkers) never counts;
// - the live approve is the strongest one (fresh over coordinator over self) among those since whatever last
//   reset the issue — a round, a reopen, a restart into in-progress (cut), or a later "changes" verdict still
//   waiting on its own approve. A later, weaker approve never spends an earlier, still-live one: only those
//   resets do — a coordinator's approve recorded after a live fresh one does not undo it;
// - `tracked` is false for an issue the journal has no filing and no status move for (a hand-made file, a
//   loop older than the log format): the gate then needs a --ran/--saw row in its Evidence section.
//
// `issues` and `journal` are for the self scope's branch lookup only, and default to a fresh load — fine for a
// single call, but a caller reading the gate for many issues (status, report, queue) must load them once and
// pass the same array and map to every call, so branchWorkers (see above) builds its map once, not per issue.
export function gateState(root, id, events = journalById(root).get(id) || [], coordinators = coordinatorNames(root), issues = loadIssues(root), journal = journalById(root)) {
  const profile = loadProfile(root);
  const issue = issues.find((i) => i.id === id) || null;
  const self = selfWorkers(events, issue, branchWorkers(issues, journal, profile), profile);
  let status = null; let anchor = null; let cut = -1;
  const evidence = []; const reviews = [];
  const moved = movesInto(profile.statuses, id);
  for (const e of events) {
    if (e.text.startsWith(`filed ${id} `)) { status = profile.initial; anchor = e; continue; }
    const move = moved.exec(e.text);
    if (move) {
      const prev = status; status = move[1];
      // A (re)start spends an earlier approve too: in progress → deferred → in progress needs a new review. The
      // flags say it: a move into a holds-claim status from one that is not; a reopen, into a dispatchable status
      // from one that closes the record or holds the claim; and any move out of a status that closes the record.
      if (profile.is(status, 'holds-claim') && !profile.is(prev, 'holds-claim')) { anchor = e; cut = e.n; }
      if (profile.is(status, 'dispatchable') && (profile.is(prev, 'closes-record') || profile.is(prev, 'holds-claim'))) { anchor = e; cut = e.n; }
      if (profile.is(prev, 'closes-record') && !profile.is(status, 'closes-record')) cut = e.n;
      continue;
    }
    if (e.text.startsWith(`${id} round `)) { cut = e.n; continue; }
    const r = REVIEW_LINE.exec(e.text);
    if (r) {
      // The kind is the one recorded, or the one today's names give, whichever is stricter: a name goal.md
      // declares as a coordinator after its approve was logged as fresh does not stay fresh, and a name that
      // turns out to have ever held the lease (self) does not stay fresh or coordinator either.
      let kind = r[3] || null;
      if (kind && r[2]) { const now = reviewerKind(r[2], self, coordinators); if (KIND_WEIGHT[now] > KIND_WEIGHT[kind]) kind = now; }
      reviews.push({ n: e.n, at: e.at, verdict: r[1], by: r[2] || null, kind });
      continue;
    }
    if (e.text.startsWith(`${id} evidence row · `)) evidence.push(e);
  }
  const last = reviews[reviews.length - 1] || null;
  // Only approves logged after the last "changes" verdict are even candidates — a changes still needs its own
  // approve, as before. Among those, and past cut, the strongest kind wins, tie-broken by the more recent.
  let sinceChanges = reviews;
  for (let i = reviews.length - 1; i >= 0; i -= 1) { if (reviews[i].verdict === 'changes') { sinceChanges = reviews.slice(i + 1); break; } }
  let live = null;
  for (const r of sinceChanges) {
    if (r.verdict !== 'approve' || r.n <= cut) continue;
    const rw = KIND_WEIGHT[r.kind] ?? Infinity;
    const lw = live ? (KIND_WEIGHT[live.kind] ?? Infinity) : Infinity;
    if (!live || rw < lw || (rw === lw && r.n > live.n)) live = r;
  }
  return {
    tracked: anchor !== null,
    anchor: anchor ? { at: anchor.at, what: anchor.text.startsWith('filed ') ? 'filed' : anchor.text.slice(id.length + 1).split(' · ')[0].replace(/^→ /, '') } : null,
    rowsSince: anchor ? evidence.filter((e) => e.n > anchor.n).length : evidence.length,
    lastReview: last ? last.verdict : null,
    lastApprove: [...reviews].reverse().find((r) => r.verdict === 'approve') || null,
    approved: Boolean(live && live.kind !== 'self'),
    selfApproved: Boolean(live && live.kind === 'self'),
    fresh: Boolean(live && live.kind === 'fresh'),
    live,
    workers: self,
  };
}

// The latest review against the rounds and reopens after it (kept for callers of the older shape).
export function reviewState(root, id) {
  const g = gateState(root, id);
  return { approved: g.approved, lastReview: g.lastReview };
}

// Who reviewed the done issues: the kind of each one's last approve, and how many carry no reviewer at all
// (approved before --by existed). Shown by status and report, never acted on.
export function reviewSplit(root, issues = loadIssues(root), journal = journalById(root)) {
  const split = { fresh: 0, coordinator: 0, self: 0, unrecorded: 0 };
  const coordinators = coordinatorNames(root);
  const profile = loadProfile(root);
  for (const i of issues.filter((x) => profile.is(x.status, 'closes-record'))) {
    // The live approve — the one that actually cleared the issue — not simply the last one recorded: a later
    // coordinator (or self) approve does not make an already-cleared issue read as coordinator- or self-reviewed.
    const a = gateState(root, i.id, journal.get(i.id) || [], coordinators, issues, journal).live;
    split[a && a.kind ? a.kind : 'unrecorded'] += 1;
  }
  return split;
}
// Who stands behind the closed issues: the reviewers, by kind — or, under a done gate with no approve, the merge that
// landed each one, with whatever reviews were recorded all the same.
function gateLine(profile, split, label) {
  if (profile.doneGate.approve !== 'none') return `${label}: ${renderSplit(split)}`;
  return `closed on a merge in the base, no approve required (this loop's done gate) · reviews recorded: ${renderSplit(split)}`;
}
function renderSplit(s) { return `fresh ${s.fresh} · coordinator ${s.coordinator} · self ${s.self}${s.unrecorded ? ` · unrecorded ${s.unrecorded}` : ''}`; }

// ---- the check a loop lands on, and the loop's metrics (report --json) ----------------------------------------------

// The check a loop declares: every `Check: <what runs>` line in goal.md (a plain line, a list item, or in bold), several
// for a loop whose repositories each have their own. Jarl never runs it: the line says what decides a landing, so the
// views can tell a loop whose merges pass a check from one that lands on its reviews alone. Where the repository has a
// check, the check decides what lands; a review can only stop a change and is recorded as testimony. A loop with no
// declared check lands on testimony alone, and status and report say so.
export function declaredChecks(root) {
  const goal = join(jarlDir(root), 'goal.md');
  if (!existsSync(goal)) return [];
  const checks = [];
  for (const line of readText(goal).split('\n')) {
    const m = /^\s*(?:[-*]\s+)?(?:\*\*)?check:(?:\*\*)?\s*(.+)$/i.exec(line);
    if (m && fieldText(m[1].replace(/\*\*/g, ''))) checks.push(fieldText(m[1].replace(/\*\*/g, '')).replace(/^`(.*)`$/, '$1'));
  }
  return checks;
}
export function checkState(root) {
  const checks = declaredChecks(root);
  return { declared: checks.length > 0, checks, landsOn: checks.length ? 'check' : 'testimony' };
}
export const TESTIMONY_NOTE = 'no check declared — this loop lands on testimony alone: a review is recorded as testimony, not proof (a `Check: <command>` line in goal.md names the check that decides a landing)';
function checkLine(c) { return c.declared ? `check: ${c.checks.join(' · ')}` : TESTIMONY_NOTE; }

// A journal stamp (YYYY-MM-DD HH:MM, UTC) in milliseconds.
function stampMs(at) { return Date.parse(`${at.replace(' ', 'T')}:00Z`); }
const HOUR = 3600000;
const DAY = 24 * HOUR;
const round1 = (x) => Math.round(x * 10) / 10;
const share = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);
const pct = (s) => `${round1(s * 100)}%`;
function spread(values) {
  if (!values.length) return { n: 0, medianHours: null, p90Hours: null, maxHours: null };
  const v = [...values].sort((a, b) => a - b);
  const at = (q) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
  const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { n: v.length, medianHours: round1(mid / HOUR), p90Hours: round1(at(0.9) / HOUR), maxHours: round1(v[v.length - 1] / HOUR) };
}
// A three-digit issue number standing alone in a text: no letter or digit touches it, so a sha (1b066c7) or a longer
// number never reads as one, while reviewer-450, raport-398 and (024) do.
function idsNamed(text) { return [...String(text || '').matchAll(/(?<![0-9A-Za-z])(\d{3})(?![0-9A-Za-z])/g)].map((m) => m[1]); }

// The loop's metrics, read from its record alone — the journal and the issue files — never from git or a network. Each
// metric carries n (how many issues it was read from) and, where the record holds nothing to read it from, noData with
// the reason and null values instead of a zero: an approve logged before --by existed has no kind, a loop with no merge
// has no CI after a merge, and a zero there would claim something the record never said.
//
// - cycleTime: first move into a status that holds the claim (in progress) → last move into one that closes the record
//   (done), per closed issue; leadTime the same from its filing. Hours, median, p90, max.
// - rounds: `round` lines and `changes` verdicts per closed issue the journal tracks.
// - reopenings: moves out of a status that closes the record (done back to open or in progress), on any issue the
//   journal tracks; deferred or dropped work brought back is not a reopening — nothing was closed as finished.
// - freshReviews: the kind of the live approve that cleared each closed issue (see gateState), its share among those
//   with a recorded kind, the same for closed issues carrying code, and who the fresh reviewers were.
// - redCiAfterMerge: issues whose CI was recorded red at any point after their merge, among merges whose CI settled
//   (green or red); pending and none (no CI to wait for) are counted apart.
// - followUps: issues filed within 7 days after a closed issue first closed whose Found by names its number. A closed
//   research issue is left out: the issues filed from its findings are what it was for, not defects it left behind.
export const FOLLOW_UP_DAYS = 7;
export function loopMetrics(root, issues = loadIssues(root), journal = journalById(root), now = Date.now()) {
  const profile = loadProfile(root);
  const coordinators = coordinatorNames(root);
  const closes = (st) => profile.is(st, 'closes-record');
  const claims = (st) => profile.is(st, 'holds-claim');
  const byId = new Map(issues.map((i) => [i.id, i]));
  // One pass over each issue's journal: filed, the moves, rounds, changes, merges and CI states.
  const facts = new Map();
  for (const i of issues) {
    const f = { filed: null, firstClaim: null, firstClose: null, lastClose: null, rounds: 0, changes: 0, reopens: 0, merged: false, ci: [], tracked: false };
    let status = null;
    const moved = movesInto(profile.statuses, i.id);
    for (const e of journal.get(i.id) || []) {
      if (e.text.startsWith(`filed ${i.id} `)) { f.filed = f.filed || e.at; status = profile.initial; f.tracked = true; continue; }
      const m = moved.exec(e.text);
      if (m) {
        const prev = status; status = m[1]; f.tracked = true;
        if (claims(status) && !f.firstClaim) f.firstClaim = e.at;
        if (closes(status)) { f.firstClose = f.firstClose || e.at; f.lastClose = e.at; }
        if (prev && closes(prev) && !closes(status)) f.reopens += 1;
        continue;
      }
      if (e.text.startsWith(`${i.id} round `)) { f.rounds += 1; continue; }
      if (e.text.startsWith(`${i.id} review changes `)) { f.changes += 1; continue; }
      const mg = new RegExp(`^${i.id} merged \\S+.* · CI (${CI_STATES.join('|')})$`).exec(e.text);
      if (mg) { f.merged = true; f.ci.push(mg[1]); continue; }
      const ci = new RegExp(`^${i.id} CI (${CI_STATES.join('|')})$`).exec(e.text);
      if (ci && f.merged) f.ci.push(ci[1]);
    }
    // A merge recorded on the issue with no journal line for it (a hand-made file): its CI field as the one reading.
    if (!f.merged && mergedOf(i)) { f.merged = true; if (mergedOf(i).ci) f.ci.push(mergedOf(i).ci); }
    facts.set(i.id, f);
  }
  const closed = issues.filter((i) => closes(i.status));
  const noData = (cond, why) => (cond ? why : null);

  const cycle = closed.map((i) => facts.get(i.id)).filter((f) => f.firstClaim && f.lastClose && stampMs(f.lastClose) >= stampMs(f.firstClaim)).map((f) => stampMs(f.lastClose) - stampMs(f.firstClaim));
  const cycleTime = { ...spread(cycle), of: closed.length, noData: noData(!cycle.length, closed.length ? 'no closed issue has a move into progress and a later close in the journal' : 'nothing closed yet') };
  const lead = closed.map((i) => facts.get(i.id)).filter((f) => f.filed && f.lastClose).map((f) => stampMs(f.lastClose) - stampMs(f.filed));
  const leadTime = { ...spread(lead), of: closed.length, noData: noData(!lead.length, closed.length ? 'no closed issue has its filing and its close in the journal' : 'nothing closed yet') };

  const trackedClosed = closed.filter((i) => facts.get(i.id).tracked);
  const withRounds = trackedClosed.filter((i) => facts.get(i.id).rounds);
  const withChanges = trackedClosed.filter((i) => facts.get(i.id).changes);
  const rounds = {
    n: trackedClosed.length,
    rounds: trackedClosed.length ? withRounds.reduce((s, i) => s + facts.get(i.id).rounds, 0) : null,
    issuesWithRounds: trackedClosed.length ? withRounds.map((i) => i.id) : null,
    changes: trackedClosed.length ? withChanges.reduce((s, i) => s + facts.get(i.id).changes, 0) : null,
    issuesWithChanges: trackedClosed.length ? withChanges.map((i) => i.id) : null,
    noData: noData(!trackedClosed.length, closed.length ? 'the journal tracks no closed issue' : 'nothing closed yet'),
  };

  const tracked = issues.filter((i) => facts.get(i.id).tracked);
  const reopened = tracked.filter((i) => facts.get(i.id).reopens);
  const reopenings = { n: tracked.length, times: tracked.length ? reopened.reduce((s, i) => s + facts.get(i.id).reopens, 0) : null, issues: tracked.length ? reopened.map((i) => i.id) : null, noData: noData(!tracked.length, 'the journal tracks no issue') };

  const kinds = { fresh: 0, coordinator: 0, self: 0, unrecorded: 0 };
  const code = { fresh: 0, coordinator: 0, self: 0, unrecorded: 0 };
  const reviewers = {};
  for (const i of closed) {
    const a = gateState(root, i.id, journal.get(i.id) || [], coordinators, issues, journal).live;
    const k = a && a.kind ? a.kind : 'unrecorded';
    kinds[k] += 1;
    if (carriesCode(i)) code[k] += 1;
    if (k === 'fresh') reviewers[a.by] = (reviewers[a.by] || 0) + 1;
  }
  const recorded = kinds.fresh + kinds.coordinator + kinds.self;
  const codeRecorded = code.fresh + code.coordinator + code.self;
  const freshReviews = {
    n: closed.length, recorded, ...kinds, share: share(kinds.fresh, recorded),
    code: { n: codeRecorded + code.unrecorded, recorded: codeRecorded, ...code, share: share(code.fresh, codeRecorded) },
    reviewers: Object.fromEntries(Object.entries(reviewers).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    noData: noData(!recorded, closed.length ? `no closed issue's approve records who gave it (${kinds.unrecorded} from before --by)` : 'nothing closed yet'),
  };

  const mergedIssues = issues.filter((i) => facts.get(i.id).merged);
  const red = mergedIssues.filter((i) => facts.get(i.id).ci.includes('red'));
  const settled = mergedIssues.filter((i) => facts.get(i.id).ci.some((c) => c === 'green' || c === 'red'));
  const lastCi = (i) => facts.get(i.id).ci[facts.get(i.id).ci.length - 1] || null;
  const redCiAfterMerge = {
    n: mergedIssues.length, settled: settled.length, red: settled.length ? red.length : null, issues: settled.length ? red.map((i) => i.id) : null, share: share(red.length, settled.length),
    pending: mergedIssues.filter((i) => lastCi(i) === 'pending').map((i) => i.id), none: mergedIssues.filter((i) => lastCi(i) === 'none').map((i) => i.id),
    noData: noData(!settled.length, mergedIssues.length ? 'no merge has a CI recorded green or red yet' : 'no merge recorded'),
  };

  // Follow-ups: the closed issues that have a close time in the journal, and every issue filed within the window after
  // it that names its number in Found by. The window of a close less than 7 days ago is still open: counted apart.
  const anyFoundBy = issues.some((i) => fieldText(i.fields['found by']));
  const followable = (i) => i.kind !== 'research' && facts.get(i.id).firstClose;
  const closedAt = closed.filter(followable);
  const found = {};
  for (const y of issues) {
    const filed = facts.get(y.id).filed;
    if (!filed) continue;
    for (const x of new Set(idsNamed(y.fields['found by']))) {
      if (x === y.id || !byId.has(x) || !followable(byId.get(x)) || !closes(byId.get(x).status)) continue;
      const gap = stampMs(filed) - stampMs(facts.get(x).firstClose);
      if (gap >= 0 && gap <= FOLLOW_UP_DAYS * DAY) (found[x] = found[x] || []).push(y.id);
    }
  }
  // The share is taken over the closes whose window has passed: a close from yesterday with no follow-up yet has not
  // shown it has none, so counting it would pull the share toward a zero the record cannot back.
  const windowClosed = closedAt.filter((i) => now - stampMs(facts.get(i.id).firstClose) >= FOLLOW_UP_DAYS * DAY);
  const windowClosedWith = windowClosed.filter((i) => found[i.id]).length;
  const followUps = {
    windowDays: FOLLOW_UP_DAYS, n: closedAt.length, windowOpen: closedAt.length - windowClosed.length,
    withFollowUps: anyFoundBy && closedAt.length ? Object.keys(found).length : null,
    windowClosed: windowClosed.length, windowClosedWithFollowUps: anyFoundBy && windowClosed.length ? windowClosedWith : null,
    share: anyFoundBy ? share(windowClosedWith, windowClosed.length) : null,
    followUps: anyFoundBy ? Object.keys(found).sort().map((id) => ({ id, followUps: found[id] })) : null,
    noData: noData(!anyFoundBy || !closedAt.length, !anyFoundBy ? 'no issue records Found by, so no follow-up can be traced to what it follows' : closed.length ? 'no closed issue outside research has its close in the journal' : 'nothing closed yet'),
  };

  return { check: checkState(root), cycleTime, leadTime, rounds, reopenings, freshReviews, redCiAfterMerge, followUps };
}

export function renderMetrics(m) {
  const nd = (x) => `no data (${x.noData})`;
  const time = (x) => (x.noData ? nd(x) : `median ${x.medianHours} h · p90 ${x.p90Hours} h · max ${x.maxHours} h · n ${x.n} of ${x.of} closed`);
  const list = (ids) => (ids.length ? `: ${ids.join(', ')}` : '');
  const f = m.freshReviews;
  return [
    '## Loop metrics',
    checkLine(m.check),
    `cycle time (in progress → closed): ${time(m.cycleTime)}`,
    `lead time (filed → closed): ${time(m.leadTime)}`,
    `rounds: ${m.rounds.noData ? nd(m.rounds) : `${m.rounds.rounds} on ${m.rounds.issuesWithRounds.length} issue(s) · changes verdicts ${m.rounds.changes} on ${m.rounds.issuesWithChanges.length} issue(s) · n ${m.rounds.n} closed`}`,
    `reopened: ${m.reopenings.noData ? nd(m.reopenings) : `${m.reopenings.issues.length} issue(s), ${m.reopenings.times} time(s)${list(m.reopenings.issues)} · n ${m.reopenings.n}`}`,
    `fresh reviews of closed work: ${f.noData ? nd(f) : `${f.fresh} of ${f.recorded} with a recorded reviewer (${pct(f.share)}) · coordinator ${f.coordinator} · self ${f.self}${f.unrecorded ? ` · no data for ${f.unrecorded} (approved before --by)` : ''}${f.code.recorded ? ` · carrying code: ${f.code.fresh} of ${f.code.recorded} (${pct(f.code.share)})` : ''}`}`,
    ...(Object.keys(f.reviewers).length ? [`fresh reviewers: ${Object.keys(f.reviewers).length}${Object.keys(f.reviewers).length > 5 ? ', most often' : ''} ${Object.entries(f.reviewers).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(' · ')}`] : []),
    `red CI after merge: ${m.redCiAfterMerge.noData ? nd(m.redCiAfterMerge) : `${m.redCiAfterMerge.red} of ${m.redCiAfterMerge.settled} settled (${pct(m.redCiAfterMerge.share)})${list(m.redCiAfterMerge.issues)}`}${m.redCiAfterMerge.pending.length ? ` · pending ${m.redCiAfterMerge.pending.length}` : ''}${m.redCiAfterMerge.none.length ? ` · no CI ${m.redCiAfterMerge.none.length}` : ''}`,
    `follow-ups within ${m.followUps.windowDays} days (Found by names the closed issue): ${m.followUps.noData ? nd(m.followUps) : `${m.followUps.withFollowUps} of ${m.followUps.n} closed${m.followUps.followUps.length ? `: ${m.followUps.followUps.map((x) => `${x.id} ← ${x.followUps.join(', ')}`).join('; ')}` : ''} · ${m.followUps.windowClosed ? `share ${m.followUps.windowClosedWithFollowUps} of ${m.followUps.windowClosed} whose ${m.followUps.windowDays} days have passed (${pct(m.followUps.share)})` : `share: no data (no close is ${m.followUps.windowDays} days old yet)`}${m.followUps.windowOpen ? ` · window still open for ${m.followUps.windowOpen}` : ''}`}`,
  ].join('\n');
}

const SEVERITIES = ['Critical', 'Important', 'Minor'];

// A "changes" verdict names at least one Critical or Important finding — Minor alone never bounces
// a branch back to a worker, it goes to evidence and the branch still merges (the review discipline's
// own rule, enforced here rather than left to a reviewer's judgement).
//
// --by names the reviewer, and every verdict needs it: the line records the name and its kind (fresh, coordinator,
// self). An approve by the issue's own worker — its Worker field, or the worker of its last lease — is refused:
// a self-approve is not a review.
export function cmdReview(root, rawIds, verdict, findings, flags = {}) {
  need(verdict === 'approve' || verdict === 'changes', 'review requires approve|changes');
  need(findings, 'review requires "<findings>" — what was read and what was found, even when nothing');
  need(flags.by === undefined || fieldText(flags.by), '--by needs a value — the reviewer\'s name');
  need(flags.by !== undefined, `a verdict needs --by <reviewer> — who read the diff: a fresh reviewer's name, or jarl when the loop's director reviewed it`);
  const issues = issuesFor(root, rawIds);
  const severities = SEVERITIES.filter((s) => findings.includes(s));
  if (verdict === 'changes') {
    need(severities.length > 0, `"changes" needs at least one finding ranked ${SEVERITIES.join('/')} — name the severity, not just the problem`);
    need(severities.some((s) => s !== 'Minor'), '"changes" needs a Critical or Important finding — Minor alone goes to evidence on an approve, it never bounces a branch');
  }
  const by = flags.by !== undefined ? fieldText(flags.by) : null;
  const journal = by ? journalById(root) : null;
  // The full issue list, not just the ones under review: a sibling elsewhere on the same Branch still counts
  // for self (see gateState/branchWorkers), and loading it once here keeps a package review call linear.
  const allIssues = by ? loadIssues(root) : null;
  const coordinators = coordinatorNames(root);
  const kinds = issues.map((issue) => {
    if (!by) return null;
    // Self is everyone who has ever held this issue's lease — its own worker across every takeover, and the
    // worker of any other issue sharing its Branch (a package) — not only its current Worker field.
    const self = [...gateState(root, issue.id, journal.get(issue.id) || [], coordinators, allIssues, journal).workers];
    const kind = reviewerKind(by, self, coordinators);
    const who = self.length === 1 ? `${self[0]} is the issue's worker` : self.length > 1 ? `${self.join(', ')} have all held ${issue.id}'s lease` : '';
    need(verdict !== 'approve' || kind !== 'self', `${issue.id}: an approve by ${by} is a self-approve${who ? ` (${who})` : ''} and does not count as review — a fresh reviewer, or the jarl, reads the diff${issues.length > 1 ? ' — nothing was written' : ''}`);
    return kind;
  });
  appendLogLines(root, issues.map((issue, n) => `${issue.id} review ${verdict} · ${by ? `by ${by} (${kinds[n]}) · ` : ''}${findings.split('\n')[0]}`));
  // Recorded, never refused: a coordinator's approve on a code issue is a fact of the record, but it does not clear
  // the issue for done or the merge queue — the output says so at once.
  const noteOf = (issue, n) => (verdict === 'approve' && kinds[n] === 'coordinator' && carriesCode(issue) ? { note: `${issue.id} carries code and ${by} is a coordinator — the fresh-review rule: this approve is recorded but does not clear it for done or the merge queue; a fresh reviewer's approve does` } : {});
  // The verdict comes back with the acceptance it was given against, so a reviewer (and the merger reading
  // the output) sees what the approve claims is met — or that there was nothing to meet.
  return oneOrMany(rawIds, issues.map((issue, n) => ({ id: issue.id, verdict, ...(by ? { by, kind: kinds[n] } : {}), severities, acceptance: (issue.sections.acceptance || '').trim(), ...noteOf(issue, n) })));
}

// ---- rounds, branches, checks ------------------------------------------------------------------

function git(root, args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// Read once per run: whether a directory is in a git repository, and every local branch of a repository with its
// tip, upstream (null when none is set or its remote branch is gone), ahead/behind against that upstream and the
// time of its last commit — one git process per repository instead of several per branch, which is what keeps the
// read-only views (status, tips, resume) fast on a loop of hundreds of issues. jarl never moves a ref, so nothing
// read here goes stale while it runs. The caches live for one command: dispatch empties them (resetCaches) before
// each one. Only what was found is kept — a directory that is not a repository, like a Repo path that did not
// resolve, is asked again, so a refusal always names the current state.
const IS_REPO = new Set();
function isGitRepo(dir) {
  if (IS_REPO.has(dir)) return true;
  const ok = git(dir, ['rev-parse', '--git-dir']) !== null;
  if (ok) IS_REPO.add(dir);
  return ok;
}
const REFS = new Map();
export function refsIn(repo) {
  if (REFS.has(repo)) return REFS.get(repo);
  const map = new Map();
  const out = git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)', 'refs/heads']);
  for (const line of (out || '').split('\n').filter(Boolean)) {
    const [ref, sha, up, track, ct] = line.split('\0');
    const gone = track === 'gone';
    map.set(ref.replace(/^refs\/heads\//, ''), {
      sha, upstream: up && !gone ? up : null,
      ahead: up && !gone ? Number(/ahead (\d+)/.exec(track)?.[1] || 0) : null,
      behind: up && !gone ? Number(/behind (\d+)/.exec(track)?.[1] || 0) : null,
      committedMs: Number(ct) * 1000 || null,
    });
  }
  REFS.set(repo, map);
  return map;
}

// Where git runs for an issue's code. A loop may keep its issues in one repository while its workers
// change another; that other repository is named by --repo on the command or by the issue's Repo
// field. A relative path is read from the loop's root, not the caller's directory, because workers,
// reviewers and the merger call the tool from different checkouts with the same --root. Naming
// nothing keeps git where the loop lives, as it always was.
//
// A repository that resolved once resolves the same for the rest of the run: a loop of hundreds of issues names a
// handful of repositories, and each check costs two git processes. A path that failed is checked again, so its
// refusal always names the current state.
const RESOLVED = new Map();
export function repoOf(root, named) {
  if (named === undefined || named === '') return root;
  need(typeof named === 'string', '--repo takes one path — the checkout of the repository the code lives in');
  const key = `${root}\n${named}`;
  if (RESOLVED.has(key)) return RESOLVED.get(key);
  const repo = resolve(root, named);
  need(isGitRepo(repo), `not a git repository: ${repo} (a relative --repo or Repo path is read from the loop's root, ${root})`);
  // A subdirectory of a repository is not the repository: the paths git reports are relative to its root, so a
  // declared file or a removed test would be read from the wrong place and go unseen.
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  need(top !== null && canonical(top) === canonical(repo), `${repo} is inside the repository at ${top}, not its root — name the root: ${portablePath(relative(canonical(root), canonical(top || repo))) || '.'}`);
  RESOLVED.set(key, repo);
  return repo;
}

export function roundsOf(root, id) {
  const path = join(jarlDir(root), 'log.md');
  if (!existsSync(path)) return 0;
  return readText(path).split('\n').filter((l) => l.includes(`· ${id} round `)).length;
}

export function cmdRound(root, rawId, what) {
  need(what, 'round requires "<what failed>"');
  const issue = findIssue(root, rawId);
  need(issue, `no such issue: ${rawId}`);
  const n = roundsOf(root, issue.id) + 1;
  appendLog(root, `${issue.id} round ${n} · ${what}`);
  const takeover = n >= ROUNDS_BEFORE_TAKEOVER;
  const log = readText(join(jarlDir(root), 'log.md')).split('\n').filter((l) => l.includes(`· ${issue.id} `)).join('\n');
  const block = takeover ? `## Takeover\n\nA prior worker attempted issue ${issue.id} ${n} times; the issue is yours now. Its rounds so far:\n\n\`\`\`\n${log}\n\`\`\`\n` : null;
  return { id: issue.id, round: n, takeover, block };
}

function defaultBase(root) {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
}

const ASSERT_RE = /\b(expect\(|assert\.|assert\(|assert |t\.(Error|Fatal|Errorf|Fatalf)\(|Assert\.|should\.|\.toBe|\.toEqual)/g;

function countAsserts(root, ref, files) {
  let n = 0;
  for (const f of files) {
    const text = git(root, ['show', `${ref}:${f}`]);
    if (text === null) continue;
    n += (text.match(ASSERT_RE) || []).length;
  }
  return n;
}

function isTestFile(f) { return /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|Tests?\.[a-z]+$/.test(f); }

// check <id> --branch <b> bounds the diff by that issue's Files; check --branch <b> with no id bounds it by the
// union of Files over every issue that records Branch <b> (in progress or done) — a package on one shared
// branch passes in one call instead of failing each issue for the files of the others.
export function cmdCheck(root, rawId, flags) {
  need(flags.branch, 'check requires --branch <worker branch>');
  let pkg;
  if (rawId === undefined) {
    const profile = loadProfile(root);
    pkg = loadIssues(root).filter((i) => i.fields.branch === flags.branch && (profile.is(i.status, 'holds-claim') || profile.is(i.status, 'closes-record')));
    need(pkg.length, `no issue records branch ${flags.branch} — name one (check <id> --branch ${flags.branch}), or record the package: set <ids> in-progress --branch ${flags.branch}`);
    if (flags.repo === undefined) {
      const repos = new Map();
      for (const i of pkg) for (const n of (reposNamed(i).length ? reposNamed(i) : ['.'])) { const r = canonical(resolve(root, n)); repos.set(r, [...(repos.get(r) || []), i.id]); }
      need(repos.size === 1, `the issues on ${flags.branch} name different repositories (${[...repos.values()].map((ids) => ids.join(', ')).join(' | ')}) — check them one by one, or pass --repo`);
    }
  } else {
    const issue = findIssue(root, rawId);
    need(issue, `no such issue: ${rawId}`);
    pkg = [issue];
    need(flags.repo !== undefined || reposNamed(issue).length <= 1, `${issue.id} names several repositories (${reposNamed(issue).join(', ')}) — check one at a time with --repo <path>`);
  }
  const issue = pkg[0];
  const repo = repoOf(root, flags.repo ?? reposNamed(issue)[0]);
  const realRepo = canonical(repo);
  const where = repo === root ? '' : ` in ${repo}`;
  const base = flags.base || defaultBase(repo);
  const tip = git(repo, ['rev-parse', '--verify', flags.branch]);
  need(tip, `no such branch: ${flags.branch}${where}`);
  const mergeBase = git(repo, ['merge-base', base, flags.branch]);
  need(mergeBase, `no merge base between ${base} and ${flags.branch}${where}`);
  const commits = (git(repo, ['rev-list', '--count', `${mergeBase}..${flags.branch}`]) || '0');
  const changed = (git(repo, ['diff', '--name-only', `${mergeBase}..${flags.branch}`]) || '').split('\n').filter(Boolean);
  // A change proves itself with a test and announces itself in the changelog, so neither is ever
  // "outside" the issue: the scope check is about source, not about the two files every issue touches.
  const alwaysInScope = (f) => isTestFile(f) || /(^|\/)CHANGELOG\.md$/i.test(f);
  // A declared file may be repo-relative (the common case) or relative to some subdirectory the
  // issue itself is scoped to (e.g. a plugin's own skill body); a diff path matches either way —
  // as a root-relative prefix, or as a path suffix ending at a "/" boundary.
  const pathMatches = (f, d) => {
    const dd = d.replace(/\/+$/, '');
    return f === dd || f.startsWith(`${dd}/`) || f.endsWith(`/${dd}`);
  };
  // The diff's paths are inside the repository read, so a file the issue declares with its
  // repository's name first is matched by the path after that name.
  // `--repo` on the command reads the paths as the issue's own Repo field would.
  // An issue that names several repositories bounds the diff by the files it declares in the one read here.
  const listsRepo = (i) => reposNamed(i).some((n) => canonical(resolve(root, n)) === realRepo);
  const named = (i) => (flags.repo !== undefined && !listsRepo(i) ? { ...i, fields: { ...i.fields, repo: flags.repo } } : i);
  const here = pkg.flatMap((i) => i.files.map((d) => ({ d, at: fileAt(root, named(i), d) }))).filter((x) => canonical(x.at.repo) === realRepo);
  const declaredFiles = [...new Set(here.map((x) => x.d))];
  const declared = here.map((x) => x.at.path);
  const outside = declaredFiles.length ? changed.filter((f) => !alwaysInScope(f) && !declared.some((d) => pathMatches(f, d))) : [];
  const noFiles = pkg.length > 1 ? pkg.filter((i) => !here.some((x) => i.files.includes(x.d))).map((i) => i.id) : [];
  const testsBase = (git(repo, ['ls-tree', '-r', '--name-only', mergeBase]) || '').split('\n').filter(isTestFile);
  const testsTip = (git(repo, ['ls-tree', '-r', '--name-only', flags.branch]) || '').split('\n').filter(isTestFile);
  const removedTests = testsBase.filter((f) => !testsTip.includes(f));
  const touchedTests = changed.filter(isTestFile);
  const assertsBase = countAsserts(repo, mergeBase, [...new Set([...touchedTests, ...removedTests])]);
  const assertsTip = countAsserts(repo, flags.branch, touchedTests);
  const items = [
    { name: 'commits beyond base', ok: Number(commits) > 0, note: `${commits} commit(s) on ${flags.branch} beyond ${mergeBase.slice(0, 7)}` },
    { name: 'diff inside declared files', ok: outside.length === 0, note: (declaredFiles.length ? (outside.length ? `outside ${declaredFiles.join(', ')}: ${outside.join(', ')}` : `${changed.length} file(s), all inside`) : `no files declared on the ${pkg.length > 1 ? 'issues' : 'issue'} — nothing to bound the diff by`) + (noFiles.length ? ` (${noFiles.join(', ')} declare${noFiles.length === 1 ? 's' : ''} no files)` : '') },
    { name: 'test files', ok: removedTests.length === 0, note: removedTests.length ? `removed: ${removedTests.join(', ')}` : `${testsTip.length} on the branch, ${touchedTests.length} touched, none removed` },
    { name: 'assertions in touched tests', ok: assertsTip >= assertsBase, note: `${assertsBase} → ${assertsTip}` },
  ];
  return { id: rawId === undefined ? null : issue.id, ids: pkg.map((i) => i.id), branch: flags.branch, repo, base, mergeBase, changed, items, ok: items.every((i) => i.ok) };
}

// Every jarl/* branch, plus every branch some worktree has checked out that is not the base: a
// worker that never renamed its branch still did the work, and a listing that hides it would
// hide a report. Such a branch is marked unnamed so the merger renames it before merging.
// With --repo, all of it is read in that repository, for a loop whose workers change another one.
// Worker branches in one repository, or — with no --repo — in the loop's own repository and in every repository
// an open or in-progress issue names, each row carrying the repository's name. The boot reads this to see a worker
// branch with commits as a report, and in a loop whose issues point at other repositories that is where they are.
export function cmdBranches(root, flags) {
  const hours = staleHours(flags);
  const issues = loadIssues(root);
  const repos = flags.repo !== undefined ? [repoOf(root, flags.repo)] : loopRepos(root, issues);
  return repos.flatMap((repo) => branchesIn(root, repo, flags, issues, hours));
}

function staleHours(flags) {
  if (flags['stale-hours'] === undefined) return STALE_HOURS;
  const h = Number(flags['stale-hours']);
  need(Number.isFinite(h) && h > 0, `--stale-hours takes a positive number of hours (got "${flags['stale-hours']}")`);
  return h;
}

// The loop's own repository, every repository an open or in-progress issue names, and every one an issue
// records a Branch in (a done package's branch waits there to be deleted).
function loopRepos(root, issues = loadIssues(root)) {
  const seen = new Map([[canonical(root), root]]);
  const profile = loadProfile(root);
  for (const issue of issues) {
    const unfinished = profile.unfinished(issue.status);
    if (!unfinished && !(issue.fields.branch && issue.status !== 'dropped')) continue;
    for (const named of reposNamed(issue)) {
      let repo;
      try { repo = repoOf(root, named); } catch { continue; }   // a Repo path that no longer resolves is not the boot's to refuse
      const real = canonical(repo);
      if (!seen.has(real)) seen.set(real, repo);
    }
  }
  return [...seen.values()];
}

// The repository an issue's code lives in, canonical; null when its Repo path no longer resolves. Resolved
// once per spelling of the path in a run: a loop of hundreds of issues names a handful of repositories.
const REPO_OF = new Map();
function issueRepos(root, issue) {
  const key = `${root}\n${issue.fields.repo || ''}`;
  if (!REPO_OF.has(key)) {
    const out = [];
    for (const n of (reposNamed(issue).length ? reposNamed(issue) : [undefined])) { try { out.push(canonical(repoOf(root, n))); } catch { /* no longer resolves */ } }
    REPO_OF.set(key, out);
  }
  return REPO_OF.get(key);
}

// The issues a branch carries in one repository: those that record it as their Branch, and — for an issue
// from before the field — the one whose number the branch's jarl/NNN-* name carries.
function issuesOnBranch(root, issues, realRepo, name) {
  const legacy = /^jarl\/(?:[^/]+\/)?(\d{3})-/.exec(name)?.[1] || /^[^/]+\/jarl\/(\d{3})-/.exec(name)?.[1];
  return issues.filter((i) => issueRepos(root, i).includes(realRepo) && (i.fields.branch ? i.fields.branch === name : i.id === legacy));
}

function parseStamp(s) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(String(s || '').trim());
  return m ? Date.parse(`${m[1]}T${m[2]}:00Z`) : null;
}
export function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// What looks wrong with an in-progress issue's lease — shown, never acted on (no expiry, no takeover): its
// recorded worktree is gone, its recorded branch is gone, or the lease is older than `hours` and its branch
// has no commit that recent either. An issue from before the lease fields has none of them and reads clean.
export function leaseProblems(root, issue, hours = STALE_HOURS, now = Date.now()) {
  if (!loadProfile(root).is(issue.status, 'holds-claim')) return [];
  const f = issue.fields;
  const out = [];
  if (f.worktree && !existsSync(f.worktree)) out.push(`worktree gone: ${f.worktree}`);
  let lastCommit = null;
  if (f.branch) {
    // Outside a git repository there is no branch to find, gone or not. An issue naming several repositories
    // keeps its branch while any of them has it.
    const repos = [];
    for (const n of (reposNamed(issue).length ? reposNamed(issue) : [undefined])) { try { const r = repoOf(root, n); if (isGitRepo(r)) repos.push(r); } catch { /* gone */ } }
    const having = repos.filter((r) => refsIn(r).has(f.branch));
    if (repos.length && !having.length) out.push(`branch gone: ${f.branch}`);
    for (const r of having) { const t = refsIn(r).get(f.branch).committedMs; if (t && (!lastCommit || t > lastCommit)) lastCommit = t; }
  }
  const since = parseStamp(f.since);
  const limit = hours * 3_600_000;
  if (since !== null && now - since > limit && !(lastCommit && now - lastCommit <= limit)) {
    out.push(`idle ${ago(now - since)}: lease since ${f.since}${lastCommit ? `, last commit ${ago(now - lastCommit)} ago` : ''}`);
  }
  return out;
}

// Whether a branch whose issues are all settled (done or dropped, at least one done) can go. 'delete': its tip
// is in the base — an ancestor of it, or of every merge sha its done issues record (a squash or a merge made
// elsewhere) — and its worktree holds nothing uncommitted. 'dirty': it would be, but its worktree has
// uncommitted files. 'unverified': its issues record merges but the branch has commits none of them contain
// (work after the merge, or a squash). A branch matched only by its jarl/NNN- number, with no Branch field
// behind it, is judged by ancestry alone: a number is too weak to trust a recorded merge for. Null otherwise.
function doneMark(repo, base, name, on, dirty, profile = DEFAULT_PROFILE) {
  const closed = (i) => profile.is(i.status, 'closes-record');
  // Given up: finished, settling what waits on it, without closing the record (built-in: dropped). A status that is
  // finished but settles nothing (deferred) is work that waits, and keeps its branch.
  const givenUp = (i) => profile.is(i.status, 'terminal') && profile.is(i.status, 'settles-dependents') && !closed(i);
  const settled = on.length > 0 && on.every((i) => closed(i) || givenUp(i)) && on.some(closed);
  if (!settled) return null;
  const inBase = git(repo, ['merge-base', '--is-ancestor', name, base]) !== null;
  let byRecord = false;
  if (!inBase) {
    const recorded = on.every((i) => i.fields.branch === name);
    const done = on.filter(closed);
    if (!recorded || !done.every((i) => mergedOf(i))) return null;
    byRecord = done.every((i) => git(repo, ['merge-base', '--is-ancestor', name, mergedOf(i).sha]) !== null);
    if (!byRecord) return 'unverified';
  }
  return dirty ? 'dirty' : 'delete';
}

function branchesIn(root, repo, flags, issues = loadIssues(root), hours = STALE_HOURS) {
  const base = flags.base || defaultBase(repo);
  const real = canonical(repo);
  const named = (git(repo, ['branch', '--list', 'jarl/*', '--format=%(refname:short)']) || '').split('\n').filter(Boolean);
  const worktrees = (git(repo, ['worktree', 'list', '--porcelain']) || '').split('\n\n').map((b) => {
    const path = /^worktree (.*)$/m.exec(b)?.[1];
    const branch = /^branch refs\/heads\/(.*)$/m.exec(b)?.[1];
    return { path, branch };
  }).filter((w) => w.branch);
  const mainPath = git(repo, ['rev-parse', '--show-toplevel']);
  // A branch some issue records as its Branch is listed whatever its name: a package's shared branch.
  const leased = [...new Set(issues.filter((i) => i.fields.branch && i.status !== 'dropped' && issueRepos(root, i).includes(real)).map((i) => i.fields.branch))];
  const exists = (b) => git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null;
  const recorded = leased.filter((b) => !named.includes(b) && b !== base && exists(b));
  const extra = worktrees.filter((w) => w.branch !== base && !named.includes(w.branch) && !recorded.includes(w.branch) && w.path !== mainPath).map((w) => w.branch);
  const rows = [...named, ...recorded, ...extra].map((name) => {
    const mb = git(repo, ['merge-base', base, name]);
    const ahead = mb ? Number(git(repo, ['rev-list', '--count', `${mb}..${name}`]) || 0) : null;
    const wt = worktrees.find((w) => w.branch === name);
    // git keeps listing a worktree whose directory was deleted under it (prunable) — that one is gone.
    const wtGone = Boolean(wt && !existsSync(wt.path));
    const dirty = wt && !wtGone ? (git(wt.path, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length : null;
    const on = issuesOnBranch(root, issues, real, name);
    const stale = on.flatMap((i) => leaseProblems(root, i, hours).map((p) => `${i.id} ${p}`));
    // Done → delete: every issue it carries is done or dropped (at least one done), and its work is in the
    // base — the branch is an ancestor of it, or every done issue records its merge.
    const done = doneMark(repo, base, name, on, dirty, loadProfile(root));
    return { repo: basename(repo), branch: name, ahead, worktree: wt ? wt.path : null, ...(wtGone ? { worktreeGone: true } : {}), dirty, unnamed: !name.startsWith('jarl/') && !leased.includes(name), issues: on.map((i) => i.id), stale, done, deletable: done === 'delete' };
  });
  // An in-progress issue whose recorded branch is not in the repository any more: a lease with nothing under it.
  const gone = leased.filter((b) => !exists(b)).map((name) => {
    const on = issuesOnBranch(root, issues, real, name);
    const stale = on.flatMap((i) => leaseProblems(root, i, hours).map((p) => `${i.id} ${p}`));
    return { repo: basename(repo), branch: name, ahead: null, worktree: null, dirty: null, unnamed: false, issues: on.map((i) => i.id), stale, done: null, deletable: false, missing: true };
  }).filter((r) => r.stale.length);
  return [...rows, ...gone];
}

// ---- tips: where each repository's branches stand, and their CI -----------------------------------

// A directory's repository, as one key: the canonical root of the git repository holding it, so a loop kept in a
// subdirectory and a Repo path naming that repository's root (../../..) are one repository, not two.
const TOP_OF = new Map();
function topOf(dir) {
  if (!TOP_OF.has(dir)) TOP_OF.set(dir, canonical(git(dir, ['rev-parse', '--show-toplevel']) || dir));
  return TOP_OF.get(dir);
}
function issueTops(root, issue) { return issueRepos(root, issue).map(topOf); }

// A merge counts as recent for tips while its CI is pending or red, or for this long after its log line.
export const TIPS_RECENT_MS = 7 * 24 * 3_600_000;

// gh, when it is on PATH (JARL_GH names another binary: a test knob). Null when it cannot be run: tips then
// says nothing about CI rather than guessing. A JARL_GH ending in .js, .mjs or .cjs is run by process.execPath, so a stub
// works the same on every OS: Windows runs no shebang script, and no .cmd shim without a shell.
let GH;
// Every cache a command fills, emptied before the next one (see dispatch).
export function resetCaches() {
  for (const m of [IS_REPO, REFS, RESOLVED, REPO_OF, TOP_OF]) m.clear();
  GH = undefined;
}
function ghBin() {
  if (GH !== undefined) return GH;
  const bin = process.env.JARL_GH || 'gh';
  try { runGh(bin, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000 }); GH = bin; } catch { GH = null; }
  return GH;
}
function runGh(bin, args, opts) {
  return /\.[cm]?js$/i.test(bin) ? execFileSync(process.execPath, [bin, ...args], opts) : execFileSync(bin, args, opts);
}
// The CI runs for one commit, summed up: pending while any run is not completed, red when any concluded
// otherwise than success, skipped or neutral, green when all did, none when no run exists. Null without gh or
// when gh fails (not logged in, no remote on GitHub): unknown, never red.
export function ciOf(repo, sha) {
  const bin = ghBin();
  if (!bin) return null;
  let runs;
  try {
    runs = JSON.parse(runGh(bin, ['run', 'list', '--commit', sha, '--json', 'conclusion,status,databaseId,workflowName', '--limit', '20'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }));
  } catch { return null; }
  if (!Array.isArray(runs)) return null;
  const pending = runs.filter((r) => r.status && r.status !== 'completed');
  const bad = runs.filter((r) => r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion));
  const state = !runs.length ? 'none' : pending.length ? 'pending' : bad.length ? 'red' : 'green';
  const pick = bad[0] || pending[0] || runs[0];
  return { state, runs: runs.length, ...(pick ? { run: pick.databaseId ?? null, workflow: pick.workflowName ?? null, conclusion: pick.conclusion || pick.status || null } : {}) };
}

// tips — read-only: for the loop's own repository and every repository an open, in-progress or recently merged
// issue names, the tip of each branch that matters there — the feature branches its in-progress issues record,
// the branch its checkout is on (the release branch), and main — with ahead/behind against its upstream as last
// fetched (nothing is fetched), and, when gh is on PATH, the CI of that exact commit. It never gates anything.
export function cmdTips(root, { ci: askCi = true } = {}) {
  const issues = loadIssues(root);
  const journal = journalById(root);
  const now = Date.now();
  const recent = (i) => {
    const m = mergedOf(i);
    if (!m || i.status === 'dropped') return false;
    if (m.ci === 'pending' || m.ci === 'red') return true;
    const line = [...(journal.get(i.id) || [])].reverse().find((e) => e.text.startsWith(`${i.id} merged `));
    const at = line ? parseStamp(line.at) : null;
    return at !== null && now - at <= TIPS_RECENT_MS;
  };
  const profile = loadProfile(root);
  const named = issues.filter((i) => profile.unfinished(i.status) || recent(i));
  const repos = new Map([[topOf(root), root]]);
  for (const i of named) {
    const m = mergedOf(i);
    for (const n of [...reposNamed(i), ...(m && m.repo ? [m.repo] : [])]) { try { const r = repoOf(root, n); if (!repos.has(topOf(r))) repos.set(topOf(r), r); } catch { /* gone */ } }
  }
  const out = [];
  for (const [real, repo] of repos) {
    if (!isGitRepo(repo)) continue;
    const current = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const refs = refsIn(repo);
    const exists = (b) => refs.has(b);
    const main = ['main', 'master'].find(exists) || null;
    const flight = issues.filter((i) => profile.is(i.status, 'holds-claim') && i.fields.branch && issueTops(root, i).includes(real));
    // A worker branch of an issue naming several repositories lives in one or some of them: it is shown where it
    // is, and GONE only when none of them has it.
    const hasBranch = (dir, b) => isGitRepo(dir) && refsIn(dir).has(b);
    const elsewhere = (b) => flight.filter((i) => i.fields.branch === b).some((i) => issueRepos(root, i).some((r) => topOf(r) !== real && hasBranch(r, b)));
    const feature = [...new Set(flight.map((i) => i.fields.branch))].filter((b) => exists(b) || !elsewhere(b));
    const wanted = [...feature.map((b) => ({ role: 'feature', branch: b })), ...(current && current !== 'HEAD' ? [{ role: 'release', branch: current }] : []), ...(main ? [{ role: 'main', branch: main }] : [])];
    const seen = new Set();
    const rows = [];
    for (const w of wanted) {
      if (seen.has(w.branch)) continue;
      seen.add(w.branch);
      if (!exists(w.branch)) { rows.push({ ...w, sha: null, missing: true }); continue; }
      const ref = refs.get(w.branch);
      const sha = ref.sha;
      // A worker branch cut with tracking of the release branch has no upstream of its own: only a remote branch
      // of the same name counts as where it was pushed.
      let upstream = ref.upstream;
      if (upstream && w.role === 'feature' && !upstream.endsWith(`/${w.branch}`)) upstream = null;
      let ahead = null; let behind = null; let against = null;
      if (upstream) {
        ahead = ref.ahead; behind = ref.behind; against = upstream;
      } else if (w.role === 'feature' && current && current !== 'HEAD' && current !== w.branch) {
        const lr = (git(repo, ['rev-list', '--left-right', '--count', `${w.branch}...${current}`]) || '').split(/\s+/).map(Number);
        [ahead, behind] = lr; against = current;
      }
      const on = w.role === 'feature' ? flight.filter((i) => i.fields.branch === w.branch).map((i) => i.id) : [];
      // CI runs on what was pushed: only a tip its upstream already holds (nothing ahead) is asked about.
      const pushed = Boolean(upstream) && ahead === 0;
      const ci = pushed && askCi ? ciOf(repo, sha) : null;
      rows.push({ ...w, sha: sha.slice(0, 12), upstream: upstream || null, against, ahead, behind, pushed, ...(on.length ? { issues: on } : {}), ...(ci ? { ci } : {}) });
    }
    const merged = named.filter((i) => mergedOf(i) && issueTops(root, i).includes(real)).map((i) => ({ id: i.id, sha: mergedOf(i).sha, ci: mergedOf(i).ci }));
    out.push({ repo: basename(real), path: repo, rows, ...(merged.length ? { merged } : {}) });
  }
  return { gh: askCi ? ghBin() !== null : null, ci: askCi, repos: out };
}

export function renderTips(o) {
  const lines = [];
  for (const r of o.repos) {
    lines.push(`[${r.repo}] ${r.path}`);
    for (const x of r.rows) {
      if (x.missing) { lines.push(`  ${x.role.padEnd(8)} ${x.branch}  GONE`); continue; }
      const ab = x.against ? `  ${x.ahead === 0 && x.behind === 0 ? `= ${x.against}` : `+${x.ahead}/-${x.behind} vs ${x.against}`}` : '  (no upstream)';
      const ci = x.ci ? `  ci ${x.ci.state}${x.ci.run ? ` (run ${x.ci.run}${x.ci.workflow ? ` ${x.ci.workflow}` : ''})` : ''}` : x.pushed ? '' : '  not pushed';
      lines.push(`  ${x.role.padEnd(8)} ${x.branch} ${x.sha}${ab}${ci}${x.issues ? `  → ${x.issues.join(', ')}` : ''}`);
    }
    for (const m of r.merged || []) lines.push(`  merged   ${m.id} ${m.sha} · CI ${m.ci || 'not recorded'}`);
  }
  return lines.join('\n') || '(no repository)';
}

// ---- the merge queue: derived, never stored --------------------------------------------------------

// queue [--repo <path>] [--base <b>] — read-only: the branches waiting for the merger. A branch is in the queue when
// an unsettled issue on it (open or in progress) holds a live approve — one no round, restart or reopen has spent,
// by a fresh reviewer (the done gate's reading for an issue that carries code) — and the branch has commits its base does
// not, so it is not merged yet. Rows are ordered by approval (the latest live approve on the branch, then the log's
// order) and, per repository, cut into batches the way the merger's brief batches: a branch joins the current batch
// while its declared files share none with it, and starts the next one otherwise. It computes, holds no lock and
// writes nothing; it runs no check and refuses no merge — that is Horde's land.
export function cmdQueue(root, flags = {}) {
  const profile = loadProfile(root);
  // Under an external scheduler the merge order is its own (and with approve: none no fresh approve would ever queue
  // anything): { scheduler, note, repos: [] }.
  if (profile.scheduler) return { scheduler: profile.scheduler, note: schedulerNote(profile.scheduler), repos: [] };
  const issues = loadIssues(root);
  const journal = journalById(root);
  // Only work in play (offered or worked on): an issue waiting in a status with no such flag (a proposal, a block) is
  // never queued for merge.
  const unsettled = issues.filter((i) => profile.active(i.status));
  const coordinators = coordinatorNames(root);
  const gate = new Map(unsettled.map((i) => [i.id, gateState(root, i.id, journal.get(i.id) || [], coordinators, issues, journal)]));
  // Every issue in the queue sits on a branch, so it carries code: only a fresh approve puts it there (the
  // fresh-review rule). One cleared by a coordinator alone waits, listed with its package as waiting for review.
  const approved = unsettled.filter((i) => gate.get(i.id).fresh);
  const repos = flags.repo !== undefined ? [repoOf(root, flags.repo)] : loopRepos(root, issues);
  const out = [];
  for (const repo of repos) {
    if (!isGitRepo(repo)) continue;
    const real = canonical(repo);
    const base = flags.base || defaultBase(repo);
    const exists = (b) => refsIn(repo).has(b);
    // The branch an approved issue is on: its Branch field, else — for an issue from before the field — the one
    // jarl/NNN-* branch carrying its number.
    const branchOf = (i) => {
      if (i.fields.branch) return exists(i.fields.branch) ? i.fields.branch : null;
      const legacy = (git(repo, ['branch', '--list', `jarl/${i.id}-*`, `jarl/*/${i.id}-*`, '--format=%(refname:short)']) || '').split('\n').filter(Boolean);
      return legacy.length === 1 ? legacy[0] : null;
    };
    const branches = new Map();
    for (const i of approved.filter((x) => issueRepos(root, x).includes(real))) {
      const b = branchOf(i);
      if (b && b !== base) branches.set(b, [...(branches.get(b) || []), i]);
    }
    const rows = [];
    for (const [branch, on] of branches) {
      const mb = git(repo, ['merge-base', base, branch]);
      const ahead = mb ? Number(git(repo, ['rev-list', '--count', `${mb}..${branch}`]) || 0) : null;
      if (!ahead) continue;   // nothing its base lacks: merged already, or never worked on
      const others = issuesOnBranch(root, unsettled, real, branch).filter((i) => !on.includes(i));
      // The live approve, not simply the last one recorded: a later coordinator approve does not spend an
      // earlier, still-live fresh approve, so the row still credits the fresh reviewer who actually cleared it.
      const approves = on.map((i) => gate.get(i.id).live);
      const last = approves.reduce((a, b) => (!a || b.n > a.n ? b : a), null);
      const files = [...new Set(on.concat(others).flatMap((i) => i.files.map((f) => { const at = fileAt(root, i, f); return canonical(at.repo) === real ? at.path : null; }).filter(Boolean)))];
      rows.push({ branch, issues: on.map((i) => i.id), waitingReview: others.map((i) => i.id), ready: others.length === 0, ahead, approvedAt: last.at, by: last.by, files, n: last.n });
    }
    rows.sort((a, b) => a.n - b.n);
    // Batches: consecutive rows whose declared files do not meet. A row with no files declared rides alone —
    // nothing says what it touches.
    let batch = 0; let taken = null;
    for (const r of rows) {
      if (!taken || !r.files.length || r.files.some((f) => taken.has(f))) { batch += 1; taken = new Set(); }
      r.files.forEach((f) => taken.add(f));
      if (!r.files.length) taken = null;
      r.batch = batch;
      delete r.n;
    }
    out.push({ repo: basename(real), path: repo, base, rows });
  }
  return { repos: out };
}

export function renderQueue(o) {
  if (o.scheduler) return o.note;
  const lines = [];
  for (const r of o.repos) {
    if (!r.rows.length && o.repos.length > 1) continue;
    lines.push(`[${r.repo}] into ${r.base}`);
    if (!r.rows.length) lines.push('  (nothing approved waits to be merged)');
    r.rows.forEach((x, n) => {
      lines.push(`  ${n + 1}. ${x.branch} → ${x.issues.join(', ')}  +${x.ahead}  approved ${x.approvedAt}${x.by ? ` by ${x.by}` : ''}  batch ${x.batch}${x.ready ? '' : `  (waiting for review: ${x.waitingReview.join(', ')})`}`);
    });
  }
  return lines.join('\n') || '(nothing approved waits to be merged)';
}

// ---- changelog fragments -----------------------------------------------------------------------------

// changelog <ids> [--repo <path>] — the ## Changelog entries of those issues, grouped by Keep a Changelog section in
// its order, ready to paste under [Unreleased] at merge time; one block per repository when the issues span several
// (an issue naming two is printed under each), or only the one --repo names. Workers record their line on the issue
// (new/body --changelog) instead of editing CHANGELOG.md, so parallel branches stop conflicting there; whoever merges
// writes the file once. Reads only.
export function cmdChangelog(root, rawIds, flags = {}) {
  need(rawIds !== undefined, 'changelog requires <ids> — the issues whose fragments to print, e.g. 284,288 or 203-206');
  const issues = issuesFor(root, rawIds);
  // --repo is matched by the repository itself (its resolved root), never by its folder name alone.
  const only = flags.repo !== undefined ? topOf(canonical(repoOf(root, flags.repo))) : null;
  const byRepo = {};
  const missing = [];
  for (const i of issues) {
    const entries = changelogEntries(i);
    if (!entries.length) { missing.push(i.id); continue; }
    if (only && !issueTops(root, i).includes(only)) continue;
    const names = only ? [basename(only)] : repoNames(root, i);
    for (const r of names) {
      const sec = (byRepo[r] = byRepo[r] || {});
      for (const e of entries) (sec[e.section] = sec[e.section] || []).push(e.text);
    }
  }
  const order = (sec) => Object.fromEntries(CHANGELOG_SECTIONS.filter((k) => sec[k]).map((k) => [k, sec[k]]));
  const repos = Object.keys(byRepo).sort();
  const block = (sec) => CHANGELOG_SECTIONS.filter((k) => sec[k]).map((k) => `### ${k}\n${sec[k].map((t) => `- ${t}`).join('\n')}`).join('\n\n');
  const text = repos.length > 1 ? repos.map((r) => `## ${r}\n\n${block(byRepo[r])}`).join('\n\n') : repos.length ? block(byRepo[repos[0]]) : '';
  return { ids: issues.map((i) => i.id), missing, repos: Object.fromEntries(repos.map((r) => [r, order(byRepo[r])])), ...(repos.length <= 1 ? { sections: repos.length ? order(byRepo[repos[0]]) : {} } : {}), text };
}

// ---- questions to the user and the handoff --------------------------------------------------

function asksPath(root) { return join(jarlDir(root), 'asks.md'); }
// A ratify item the close's batch filed names the area ruling it asks about: `· ruling <slug>`.
const ASK_RE = /^- \*\*a-(\d{3})\*\* \((open|answered)\)(?: · (stop|stuck|lower|charter|ratify))?(?: · target (\S+))?(?: · issue (\d{3}))?(?: · ruling ([A-Za-z0-9][A-Za-z0-9._-]{0,79}))? · (.*)$/;

export function loadAsks(root) {
  const path = asksPath(root);
  if (!existsSync(path)) return [];
  return readText(path).split('\n').map((l) => ASK_RE.exec(l)).filter(Boolean)
    .map((m) => ({ id: m[1], state: m[2], kind: m[3] || null, target: m[4] || null, issue: m[5] || null, ...(m[6] ? { ruling: m[6] } : {}), question: m[7] }));
}

export function cmdAsk(root, question, flags) {
  need(question, 'ask requires "<question>"');
  const kind = String(flags.kind || 'stuck');
  need(ASK_KINDS.includes(kind), `--kind must be one of: ${ASK_KINDS.join(', ')} — stop (halt everything), stuck (this issue only), lower (weaken something protected, needs a target), charter (the goal itself), ratify (a choice already made under a mandate, awaiting the user's word; blocks nothing)`);
  if (flags.issue !== undefined) need(findIssue(root, flags.issue), `no such issue: ${flags.issue}`);
  need(kind !== 'lower' || flags.target, '--target is required for kind lower — nothing to weaken without naming it');
  need(kind === 'lower' || !flags.target, `--target has no meaning for kind "${kind}" — only lower names something to weaken`);
  const asks = loadAsks(root);
  const id = String(asks.reduce((m, a) => Math.max(m, Number(a.id)), 0) + 1).padStart(3, '0');
  const path = asksPath(root);
  const target = kind === 'lower' ? ` · target ${flags.target}` : '';
  // flags.ruling is not a flag of the command line: only the close's ratification batch passes it.
  const ruling = kind === 'ratify' && flags.ruling ? ` · ruling ${flags.ruling}` : '';
  appendAtomic(path, '# Questions to the user\n\n', `- **a-${id}** (open) · ${kind}${target}${flags.issue ? ` · issue ${String(flags.issue).padStart(3, '0')}` : ''}${ruling} · ${question}\n`);
  appendLog(root, `asked a-${id} (${kind}) · ${question}`);
  return { id, question, kind };
}

// The one word that answers a ratification: the first word of the answer, without case or trailing punctuation.
// "no" is not among them: it is English no and colloquial Polish yes ("no tak", "no"), so it decides nothing alone —
// the word after it decides ("no tak" ratifies, "no nie" rejects), and a bare "no" is refused with a request for
// tak or nie rather than read as a rejection the user may not have meant.
export const RATIFY_WORDS = ['yes', 'ok', 'ratify', 'ratified', 'accept', 'accepted', 'approve', 'approved', 'tak'];
export const REJECT_WORDS = ['reject', 'rejected', 'nie'];
export const AMBIGUOUS_WORDS = ['no'];
function ratifyVerdict(answer) {
  const words = String(answer).trim().split(/\s+/).map((w) => w.toLowerCase().replace(/[.,;:!?]+$/, ''));
  const verdict = (w) => (RATIFY_WORDS.includes(w) ? 'ratified' : REJECT_WORDS.includes(w) ? 'rejected' : null);
  return AMBIGUOUS_WORDS.includes(words[0]) ? verdict(words[1] || '') : verdict(words[0]);
}
function ratifyRefusal(id, ruling, answer) {
  const first = String(answer).trim().split(/\s+/)[0].toLowerCase().replace(/[.,;:!?]+$/, '');
  if (AMBIGUOUS_WORDS.includes(first)) return `a-${id} ratifies ruling ${ruling}: "${first}" is English no and colloquial Polish yes, so it decides nothing — answer tak or nie (yes or reject)`;
  return `a-${id} ratifies ruling ${ruling}: the answer starts with one word — ${RATIFY_WORDS.join(', ')} to ratify it, ${REJECT_WORDS.join(', ')} to reject it`;
}

export function cmdAnswer(root, rawId, answer, flags = {}) {
  need(answer, 'answer requires "<answer>"');
  need(flags.by === undefined || fieldText(flags.by), '--by needs a value — who answered: owner or a name');
  const by = flags.by === undefined ? null : fieldText(flags.by);
  const id = String(rawId).replace(/^a-/, '').padStart(3, '0');
  const ask = loadAsks(root).find((a) => a.id === id);
  need(ask, `no such question: a-${id}`);
  need(ask.state === 'open', `a-${id} is already answered`);
  // A batch item asks about one area ruling, and its answer says one word first: yes or reject (tak or nie).
  const rulings = ask.ruling ? loadDecisions(root) : [];
  const ruling = ask.ruling ? rulings.find((d) => d.slug === ask.ruling) : null;
  const verdict = ask.ruling ? ratifyVerdict(answer) : null;
  need(!ask.ruling || verdict, ask.ruling && !verdict ? ratifyRefusal(id, ask.ruling, answer) : '');
  need(!ask.ruling || ruling, `a-${id} ratifies ruling ${ask.ruling}, which is no longer in decisions.md`);
  appendDecision(root, `ask-${id}`, `**Question:** ${ask.question}\n**Answer:** ${answer}`, { by: by || 'owner' });
  const path = asksPath(root);
  writeAtomic(path, readText(path).replace(`- **a-${id}** (open)`, `- **a-${id}** (answered)`));
  appendLog(root, `answered a-${id} · ${answer.split('\n')[0]}`);
  // The issue the question was about carries the answer too, so reading the issue is enough.
  const issue = ask.issue ? findIssue(root, ask.issue) : null;
  if (issue) appendRuling(root, [issue], `Ruling ask-${id}${ask.kind ? ` (${ask.kind})` : ''}: ${answer.split('\n')[0]}`);
  const out = { id, answer, ...(issue ? { issue: issue.id } : {}) };
  if (ruling) Object.assign(out, ratify(root, ruling, rulings, verdict, id, by));
  return out;
}

// A ratification answered: the ruling is marked in place. A ratified area ruling hands back the entry for the type's
// decision log (typeDecision: { type, text, supersedes }) and, when it names a rule of the graph (decide --rule), the
// ratification of that rule (ruleRatification: { rule, text }, with by when answer --by named who gave it) — what the command line writes through yg-edge.mjs,
// the one place in Jarl that reaches another tool, and what a composer standing on record.mjs may write with its own
// code. This module never writes either: it reads and writes the loop's files only.
function ratify(root, ruling, rulings, verdict, askId, by = null) {
  markDecision(root, ruling.slug, `**${verdict === 'ratified' ? 'Ratified' : 'Rejected'}:** a-${askId} (${today()})`);
  appendLog(root, `${verdict} ${ruling.slug} · a-${askId}${ruling.area ? ` · area ${ruling.area}` : ''}`);
  const out = { ruling: ruling.slug, verdict, typeDecision: null, typeLog: null, ruleRatification: null, ruleLog: null };
  if (verdict !== 'ratified' || !ruling.area) return out;
  if (ruling.supersededBy) {
    const skipped = { state: 'skipped', reason: `superseded by ${ruling.supersededBy}, whose own item asks about it` };
    return { ...out, typeLog: skipped, ...(ruling.rule ? { ruleLog: skipped } : {}) };
  }
  // The ruling it replaces, when its entry is in the same type's log, is replaced there too.
  const prior = ruling.supersedes ? rulings.find((d) => d.slug === ruling.supersedes) : null;
  const supersedes = prior && prior.typeLog && prior.typeLog.type === ruling.area ? prior.typeLog.datetime : null;
  const text = `${ruling.ruling}\n\n(ratified: ${ruling.slug}, a-${askId})`;
  return { ...out, typeDecision: { type: ruling.area, text, supersedes }, ...(ruling.rule ? { ruleRatification: { rule: ruling.rule, text, ...(by ? { by } : {}) } } : {}) };
}

// What became of a ratified area ruling's entry in the type's decision log, recorded: a written one marks the ruling
// **Type log:** <type> · <datetime> (what a later ruling superseding it replaces); a failed one is a log line. Either
// way the ruling stays in decisions.md.
export function recordTypeLog(root, slug, decision, result) {
  if (result.state === 'written') {
    markDecision(root, slug, `**Type log:** ${decision.type} · ${result.datetime || 'unknown'}`);
    appendLog(root, `${slug} written into the decision log of type ${decision.type}${decision.supersedes ? ` · supersedes ${decision.supersedes}` : ''}`);
  } else if (result.state === 'failed') {
    appendLog(root, `${slug} NOT written into the decision log of type ${decision.type} · ${result.reason}`);
  }
}

// What became of a ratified ruling's rule ratification in the rule's own log, recorded the same way: a written one
// marks the ruling **Rule log:** <rule> · <datetime>; a failed one is a log line.
export function recordRuleLog(root, slug, ratification, result) {
  if (result.state === 'written') {
    markDecision(root, slug, `**Rule log:** ${ratification.rule} · ${result.datetime || 'unknown'}`);
    appendLog(root, `${slug} ratified rule ${ratification.rule} in its own log · by ${result.by}`);
  } else if (result.state === 'failed') {
    appendLog(root, `${slug} did NOT ratify rule ${ratification.rule} in its own log · ${result.reason}`);
  }
}

// A ruling written into issues' Evidence, after what is there, with one log line each. The status is left
// alone: a ruling may settle the question and still leave work, and done keeps its own preconditions.
function appendRuling(root, issues, line) {
  for (const issue of issues) {
    const text = readText(issue.file);
    const current = (parseIssue(text, issue.file).sections.evidence || '').trim();
    writeAtomic(issue.file, setSection(text, 'Evidence', current ? `${current}\n\n${line}` : line));
  }
  appendLogLines(root, issues.map((issue) => `${issue.id} evidence · ${line}`));
}

// decide <slug> "<ruling>" [--by who] [--supersedes <slug>] [--settles <ids>]: the ruling, who ruled (the owner
// unless --by says otherwise: jarl for a choice the loop made under a mandate), the earlier ruling it replaces —
// marked **Superseded by:** in place, so a reader of decisions.md, and decisions --live, see it is no longer in
// force — and the issues it settles.
export function cmdDecide(root, slug, ruling, flags = {}) {
  need(slug && ruling, 'decide requires <slug> "<ruling>"');
  need(flags.by === undefined || fieldText(flags.by), '--by needs a value — who ruled: owner, jarl, or a name');
  need(flags.area === undefined || AREA_RE.test(String(flags.area)), `--area names the type of code the ruling reaches, as the repository's graph names it: one word of letters, digits and . _ - (got "${flags.area}")`);
  need(flags.reach === undefined || flags.area !== undefined, '--reach counts the files of the --area type — it needs --area');
  need(flags.reach === undefined || /^\d+$/.test(String(flags.reach)), `--reach is how many files the area holds, a whole number (got "${flags.reach}")`);
  need(flags.rule === undefined || flags.area !== undefined, '--rule names the rule of the graph the ruling admits on the --area type — it needs --area');
  need(flags.rule === undefined || RULE_RE.test(String(flags.rule)), `--rule names a rule as the repository's graph names it: its id, segments of letters, digits and . _ - joined by / (got "${flags.rule}")`);
  const by = flags.by !== undefined ? fieldText(flags.by) : 'owner';
  const settles = flags.settles !== undefined ? issuesFor(root, flags.settles) : [];
  const area = flags.area !== undefined ? String(flags.area) : null;
  const reach = flags.reach !== undefined ? Number(flags.reach) : null;
  const rule = flags.rule !== undefined ? String(flags.rule) : null;
  appendDecision(root, slug, settles.length ? `${ruling.trim()}\n\n**Settles:** ${settles.map((i) => i.id).join(', ')}` : ruling, { by, supersedes: flags.supersedes, area, reach, rule });
  appendLog(root, `decided ${slug} · by ${by}${flags.supersedes !== undefined ? ` · supersedes ${flags.supersedes}` : ''}${area ? ` · area ${area}${reach !== null ? ` (${reach} files)` : ''}${rule ? ` · rule ${rule}` : ''}` : ''}`);
  if (settles.length) appendRuling(root, settles, `Ruling ${slug}: ${ruling.trim().split('\n')[0]}`);
  return { slug, by, supersedes: flags.supersedes ?? null, settles: settles.map((i) => i.id), ...(area ? { area, reach, ...(rule ? { rule } : {}) } : {}) };
}

// A type name as the repository's graph takes it for a log: one path segment.
export const AREA_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// A rule id as the graph names it: path segments of the same letters, none of them . or .., joined by /.
export const RULE_RE = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// ---- the ratification batch: area rulings the user admits when the loop closes -----------------------------

// At most this many area rulings wait for the user's word at once; the rest wait for the next close.
export const RATIFY_BATCH = 10;
// A ruling's first sentence, as the batch quotes it.
function firstSentence(text) {
  const line = String(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  const s = /^.+?[.!?](?=\s|$)/.exec(line)?.[0] || line;
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

// The batch: every open ratify item that asks about an area ruling, and new ones filed for the area rulings in force
// that no item has asked about yet — the widest reach first (a ruling with no count last, then oldest first) — up to
// RATIFY_BATCH open in all. A ruling already ratified or rejected is never asked again. Nothing here blocks anything.
export function ratificationBatch(root) {
  const asks = loadAsks(root);
  const asked = new Set(asks.filter((a) => a.ruling).map((a) => a.ruling));
  const pending = asks.filter((a) => a.ruling && a.state === 'open');
  const rulings = loadDecisions(root);
  const candidates = rulings
    .filter((d) => d.area && !d.supersededBy && !d.ratified && !d.rejected && !asked.has(d.slug))
    .map((d, n) => ({ d, n }))
    .sort((a, b) => (b.d.reach ?? -1) - (a.d.reach ?? -1) || a.n - b.n)
    .map((x) => x.d);
  const room = Math.max(0, RATIFY_BATCH - pending.length);
  const filed = candidates.slice(0, room).map((d) => {
    const reach = d.reach !== null ? `${d.reach} file${d.reach === 1 ? '' : 's'}` : 'files not counted';
    // A rule's ratification admits it, as it stands now, on every type the graph has it reach — Yggdrasil reads them,
    // not Jarl — so the question says so: a yes about one area must not pass for consent to less than it gives.
    const scope = d.rule ? `, and to ratify rule ${d.rule} as it stands now on every type the graph has it reach (not only ${d.area})` : '';
    return cmdAsk(root, `area ${d.area}${d.rule ? ` · rule ${d.rule}` : ''} · ${reach} · ${d.slug}: "${firstSentence(d.ruling)}" — yes (tak) to admit it into the type's decisions${scope}, reject (nie) to leave it a ruling of this loop`, { kind: 'ratify', ruling: d.slug }).id;
  });
  const bySlug = new Map(rulings.map((d) => [d.slug, d]));
  const items = loadAsks(root).filter((a) => a.ruling && a.state === 'open').map((a) => {
    const d = bySlug.get(a.ruling);
    return { ask: `a-${a.id}`, ruling: a.ruling, area: d?.area ?? null, reach: d?.reach ?? null, rule: d?.rule ?? null, question: a.question };
  });
  return { items, filed: filed.map((id) => `a-${id}`), waiting: candidates.length - filed.length };
}

// decisions [--live]: the rulings, oldest first, each with who ruled and what superseded it; --live leaves out
// the superseded ones — what a session reads at boot as the rulings in force.
export function cmdDecisions(root, flags = {}) {
  const all = loadDecisions(root);
  return flags.live ? all.filter((d) => !d.supersededBy) : all;
}

// ---- resume: the state a session picks the loop up from, assembled live -------------------------------

// The loop has no hand-written handoff any more: everything a new session needs is already in the loop's own
// files — the goal, the rulings, the issues with their leases and After, the asks, the log — and in the
// repositories they name. resume reads it all now, so nothing can be stale and nothing has to be written before a
// session ends (a session that gets cut leaves nothing half-said). Intent lives where it always did: order in
// the priorities and After, reasons in decisions.md and the issues' bodies. .jarl/handoff.md from before is kept
// and read only as history.
function handoffPath(root) { return join(jarlDir(root), 'handoff.md'); }

// How old the legacy handoff is, against the clock and against the loop's last log line: stale when the loop
// moved on for more than HANDOFF_STALE_MS after it was written. Null when there is no handoff file.
export function handoffAge(root, lastActivity, now = Date.now()) {
  if (!existsSync(handoffPath(root))) return null;
  const text = readText(handoffPath(root));
  const at = /^\*\*At:\*\* (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/m.exec(text)?.[1] || null;
  const atMs = parseStamp(at);
  if (atMs === null) return { at: null, ageMs: null, staleByMs: null, stale: false };
  const last = parseStamp(lastActivity);
  const staleByMs = last !== null && last - atMs > HANDOFF_STALE_MS ? last - atMs : 0;
  return { at, ageMs: now - atMs, staleByMs, stale: staleByMs > 0 };
}

export const RESUME_LOG_LINES = 15;
export const RESUME_READY = 10;
const RESUME_TITLE = 160;
const short = (t, n = RESUME_TITLE) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
function countFlag(flags, name, dflt) {
  if (flags[name] === undefined) return dflt;
  const n = Number(flags[name]);
  need(Number.isInteger(n) && n >= 0, `--${name} takes a whole number, 0 or more (got "${flags[name]}")`);
  return n;
}

// resume [--log n] [--ready n] [--ci] — read-only, no lock: the goal and where the loop stands (status), the
// rulings in force, in flight with leases, waiting on After, the questions and the ratify items, the next ready
// issues and the merge queue, the merges whose CI is pending or red, the tips of every repository the loop's
// issues name, the loop files git has not committed, and the last n log lines. Nothing goes to the network
// unless --ci asks gh for the CI of each pushed tip.
export function cmdResume(root, flags = {}) {
  need(existsSync(jarlDir(root)), `no loop here: ${jarlDir(root)} does not exist — open one with jarl.mjs init "<goal>", or pass --root <the directory holding .jarl/>`);
  const logN = countFlag(flags, 'log', RESUME_LOG_LINES);
  const readyN = countFlag(flags, 'ready', RESUME_READY);
  const status = cmdStatus(root);
  const profile = loadProfile(root);
  const issues = loadIssues(root);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const stale = new Map(status.stale.map((x) => [x.id, x.problems]));
  const rulings = cmdDecisions(root, { live: true }).map((d) => ({ date: d.date, slug: d.slug, by: d.by, line: (d.ruling.split('\n').find((l) => l.trim()) || '').trim() }));
  // In flight and waiting split the unfinished issues the way status counts them: an issue whose After is not
  // settled is waiting, in progress or not, so each section's count is the number on the counts line.
  const unsettled = (i) => waitingOn(i, byId, profile).length > 0;
  const holds = (i) => profile.is(i.status, 'holds-claim');
  // Under a profile that declares fields, each row carries the ones the issue holds (fields: { Name: value }).
  const declared = (i) => (profile.fields.length ? { fields: Object.fromEntries(profile.fields.map((f) => [f.name, fieldText(i.fields[f.key])]).filter(([, v]) => v)) } : {});
  const inFlight = issues.filter((i) => holds(i) && !unsettled(i)).map((i) => ({
    id: i.id, title: i.title, branch: i.fields.branch || null, worker: i.fields.worker || null, since: i.fields.since || null,
    stale: stale.get(i.id) || [], ...declared(i),
  }));
  const waiting = issues.filter((i) => profile.active(i.status) && unsettled(i)).map((i) => ({
    id: i.id, title: i.title, status: i.status, after: waitingOn(i, byId, profile),
    ...(holds(i) ? { branch: i.fields.branch || null, worker: i.fields.worker || null, since: i.fields.since || null, stale: stale.get(i.id) || [] } : {}),
  }));
  const asks = loadAsks(root).filter((a) => a.state === 'open');
  const scheduled = profile.scheduler !== null;
  const next = scheduled ? [] : cmdNext(root, {});
  const ready = next.filter((r) => r.ready);
  // Open, not waiting on After, and still not offered: a file it declares is taken by work in flight (or by a ready
  // issue ahead of it). Ready and held together are the open count on the status line.
  const held = next.filter((r) => !r.ready && !r.after.length).map((r) => ({ id: r.id, title: r.title, priority: r.priority, files: r.waitsOn, heldBy: r.heldBy }));
  const merged = issues.filter((i) => status.ciPending.includes(i.id) || status.ciRed.includes(i.id)).map((i) => ({ id: i.id, title: i.title, ...mergedOf(i) }));
  const logPath = join(jarlDir(root), 'log.md');
  const logLines = existsSync(logPath) ? readText(logPath).split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · /.test(l)) : [];
  const legacy = handoffAge(root, status.lastActivity);
  return {
    goal: status.goal, opened: status.opened, lastActivity: status.lastActivity, archived: status.archived, status,
    rulings, inFlight, waiting,
    questions: asks.filter((a) => a.kind !== 'ratify'), ratify: asks.filter((a) => a.kind === 'ratify'),
    held, next: ready.slice(0, readyN).map((r) => ({ id: r.id, title: r.title, priority: r.priority, ...(r.noAcceptance ? { noAcceptance: true } : {}), ...declared(byId.get(r.id)) })), readyTotal: scheduled ? null : ready.length,
    ...(scheduled ? { scheduler: profile.scheduler } : {}),
    queue: cmdQueue(root), merged, tips: cmdTips(root, { ci: flags.ci === true }),
    uncommitted: uncommittedLoopFiles(root),
    log: logN ? logLines.slice(-logN).map((l) => l.slice(2)) : null,
    legacyHandoff: legacy ? { path: handoffPath(root), at: legacy.at, ageMs: legacy.ageMs } : null,
  };
}

export function renderResume(o, profile = DEFAULT_PROFILE) {
  const shownFields = (x) => (x.fields && Object.keys(x.fields).length ? ` · ${Object.entries(x.fields).map(([n, v]) => `${n}=${v}`).join(' ')}` : '');
  const sec = (title, lines, none) => (lines.length ? [`## ${title}`, ...lines, ''] : none === undefined ? [] : [`## ${title}`, none, '']);
  const lease = (x) => [x.branch && `branch ${x.branch}`, x.worker && `worker ${x.worker}`, x.since && `since ${x.since}`].filter(Boolean).join(' · ');
  const st = o.status;
  const head = [
    `# Resume${o.goal ? ` · ${o.goal}` : ''}`,
    `opened ${o.opened || '?'} · last activity ${o.lastActivity || '?'}${o.archived ? ` · ${o.archived} archived loop(s)` : ''}${profile.declared ? ` · profile ${profile.name}` : ''}`,
    countsLine(st, profile),
    '',
  ];
  const tips = [];
  for (const r of o.tips.repos) {
    tips.push(`[${r.repo}] ${r.path}`);
    for (const x of r.rows) {
      if (x.missing) { tips.push(`  ${x.role.padEnd(8)} ${x.branch}  GONE`); continue; }
      const ab = x.against ? `  ${x.ahead === 0 && x.behind === 0 ? `= ${x.against}` : `+${x.ahead}/-${x.behind} vs ${x.against}`}` : '  (no upstream)';
      const ci = x.ci ? `  ci ${x.ci.state}${x.ci.run ? ` (run ${x.ci.run}${x.ci.workflow ? ` ${x.ci.workflow}` : ''})` : ''}` : x.pushed ? '' : '  not pushed';
      tips.push(`  ${x.role.padEnd(8)} ${x.branch} ${x.sha}${ab}${ci}${x.issues ? `  → ${x.issues.join(', ')}` : ''}`);
    }
  }
  const queue = [];
  for (const r of o.queue.repos) {
    if (!r.rows.length) continue;
    queue.push(`[${r.repo}] into ${r.base}`);
    r.rows.forEach((x, n) => queue.push(`  ${n + 1}. ${x.branch} → ${x.issues.join(', ')}  +${x.ahead}  approved ${x.approvedAt}${x.by ? ` by ${x.by}` : ''}  batch ${x.batch}${x.ready ? '' : `  (waiting for review: ${x.waitingReview.join(', ')})`}`));
  }
  const files = o.uncommitted || [];
  return [
    ...head,
    ...sec(`Rulings in force (${o.rulings.length})`, o.rulings.map((d) => `- ${d.date} · ${d.slug}${d.by ? ` · by ${d.by}` : ''} — ${short(d.line)}`), '- (none)'),
    ...sec(`In flight (${o.inFlight.length})`, o.inFlight.map((x) => `- ${x.id} ${short(x.title)}${shownFields(x)}${lease(x) ? ` · ${lease(x)}` : ''}${x.stale.length ? ` · STALE: ${x.stale.join('; ')}` : ''}`), '- (nothing)'),
    ...sec(`Waiting — After not settled (${o.waiting.length})`, o.waiting.map((x) => `- ${x.id} ${short(x.title)} (after ${x.after.join(', ')})${x.stale !== undefined ? ` · ${x.status === 'in-progress' ? 'in progress' : x.status}${lease(x) ? ` · ${lease(x)}` : ''}${x.stale.length ? ` · STALE: ${x.stale.join('; ')}` : ''}` : ''}`)),
    ...sec(`Questions to the user (${o.questions.length})`, o.questions.map((a) => `- a-${a.id} (${a.kind || 'stuck'})${a.issue ? ` issue ${a.issue}` : ''} · ${a.question}`), '- (nothing)'),
    ...sec(`To ratify (${o.ratify.length})`, o.ratify.map((a) => `- a-${a.id}${a.issue ? ` (issue ${a.issue})` : ''} · ${a.question}`)),
    ...sec(`Held — files in flight (${o.held.length})`, o.held.map((x) => `- ${x.id}  P${x.priority}  ${short(x.title)} (${x.files.join(', ')} held by ${x.heldBy.join(', ')})`)),
    ...(o.scheduler ? sec('Next ready and merge queue', [`- ${schedulerNote(o.scheduler)}`]) : [
      ...sec(`Next ready (${o.next.length} of ${o.readyTotal})`, o.next.map((r) => `- ${r.id}  P${r.priority}  ${short(r.title)}${shownFields(r)}${r.noAcceptance ? '  (no acceptance yet)' : ''}`), '- (nothing ready)'),
      ...sec('Merge queue', queue, '- (nothing approved waits to be merged)'),
    ]),
    ...sec(`Merged, CI pending or red (${o.merged.length})`, o.merged.map((m) => `- ${m.id} ${m.sha}${m.repo ? ` in ${m.repo}` : ''} · CI ${m.ci}`)),
    ...sec(`Tips${o.tips.ci ? '' : ' (CI not asked — --ci asks gh)'}`, tips),
    ...(files.length ? sec(`Loop files not committed (${files.length}) — commit .jarl/`, [...files.slice(0, 20).map((f) => `- ${f}`), ...(files.length > 20 ? [`- … ${files.length - 20} more`] : [])]) : []),
    ...(o.log ? sec(`Last ${o.log.length} log line(s)`, o.log.map((l) => `- ${l}`), '- (empty log)') : []),
    ...(o.legacyHandoff ? [`(a handoff file from before resume is kept at .jarl/handoff.md${o.legacyHandoff.at ? `, written ${o.legacyHandoff.at}` : ''} — history, not the state; handoff read prints it)`] : []),
  ].join('\n').replace(/\n+$/, '');
}

// handoff read — resume, then the legacy .jarl/handoff.md, if one is kept, as history: its headings one level
// down under a heading that says how old it is, so its old snapshot is never read as the state.
export function cmdHandoffRead(root, flags = {}) {
  const out = cmdResume(root, flags);
  if (!existsSync(handoffPath(root))) return { ...out, history: null, text: renderResume(out, loadProfile(root)) };
  const written = readText(handoffPath(root));
  const body = written.split('\n').filter((l) => !/^#\s+Handoff\s*$/.test(l)).map((l) => (/^#{1,5}\s/.test(l) ? `#${l}` : l)).join('\n').trim();
  const h = out.legacyHandoff;
  const when = h && h.at ? `written ${h.at}, ${ago(h.ageMs)} ago` : 'written at an unknown time';
  const text = `${renderResume(out, loadProfile(root))}\n\n## Earlier handoff — history, ${when}; not the current state\n${body}`;
  return { ...out, history: written, text };
}

// handoff write — retired: the state is assembled live by resume, so there is nothing to write. It is still
// accepted (with its old flags) so a script or a session following an older SKILL.md does not fail, writes
// nothing — no file, no log line — and says so; exit 0.
export const HANDOFF_RETIRED = 'handoff write is retired: nothing written. The state a session resumes from is assembled live — run jarl.mjs resume. Put intent where it lives: order in priorities and After (prio, after), reasons in rulings (decide) and issue bodies (body).';
export function cmdHandoffWrite() {
  return { retired: true, wrote: null, note: HANDOFF_RETIRED };
}

// The reason an issue was dropped or deferred: the last "Dropped: ..." / "Deferred: ..." line of its Evidence,
// whatever notes were written before it. Evidence with no such line (an older file) is read whole.
function statusReason(evidence, word) {
  const text = (evidence || '').trim();
  const last = [...text.matchAll(new RegExp(`^${word}:\\s*(.*)$`, 'gm'))].pop();
  return last ? last[1].trim() : text;
}

// The repository an issue's work counts under in the report: the directory name of each repository it names,
// or the loop's own.
function repoNames(root, issue) {
  const named = reposNamed(issue);
  return named.length ? [...new Set(named.map((n) => basename(topOf(canonical(resolve(root, n))))))] : [basename(topOf(root))];
}

// report [--found]: done (per repository when the done work spans more than one — an issue naming several is
// listed under each, for each repository's changelog), dropped, deferred, still open, and who reviewed the done
// work; --found adds the issues someone other than the jarl found.
export function cmdReport(root, flags = {}) {
  const profile = loadProfile(root);
  const issues = loadIssues(root);
  const done = issues.filter((i) => profile.is(i.status, 'closes-record'));
  const dropped = issues.filter((i) => i.status === 'dropped');
  const deferred = issues.filter((i) => i.status === 'deferred');
  const left = issues.filter((i) => profile.unfinished(i.status));
  // Every other finished status gets its own section after Done, in the profile's order (built-in: Dropped, then
  // Deferred), with the reason a needs-reason status carries.
  const closedOther = profile.statuses.filter((st) => profile.is(st, 'terminal') && !profile.is(st, 'closes-record'));
  const found = issues.filter((i) => i.fields['found by'] && !/^jarl\b/i.test(i.fields['found by']));
  const goal = existsSync(join(jarlDir(root), 'goal.md')) ? readText(join(jarlDir(root), 'goal.md')).split('\n').slice(2).find((l) => l.trim()) || '' : '';
  const byRepo = {};
  for (const i of done) for (const r of repoNames(root, i)) (byRepo[r] = byRepo[r] || []).push(i);
  const row = (i) => `- ${i.id} ${i.title} (${i.kind})${mergedOf(i) ? ` · merged ${mergedOf(i).sha}${mergedOf(i).repo ? ` in ${mergedOf(i).repo}` : ''}` : ''}`;
  const repos = Object.keys(byRepo).sort();
  const doneLines = repos.length > 1 ? repos.flatMap((r) => ['', `### ${r} (${byRepo[r].length})`, ...byRepo[r].map(row)]) : done.map(row);
  const journal = journalById(root);
  const split = reviewSplit(root, issues, journal);
  const coordinators = coordinatorNames(root);
  // One row per issue, for a host that renders its own dashboard from --json: the same fields a reader of the
  // issue would look up, with the live approve (who, which kind, when) — the one that actually cleared it, not
  // simply the last one recorded.
  const rows = issues.map((i) => {
    const m = mergedOf(i);
    const a = gateState(root, i.id, journal.get(i.id) || [], coordinators, issues, journal).live;
    return { id: i.id, title: i.title, status: i.status, kind: i.kind, priority: i.priority, tier: i.tier, tags: i.tags, repos: repoNames(root, i), branch: i.fields.branch || null, after: i.after, sources: i.sources, merged: m ? m.sha : null, ci: m ? m.ci : null, review: a ? { by: a.by, kind: a.kind, at: a.at } : null };
  });
  const metrics = loopMetrics(root, issues, journal);
  const lines = [`# Report`, '', goal, '', ...(metrics.check.declared ? [] : [TESTIMONY_NOTE, '']), `## Done (${done.length})`, ...(done.length ? [gateLine(profile, split, 'Reviewed by')] : []), ...doneLines,
    ...closedOther.flatMap((st) => {
      const on = issues.filter((i) => i.status === st);
      return ['', `## ${reasonWord(st)} (${on.length})`, ...on.map((i) => `- ${i.id} ${i.title}${profile.is(st, 'needs-reason') ? ` — ${statusReason(i.sections.evidence, reasonWord(st))}` : ''}`)];
    }),
    '', `## Still open (${left.length})`, ...left.map((i) => `- ${i.id} ${i.title} (${i.status})`),
    ...(flags.found ? ['', `## Found along the way (${found.length})`, ...found.map((i) => `- ${i.id} ${i.title} — ${i.fields['found by']}`)] : []),
    '', renderMetrics(metrics)];
  return { done: done.length, dropped: dropped.length, deferred: deferred.length, left: left.length, found: found.length, reviews: split,
    ...(profile.declared ? { statuses: Object.fromEntries(profile.statuses.map((st) => [st, issues.filter((i) => i.status === st).length])) } : {}),
    byRepo: Object.fromEntries(repos.map((r) => [r, byRepo[r].map((i) => i.id)])), issues: rows, text: lines.join('\n') + '\n', check: metrics.check, metrics };
}

// ---- research findings into issues ----------------------------------------------------------------

// A research round leaves a findings.json beside its report. import turns each finding into one issue whose
// **Source:** is <report dir>#<finding id>: the report directory is dated, so the pair names that finding for
// good, and a re-run skips every finding whose Source an issue already carries. The mapping (SKILL.md, "From
// research to issues") reads three shapes: a flat array of findings; an array of angles, each with its
// surviving findings under `surviving`; and { results: [{ area, kept: [...] }] }. A finding without an id
// cannot be keyed, so the file is refused whole.
const KIND_OF = { defect: 'bug', inconsistency: 'bug', risk: 'gap', opportunity: 'gap' };
const PRIO_OF = { blocker: '1', critical: '1', high: '1', medium: '2', major: '2', important: '2', low: '3', minor: '3' };

export function findingsOf(json) {
  let list;
  // In the angles shape an id is unique only inside its angle (two angles may each have an F1), so the key
  // is <angle>/<id> there, always — never only when two collide, which would change a key once a later
  // edit of the file added a twin.
  if (Array.isArray(json) && json.some((x) => x && Array.isArray(x.surviving))) {
    list = json.flatMap((x) => (x.surviving || []).map((f) => (f && f.id !== undefined && x.angle ? { ...f, id: `${slugify(String(x.angle))}/${f.id}`, localId: String(f.id), angle: slugify(String(x.angle)) } : f)));
  } else if (Array.isArray(json)) list = json;
  else if (json && Array.isArray(json.results)) list = json.results.flatMap((r) => r.kept || []);
  else if (json && Array.isArray(json.findings)) list = json.findings;
  else throw new Error('not a findings file this tool reads: expected an array of findings, an array of angles with `surviving`, or { results: [{ kept }] } — see SKILL.md, "From research to issues"');
  const seen = new Set();
  const out = list.map((f, n) => {
    need(f && typeof f === 'object' && (typeof f.id === 'string' || typeof f.id === 'number') && String(f.id).trim(), `finding #${n + 1} has no id — every finding needs one to be filed once and only once; nothing was filed`);
    const id = String(f.id).trim();
    need(!/[\s,#]/.test(id), `finding id "${id}" holds a space, a comma or a # — it cannot be a Source key; nothing was filed`);
    need(!seen.has(id), `finding id ${id} appears twice in the file; nothing was filed`);
    seen.add(id);
    const claim = typeof f.claim === 'string' ? f.claim : '';
    const title = String(f.title || claim.split(/(?<=[.!?])\s/)[0] || id).replace(/\s+/g, ' ').trim();
    const kindRaw = String(f.kind || '').toLowerCase();
    const prioRaw = String(f.priority ?? f.severity ?? '').toLowerCase();
    const why = [f.impact, f.adopter_impact].filter((x) => typeof x === 'string' && x.trim()).join('\n\n');
    const proposal = [f.proposal, f.suggested_fix, f.fix].find((x) => typeof x === 'string' && x.trim());
    return {
      id,
      localId: f.localId || id,
      angle: f.angle || null,
      title: title.length > 140 ? `${title.slice(0, 139)}…` : title,
      kind: KINDS.includes(kindRaw) ? kindRaw : (KIND_OF[kindRaw] || 'bug'),
      priority: PRIORITIES.includes(prioRaw) ? prioRaw : (PRIO_OF[prioRaw] || '2'),
      where: String(f.where || f.surfaces || ''),
      what: [claim && `Claim: ${claim}`, typeof f.truth === 'string' && f.truth && `Truth: ${f.truth}`, typeof f.evidence === 'string' ? f.evidence : ''].filter(Boolean).join('\n\n'),
      why: [why, f.effort && `Effort (the finding's estimate): ${f.effort}`].filter(Boolean).join('\n\n'),
      acceptance: proposal ? `${PROPOSED} — make it checkable before a worker starts: ${proposal}` : '',
    };
  });
  return out;
}

// The report directory a findings file belongs to, as its Source spells it: the path from the root of the
// repository holding it (core/research/2026-09-25-jarl), so every loop that imports it writes the same key;
// the directory's own name outside a repository.
export function reportDirOf(file) {
  const dir = dirname(resolve(file));
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  const rel = top ? relative(canonical(top), canonical(dir)).split('\\').join('/') : '';
  // On Windows a path on another drive has no relative spelling: relative() gives it back absolute.
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : basename(dir);
}

function readFindings(file, flags = {}) {
  need(file, 'a findings file is required: jarl.mjs import <findings.json>');
  need(existsSync(file), `no such file: ${file}`);
  let json;
  try { json = JSON.parse(readText(file)); } catch (e) { throw new Error(`${file} is not JSON: ${e.message}`); }
  const dir = flags.source !== undefined ? String(flags.source).replace(/\/+$/, '') : reportDirOf(file);
  need(dir && !/[\s,#]/.test(dir), `--source is the report directory alone, with no space, comma or # in it (got "${dir}")`);
  return { dir, findings: findingsOf(json) };
}

// An issue filed before Source existed often names its finding. That issue is found, never guessed at, and
// mainly where an issue says what it is about: its title and its What, Why and Acceptance — never a header
// field (`**Priority:** 2` is not finding 2). Evidence (notes about other work, too) counts only under the
// strict rule in inEvidence below. An id that reads as unique
// on its own (jarl-2-B2: a dash, and at least 8 characters) is enough by itself. A short one (F1, C1, 2) or one
// from the angles shape needs its report named in the same issue too: the report directory's name, or the
// <angle>/<id> key. A title naming the finding wins, else the one issue whose body does; two candidates are
// reported as ambiguous and left alone.
function uniqueLooking(id) { return id.includes('-') && id.length >= 8; }
function tokenRe(s) { return new RegExp(`(^|[^A-Za-z0-9-])${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([^A-Za-z0-9-]|$)`); }
function mentionOf(issues, finding, dir) {
  const own = tokenRe(finding.id);
  const bare = tokenRe(finding.localId);
  const report = tokenRe(basename(dir));
  const named = (text) => {
    if (own.test(text) && finding.id !== finding.localId) return true;   // <angle>/<id> written out
    if (!bare.test(text)) return false;
    return !finding.angle && uniqueLooking(finding.localId);
  };
  const namedWithReport = (text) => named(text) || (bare.test(text) && report.test(text));
  const legacy = issues.filter((i) => i.fields.source === undefined);
  const bodyOf = (i) => [i.title, i.sections.what, i.sections.why, i.sections.acceptance].filter(Boolean).join('\n');
  const byTitle = legacy.filter((i) => named(i.title) || (bare.test(i.title) && report.test(bodyOf(i))));
  if (byTitle.length === 1) return { issue: byTitle[0] };
  if (byTitle.length > 1) return { ambiguous: byTitle.map((i) => i.id) };
  // Evidence counts under the strictest rule only: an id that reads as unique on its own, on an Evidence line
  // that also names the report (a package issue's "Source: <report dir>/report.md … Ids: a-b-01, a-b-02").
  const inEvidence = (i) => !finding.angle && uniqueLooking(finding.localId)
    && (i.sections.evidence || '').split('\n').some((l) => bare.test(l) && report.test(l));
  const byBody = legacy.filter((i) => namedWithReport(bodyOf(i)) || inEvidence(i));
  if (byBody.length === 1) return { issue: byBody[0] };
  return byBody.length ? { ambiguous: byBody.map((i) => i.id) } : {};
}

function bySource(issues) {
  const map = new Map();
  for (const i of issues) for (const s of i.sources) map.set(s, [...(map.get(s) || []), i]);
  return map;
}

export function cmdImport(root, file, flags) {
  needLiveLoop(root, ' — run: jarl.mjs init "<goal>"');
  const { dir, findings: read } = readFindings(file, flags);
  const profile = loadProfile(root);
  if (flags.kind !== undefined) need(profile.kinds.includes(flags.kind), `--kind must be one of: ${profile.kinds.join(', ')}`);
  if (flags.prio !== undefined) need(PRIORITIES.includes(String(flags.prio)), '--prio must be 1, 2 or 3');
  if (flags.tier !== undefined) need(profile.tiers.includes(String(flags.tier)), `--tier must be one of: ${profile.tiers.join(', ')}`);
  // A finding's kind is mapped onto the built-in kinds; under a profile with kinds of its own, one it does not
  // name is filed under the profile's default kind.
  const findings = profile.declared ? read.map((f) => (profile.kinds.includes(f.kind) ? f : { ...f, kind: profile.kindDefault })) : read;
  if (flags.repo !== undefined) repoList(root, flags.repo);
  let chosen = findings;
  if (flags.only !== undefined) {
    const only = splitList(flags.only);
    const unknown = only.filter((id) => !findings.some((f) => f.id === id));
    need(unknown.length === 0, `not in ${file}: ${unknown.join(', ')}`);
    chosen = findings.filter((f) => only.includes(f.id));
  }
  const issues = loadIssues(root);
  const filedAs = bySource(issues);
  const out = { source: dir, findings: findings.length, considered: chosen.length, filed: [], already: [], adopted: [], mentioned: [], ambiguous: [], dryRun: flags['dry-run'] === true };
  const toFile = [];
  for (const f of chosen) {
    const key = `${dir}#${f.id}`;
    if (filedAs.has(key)) { out.already.push({ finding: f.id, issues: filedAs.get(key).map((i) => i.id) }); continue; }
    const m = mentionOf(issues, f, dir);
    if (m.ambiguous) { out.ambiguous.push({ finding: f.id, issues: m.ambiguous }); continue; }
    if (m.issue) {
      if (flags.adopt === true) out.adopted.push({ finding: f.id, issue: m.issue.id, key });
      else out.mentioned.push({ finding: f.id, issue: m.issue.id });
      continue;
    }
    toFile.push({ f, key });
  }
  if (out.dryRun) {
    out.filed = toFile.map(({ f, key }) => ({ id: null, finding: f.id, source: key, title: f.title, kind: flags.kind || f.kind, priority: String(flags.prio || f.priority) }));
    return out;
  }
  // One older issue may name several findings (a package of minor ones): its Source gets all of them, once.
  const adopt = new Map();
  for (const a of out.adopted) adopt.set(a.issue, [...(adopt.get(a.issue) || []), a.key]);
  for (const [id, keys] of adopt) cmdSource(root, id, [...(findIssue(root, id).sources), ...keys].join(','));
  for (const { f, key } of toFile) {
    const r = cmdNew(root, f.title, {
      kind: flags.kind || f.kind, prio: flags.prio || f.priority, tier: flags.tier, tags: flags.tags, repo: flags.repo,
      field: flags.field, 'found-by': flags['found-by'] || `research ${dir}`, where: f.where, what: f.what, why: f.why, acceptance: f.acceptance || undefined, source: key,
    });
    out.filed.push({ id: r.id, finding: f.id, source: key, title: f.title, kind: flags.kind || f.kind, priority: String(flags.prio || f.priority) });
  }
  appendLog(root, `imported ${dir} · ${out.filed.length} filed, ${out.already.length} already filed${out.adopted.length ? `, ${out.adopted.length} adopted` : ''}${out.mentioned.length ? `, ${out.mentioned.length} named by an issue without Source` : ''}${out.ambiguous.length ? `, ${out.ambiguous.length} ambiguous` : ''}`);
  return out;
}

// sources — per report: its findings, the issues filed from them and where those stand. With findings files,
// every finding in them is listed, the unfiled ones too; without, only what the issues' Source fields name.
export function cmdSources(root, files, flags = {}) {
  const issues = loadIssues(root);
  const filedAs = bySource(issues);
  const reports = new Map();   // dir -> ordered finding ids
  const add = (dir, id) => { if (!reports.has(dir)) reports.set(dir, []); if (!reports.get(dir).includes(id)) reports.get(dir).push(id); };
  need(files.length <= 1 || flags.source === undefined, '--source names one report directory: give one findings file with it');
  const mentionKey = new Map();
  for (const file of files) { const { dir, findings } = readFindings(file, flags); findings.forEach((f) => { add(dir, f.id); mentionKey.set(`${dir}#${f.id}`, f); }); }
  for (const key of filedAs.keys()) { const at = key.indexOf('#'); add(key.slice(0, at), key.slice(at + 1)); }
  const fromFile = new Set();
  for (const file of files) fromFile.add(readFindings(file, flags).dir);
  return [...reports.entries()].map(([dir, ids]) => {
    const rows = ids.map((id) => {
      const on = filedAs.get(`${dir}#${id}`) || [];
      if (on.length) return { finding: id, issues: on.map((i) => ({ id: i.id, status: i.status })) };
      const m = mentionKey.has(`${dir}#${id}`) ? mentionOf(issues, mentionKey.get(`${dir}#${id}`), dir) : {};
      return { finding: id, issues: [], ...(m.issue ? { mentionedBy: [m.issue.id] } : m.ambiguous ? { mentionedBy: m.ambiguous } : {}) };
    });
    const distinct = [...new Map(rows.flatMap((r) => r.issues).map((i) => [i.id, i])).values()];
    const byStatus = {};
    for (const i of distinct) byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    return {
      source: dir, findings: fromFile.has(dir) ? ids.length : null, filed: rows.filter((r) => r.issues.length).length,
      mentioned: rows.filter((r) => !r.issues.length && r.mentionedBy).length, unfiled: rows.filter((r) => !r.issues.length && !r.mentionedBy).length,
      issues: byStatus, rows,
    };
  });
}


// The counts line of status and resume: the issues ready (in the dispatchable status — built-in: open) and in flight
// (holds-claim), less those waiting on After, then every other status by its own name, then the questions.
// One status's count from a status object, with or without a profile (see cmdStatus).
function countOf(o, st) { return (o.statuses || o)[st] || 0; }
function countsLine(o, profile) {
  const ready = profile.with('dispatchable');
  const rest = profile.statuses.filter((st) => !profile.active(st)).map((st) => ` · ${st} ${countOf(o, st)}`).join('');
  // Under an external scheduler Jarl does not reckon readiness: each dispatchable status by its own count instead.
  const head = o.scheduler ? ready.map((st) => `${st} ${countOf(o, st)}`).join(' · ') : `${ready.length === 1 ? ready[0] : 'ready'} ${o.ready}`;
  return `${head} · in flight ${o.inFlight}${o.waiting ? ` · waiting ${o.waiting}` : ''}${rest} · questions ${o.questions}${o.ratify ? ` · to ratify ${o.ratify}` : ''}${o.ciPending.length ? ` · merged, CI pending ${o.ciPending.length}` : ''}${o.ciRed.length ? ` · CI red ${o.ciRed.length}` : ''}`;
}
const statusLabel = (st) => (st === 'in-progress' ? 'in flight' : st);

export function renderStatus(o, profile = DEFAULT_PROFILE) {
  const head = o.goal ? `goal: ${o.goal}\nopened ${o.opened || '?'} · last activity ${o.lastActivity || '?'}${o.archived ? ` · ${o.archived} archived loop(s)` : ''}${profile.declared ? ` · profile ${profile.name}` : ''}\n` : '';
  const line = countsLine(o, profile);
  const width = o.by ? Math.max(...Object.keys(o.by.groups).map((k) => k.length), 1) : 0;
  const by = o.by ? [`by ${o.by.key}:`, ...Object.entries(o.by.groups).map(([k, g]) => `  ${k.padEnd(width)}  ${profile.statuses.map((st) => `${statusLabel(st)} ${g[st]}`).join(' · ')}`)] : [];
  const more = [
    ...(o.check && !o.check.declared ? [TESTIMONY_NOTE] : []),
    ...(o.scheduler ? [schedulerNote(o.scheduler)] : []),
    ...by,
    ...o.stale.map((x) => `stale ${x.id} · ${x.problems.join('; ')}`),
    ...(o.ciPending.length ? [`merged, CI pending: ${o.ciPending.join(', ')}`] : []),
    ...(o.ciRed.length ? [`merged, CI red: ${o.ciRed.join(', ')}`] : []),
    ...(profile.with('closes-record').some((st) => countOf(o, st)) ? [gateLine(profile, o.reviews, 'done reviewed by')] : []),
    ...(o.uncommitted ? [`${o.uncommitted} loop file(s) not committed — commit .jarl/ in the loop's repository`] : []),
    ...o.toRatify.map((a) => `ratify a-${a.id}${a.issue ? ` (issue ${a.issue})` : ''} · ${a.question}`),
    ...(o.waiting ? [`waiting (After not settled): ${o.waitingIds.join(', ')}`] : []),
    ...(o.noAcceptance.length ? [`in flight with no acceptance line: ${o.noAcceptance.join(', ')}`] : []),
  ];
  return `${head}${line}${more.length ? `\n${more.join('\n')}` : ''}`;
}

export function renderImport(o) {
  const head = `${o.source}: ${o.findings} finding(s)${o.considered !== o.findings ? `, ${o.considered} chosen` : ''} · ${o.dryRun ? 'would file' : 'filed'} ${o.filed.length} · already filed ${o.already.length}${o.adopted.length ? ` · adopted ${o.adopted.length}` : ''}${o.mentioned.length ? ` · named by an issue without Source ${o.mentioned.length} (--adopt links them)` : ''}${o.ambiguous.length ? ` · ambiguous ${o.ambiguous.length}` : ''}`;
  const rows = [
    ...o.filed.map((f) => `${o.dryRun ? 'would file' : `filed ${f.id}`} · ${f.finding} · ${f.kind} P${f.priority} · ${f.title}`),
    ...o.adopted.map((a) => `adopted ${a.issue} · ${a.finding}`),
    ...o.mentioned.map((m) => `named by ${m.issue} · ${m.finding}`),
    ...o.ambiguous.map((m) => `ambiguous · ${m.finding} · named by ${m.issues.join(', ')}`),
  ];
  return [head, ...rows].join('\n');
}

export function renderSources(reports) {
  if (!reports.length) return '(no issue carries a Source, and no findings file was given)';
  return reports.map((r) => {
    const st = Object.entries(r.issues).map(([k, v]) => `${k} ${v}`).join(', ');
    const head = `${r.source} · ${r.findings === null ? '' : `${r.findings} finding(s) · `}${r.filed} filed${r.mentioned ? ` · ${r.mentioned} named by an issue without Source` : ''}${r.findings === null ? '' : ` · ${r.unfiled} unfiled`}${st ? ` · issues: ${st}` : ''}`;
    const rows = r.rows.map((x) => `  ${x.finding}  ${x.issues.length ? x.issues.map((i) => `${i.id} ${i.status}`).join(', ') : x.mentionedBy ? `named by ${x.mentionedBy.join(', ')} (no Source)` : 'unfiled'}`);
    return [head, ...rows].join('\n');
  }).join('\n\n');
}

// The profile's declared fields an issue holds a value for, as Name=value — shown by list and resume.
function declaredShown(i, profile) {
  return profile.fields.map((f) => [f.name, fieldText(i.fields[f.key])]).filter(([, v]) => v).map(([n, v]) => `${n}=${v}`).join(' ');
}
export function renderList(rows, profile = DEFAULT_PROFILE) {
  if (rows.length === 0) return '(none)';
  return rows.map((i) => { const d = declaredShown(i, profile); return `${i.id}  P${i.priority}  ${i.status.padEnd(11)} ${i.kind.padEnd(8)} ${i.title}${i.tags.length ? `  [${i.tags.join(', ')}]` : ''}${d ? `  ${d}` : ''}`; }).join('\n');
}


// ---- git merges the loop's own files ----------------------------------------------------------------
//
// A committed loop travels with the branches, so git merges its files whenever two of them meet. The journal is one
// dated line per event, so a union of both sides is its merge. decisions.md is never a union: a union joins lines,
// and a ruling is a block whose closing fields (Superseded by, Ratified, …) are added in place later — a union once
// pinned a `**Superseded by:**` line to the wrong ruling and let two rulings each supersede one ruling. It gets a
// driver of its own, mergeDecisionsTexts, run by git as `jarl.mjs merge-driver decisions %O %A %B`.

const SINGLE_VALUED = new Set(['By', 'Supersedes', 'Superseded by', 'Area', 'Reach', 'Ratified', 'Rejected', 'Type log']);

// decisions.md as blocks: the text before the first ruling, then one block per `## <date> · <slug>` heading — the
// same reading loadDecisions makes — each with its ruling text and its closing field lines kept apart.
function decisionBlocks(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const pre = [];
  const blocks = [];
  for (const line of lines) {
    const h = DECISION_HEAD.exec(line);
    if (h) { blocks.push({ slug: h[2], head: line, body: [] }); continue; }
    (blocks.length ? blocks[blocks.length - 1].body : pre).push(line);
  }
  const trimEnd = (a) => { const out = [...a]; while (out.length && out[out.length - 1].trim() === '') out.pop(); return out; };
  return {
    pre: trimEnd(pre).join('\n'),
    blocks: blocks.map((b) => {
      const body = trimEnd(b.body);
      let cut = body.length;
      while (cut > 0 && (body[cut - 1].trim() === '' || DECISION_META.test(body[cut - 1]))) cut -= 1;
      const meta = body.slice(cut).filter((l) => l.trim() !== '');
      return { slug: b.slug, head: b.head, ruling: trimEnd(body.slice(0, cut)).join('\n'), meta, text: [b.head, ...body].join('\n') };
    }),
  };
}

// One ruling both sides changed since the base: mergeable only when both kept the heading and the ruling text and
// only added closing fields — their union, base's first, then ours', then theirs'. A field that holds one value
// (Superseded by, Ratified, …) given two different values is a conflict, and two successors is the double
// supersession this driver exists to refuse.
function mergeRuling(b, o, t) {
  if (o.head !== t.head || o.ruling !== t.ruling || (b && (b.head !== o.head || b.ruling !== o.ruling))) return { conflict: `${o.slug}: both sides changed the ruling's text` };
  const meta = [...(b ? b.meta : [])];
  for (const line of [...o.meta, ...t.meta]) if (!meta.includes(line)) meta.push(line);
  const byField = new Map();
  for (const line of meta) {
    const m = DECISION_META.exec(line);
    if (!m || !SINGLE_VALUED.has(m[1])) continue;
    const value = m[1] === 'Superseded by' ? m[2].trim().split(/\s/)[0] : m[2].trim();
    const seen = byField.get(m[1]);
    if (seen !== undefined && seen !== value) {
      return { conflict: m[1] === 'Superseded by' ? `${o.slug} is superseded on both sides — by ${seen} and by ${value}` : `${o.slug}: both sides wrote **${m[1]}:** with different values` };
    }
    byField.set(m[1], value);
  }
  return { text: [o.head, ...(o.ruling ? [o.ruling] : []), ...(meta.length ? ['', ...meta] : [])].join('\n') };
}

// What git's decisions.md driver writes: { ok: true, text } for a clean merge, or { ok: false, text, conflicts } with
// every conflicting ruling between conflict markers (ours, then theirs) and every other ruling merged, so the person
// resolving sees each conflict where it is. Refused: a ruling both sides superseded (two successors in force), a slug
// both sides added with different rulings, a ruling both sides rewrote, and one side changed while the other removed
// it. Blocks keep ours' order, then theirs' new ones; a ruling one side changed and the other did not takes the change.
export function mergeDecisionsTexts(base, ours, theirs) {
  const B = decisionBlocks(base);
  const O = decisionBlocks(ours);
  const T = decisionBlocks(theirs);
  const index = (d) => new Map(d.blocks.map((b) => [b.slug, b]));
  const [bi, oi, ti] = [index(B), index(O), index(T)];
  const conflicts = [];
  const out = [];
  const marked = (o, t, why) => { conflicts.push(why); out.push(`<<<<<<< ours\n${o ? o.text : ''}\n=======\n${t ? t.text : ''}\n>>>>>>> theirs`); };
  const one = (b, o, t) => {
    const same = (x, y) => (x ? x.text : null) === (y ? y.text : null);
    if (same(o, t)) { if (o) out.push(o.text); return; }
    if (same(o, b)) { if (t) out.push(t.text); return; }
    if (same(t, b)) { if (o) out.push(o.text); return; }
    if (!o || !t) { marked(o, t, `${(o || t).slug}: one side changed the ruling, the other removed it`); return; }
    if (!b) { marked(o, t, `${o.slug}: both sides added a ruling with this slug`); return; }
    const r = mergeRuling(b, o, t);
    if (r.conflict) marked(o, t, r.conflict); else out.push(r.text);
  };
  for (const o of O.blocks) one(bi.get(o.slug), o, ti.get(o.slug));
  for (const t of T.blocks) if (!oi.has(t.slug)) one(bi.get(t.slug), undefined, t);
  // Two new rulings that each supersede the same one: caught above when both marked it, and here when a side's mark
  // is missing (a hand edit), since a merge must never leave two successors of one ruling in force.
  const successors = new Map();
  for (const [side, d] of [['ours', O], ['theirs', T]]) {
    for (const b of d.blocks) {
      if (bi.has(b.slug)) continue;
      const m = b.meta.map((l) => DECISION_META.exec(l)).find((x) => x && x[1] === 'Supersedes');
      if (!m) continue;
      const target = m[2].trim();
      const was = successors.get(target);
      if (was && was.side !== side && was.slug !== b.slug) conflicts.push(`${target} is superseded on both sides — by ${was.slug} and by ${b.slug}`);
      else successors.set(target, { side, slug: b.slug });
    }
  }
  let pre = O.pre;
  if (O.pre !== T.pre) {
    if (O.pre === B.pre) pre = T.pre;
    else if (T.pre !== B.pre) { conflicts.push('both sides changed the text before the first ruling'); pre = `<<<<<<< ours\n${O.pre}\n=======\n${T.pre}\n>>>>>>> theirs`; }
  }
  const text = `${[pre, ...out].filter((s) => s !== '').join('\n\n')}\n`;
  if (!conflicts.length) return { ok: true, text };
  // A conflict found only by the successor scan leaves no marker of its own: mark the whole merge, so git stops.
  const line = (x) => (x === '' || x.endsWith('\n') ? x : `${x}\n`);
  return { ok: false, conflicts, text: text.includes('\n<<<<<<< ours\n') || text.startsWith('<<<<<<< ours\n') ? text : `<<<<<<< ours\n${line(ours)}=======\n${line(theirs)}>>>>>>> theirs\n` };
}

// The command git runs for the decisions driver, as the loop's repository records it in its local configuration.
// It names this runtime and this script by absolute path, and falls back to git's own text merge with conflict
// markers when either is gone: a driver configured whose program cannot start leaves the file conflicted with ours
// alone and no markers, and staging that drops theirs without a word. Git runs it through its own POSIX shell on
// every platform (Git for Windows ships one); a Windows path is written with forward slashes, which that shell reads.
export function decisionsDriverCommand(runtime = process.execPath, script = JARL_SCRIPT) {
  const q = (p) => `"${String(p).replace(/\\/g, '/').replace(/(["$`])/g, '\\$1')}"`;
  return `if [ -f ${q(runtime)} ] && [ -f ${q(script)} ]; then ${guardedDriver(`${q(runtime)} ${q(script)} merge-driver decisions %O %A %B`)}; else ${TEXT_MERGE}; fi`;
}

// git's own three-way text merge with conflict markers, over %A: what git does with no driver.
const TEXT_MERGE = 'git merge-file -L ours -L base -L theirs %A %O %B';

// A driver program run so that it can never leave ours alone as the answer: a program that is there but does not
// start (a runtime too old for it, a half-finished upgrade, a Yggdrasil CLI with no merge-driver command) exits
// non-zero without writing, and git would keep ours with no markers. A non-zero exit that left no conflict markers in
// %A therefore gets git's text merge; a driver's own refusal writes its markers first and is kept. POSIX sh and grep,
// which git's shell has on every platform.
function guardedDriver(run) {
  return `${run}; s=$?; if [ $s -ne 0 ] && ! grep -q '^<<<<<<< ' %A; then ${TEXT_MERGE}; exit 1; fi; exit $s`;
}
export const JARL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'jarl.mjs');

// How git merges a committed loop's files, in .jarl/.gitattributes (paths relative to .jarl/): the journal by union,
// decisions.md by the jarl-decisions driver. A clone that never configured the driver merges decisions.md with
// plain conflict markers — the fallback, never a silent union.
export const JARL_GITATTRIBUTES = '# jarl: how git merges the loop (see SKILL.md): the journal by union, decisions.md by its own driver\n/log.md merge=union\n/decisions.md merge=jarl-decisions\n';

// The variables that point git at another repository than the one its working directory is in (git sets them for
// a hook it runs): the loop's repository is always the one its directory is in.
const REPOSITORY_OVERRIDES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE'];
function gitHere(dir, args) {
  const env = { ...process.env };
  for (const name of REPOSITORY_OVERRIDES) delete env[name];
  try { return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// A committed loop's merge setup: .jarl/.gitattributes, and the jarl-decisions driver in the local configuration of
// the repository the loop is in (a driver is a local command, never committed). Idempotent; returns what it
// changed. A loop out of git, or outside a repository, is left alone.
export function ensureLoopMerge(root) {
  const changed = [];
  if (!existsSync(jarlDir(root)) || outOfGit(root)) return changed;
  const attrs = join(jarlDir(root), '.gitattributes');
  if (!existsSync(attrs) || readText(attrs) !== JARL_GITATTRIBUTES) { writeAtomic(attrs, JARL_GITATTRIBUTES); changed.push('.jarl/.gitattributes'); }
  if (gitHere(jarlDir(root), ['rev-parse', '--is-inside-work-tree']) !== 'true') return changed;
  for (const [key, value] of [['merge.jarl-decisions.name', "Jarl's decisions.md (rulings merged block by block)"], ['merge.jarl-decisions.driver', decisionsDriverCommand()]]) {
    if (gitHere(jarlDir(root), ['config', '--local', '--get', key]) === value) continue;
    if (gitHere(jarlDir(root), ['config', '--local', key, value]) !== null) changed.push(key);
  }
  return changed;
}

// The `-c` settings a merger passes on every `git merge`, so the drivers run whatever the clone's own configuration
// holds: the decisions driver always, and Yggdrasil's log and lock drivers when a Yggdrasil command is given (a
// repository with a graph). One shell-quoted line, ready to put between `git` and `merge`.
export function mergeFlags({ yg } = {}) {
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const pairs = [['merge.jarl-decisions.name', 'jarl decisions.md'], ['merge.jarl-decisions.driver', decisionsDriverCommand()]];
  if (yg) {
    for (const kind of ['log', 'lock']) {
      pairs.push([`merge.yg-${kind}.name`, `Yggdrasil ${kind}`], [`merge.yg-${kind}.driver`, guardedDriver(`${yg} merge-driver ${kind} %O %A %B %P`)]);
    }
  }
  return pairs.map(([k, v]) => `-c ${sq(`${k}=${v}`)}`).join(' ');
}

// jarl.mjs merge-driver decisions <base> <ours> <theirs> — what git runs. The result always replaces <ours> before a
// clean exit; a refusal writes the markers and exits 1 so git stops on the file; anything unexpected hands the file
// to git's own text merge with markers, so ours is never left alone as if it were the answer.
export function runDecisionsDriver(basePath, oursPath, theirsPath) {
  try {
    const r = mergeDecisionsTexts(readText(basePath), readText(oursPath), readText(theirsPath));
    writeFileSync(oursPath, r.text);
    if (r.ok) return { code: 0, conflicts: [] };
    return { code: 1, conflicts: r.conflicts };
  } catch (e) {
    try { execFileSync('git', ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath, basePath, theirsPath], { stdio: 'ignore' }); } catch { /* merge-file exits with the number of conflicts */ }
    return { code: 1, conflicts: [`the decisions driver failed (${e.message}); git's text merge with markers was written instead`] };
  }
}
