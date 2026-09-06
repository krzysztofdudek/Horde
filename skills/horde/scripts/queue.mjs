#!/usr/bin/env node
// horde skill — queue.mjs
//
// The DAG of work for one team: teams/<team>/queue.json. A real ticket item gets its own branch
// and worktree the moment it goes "running" (cut from the team branch's tip, so a worker never
// has to figure out where to start); "merged" is refused until the ticket carries both keys and
// an approval for every node it names, because the queue is the one place that gate is actually
// enforced before a branch disappears. An item named "team:<name>" stands for a sub-team's own
// branch instead of a ticket — roster.mjs creates that branch directly when the sub-team's
// steward is spawned, so queue.mjs skips all branch/worktree work for it.
//
// `plan` is the other half of this file and writes nothing: the order of the work is not typed in
// here, it is derived from what the owners declared on their own tickets — the ports each needs and
// delivers, the files each touches, the evidence each earns — plus whatever order somebody wrote by
// hand. The queue stays the state; the plan is a view of the tickets, recomputed every time.
//
// Exports renderQueueDoc so roster.mjs can write a freshly-created team's (and the parent
// team's updated) queue.json with the same rendered .md sibling this file produces itself.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  hordePath, teamPath, hordeRoot, repoRoot, readJSON, writeJSON, readText, readConfig, nowIso,
  fail, parseArgs, emit, isMain, resolveHorde, git,
} from './_lib.mjs';
import {
  findTicket, parseField, padId, parseKeys, hasAuthor, hasVerifier, allNodesApproved,
  allTickets, nodesOf, ticketFiles, ticketPorts, ticketEvidence,
} from './tk.mjs';
import { noteMerged, parseEvidenceRows } from './wave.mjs';
import { consumersOf, portExists, globToRegExp } from './node.mjs';

const STATES = ['queued', 'waiting', 'running', 'landed', 'merged', 'escalated', 'dropped'];
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

const USAGE = `usage: queue.mjs <command> [options]

commands:
  list [--state s] [--team t] [--horde h]
  add <ticket> [--depends dep,…] [--team t] [--horde h]
      each dep is NNN (same team), <team>:NNN (a ticket in another team), or
      <team>:team:<name> (that team's own merge-up item) — e.g. "trunk:team:allies".
  set <ticket|team:name> <${STATES.join('|')}> [--sha x] [--agent name] [--note "…"]
      [--team t] [--horde h]
      "running" on a real ticket creates the branch "<horde>/t-NNN" off the team's tip and a
      worktree at "<hordeRoot>/worktrees/<horde>/t-NNN" (per horde, so two hordes never collide
      on a ticket number), and prints the path. "merged" removes the worktree first, then deletes
      the branch — refused unless the ticket's Keys line has the author key, the verifier key (a
      "reproduced" verdict), and an approval for every node it names. "waiting" (the class this
      item needs is overloaded — no agent of that class can be spawned right now) just changes
      the state, keeping class, branch and worktree exactly as they were; "next" never offers a
      waiting item, and "reconcile" leaves it alone. "set <ticket> queued" brings it back.
      Items named "team:<name>" skip all of the running/merged branch and worktree work — the
      sub-team's branch already exists. "merged" also appends the merge's bullet to the team's
      wave journal, so the evidence catalogue sees it without a second command.
  dep <ticket> --on <dep> [--team t] [--horde h]
      adds a dependency to an existing item — --on takes the same NNN / <team>:NNN /
      <team>:team:<name> forms as add's --depends. A "running" item that gains one goes back to
      "queued" (its worktree kept) until the dependency merges. Refuses a same-team cycle and an
      unknown dependency (cross-team dependencies are not cycle-checked — a merge-up DAG only
      ever points up or sideways, never back down).
  next [--class c] [--team t] [--horde h]
      the first queued item whose every dependency is merged, high severity first (read live
      from the ticket) then FIFO by queue order. A cross-team dependency is checked against the
      other team's own queue.json, read fresh each time. A "waiting" item is never a candidate.
  plan [--team t] [--apply-order] [--horde h]
      derives the team's DAG from the tickets themselves and prints it; dispatches nothing.
      Edges come from the ports the tickets declare (a ticket consuming <node>/<port>@<v> comes
      after the one producing it), from the graph (a version bump comes before every ticket of a
      node that consumes that port and still names the old version), and from the dependencies
      written by hand — the three added together, never one overriding another. Prints the
      layers, the critical path, the components, the tickets that claim the same file with no
      order between them, the files three or more tickets claim, the approvals a version bump
      owes the nodes that consume it, ports nothing produces, the charter's evidence rows no
      ticket names, and what the whole thing costs in runs. Refuses, naming the circle, when the
      tickets depend on each other in one. --apply-order records the order it proposes for a
      file clash as an ordinary dependency, with a note.
  rm <ticket> [--team t] [--horde h]
  move <ticket> --team t [--horde h]
      relocates the item to team t's queue (the source team is found by searching).
  render [--team t] [--horde h]
  reconcile [--team t] [--horde h]
      every "running" item: a commit beyond the team tip -> "landed"; a dirty worktree -> commits
      it as "wip: reclaimed" on the ticket branch and goes to "queued" (worktree kept, noted);
      a clean worktree with no commit -> "queued", worktree removed. A "waiting" item is left
      untouched — it has nothing running to reconcile.

options: --json  --help`;

function queuePath(horde, team) { return teamPath(horde, team, 'queue.json'); }

export function renderQueueDoc(doc) {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const lines = ['# Queue', ''];
  for (const state of STATES) {
    const group = items.filter((i) => i.state === state);
    lines.push(`## ${state} (${group.length})`, '');
    if (group.length === 0) { lines.push('(none)', ''); continue; }
    for (const it of group) {
      const parts = [it.ticket, it.class || '-', it.branch || '-', it.agent || '-', it.sha || '-'];
      lines.push(`- ${parts.join('  ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function load(horde, team) {
  const doc = readJSON(queuePath(horde, team), null);
  return doc && Array.isArray(doc.items) ? doc : { items: [] };
}

function save(horde, team, doc) {
  writeJSON(queuePath(horde, team), doc, { render: renderQueueDoc });
}

function isTeamItem(key) { return String(key).startsWith('team:'); }

function normalizeKey(raw) {
  if (isTeamItem(raw)) return raw;
  try { return padId(raw); } catch (e) { fail(e.message); return undefined; }
}

function teamBranchName(horde, team) {
  return team === 'trunk' ? `${horde}/trunk` : `${horde}/${String(team).split('/').pop()}`;
}

// Every team's queue, as {team, doc} — used by move and next-across-team lookups. Mirrors
// tk.mjs's own team walk (kept private here rather than shared, per the no-cross-file-coupling
// instruction beyond the tk.mjs helpers this file already imports for ticket/keys reads).
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

function cmdList(horde, positional, flags) {
  const team = flags.team || 'trunk';
  let items = load(horde, team).items;
  if (flags.state) items = items.filter((i) => i.state === flags.state);
  emit(items, flags, () => (items.length ? items.map((i) => `${i.ticket} ${i.state} ${i.class} ${i.branch || '-'}`).join('\n') : '(empty)'));
}

// A dependency string is "NNN" (same team as `defaultTeam`), "<team>:NNN" (a ticket in another
// team), or "<team>:team:<name>" (that team's own merge-up item, e.g. "trunk:team:allies") — the
// same forms next.mjs's "team:<name>" items already use, just addressed from outside their own
// team. Resolves and validates against the target team's queue.json (loaded fresh — teamPath()
// itself refuses an unknown team), returning the canonical string to store: same-team collapses
// to the bare ticket, cross-team keeps the "<team>:" prefix so it round-trips unambiguously.
function resolveDepRef(horde, raw, defaultTeam) {
  const str = String(raw).trim();
  const firstColon = str.indexOf(':');
  let team;
  let ticket;
  if (firstColon === -1) {
    team = defaultTeam;
    try { ticket = padId(str); } catch (e) { fail(e.message); }
  } else {
    team = str.slice(0, firstColon);
    const rest = str.slice(firstColon + 1);
    if (!team || !rest) fail(`invalid dependency: "${raw}"`);
    if (rest.startsWith('team:')) {
      if (rest.length <= 'team:'.length) fail(`invalid dependency: "${raw}"`);
      ticket = rest;
    } else {
      try { ticket = padId(rest); } catch (e) { fail(e.message); }
    }
  }
  const doc = load(horde, team);
  const item = doc.items.find((i) => i.ticket === ticket);
  const canonical = team === defaultTeam ? ticket : `${team}:${ticket}`;
  return {
    team, ticket, canonical, item,
  };
}

function cmdAdd(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('add requires <ticket>');
  const team = flags.team || 'trunk';
  const ticket = findTicket(horde, idRaw);
  if (!ticket) fail(`no such ticket: ${idRaw}`);
  const doc = load(horde, team);
  if (doc.items.some((i) => i.ticket === ticket.id)) fail(`ticket ${ticket.id} is already queued in team ${team}`);
  let dependsOn = [];
  if (flags.depends) {
    const raws = String(flags.depends).split(',').map((s) => s.trim()).filter(Boolean);
    for (const raw of raws) {
      const ref = resolveDepRef(horde, raw, team);
      if (!ref.item) fail(`no such dependency: "${raw}" (team ${ref.team})`);
      dependsOn.push(ref.canonical);
    }
  }
  const item = {
    ticket: ticket.id,
    state: 'queued',
    class: parseField(ticket.text, 'Class') || 'sonnet',
    branch: null,
    worktree: null,
    dependsOn,
    agent: null,
    sha: null,
    notes: [],
  };
  doc.items.push(item);
  save(horde, team, doc);
  emit(item, flags, () => `queued: ${item.ticket}`);
}

function findItem(horde, team, key) {
  const doc = load(horde, team);
  return { doc, item: doc.items.find((i) => i.ticket === key) };
}

function cmdSet(horde, positional, flags) {
  const [rawKey, state] = positional;
  if (!rawKey || !state) fail('set requires <ticket|team:name> <state>');
  if (!STATES.includes(state)) fail(`unknown state: ${state} (allowed: ${STATES.join(', ')})`);
  const team = flags.team || 'trunk';
  const key = normalizeKey(rawKey);
  const { doc, item } = findItem(horde, team, key);
  if (!item) fail(`no queue item: ${key}`);

  if (state === 'running' && !isTeamItem(key)) {
    const teamBranch = teamBranchName(horde, team);
    const root = repoRoot();
    let branchName = item.branch;
    if (!branchName) {
      branchName = `${horde}/t-${key}`;
      if (git(['rev-parse', '--verify', branchName], root) !== null) fail(`branch already exists: ${branchName}`);
      const created = git(['branch', branchName, teamBranch], root);
      if (created === null) fail(`could not create branch ${branchName} off ${teamBranch}`);
    }
    const worktreePath = join(hordeRoot(), 'worktrees', horde, `t-${key}`);
    if (!existsSync(worktreePath)) {
      const added = git(['worktree', 'add', worktreePath, branchName], root);
      if (added === null) fail(`could not create worktree at ${worktreePath} for ${branchName}`);
    }
    item.branch = branchName;
    item.worktree = worktreePath;
  }

  if (state === 'merged') {
    if (!isTeamItem(key)) {
      const ticket = findTicket(horde, key);
      if (!ticket) fail(`ticket ${key} not found — cannot check its keys`);
      if (!hasAuthor(ticket.text)) fail(`ticket ${key} has no author key set`);
      if (!hasVerifier(ticket.text)) fail(`ticket ${key} has no verifier key (a "reproduced" verdict) set`);
      if (!allNodesApproved(ticket.text)) fail(`ticket ${key} is missing an approval for one or more of its nodes`);
      if (!flags.sha) fail('set merged requires --sha');
      if (item.worktree) git(['worktree', 'remove', '--force', item.worktree], repoRoot());
      if (item.branch) git(['branch', '-D', item.branch], repoRoot());
      item.worktree = null;
    }
    if (flags.sha) item.sha = flags.sha;
  }

  item.state = state;
  if (flags.agent) item.agent = flags.agent;
  if (flags.sha && state !== 'merged') item.sha = flags.sha;
  if (flags.note) item.notes.push({ at: nowIso(), text: flags.note });
  save(horde, team, doc);

  // A merge is one event, so it costs one write. The queue is where the state lives; the journal
  // is where the wave close reads from when it works out which evidence rows this wave turned
  // green. Writing only the first left the catalogue at 0 until somebody remembered a second,
  // independent command — so the state change writes the journal bullet itself.
  let journal = null;
  if (state === 'merged' && flags.sha) journal = noteMerged(horde, team, key, String(flags.sha));

  emit(
    { ...item, journal },
    flags,
    () => `${item.ticket} -> ${item.state}${item.worktree ? ` worktree=${item.worktree}` : ''}`
      + (journal && journal.appended ? ` · journal: ${journal.bullet}` : ''),
  );
}

// True when `from` already (transitively) depends on `target` — adding target as a dependency
// of from's dependent would close a cycle back on itself. Only meaningful within one team's own
// doc: a cross-team reference (one with a ":") is a leaf here, not traversed further — a
// merge-up DAG only ever points up or sideways, never back down into a team that depends on it.
function dependsTransitively(doc, from, target, seen = new Set()) {
  if (from === target) return true;
  if (from.includes(':') || seen.has(from)) return false;
  seen.add(from);
  const item = doc.items.find((i) => i.ticket === from);
  if (!item) return false;
  return (item.dependsOn || []).some((d) => dependsTransitively(doc, d, target, seen));
}

function cmdDep(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('dep requires <ticket>');
  if (!flags.on) fail('dep requires --on <dep>');
  const team = flags.team || 'trunk';
  const key = normalizeKey(idRaw);
  const { doc, item } = findItem(horde, team, key);
  if (!item) fail(`no queue item: ${key}`);

  const ref = resolveDepRef(horde, flags.on, team);
  if (!ref.item) fail(`no such dependency: "${flags.on}" (team ${ref.team})`);
  if (ref.canonical === key) fail(`cannot depend on itself: ${key}`);
  if (dependsTransitively(doc, ref.canonical, key)) fail(`adding this dependency would create a cycle: ${ref.canonical} already depends on ${key}`);

  if (!item.dependsOn.includes(ref.canonical)) item.dependsOn.push(ref.canonical);
  if (item.state === 'running' && ref.item.state !== 'merged') {
    item.state = 'queued';
    item.notes.push({ at: nowIso(), text: `dep: gained dependency on ${ref.canonical} — back to queued until it merges` });
  }
  save(horde, team, doc);
  emit(item, flags, () => `${item.ticket} now depends on ${ref.canonical}`);
}

function severityOf(horde, item) {
  if (isTeamItem(item.ticket)) return 'medium';
  const ticket = findTicket(horde, item.ticket);
  return (ticket && parseField(ticket.text, 'Severity')) || 'medium';
}

// A same-team dependency is checked against `doc` directly; a cross-team one ("<team>:<ticket>")
// is checked against that team's own queue.json, read fresh — never cached, since another
// team's steward can merge at any time and this has to see it the moment it happens.
function dependencySatisfied(horde, doc, defaultTeam, dep) {
  const firstColon = dep.indexOf(':');
  if (firstColon === -1) {
    const item = doc.items.find((i) => i.ticket === dep);
    return !!item && item.state === 'merged';
  }
  const team = dep.slice(0, firstColon);
  const ticket = dep.slice(firstColon + 1);
  const otherDoc = load(horde, team);
  const item = otherDoc.items.find((i) => i.ticket === ticket);
  return !!item && item.state === 'merged';
}

function cmdNext(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const doc = load(horde, team);
  const candidates = doc.items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.state === 'queued')
    .filter(({ item }) => (item.dependsOn || []).every((d) => dependencySatisfied(horde, doc, team, d)))
    .filter(({ item }) => !flags.class || item.class === flags.class);
  candidates.sort((a, b) => {
    const ra = SEVERITY_RANK[severityOf(horde, a.item)] ?? 1;
    const rb = SEVERITY_RANK[severityOf(horde, b.item)] ?? 1;
    return ra !== rb ? ra - rb : a.idx - b.idx;
  });
  const chosen = candidates.length ? candidates[0].item : null;
  emit(chosen, flags, () => (chosen ? `${chosen.ticket} (${chosen.class})` : '(none ready)'));
}

// ---- plan: the DAG derived, not typed in --------------------------------------------
//
// Nothing here dispatches or changes state (except `--apply-order`, which writes exactly the
// dependencies it printed). Everything is read off what the owners already declared on their
// tickets — the files they touch, the ports they need and deliver, the evidence rows they earn —
// so the plan is a view of the tickets, and the tickets stay the source of truth.

// Two declared file lists collide when any path in one is the other's path, or matches it as a
// glob ("src/auth/policy*.ts" and "src/auth/policy.ts" are the same file being claimed twice).
function filesOverlap(a, b) {
  return a.some((fa) => b.some((fb) => fa === fb
    || (fa.includes('*') && globToRegExp(fa).test(fb))
    || (fb.includes('*') && globToRegExp(fb).test(fa))));
}

function titleOf(text) {
  return (/^#\s*\S+\s*·\s*(.*)$/.exec((text.split('\n')[0] || '').trim()) || [])[1] || '';
}

// The manual edges: what the ticket's own "**Depends on:**" field says, plus what its queue item
// carries — union, never one overriding the other (a steward's `--depends` and an owner's field
// are two people saying the same kind of thing, and dropping either loses an order somebody
// meant).
function manualDeps(ticketText, item) {
  const field = parseField(ticketText, 'Depends on');
  const fromField = field && field !== 'none' ? field.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const fromQueue = item && Array.isArray(item.dependsOn) ? item.dependsOn : [];
  const out = [];
  for (const d of [...fromField, ...fromQueue]) {
    const canonical = d.includes(':') ? d : (() => { try { return padId(d); } catch { return null; } })();
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function buildPlan(horde, team, cfg) {
  const root = repoRoot();
  const queue = load(horde, team);
  const items = new Map(queue.items.map((i) => [i.ticket, i]));
  // A ticket records its team as the path it sits at on disk ("trunk/alfa"); every address a
  // caller uses is the short leaf name ("alfa"), so both sides are compared as leaves.
  const leafOf = (t) => String(t).split('/').pop();
  const everyTicket = allTickets(horde).map((t) => ({ ...t, team: leafOf(t.team) }));
  const planned = everyTicket.filter((t) => t.team === leafOf(team) && t.status !== 'merged');
  const inSet = new Set(planned.map((t) => t.id));

  const tickets = planned.map((t) => {
    const item = items.get(t.id);
    const nodes = nodesOf(t.text);
    const produces = ticketPorts(t.text, 'Produces');
    const consumerNodes = [...new Set(produces.flatMap((p) => consumersOf(root, cfg, p.node, p.port)))]
      .filter((n) => !nodes.includes(n)).sort();
    return {
      id: t.id,
      title: titleOf(t.text),
      nodes,
      class: parseField(t.text, 'Class') || 'sonnet',
      severity: parseField(t.text, 'Severity') || 'medium',
      state: item ? item.state : t.status,
      files: ticketFiles(t.text),
      consumes: ticketPorts(t.text, 'Consumes').map((c) => c.ref),
      produces: produces.map((p) => p.ref),
      evidence: ticketEvidence(t.text),
      approvals: [...nodes, ...consumerNodes],
      dependsOn: [],
      waitsOnOutside: [],
    };
  });
  const byId = new Map(tickets.map((t) => [t.id, t]));

  const edges = [];
  const addEdge = (from, on, why) => {
    const target = byId.get(from);
    if (!target) return;
    if (from === on) return;
    if (edges.some((e) => e.from === from && e.on === on && e.why === why)) return;
    edges.push({ from, on, why });
    if (inSet.has(on)) {
      if (!target.dependsOn.includes(on)) target.dependsOn.push(on);
    } else if (!target.waitsOnOutside.includes(on)) {
      target.waitsOnOutside.push(on);
    }
  };

  // (a) a consumed port depends on the ticket that produces that exact version — in this team or
  // another one; a cross-team producer is an edge all the same, it just falls outside the layers.
  const consumesWithoutProducer = [];
  for (const t of planned) {
    for (const c of ticketPorts(t.text, 'Consumes')) {
      const producers = everyTicket.filter((o) => o.id !== t.id
        && ticketPorts(o.text, 'Produces').some((p) => p.node === c.node && p.port === c.port && p.version === c.version));
      for (const p of producers) addEdge(t.id, p.team === leafOf(team) ? p.id : `${p.team}:${p.id}`, `consumes ${c.ref}`);
      if (producers.length === 0) {
        const anyProducer = everyTicket.some((o) => o.id !== t.id
          && ticketPorts(o.text, 'Produces').some((p) => p.node === c.node && p.port === c.port));
        if (!anyProducer && !portExists(root, cfg, c.node, c.port)) {
          consumesWithoutProducer.push({ ticket: t.id, port: c.ref });
        }
      }
    }
  }

  // (b) the graph's own edge: a ticket that raises a port's version comes before every ticket of
  // a node that consumes that port and still names the version being replaced.
  for (const producer of planned) {
    for (const p of ticketPorts(producer.text, 'Produces')) {
      const consumerNodes = consumersOf(root, cfg, p.node, p.port);
      if (consumerNodes.length === 0) continue;
      for (const t of planned) {
        if (t.id === producer.id) continue;
        if (!nodesOf(t.text).some((n) => consumerNodes.includes(n))) continue;
        const old = ticketPorts(t.text, 'Consumes')
          .find((c) => c.node === p.node && c.port === p.port && c.version < p.version);
        if (old) addEdge(t.id, producer.id, `${producer.id} raises ${p.node}/${p.port} to @${p.version}, this ticket consumes @${old.version}`);
      }
    }
  }

  // (c) what a steward or an owner wrote by hand, added to the derived edges, never replacing them.
  for (const t of planned) {
    for (const d of manualDeps(t.text, items.get(t.id))) addEdge(t.id, d, 'declared dependency');
  }

  // layers, cycles, critical path
  const layers = [];
  const layerOf = new Map();
  let remaining = tickets.map((t) => t.id);
  while (remaining.length) {
    const ready = remaining.filter((id) => byId.get(id).dependsOn.every((d) => layerOf.has(d)));
    if (ready.length === 0) break;
    layers.push(ready.slice().sort());
    for (const id of ready) layerOf.set(id, layers.length - 1);
    remaining = remaining.filter((id) => !layerOf.has(id));
  }
  const cycles = remaining.length ? [findCycle(byId, remaining)] : [];

  const weightOf = (cls) => ((cfg.classes && cfg.classes[cls]) || 1);
  const longest = new Map();
  const cameFrom = new Map();
  for (const layer of layers) {
    for (const id of layer) {
      const t = byId.get(id);
      let best = null;
      for (const d of t.dependsOn) {
        if (!longest.has(d)) continue;
        if (best === null || longest.get(d) > longest.get(best)) best = d;
      }
      longest.set(id, (best === null ? 0 : longest.get(best)) + 1);
      cameFrom.set(id, best);
    }
  }
  let endpoint = null;
  for (const [id, len] of longest) if (endpoint === null || len > longest.get(endpoint)) endpoint = id;
  const criticalPath = [];
  for (let cur = endpoint; cur !== null && cur !== undefined; cur = cameFrom.get(cur)) criticalPath.unshift(cur);
  const criticalWeight = criticalPath.reduce((sum, id) => sum + weightOf(byId.get(id).class), 0);

  // components of the undirected graph, and the tickets that hang loose on their own
  const groups = components(tickets, byId);
  const loose = groups.filter((g) => g.length === 1).flat();
  const realComponents = groups.filter((g) => g.length > 1);

  // file locks: two tickets with no order between them, claiming the same file
  const reach = reachability(tickets, byId);
  const lockConflicts = [];
  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      const a = tickets[i];
      const b = tickets[j];
      if (!a.files.length || !b.files.length) continue;
      if (reach.get(a.id).has(b.id) || reach.get(b.id).has(a.id)) continue;
      if (!filesOverlap(a.files, b.files)) continue;
      const shared = a.files.filter((f) => filesOverlap([f], b.files));
      const first = a.files.length === b.files.length
        ? (a.id <= b.id ? a : b)
        : (a.files.length < b.files.length ? a : b);
      const second = first === a ? b : a;
      lockConflicts.push({
        tickets: [a.id, b.id], files: shared, order: [first.id, second.id],
      });
    }
  }

  const fileCounts = new Map();
  for (const t of tickets) for (const f of new Set(t.files)) fileCounts.set(f, [...(fileCounts.get(f) || []), t.id]);
  const hubFiles = [...fileCounts.entries()]
    .filter(([, ids]) => ids.length >= 3)
    .map(([file, ids]) => ({ file, tickets: ids }))
    .sort((a, b) => b.tickets.length - a.tickets.length || a.file.localeCompare(b.file));

  const charter = readText(hordePath(horde, 'charter.md')) || '';
  const claimed = new Set(everyTicket.flatMap((t) => ticketEvidence(t.text)));
  const uncoveredEvidence = parseEvidenceRows(charter)
    .filter((r) => r.id && !claimed.has(r.id))
    .map((r) => ({ id: r.id, evidence: r.evidence }));

  const cost = tickets.reduce((sum, t) => sum + weightOf(t.class) * 2, 0);
  const parallelism = cfg.parallelism || 6;
  const waves = layers.reduce((sum, l) => sum + Math.ceil(l.length / parallelism), 0);

  return {
    schema: 'horde-plan/1',
    horde,
    team,
    at: nowIso(),
    tickets,
    edges,
    layers,
    criticalPath: { tickets: criticalPath, length: criticalPath.length, weight: criticalWeight },
    components: realComponents,
    loose,
    lockConflicts,
    hubFiles,
    consumesWithoutProducer,
    cycles,
    uncoveredEvidence,
    cost: { estimate: cost, runsPerTicket: 2 },
    waves: { estimated: waves, parallelism },
  };
}

function findCycle(byId, remaining) {
  const stack = [];
  const onStack = new Set();
  const seen = new Set();
  const walk = (id) => {
    if (onStack.has(id)) return stack.slice(stack.indexOf(id)).concat(id);
    if (seen.has(id)) return null;
    seen.add(id);
    onStack.add(id);
    stack.push(id);
    for (const d of byId.get(id) ? byId.get(id).dependsOn : []) {
      const found = walk(d);
      if (found) return found;
    }
    stack.pop();
    onStack.delete(id);
    return null;
  };
  for (const id of remaining) {
    const found = walk(id);
    if (found) return found;
  }
  return remaining.slice();
}

function components(tickets, byId) {
  const seen = new Set();
  const neighbours = new Map(tickets.map((t) => [t.id, new Set(t.dependsOn)]));
  for (const t of tickets) for (const d of t.dependsOn) if (neighbours.has(d)) neighbours.get(d).add(t.id);
  const out = [];
  for (const t of tickets) {
    if (seen.has(t.id)) continue;
    const group = [];
    const stack = [t.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(id);
      for (const n of neighbours.get(id) || []) if (!seen.has(n)) stack.push(n);
    }
    out.push(group.sort());
  }
  return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

// Every ticket each ticket transitively depends on — what "these two have no order between them"
// is decided against.
function reachability(tickets, byId) {
  const memo = new Map();
  const walk = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return new Set();
    seen.add(id);
    const out = new Set();
    for (const d of (byId.get(id) ? byId.get(id).dependsOn : [])) {
      out.add(d);
      for (const x of walk(d, seen)) out.add(x);
    }
    memo.set(id, out);
    return out;
  };
  for (const t of tickets) walk(t.id);
  return memo;
}

function renderPlan(plan) {
  const lines = [`plan · horde ${plan.horde} · team ${plan.team} · ${plan.tickets.length} open ticket(s)`, ''];
  if (plan.tickets.length === 0) return `${lines[0]}\n(nothing to plan)`;
  plan.layers.forEach((layer, i) => lines.push(`L${i}  ${layer.join(' ')}`));
  if (plan.layers.length) lines.push('');
  const cp = plan.criticalPath;
  lines.push(`critical path: ${cp.length} ticket(s), weight ${cp.weight} — ${cp.tickets.join(' → ') || '(none)'}`);
  lines.push(`components: ${plan.components.length}${plan.loose.length ? ` · loose: ${plan.loose.join(' ')}` : ''}`);
  lines.push(plan.lockConflicts.length
    ? `file locks: ${plan.lockConflicts.map((c) => `${c.tickets.join('/')} share ${c.files.join(', ')} — run ${c.order.join(' before ')}`).join(' · ')}`
    : 'file locks: none');
  lines.push(plan.hubFiles.length
    ? `hub files: ${plan.hubFiles.map((h) => `${h.file} (${h.tickets.join(', ')})`).join(' · ')}`
    : 'hub files: none');
  const extra = plan.tickets.filter((t) => t.approvals.length > t.nodes.length);
  lines.push(extra.length
    ? `extra approvals: ${extra.map((t) => `${t.id} → ${t.approvals.filter((n) => !t.nodes.includes(n)).join(', ')}`).join(' · ')}`
    : 'extra approvals: none');
  lines.push(plan.consumesWithoutProducer.length
    ? `consumes without a producer: ${plan.consumesWithoutProducer.map((c) => `${c.ticket} needs ${c.port}`).join(' · ')}`
    : 'consumes without a producer: none');
  lines.push(plan.uncoveredEvidence.length
    ? `evidence nobody is building: ${plan.uncoveredEvidence.map((e) => e.id).join(', ')}`
    : 'evidence nobody is building: none');
  lines.push(`cost estimate: ${plan.cost.estimate} (class weight × 2 runs per ticket) · waves: ${plan.waves.estimated} at parallelism ${plan.waves.parallelism}`);
  return lines.join('\n');
}

function cmdPlan(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const cfg = readConfig() || {};
  const plan = buildPlan(horde, team, cfg);
  if (plan.cycles.length && plan.cycles[0].length) {
    fail(`the tickets depend on each other in a circle: ${plan.cycles[0].join(' → ')} — a plan cannot start any of them. Drop one of those dependencies (queue.mjs is not the place: the ticket that should not wait is edited with tk.mjs edit --consumes, or the manual --depends is removed) and run plan again`);
  }
  if (flags['apply-order']) {
    const applied = applyOrder(horde, team, plan);
    emit({ ...plan, applied }, flags, () => `${renderPlan(plan)}\n\napplied: ${applied.length ? applied.map((a) => `${a.ticket} now depends on ${a.on}`).join(' · ') : 'nothing to apply'}`);
    return;
  }
  emit(plan, flags, () => renderPlan(plan));
}

// The one thing plan writes, and only when asked: the order it just proposed for a file lock,
// recorded as an ordinary dependency with a note saying why it is there. Both tickets have to be
// in the queue for that — a proposal that isn't queued yet has nothing to hang the edge on, and
// the result says so rather than pretending it landed.
function applyOrder(horde, team, plan) {
  const doc = load(horde, team);
  const applied = [];
  for (const conflict of plan.lockConflicts) {
    const [first, second] = conflict.order;
    const item = doc.items.find((i) => i.ticket === second);
    const firstItem = doc.items.find((i) => i.ticket === first);
    if (!item || !firstItem) continue;
    if (item.dependsOn.includes(first)) continue;
    item.dependsOn.push(first);
    item.notes.push({ at: nowIso(), text: `plan: ordered after ${first} — both declare ${conflict.files.join(', ')}` });
    applied.push({ ticket: second, on: first, files: conflict.files });
  }
  if (applied.length) save(horde, team, doc);
  return applied;
}

function cmdRm(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('rm requires <ticket>');
  const team = flags.team || 'trunk';
  const key = normalizeKey(idRaw);
  const doc = load(horde, team);
  const before = doc.items.length;
  doc.items = doc.items.filter((i) => i.ticket !== key);
  if (doc.items.length === before) fail(`no queue item: ${key}`);
  save(horde, team, doc);
  emit({ ticket: key }, flags, () => `removed: ${key}`);
}

function cmdMove(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('move requires <ticket>');
  if (!flags.team) fail('move requires --team <t>');
  const key = normalizeKey(idRaw);
  let sourceTeam = null;
  let found = null;
  for (const team of allTeamPaths(horde)) {
    const doc = load(horde, team);
    const item = doc.items.find((i) => i.ticket === key);
    if (item) { sourceTeam = team; found = item; break; }
  }
  if (!found) fail(`no queue item: ${key}`);
  if (sourceTeam === flags.team) fail(`already in team ${flags.team}`);
  const srcDoc = load(horde, sourceTeam);
  srcDoc.items = srcDoc.items.filter((i) => i !== found);
  save(horde, sourceTeam, srcDoc);
  const destDoc = load(horde, flags.team);
  destDoc.items.push(found);
  save(horde, flags.team, destDoc);
  emit(found, flags, () => `${found.ticket} moved: ${sourceTeam} -> ${flags.team}`);
}

function cmdRender(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const doc = load(horde, team);
  save(horde, team, doc);
  emit({ team }, flags, () => queuePath(horde, team).replace(/\.json$/, '.md'));
}

function cmdReconcile(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const doc = load(horde, team);
  const teamBranch = teamBranchName(horde, team);
  const results = [];
  for (const item of doc.items) {
    if (item.state !== 'running' || isTeamItem(item.ticket) || !item.branch) continue;
    const countOut = git(['rev-list', '--count', `${teamBranch}..${item.branch}`], repoRoot());
    const count = countOut === null ? 0 : Number(countOut);
    if (count > 0) {
      item.state = 'landed';
      results.push({ ticket: item.ticket, state: item.state });
      continue;
    }
    const dirty = item.worktree && existsSync(item.worktree)
      ? git(['status', '--porcelain'], item.worktree)
      : null;
    if (dirty) {
      git(['add', '-A'], item.worktree);
      git(['commit', '-m', 'wip: reclaimed'], item.worktree);
      item.state = 'queued';
      item.notes.push({ at: nowIso(), text: 'reconcile: worktree was dirty — committed as "wip: reclaimed"' });
    } else {
      item.state = 'queued';
      if (item.worktree) {
        git(['worktree', 'remove', '--force', item.worktree], repoRoot());
        item.worktree = null;
      }
    }
    results.push({ ticket: item.ticket, state: item.state });
  }
  save(horde, team, doc);
  emit(results, flags, () => (results.length ? results.map((r) => `${r.ticket} -> ${r.state}`).join('\n') : '(nothing running)'));
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2), { flags: ['apply-order'] });
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'list': return cmdList(horde, positional, flags);
    case 'add': return cmdAdd(horde, positional, flags);
    case 'set': return cmdSet(horde, positional, flags);
    case 'dep': return cmdDep(horde, positional, flags);
    case 'next': return cmdNext(horde, positional, flags);
    case 'plan': return cmdPlan(horde, positional, flags);
    case 'rm': return cmdRm(horde, positional, flags);
    case 'move': return cmdMove(horde, positional, flags);
    case 'render': return cmdRender(horde, positional, flags);
    case 'reconcile': return cmdReconcile(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
