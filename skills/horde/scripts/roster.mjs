#!/usr/bin/env node
// horde skill — roster.mjs
//
// Who is alive. A name is reserved for an agent's whole life so a report never lands in a
// stranger's session, and it is never reused — reclaiming a lease just means the next spawn for
// that same team or node gets N+1, computed by scanning every entry (dead ones too) for the
// highest existing N. Liveness is judged from the tools' own record of activity, never from
// silence alone: a steward's team branch and queue.json, an owner's review window on its node's
// tickets, and lastTrace as a third, rescuing signal — the newest of the three, per role, is
// what "silence" is measured from, so a busy agent that hasn't called trace yet still reads as
// alive as long as its branch, queue or reviews show it.
//
// `spawn steward --team t --parent p` additionally brings the sub-team into being: its branch
// (cut from the parent's branch tip, short name only — hierarchy lives in this roster, never in
// a branch name), its team directory, and a "team:<t>" item already running in the parent's
// queue, since the branch it stands for exists from this same call.

import {
  existsSync, mkdirSync, readdirSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  hordePath, teamPath, hordeRoot, repoRoot, readJSON, writeJSON, readText, nowIso, fail, parseArgs,
  emit, isMain, resolveHorde, readConfig, git,
} from './_lib.mjs';
import { currentWaveNumber } from './wave.mjs';
import { appendDecision } from './decide.mjs';
import { renderQueueDoc } from './queue.mjs';
import { nodesOf, findTicket, parseField } from './tk.mjs';

const USAGE = `usage: roster.mjs <command> [options]

commands:
  spawn <role> [--team t | --node n] [--parent p] --class c [--ticket NNN] [--agent-id id]
      [--horde h]
      reserves the next unique name "<horde>-<role>-<team|node|mission>-<N>", books the run
      against cost.json, and prints the name. "t" is always the team's short leaf name — unique
      per horde, refused if another team already claims it under a different parent. For
      "steward --team t --parent p" also creates the branch "<horde>/<t>" off the parent's tip,
      the team directory (queue.json, issues/), and a "team:<t>" item already running in the
      parent's queue — or, if the branch and team directory already exist (a respawn after a
      reclaim, same leaf and parent), re-registers onto them instead. "steward --team trunk"
      needs no --parent and creates no branch or directory — the trunk branch and directory
      already exist from horde.mjs init. Either way, for any "steward --team t", a worktree for
      it at "<hordeRoot>/worktrees/<horde>/<t>" on the team branch is created when missing and
      its path printed in the result; a reclaim leaves it in place for the successor to pick up.
      --agent-id records the Agent tool's own id for this run, when already known.
  trace <name> [--agent-id id] [--horde h]
      updates lastTrace to now, and (since a trace is itself proof of life) revives a "dead"
      lease back to "active" — reclaimed and retired leases, being deliberate, are untouched.
      --agent-id records the Agent tool's id, settable now that it's known even though it wasn't
      at spawn time.
  revive <name> [--horde h]
      the explicit form: restores any lease — dead, reclaimed or retired — because a human asked
      for this entry by name, on purpose.
  list [--dead] [--horde h]
      every entry with a liveness verdict against config.liveness: a steward from its team
      branch and queue.json (a "team:<t>" running item never counts as work of the steward's
      own — a steward whose only running items are those is alive as long as any of those
      sub-teams' stewards is alive), an owner from its node's review windows, an architect from
      open graph proposals/pending contracts, lastTrace as a rescuing signal throughout. Auditor
      and counsel (one-shot roles) are never dead.
  reclaim <name> ["why"] [--lesson] [--by director] [--horde h]
      marks the lease reclaimed; the next spawn for the same team or node gets N+1. Appends
      "why" to decisions.md as a lesson when --lesson is given (requires "why"). A mission-scoped
      entry (architect, or anything spawned with neither --team nor --node) requires
      --by director.
  stand-down <name> [--horde h]
      marks the entry retired.
  reconcile [--only-team t] [--horde h]
      marks every active entry dead — the session that spawned them is gone. --only-team limits
      this to one team's subtree (that team's own steward and everything nested under it).

options: --json  --help`;

function rosterPath(horde) { return hordePath(horde, 'roster.json'); }

function renderRoster(doc) {
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const lines = ['# Roster', ''];
  if (entries.length === 0) lines.push('(none)');
  for (const e of entries) {
    lines.push(`- ${e.name}  ${e.role}  ${e.team || e.node || 'mission'}  ${e.class}  lease=${e.lease}`);
  }
  return lines.join('\n');
}

function load(horde) {
  const doc = readJSON(rosterPath(horde), null);
  return doc && Array.isArray(doc.entries) ? doc : { entries: [] };
}

function save(horde, doc) {
  writeJSON(rosterPath(horde), doc, { render: renderRoster });
}

function scopeOf(flags) {
  if (flags.team) return flags.team;
  if (flags.node) return flags.node;
  return 'mission';
}

function nextName(doc, horde, role, scope) {
  const prefix = `${horde}-${role}-${scope}-`;
  let max = 0;
  for (const e of doc.entries) {
    if (e.name.startsWith(prefix)) {
      const n = Number(e.name.slice(prefix.length));
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
  }
  return `${prefix}${max + 1}`;
}

function teamBranchName(horde, team) {
  return team === 'trunk' ? `${horde}/trunk` : `${horde}/${team}`;
}

// Reconstructs a sub-team's full "parent/child" short path by walking steward entries' own
// `parent` links back to "trunk", from the in-memory `doc` rather than disk — used only at
// spawn time, for the one moment a brand-new team's own directory has to be created before its
// roster entry is persisted, so _lib.mjs's own (disk-reading) teamPath() can't resolve it yet.
// Every other reader, including this file's own liveness checks, uses the shared teamPath()
// directly once the entry exists on disk.
function resolveTeamPath(horde, doc, name) {
  if (!name || name === 'trunk') return 'trunk';
  const entry = doc.entries.find((e) => e.role === 'steward' && e.team === name);
  if (!entry) return name;
  return `${resolveTeamPath(horde, doc, entry.parent)}/${name}`;
}

// A plain segment expansion with no roster lookup — the pre-persistence counterpart to
// _lib.mjs's teamPath(), for writing a brand-new team's own files at the full path this file
// already worked out via resolveTeamPath() above.
function rawTeamPath(horde, fullPath, ...parts) {
  const segments = fullPath.split('/').filter(Boolean);
  return hordePath(horde, ...segments.flatMap((s) => ['teams', s]), ...parts);
}

function bookCost(horde, run) {
  const path = hordePath(horde, 'cost.json');
  const doc = readJSON(path, { runs: [] });
  if (!Array.isArray(doc.runs)) doc.runs = [];
  const wave = currentWaveNumber(readText(hordePath(horde, 'plan.md'))) || null;
  doc.runs.push({ ...run, wave, at: nowIso() });
  writeJSON(path, doc);
}

function cmdSpawn(horde, positional, flags) {
  const role = positional[0];
  if (!role) fail('spawn requires <role>');
  if (flags.team && flags.node) fail('spawn takes --team or --node, not both');
  if (!flags.class) fail('spawn requires --class <c>');
  const cfg = readConfig();
  const classes = (cfg && cfg.classes) || {};
  if (Object.keys(classes).length && !Object.prototype.hasOwnProperty.call(classes, flags.class)) {
    fail(`unknown class: ${flags.class} (config classes: ${Object.keys(classes).join(', ')})`);
  }
  if (role === 'steward' && flags.team && flags.team !== 'trunk' && !flags.parent) {
    fail('spawn steward --team requires --parent <p> (unless --team trunk)');
  }
  // A worker or verifier is never staffed below its ticket's class: a short budget is the cost
  // escalation, an overloaded class is the waiting state — a quiet downgrade is neither.
  if ((role === 'worker' || role === 'verifier') && flags.ticket) {
    const ticket = findTicket(horde, flags.ticket);
    const ticketClass = ticket ? parseField(ticket.text, 'Class') : null;
    if (ticketClass && classes[ticketClass] !== undefined && classes[flags.class] !== undefined && classes[flags.class] < classes[ticketClass]) {
      fail(`class ${flags.class} is below ticket ${ticket.id}'s class ${ticketClass} — a ${role} is never staffed below the ticket's class; a short budget is a cost escalation, an overloaded class is "queue set ${ticket.id} waiting"`);
    }
  }

  const doc = load(horde);

  // Leaf team names are unique per horde: the same leaf under the same parent, across a
  // reclaim, is the ordinary respawn case below; the same leaf claimed under a *different*
  // parent is a genuine collision, since every other tool addresses a team by this leaf alone.
  if (role === 'steward' && flags.team && flags.team !== 'trunk') {
    const priorEntry = doc.entries.find((e) => e.role === 'steward' && e.team === flags.team);
    if (priorEntry && priorEntry.parent !== flags.parent) {
      fail(`team name "${flags.team}" is already in use under parent "${priorEntry.parent}" — leaf names are unique per horde`);
    }
  }

  const scope = scopeOf(flags);
  const name = nextName(doc, horde, role, scope);
  const ticket = flags.ticket ? String(flags.ticket) : null;

  const entry = {
    name,
    role,
    class: flags.class,
    team: flags.team || null,
    node: flags.node || null,
    parent: flags.parent || null,
    ticket,
    agentId: flags['agent-id'] || null,
    spawnedAt: nowIso(),
    lastTrace: nowIso(),
    lease: 'active',
  };
  doc.entries.push(entry);

  let teamPathCreated = null;
  if (role === 'steward' && flags.team === 'trunk') {
    // The trunk branch and its team directory already exist from horde.mjs init — this spawn
    // just registers who is stewarding it now, same as any other roster entry.
    teamPathCreated = 'trunk';
  } else if (role === 'steward' && flags.team) {
    // Computed in-memory (see resolveTeamPath's own comment) since this entry — which the shared,
    // disk-reading teamPath() would need to resolve "flags.team" itself — isn't saved yet.
    const parentPath = resolveTeamPath(horde, doc, flags.parent);
    const fullPath = `${parentPath}/${flags.team}`;
    const parentBranch = teamBranchName(horde, flags.parent);
    const newBranch = `${horde}/${flags.team}`;
    const root = repoRoot();
    const branchExists = git(['rev-parse', '--verify', newBranch], root) !== null;
    const dirExists = existsSync(rawTeamPath(horde, fullPath));

    // A branch with no team directory behind it is a name collision or a half-finished spawn —
    // there's nothing safe to guess, so this is the one case that refuses outright. Both present
    // (or both absent) are fine: the former is a respawn onto an existing team after a reclaim.
    if (branchExists && !dirExists) {
      fail(`branch ${newBranch} already exists but its team directory is missing — refusing to guess whether this is the same team`);
    }
    if (!branchExists) {
      const created = git(['branch', newBranch, parentBranch], root);
      if (created === null) fail(`could not create branch ${newBranch} off ${parentBranch} — does the parent team exist?`);
    }
    if (!dirExists) {
      writeJSON(rawTeamPath(horde, fullPath, 'queue.json'), { items: [] }, { render: renderQueueDoc });
      mkdirSync(rawTeamPath(horde, fullPath, 'issues'), { recursive: true });
    }
    // Reported (and stored on the entry, above) as the bare leaf — the one address every other
    // tool takes; the full path above exists only to create the right files at spawn time.
    teamPathCreated = flags.team;

    const parentQueuePath = rawTeamPath(horde, parentPath, 'queue.json');
    const parentQueue = readJSON(parentQueuePath, { items: [] });
    if (!Array.isArray(parentQueue.items)) parentQueue.items = [];
    const existingItem = parentQueue.items.find((i) => i.ticket === `team:${flags.team}`);
    if (existingItem) {
      existingItem.state = 'running';
      existingItem.agent = name;
    } else {
      parentQueue.items.push({
        ticket: `team:${flags.team}`,
        state: 'running',
        class: flags.class,
        branch: newBranch,
        worktree: null,
        dependsOn: [],
        agent: name,
        sha: null,
        notes: [],
      });
    }
    writeJSON(parentQueuePath, parentQueue, { render: renderQueueDoc });
  }

  // Every steward — trunk included — works in its own worktree on its team branch (topology.md:
  // "stewards work in their own worktree on their team branch"). Left in place across a reclaim
  // and respawn, same as a ticket's worktree survives a queue reconcile: the successor picks up
  // wherever it was, and nothing here ever deletes one.
  let worktreePath = null;
  if (role === 'steward' && flags.team) {
    worktreePath = join(hordeRoot(), 'worktrees', horde, flags.team);
    if (!existsSync(worktreePath)) {
      const branch = teamBranchName(horde, flags.team);
      const added = git(['worktree', 'add', worktreePath, branch], repoRoot());
      if (added === null) fail(`could not create worktree at ${worktreePath} for ${branch}`);
    }
  }

  bookCost(horde, {
    name, role, class: flags.class, ticket, team: flags.team || null,
  });
  save(horde, doc);
  emit({
    name, team: teamPathCreated, worktree: worktreePath, agentId: entry.agentId,
  }, flags, () => (worktreePath ? `${name}\nworktree: ${worktreePath}` : name));
}

// Updates lastTrace for `name` and returns the entry, or null when `name` isn't in the roster —
// exported so other tools can trace whoever their own --by names, without shelling out, and
// without having to first check whether that name happens to be a roster entry at all (a --by
// value is often just a free-text name, not necessarily one roster.mjs spawn ever reserved). A
// trace is itself proof of life, so it revives a "dead" entry back to "active" — reconcile's
// judgment was provisional, made in the entry's absence; a reclaimed or retired lease is a
// deliberate decision instead, and stays as it is (see revive() below for undoing those on
// purpose). `agentId`, when given, is recorded — the one moment an agent's own id is knowable is
// after the Agent tool has already returned it, which is generally after the spawn that reserved
// its name.
// The roster's entry for a name — the class an agent was actually staffed at, for a verdict's
// label — or null.
export function rosterEntry(horde, name) {
  return load(horde).entries.find((e) => e.name === name) || null;
}

// The most recently spawned owner entry's name for a node — any lease state, since a ticket's
// node ownership is a roster fact, not a liveness one. tk.mjs's review command reads this to tell
// whether a ticket's own author is that node's owner, the condition its approval seat depends on.
export function ownerNameForNode(horde, node) {
  const owners = load(horde).entries.filter((e) => e.role === 'owner' && e.node === node);
  return owners.length ? owners[owners.length - 1].name : null;
}

export function trace(horde, name, agentId) {
  const doc = load(horde);
  const entry = doc.entries.find((e) => e.name === name);
  if (!entry) return null;
  entry.lastTrace = nowIso();
  if (entry.lease === 'dead') entry.lease = 'active';
  if (agentId) entry.agentId = agentId;
  save(horde, doc);
  return entry;
}

function cmdTrace(horde, positional, flags) {
  const name = positional[0];
  if (!name) fail('trace requires <name>');
  const entry = trace(horde, name, flags['agent-id']);
  if (!entry) fail(`no such roster entry: ${name}`);
  emit(entry, flags, () => `${name} traced`);
}

// The explicit form of a revival: unlike trace()'s implicit one (which only ever lifts a "dead"
// lease, since that judgment is the roster's own and provisional), this restores any lease —
// dead, reclaimed or retired — because a human asked for it by name, on purpose.
function cmdRevive(horde, positional, flags) {
  const name = positional[0];
  if (!name) fail('revive requires <name>');
  const doc = load(horde);
  const entry = doc.entries.find((e) => e.name === name);
  if (!entry) fail(`no such roster entry: ${name}`);
  entry.lease = 'active';
  entry.lastTrace = nowIso();
  delete entry.deadAt;
  delete entry.reclaimedAt;
  delete entry.retiredAt;
  save(horde, doc);
  emit(entry, flags, () => `${name} revived`);
}

// Every team directory the horde has, as the short "parent/child" path strings teamPath()
// expects — the same walk tk.mjs and queue.mjs each keep privately, needed here to find every
// ticket naming an owner's node regardless of which team filed it.
function allTeamPaths(horde) {
  const root = hordePath(horde, 'teams');
  const out = [];
  const walk = (rel) => {
    out.push(rel);
    const subDir = teamPath(horde, rel, 'teams');
    if (existsSync(subDir)) {
      for (const d of readdirSync(subDir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(`${rel}/${d.name}`);
      }
    }
  };
  if (existsSync(root)) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory()) walk(d.name);
    }
  }
  return out;
}

// Every ticket's log text that names `node`, across every team — an owner's liveness depends on
// tickets it owns regardless of which team filed them.
function logsForNode(horde, node) {
  const logs = [];
  for (const team of allTeamPaths(horde)) {
    const issuesDir = teamPath(horde, team, 'issues');
    if (!existsSync(issuesDir)) continue;
    for (const d of readdirSync(issuesDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const issueText = readText(join(issuesDir, d.name, 'issue.md')) || '';
      if (!nodesOf(issueText).includes(node)) continue;
      logs.push(readText(join(issuesDir, d.name, 'log.md')) || '');
    }
  }
  return logs;
}

// tk.mjs's own log lines: "- <iso> review requested" and "- <iso> review: <node> approve|changes
// by <name>[ — why]" — parsed back into chronological events so liveness can tell whether the
// last review request against a ticket was ever answered.
function parseReviewEvents(logText) {
  const events = [];
  for (const line of logText.split('\n')) {
    let m = /^- (\S+) review requested$/.exec(line);
    if (m) { events.push({ at: m[1], type: 'request' }); continue; }
    m = /^- (\S+) review: (\S+) (approve|changes) by (\S+)/.exec(line);
    if (m) events.push({
      at: m[1], type: 'review', node: m[2], by: m[4],
    });
  }
  return events;
}

function isoOrEpoch(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

// The threshold in minutes for "steward" or "owner" liveness, from config.liveness. A
// "<kind>Seconds" key wins over "<kind>Minutes" when both are present — the seconds form exists
// for tests and fast-loop tuning, where waiting a whole default minute isn't practical. Falls
// back to this tool's long-standing defaults (steward 60, owner 45) when neither is set.
function livenessThresholdMinutes(cfg, kind) {
  const liveness = (cfg && cfg.liveness) || {};
  const seconds = liveness[`${kind}Seconds`];
  if (seconds !== undefined) return Number(seconds) / 60;
  const minutes = liveness[`${kind}Minutes`];
  const fallback = kind === 'steward' ? 60 : 45;
  return minutes !== undefined ? Number(minutes) : fallback;
}

// A steward is dead only once its team's queue is non-empty (an empty queue has nothing to be
// silent about, so it's always alive) and every one of the three signals — its team branch's tip
// commit time, its queue.json's own mtime, and lastTrace — is older than stewardMinutes; the
// newest of the three is what "silence" is measured from.
function stewardLivenessVerdict(horde, doc, entry, cfg) {
  // entry.team is the short leaf name (branch names are leaf-only) — teamPath() now resolves it
  // through roster.json itself, so no separate lookup is needed here.
  const queuePath = teamPath(horde, entry.team, 'queue.json');
  const queue = readJSON(queuePath, { items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];
  // A "team:<t>" item stands for a sub-team's own branch, not work of this steward's own — it
  // never counts toward "this queue has something to be silent about" the way a real ticket does.
  const realItems = items.filter((i) => !String(i.ticket).startsWith('team:'));
  const runningTeamItems = items.filter((i) => String(i.ticket).startsWith('team:') && i.state === 'running');

  if (realItems.length === 0) {
    if (runningTeamItems.length === 0) return 'alive';
    // Purely a coordinator right now: alive as long as any of the sub-teams it's running is
    // itself alive — that live sub-steward IS the activity, even though it never touches this
    // steward's own branch or queue.json directly. None alive falls through to this steward's
    // own signals below, the same as if it had nothing running at all.
    const anySubAlive = runningTeamItems.some((ti) => {
      const subLeaf = ti.ticket.slice('team:'.length);
      const subEntry = doc.entries.find((e) => e.role === 'steward' && e.team === subLeaf);
      return subEntry && livenessVerdict(horde, doc, subEntry, cfg) === 'alive';
    });
    if (anySubAlive) return 'alive';
  }

  const branch = teamBranchName(horde, entry.team);
  const commitAt = git(['log', '-1', '--format=%cI', branch], repoRoot());
  const queueMtime = existsSync(queuePath) ? statSync(queuePath).mtime.toISOString() : null;

  const newest = Math.max(isoOrEpoch(commitAt), isoOrEpoch(queueMtime), isoOrEpoch(entry.lastTrace));
  const threshold = livenessThresholdMinutes(cfg, 'steward');
  const minutes = (Date.now() - newest) / 60000;
  return minutes > threshold ? 'dead' : 'alive';
}

// An owner is dead when the most recent review-request on a ticket naming its node has gone
// unanswered (no review by this owner, on that node, after it) for longer than ownerMinutes —
// with no ticket like that at all, the owner is alive. lastTrace is the third signal: a fresh
// trace rescues an otherwise-stale open request the same way it would for a steward.
function ownerLivenessVerdict(horde, entry, cfg) {
  const logs = logsForNode(horde, entry.node);
  let oldestOpenAt = null;
  for (const logText of logs) {
    const events = parseReviewEvents(logText);
    const lastRequest = [...events].reverse().find((e) => e.type === 'request');
    if (!lastRequest) continue;
    const answered = events.some((e) => e.type === 'review' && e.node === entry.node && e.by === entry.name && e.at > lastRequest.at);
    if (!answered && (oldestOpenAt === null || lastRequest.at < oldestOpenAt)) oldestOpenAt = lastRequest.at;
  }
  if (oldestOpenAt === null) return 'alive';

  const newest = Math.max(isoOrEpoch(oldestOpenAt), isoOrEpoch(entry.lastTrace));
  const threshold = livenessThresholdMinutes(cfg, 'owner');
  const minutes = (Date.now() - newest) / 60000;
  return minutes > threshold ? 'dead' : 'alive';
}

// The architect is mission-scoped, with no branch or queue of its own — its "open work" is
// whatever it has left un-ruled in the graph: an open proposal (node.mjs propose) or a pending
// contract (node.mjs contract propose), both in hordes/<horde>/graph.json. With nothing open, an
// architect is always alive (nothing to be silent about); with something open, the same
// oldest-open-plus-lastTrace-rescue shape as an owner's review window, against the same
// ownerMinutes|Seconds threshold — an architect ruling on the graph is not a different kind of
// waiting from an owner reviewing a ticket.
function architectLivenessVerdict(horde, entry, cfg) {
  const graph = readJSON(hordePath(horde, 'graph.json'), { proposals: [], contracts: [] });
  const proposals = Array.isArray(graph.proposals) ? graph.proposals : [];
  const contracts = Array.isArray(graph.contracts) ? graph.contracts : [];
  const openTimes = [
    ...proposals.filter((p) => p.status === 'open').map((p) => p.at),
    ...contracts.filter((c) => c.status === 'proposed').map((c) => c.at),
  ].filter(Boolean);
  if (openTimes.length === 0) return 'alive';
  const oldestOpenAt = [...openTimes].sort()[0];

  const newest = Math.max(isoOrEpoch(oldestOpenAt), isoOrEpoch(entry.lastTrace));
  const threshold = livenessThresholdMinutes(cfg, 'owner');
  const minutes = (Date.now() - newest) / 60000;
  return minutes > threshold ? 'dead' : 'alive';
}

function livenessVerdict(horde, doc, entry, cfg) {
  if (entry.lease !== 'active') return entry.lease;
  if (entry.role === 'steward' && entry.team) return stewardLivenessVerdict(horde, doc, entry, cfg);
  if (entry.role === 'owner' && entry.node) return ownerLivenessVerdict(horde, entry, cfg);
  if (entry.role === 'architect') return architectLivenessVerdict(horde, entry, cfg);
  // Auditor and counsel are one-shot — spawned for a single wave audit or a single question, with
  // no ongoing branch, queue or graph window to judge silence against — the roster never marks
  // them dead.
  if (entry.role === 'auditor' || entry.role === 'counsel') return 'alive';
  // Every remaining shape (worker, verifier, or a steward/owner spawned with neither --team nor
  // --node) has no branch, queue or review window of its own to read — lastTrace is the only
  // signal there is.
  if (!entry.lastTrace) return 'no-trace';
  const minutes = (Date.now() - new Date(entry.lastTrace).getTime()) / 60000;
  const threshold = livenessThresholdMinutes(cfg, 'steward');
  return minutes > threshold ? 'dead' : 'alive';
}

// Whether any architect entry on the roster currently reads alive — tk.mjs's review command
// needs to know whether the architect seat is actually staffed, not just declared through a
// trust-based --by value nobody checks against the roster.
export function architectIsLive(horde) {
  const cfg = readConfig();
  const doc = load(horde);
  return doc.entries.some((e) => e.role === 'architect' && livenessVerdict(horde, doc, e, cfg) === 'alive');
}

function cmdList(horde, positional, flags) {
  const cfg = readConfig();
  const doc = load(horde);
  let rows = doc.entries.map((e) => ({ ...e, verdict: livenessVerdict(horde, doc, e, cfg) }));
  if (flags.dead) rows = rows.filter((r) => r.verdict !== 'alive');
  emit(rows, flags, () => (rows.length
    ? rows.map((r) => `${r.name}  ${r.role}  ${r.team || r.node || 'mission'}  ${r.class}  ${r.verdict}`).join('\n')
    : '(no roster entries)'));
}

function cmdReclaim(horde, positional, flags) {
  const [name, why] = positional;
  if (!name) fail('reclaim requires <name>');
  const doc = load(horde);
  const entry = doc.entries.find((e) => e.name === name);
  if (!entry) fail(`no such roster entry: ${name}`);
  // A mission-scoped entry (architect, or anything spawned with neither --team nor --node) has
  // no steward or parent above it to reclaim it as a matter of course — only the director does,
  // and says so explicitly, rather than any tool inferring it from who happens to be calling.
  if (!entry.team && !entry.node && flags.by !== 'director') {
    fail(`reclaiming a mission-scope entry (${entry.role}) requires --by director`);
  }
  if (flags.lesson && !why) fail('reclaim --lesson requires "<why>"');
  entry.lease = 'reclaimed';
  entry.reclaimedAt = nowIso();
  if (why) entry.reclaimedWhy = why;
  save(horde, doc);
  if (flags.lesson) {
    try {
      appendDecision(horde, { slug: `lesson-${name}`, ruling: why });
    } catch (e) {
      fail(`reclaimed, but recording the lesson failed: ${e.message}`);
    }
  }
  emit(entry, flags, () => `${name} reclaimed`);
}

function cmdStandDown(horde, positional, flags) {
  const name = positional[0];
  if (!name) fail('stand-down requires <name>');
  const doc = load(horde);
  const entry = doc.entries.find((e) => e.name === name);
  if (!entry) fail(`no such roster entry: ${name}`);
  entry.lease = 'retired';
  entry.retiredAt = nowIso();
  save(horde, doc);
  emit(entry, flags, () => `${name} retired`);
}

// True when `team` (a steward's own, or any other role's --team scope) sits inside the subtree
// rooted at `root` — root itself, or reachable from it by walking parent links downward from
// `team`'s own ancestry upward to root. Entries with no team at all (an owner, scoped by node;
// a mission-scoped architect/auditor/counsel) are never in any team's subtree.
function isInTeamSubtree(doc, team, root) {
  let cur = team;
  while (cur) {
    if (cur === root) return true;
    if (cur === 'trunk') return false;
    const parentEntry = doc.entries.find((e) => e.role === 'steward' && e.team === cur);
    cur = parentEntry ? parentEntry.parent : null;
  }
  return false;
}

function cmdReconcile(horde, positional, flags) {
  const doc = load(horde);
  let n = 0;
  for (const e of doc.entries) {
    if (e.lease !== 'active') continue;
    if (flags['only-team'] && (!e.team || !isInTeamSubtree(doc, e.team, flags['only-team']))) continue;
    e.lease = 'dead';
    e.deadAt = nowIso();
    n += 1;
  }
  save(horde, doc);
  emit({ marked: n }, flags, () => `${n} entries marked dead`);
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2), { flags: ['dead', 'lesson'] });
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'spawn': return cmdSpawn(horde, positional, flags);
    case 'trace': return cmdTrace(horde, positional, flags);
    case 'list': return cmdList(horde, positional, flags);
    case 'reclaim': return cmdReclaim(horde, positional, flags);
    case 'stand-down': return cmdStandDown(horde, positional, flags);
    case 'revive': return cmdRevive(horde, positional, flags);
    case 'reconcile': return cmdReconcile(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
