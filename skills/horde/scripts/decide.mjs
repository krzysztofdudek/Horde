#!/usr/bin/env node
// horde skill — decide.mjs
//
// Durable rulings and lessons, in the mission's own record: the Jarl loop's decisions.md
// (.horde/hordes/<horde>/.jarl/decisions.md, loop.mjs). The loop writes and numbers nothing here but
// the ruling itself — its date and slug heading, its text, who ruled, what it supersedes and the ticket
// it settles — so Jarl's own views (`jarl.mjs decisions --live --root .horde/hordes/<h>`) read every
// ruling this writes.
//
// A ruling about code the graph names reaches the graph's own logs, written by this file's own code
// when the mission is done (horde.mjs done), as one commit on the trunk it hands over:
//   --node <path>   one component: its why, in that node's log (yg log add --node). It needs nobody's
//                   consent, so every node ruling in force is written.
//   --area <type>   every file of one type: a decision in the type's log (yg log add --type). It is a
//                   ruling of the mission at once and enters the type's decisions only when the client
//                   ratifies it: `ratify` files the batch (at most ten, widest reach first), the client
//                   answers each with ask.mjs answer <a-id> "tak" or "nie", and a ruling nobody ratified
//                   stays the mission's own. --rule <id> names a rule of the graph the ruling admits on
//                   that type, and its ratification is written into the rule's own log too (yg log add
//                   --aspect <id> --ratify).
// What is written is marked on the ruling (**Node log:**, **Type log:**, **Rule log:**), so nothing is
// written twice — and Jarl's own command line, answering an item of this mission, sends nothing to the
// graph: the mission's profile keeps it to Horde.
//
// Entry format, as the loop writes it:
//   ## <YYYY-MM-DD> · <slug>
//   <ruling text, may be multi-line>
//
//   **Settles:** NNN       (with --ticket: the ticket the ruling is about; its Evidence carries the ruling too)
//   **By:** <who>
//   **Supersedes:** <slug> (with --supersedes; the earlier ruling is marked Superseded by in place)

import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  fail, parseArgs, emit, isMain, resolveHorde, readText, parseDecisionEntries, runMain,
  hordePath, createLockFile, processAlive, readLockText, removeStaleLock, sleepSync, nowIso,
  decisionField, resolveTree, git, gitError, repoRoot,
} from './_lib.mjs';
import { ygCommand, ygTimeout } from './node.mjs';
import {
  decideLoop, decisionsFile, ticketFile, loopDecisions, loopAsks, fileLoopAsk, withLoopLock, writeLoopFile, appendLoopLog,
} from './loop.mjs';
import { loadAsks } from './ask.mjs';

export const USAGE = `usage: decide.mjs <command> [options]

commands:
  add <slug> "<ruling>" [--ticket NNN] [--by who] [--supersedes <slug>]
      [--node <path> | --area <type> [--reach n] [--rule <id>]] [--horde h]
      appends a new ruling to the mission's record; refuses a duplicate slug. --ticket names the
      ticket the ruling settles (written on the ticket too). --supersedes names an earlier ruling
      this one replaces (marked as superseded in place). --by says who ruled (default: director).
      --node names the one component the ruling is about (its path under .yggdrasil/model/): its
      why, written into that node's own log when the mission is done, with nobody's consent.
      --area names a whole type of code the ruling reaches (as yg-architecture.yaml names it),
      --reach how many files that type holds, --rule the rule of the graph it admits on that type:
      the client ratifies it first (ratify), and only a ratified one is written into the type's
      decision log (and the rule's own log) when the mission is done. --node and --area exclude
      each other.
  ratify [--horde h]
      files the ratification batch: every area ruling in force that nobody has asked about yet,
      widest reach first, up to ten open at once (the rest wait for the next call), each a question
      to the client answered with one word — ask.mjs answer <a-id> "tak" (or yes) admits it, "nie"
      (or reject) leaves it a ruling of this mission. Blocks nothing; lists the items open now.
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
        date, slug, ticket: ticket || (asked ? askTickets.get(asked[1]) || null : null), node: node || nodeOf(body), body,
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

// A component as the graph names it: its path under .yggdrasil/model/, segments of letters, digits and
// . _ - joined by /, none of them . or .. — checked here, and again before it reaches yg.
export const NODE_PATH_RE = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// The component a ruling is about: the **Node:** field Horde writes as the ruling's first line (the
// record's own fields close a ruling, and a line after them would read as its text).
function nodeOf(body) {
  const first = String(body || '').split('\n').find((l) => l.trim()) || '';
  return /^\*\*Node:\*\*/.test(first) ? decisionField(first, 'Node') || null : null;
}

// appendDecision(horde, {slug, ruling, ticket, node, by, supersedes, area, reach, rule}) — throws on a
// missing field, a duplicate slug, a bad node path, or a ruling naming both a node and an area; the
// caller decides how to report it. The loop holds its own lock for the check and the write, and for
// the node's field written into the same ruling before it lets go.
export function appendDecision(horde, {
  slug, ruling, ticket, node, by, supersedes, area, reach, rule,
} = {}) {
  if (!slug) throw new Error('slug required');
  if (!ruling) throw new Error('ruling required');
  if (node !== undefined && node !== null && !NODE_PATH_RE.test(String(node))) {
    throw new Error(`--node names one component by its path under .yggdrasil/model/: segments of letters, digits and . _ - joined by / (got "${node}")`);
  }
  if (node && area !== undefined) {
    throw new Error('--node and --area exclude each other: a ruling about one component is its why, written with nobody\'s consent; one about a whole type waits for the client\'s — record two rulings when both are meant');
  }

  const settles = ticket ? String(ticket).replace(/^t-/, '').padStart(3, '0') : null;
  if (settles && !ticketFile(horde, settles)) throw new Error(`no such ticket: ${settles} — a ruling names a ticket of this mission (tk.mjs list)`);
  const done = withLoopLock(horde, () => {
    const d = decideLoop(horde, slug, ruling, {
      by: by || 'director', ...(settles ? { settles } : {}), ...(supersedes ? { supersedes } : {}),
      ...(area !== undefined ? { area } : {}), ...(reach !== undefined ? { reach } : {}), ...(rule !== undefined ? { rule } : {}),
    });
    if (node) headRuling(horde, slug, (lines, at) => lines.splice(at + 1, 0, `**Node:** ${node}`));
    return d;
  });
  return {
    date: new Date().toISOString().slice(0, 10), slug, ticket: settles, node: node || null, body: ruling, by: done.by, supersedes: done.supersedes,
    ...(done.area ? { area: done.area, reach: done.reach, ...(done.rule ? { rule: done.rule } : {}) } : {}),
  };
}

// One ruling's lines in decisions.md, changed in place: `change(lines, at)` gets the whole file's lines
// and the index of the ruling's heading. The caller holds the loop's lock.
function headRuling(horde, slug, change) {
  const path = decisionsFile(horde);
  const lines = (readText(path) || '').split('\n');
  const at = lines.findIndex((l) => l.startsWith('## ') && l.replace(/\s+$/, '').endsWith(` · ${slug}`) && /^## \d{4}-\d{2}-\d{2} · /.test(l));
  if (at === -1) throw new Error(`no ruling ${slug} in decisions.md`);
  change(lines, at);
  writeLoopFile(path, lines.join('\n'));
}

// A field the record reads, added at the end of the ruling's own section — where the record's own
// fields close a ruling (**Type log:**, **Rule log:**, as Jarl writes them).
function closeRuling(horde, slug, line) {
  headRuling(horde, slug, (lines, at) => {
    let end = lines.findIndex((l, n) => n > at && l.startsWith('## '));
    if (end === -1) end = lines.length;
    while (end - 1 > at && lines[end - 1].trim() === '') end -= 1;
    lines.splice(end, 0, line);
  });
}

// ---- the ratification batch ----------------------------------------------------------------------

// At most this many area rulings wait for the client's word at once; the rest wait for the next batch.
export const RATIFY_BATCH = 10;

function firstSentence(text) {
  const line = String(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  const s = /^.+?[.!?](?=\s|$)/.exec(line)?.[0] || line;
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

// ratify(horde) — files a ratify question for every area ruling in force nobody has asked about yet,
// widest reach first (an uncounted one last, then oldest first), up to RATIFY_BATCH open in all, and
// returns the open items: { items: [{ id, ruling, area, reach, rule, question }], filed: [ids], waiting }.
// The record checks each item names an area ruling in force, asked about once.
export function ratify(horde) {
  return withLoopLock(horde, () => {
    const asks = loopAsks(horde);
    const asked = new Set(asks.filter((a) => a.ruling).map((a) => a.ruling));
    const open = asks.filter((a) => a.ruling && a.state === 'open');
    const rulings = loopDecisions(horde);
    const candidates = rulings
      .map((d, n) => ({ d, n }))
      .filter(({ d }) => d.area && !d.supersededBy && !d.ratified && !d.rejected && !asked.has(d.slug))
      .sort((a, b) => (b.d.reach ?? -1) - (a.d.reach ?? -1) || a.n - b.n)
      .map((x) => x.d);
    const room = Math.max(0, RATIFY_BATCH - open.length);
    const filed = candidates.slice(0, room).map((d) => {
      const reach = d.reach !== null ? `${d.reach} file${d.reach === 1 ? '' : 's'}` : 'files not counted';
      // A rule's ratification admits it on every type the graph has it reach, not only this one: the
      // question says so, so a yes about one area never passes for consent to less than it gives.
      const scope = d.rule ? `, and to ratify rule ${d.rule} as it stands now on every type the graph has it reach (not only ${d.area})` : '';
      const q = `area ${d.area}${d.rule ? ` · rule ${d.rule}` : ''} · ${reach} · ${d.slug}: "${firstSentence(d.ruling)}" — tak (yes) to admit it into the type's decisions${scope}, nie (reject) to leave it a ruling of this mission`;
      return `a-${fileLoopAsk(horde, q, { kind: 'ratify', ruling: d.slug }).id}`;
    });
    const bySlug = new Map(rulings.map((d) => [d.slug, d]));
    const items = loopAsks(horde).filter((a) => a.ruling && a.state === 'open').map((a) => {
      const d = bySlug.get(a.ruling);
      return {
        id: `a-${a.id}`, ruling: a.ruling, area: d?.area ?? null, reach: d?.reach ?? null, rule: d?.rule ?? null, question: a.question,
      };
    });
    return { items, filed, waiting: candidates.length - filed.length };
  });
}

// ---- the graph's logs, at done -----------------------------------------------------------------

// What the mission owes the graph's logs: every node ruling in force not yet in its node's log, and
// every ratified area ruling in force not yet in its type's log (with its rule's ratification, when it
// names a rule and that is not written yet). Also what stays behind: area rulings in force nobody has
// ratified or rejected (unratified) and the ratify questions still open (pending).
export function graphLogPlan(horde) {
  const rulings = loopDecisions(horde);
  const blocks = new Map(parseDecisionEntries(readText(decisionsFile(horde)) || '').filter((e) => e.slug).map((e) => [e.slug, e.block]));
  const items = [];
  const unratified = [];
  for (const d of rulings) {
    if (d.supersededBy) continue;
    const node = nodeOf(d.ruling);
    const text = node ? d.ruling.split('\n').slice(d.ruling.split('\n').findIndex((l) => l.trim()) + 1).join('\n').trim() : d.ruling;
    if (node && !decisionField(blocks.get(d.slug) || '', 'Node log')) {
      items.push({ kind: 'node', slug: d.slug, node, text: `${text}\n\n(ruling ${d.slug}, mission ${horde})` });
    }
    if (!d.area) continue;
    if (!d.ratified) {
      if (!d.rejected) unratified.push(d.slug);
      continue;
    }
    const said = `${text}\n\n(ratified: ${d.slug}, ${d.ratified}; mission ${horde})`;
    // The ruling it replaces, when that one's entry is in the same type's log, is replaced there too.
    const prior = d.supersedes ? rulings.find((x) => x.slug === d.supersedes) : null;
    const supersedes = prior && prior.typeLog && prior.typeLog.type === d.area ? prior.typeLog.datetime : null;
    if (!d.typeLog) items.push({ kind: 'type', slug: d.slug, type: d.area, supersedes, text: said });
    if (d.rule && !d.ruleLog) items.push({ kind: 'rule', slug: d.slug, rule: d.rule, text: said });
  }
  const pending = loopAsks(horde).filter((a) => a.ruling && a.state === 'open').map((a) => `a-${a.id}`);
  return { items, unratified, pending };
}

// Who admitted a rule, as its ratification names them: the person git names in the repository (the
// chairman answering the batch), else "the client". A name a shell would misread is not passed.
function ratifier(root) {
  const name = git(['config', 'user.name'], root) || '';
  return /^[^"%!\r\n\x00-\x1f]{1,120}$/u.test(name) && /\p{L}/u.test(name) ? name : 'the client';
}

const TIMESTAMP_RE = /^\d{4}-\d\d-\d\dT[0-9:.]+Z$/;
const TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function ygSaid(e) {
  const said = `${e.stderr || ''}\n${e.stdout || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return said.length ? said.slice(0, 12).join(' | ') : String(e.message || e).split('\n')[0];
}

// One entry: the yg arguments and the command to run by hand when it fails.
function entryCommand(it, by, file) {
  if (it.kind === 'node') return { args: ['log', 'add', '--node', it.node, '--reason-file', file], retry: `log add --node ${it.node} --reason '<the ruling>'` };
  if (it.kind === 'type') {
    const sup = it.supersedes ? ['--supersedes', it.supersedes] : [];
    return { args: ['log', 'add', '--type', it.type, '--reason-file', file, ...sup], retry: `log add --type ${it.type} --reason '<the ruling>'${it.supersedes ? ` --supersedes ${it.supersedes}` : ''}` };
  }
  return { args: ['log', 'add', '--aspect', it.rule, '--ratify', '--by', by, '--reason-file', file], retry: `log add --aspect ${it.rule} --ratify --by '${by.replace(/'/g, "'\\''")}' --reason '<what was admitted>'` };
}

// writeGraphLogs(horde, cfg, {branch, sha}) — what graphLogPlan owes, written into the graph's logs in a
// throwaway tree at the trunk tip `sha`, committed there as one commit and moved onto `branch` (named
// with its old value, so a trunk that moved meanwhile refuses rather than losing what landed on it).
// Nothing here blocks the mission: an entry yg refuses (an unknown node or type, decisions in force
// the new one says nothing about) is reported with the command to run by hand, and one that could not
// reach the trunk (the commit refused by a hook, the branch moved) likewise; each stays a ruling of the
// mission, unmarked. What reached the trunk is marked on its ruling, so it is never written twice.
// Returns { commit, from, written: [..], failed: [..], unratified, pending }.
export function writeGraphLogs(horde, cfg, { branch, sha }) {
  const plan = graphLogPlan(horde);
  const out = {
    commit: null, from: sha, written: [], failed: [], unratified: plan.unratified, pending: plan.pending,
  };
  // What decisions.md holds is checked again before it reaches yg: a hand edit could put anything there.
  const items = [];
  for (const it of plan.items) {
    const bad = (it.kind === 'node' && !NODE_PATH_RE.test(it.node)) || (it.kind === 'type' && !TYPE_RE.test(it.type)) || (it.kind === 'rule' && !NODE_PATH_RE.test(it.rule));
    if (bad) out.failed.push({ ...it, reason: 'not a name yg takes', retry: null });
    else items.push({ ...it, supersedes: it.supersedes && TIMESTAMP_RE.test(it.supersedes) ? it.supersedes : null });
  }
  if (!items.length) return out;
  const yg = ygCommand(cfg);
  const root = repoRoot();
  const by = ratifier(root);
  const info = resolveTree({ scratch: sha });
  const tmp = mkdtempSync(join(tmpdir(), 'horde-graph-log-'));
  const wrote = [];
  try {
    items.forEach((it, n) => {
      const file = join(tmp, `${n}.md`);
      writeFileSync(file, `${it.text.trim()}\n`);
      const { args, retry } = entryCommand(it, by, file);
      try {
        const said = execFileSync(yg.cmd, [...yg.prefix, ...args], {
          cwd: info.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ygTimeout(cfg), killSignal: 'SIGTERM',
        });
        wrote.push({ ...it, datetime: /Timestamp:\s*(\S+)/.exec(said)?.[1] || 'unknown', ...(it.kind === 'rule' ? { by } : {}) });
      } catch (e) {
        out.failed.push({ ...it, reason: ygSaid(e), retry: `${yg.display} ${retry}` });
      }
    });
    if (!wrote.length) return out;
    const lost = (reason) => { for (const w of wrote) out.failed.push({ ...w, reason, retry: null }); return out; };
    if (git(['add', '-A', '--', '.yggdrasil'], info.path) === null) return lost(`the entries were written but could not be staged: ${gitError() || 'git add failed'}`);
    const counts = ['node', 'type', 'rule'].map((k) => [k, wrote.filter((w) => w.kind === k).length]).filter(([, c]) => c);
    const subject = `decisions: mission ${horde} into the graph's logs — ${counts.map(([k, c]) => `${c} ${{ node: 'node ruling', type: 'type decision', rule: 'rule ratification' }[k]}${c === 1 ? '' : 's'}`).join(', ')}`;
    const lines = wrote.map((w) => `- ${w.slug} → ${w.kind === 'node' ? `node ${w.node}` : w.kind === 'type' ? `type ${w.type}` : `rule ${w.rule} (ratified by ${w.by})`}`);
    if (git(['commit', '-q', '-m', subject, '-m', lines.join('\n')], info.path) === null) return lost(`the commit on ${branch} was refused: ${gitError() || 'git commit failed'}`);
    const commit = git(['rev-parse', 'HEAD'], info.path);
    if (git(['update-ref', `refs/heads/${branch}`, commit, sha], root) === null) return lost(`${branch} moved while the entries were written, so they were not put on it`);
    out.commit = commit;
    withLoopLock(horde, () => {
      for (const w of wrote) {
        if (w.kind === 'node') headRuling(horde, w.slug, (ls, at) => { const i = ls.findIndex((l, k) => k > at && /^\*\*Node:\*\*/.test(l)); if (i !== -1) ls[i] = `${ls[i]} · **Node log:** ${w.datetime}`; });
        else closeRuling(horde, w.slug, w.kind === 'type' ? `**Type log:** ${w.type} · ${w.datetime}` : `**Rule log:** ${w.rule} · ${w.datetime}`);
        appendLoopLog(horde, `${w.slug} written into the log of ${w.kind === 'node' ? `node ${w.node}` : w.kind === 'type' ? `type ${w.type}` : `rule ${w.rule} as its ratification, by ${w.by}`} · ${commit.slice(0, 7)} on ${branch}`);
      }
    });
    out.written = wrote;
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    info.cleanup();
  }
}

function cmdAdd(horde, positional, flags) {
  const [slug, ruling] = positional;
  if (!slug || !ruling) fail('add requires <slug> "<ruling>"');
  let entry;
  try {
    entry = appendDecision(horde, {
      slug, ruling, ticket: flags.ticket, node: flags.node, by: flags.by, supersedes: flags.supersedes, area: flags.area, reach: flags.reach, rule: flags.rule,
    });
  } catch (e) {
    fail(e.message);
  }
  emit(entry, flags, () => `decision added: ${slug}${entry.node ? ` · node ${entry.node} — written into its log when the mission is done` : ''}${entry.area ? ` · area ${entry.area} — put it to the client with decide.mjs ratify; written into the type's log when the mission is done, once ratified` : ''}`);
}

function cmdRatify(horde, positional, flags) {
  let out;
  try { out = ratify(horde); } catch (e) { fail(e.message); }
  emit(out, flags, () => {
    if (!out.items.length) return 'no area ruling awaits ratification';
    return [
      `to ratify (${out.items.length}${out.waiting ? `, ${out.waiting} more at the next batch` : ''}) — the client answers each with one word: ask.mjs answer <a-id> "tak" (yes) or "nie" (reject); nothing waits on it`,
      ...out.items.map((i) => `- ${i.id} · ${i.question}`),
    ].join('\n');
  });
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
    case 'ratify': return cmdRatify(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) runMain(main);
