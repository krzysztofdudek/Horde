#!/usr/bin/env node
// horde skill — queue.mjs
//
// The DAG of work for one team: teams/<team>/queue.json. A real ticket item gets its own branch
// and worktree the moment it goes "running" (cut from the team branch's tip, so a worker never
// has to figure out where to start — or, with `--on`, from an unmerged dependency's tip, so a
// chain of tickets does not cost one wave per link); "merged" is refused while a dependency of
// the ticket is unmerged.
//
// `plan` is the other half of this file and writes nothing: the order of the work is not typed in
// here, it is derived from what the tickets themselves declare — the ports each needs and
// delivers, the files each touches, the evidence each earns — plus whatever order somebody wrote by
// hand. The queue stays the state; the plan is a view of the tickets, recomputed every time.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  hordePath, teamPath, hordeRoot, readJSON, writeJSON, readText, readConfig, nowIso, fail, parseArgs, emit, isMain, resolveHorde, git, parentBranchOf, qualityPolicy, asArray, writeText, readLeases,
  resolveTree, provisionTree, provenanceLine, withProvenance,
} from './_lib.mjs';
import {
  findTicket, parseField, padId, allTickets, nodesOf, ticketFiles, ticketPorts, ticketEvidence, ticketKind, createTicket, setTicketBody, acceptanceLines,
} from './tk.mjs';
import { noteMerged, parseEvidenceRows } from './wave.mjs';
import {
  consumersOf, portExists, globToRegExp, nodeExists, advisoryKey, readAdvisoryLedger,
  recordAdvisory,
} from './node.mjs';

// "proposed" is the state a ticket nobody has ruled on sits in: in the queue, listed and counted,
// and never a candidate for `next`. A consultant files its own tickets and adds them here itself;
// the architect's plan review (refine.mjs --step review) is the only way one becomes "queued".
// "blocked" is where a ticket stops: its fix rounds are spent, so another round would be a state
// pretending to be progress. Nothing here moves it — `next` never offers it and `reconcile` never
// touches it — until the client answers the "stuck" ask tick filed for it.
const STATES = ['proposed', 'queued', 'waiting', 'running', 'landed', 'blocked', 'merged', 'escalated', 'dropped'];
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

const USAGE = `usage: queue.mjs <command> [options]

commands:
  list [--state s] [--team t] [--horde h]
  add <ticket> [--depends dep,…] [--proposed] [--team t] [--horde h]
      each dep is NNN, a ticket number in this same team.
      --proposed files it as a proposal rather than as work: listed and counted in the queue,
      never offered by "next", until the architect's plan review passes it. That is how a
      consultant's own tickets enter — nothing it writes is dispatchable before somebody has
      looked at the whole plan.
  set <ticket> <${STATES.join('|')}> [--sha x] [--agent name] [--note "…"]
      [--on MMM] [--team t] [--horde h]
      "running --on MMM" starts the ticket from MMM's tip instead of the team's (a stack): MMM
      must be a dependency of this ticket, in this same team, running or landed, and on a
      branch. The item records "stackedOn"; everything measured against a parent — base
      freshness, the diff, the revert test — then names MMM's branch, until MMM merges and this
      item's "merged" write clears it back to the team branch.
      "running" creates the branch "<horde>/t-NNN" off the team's tip and a worktree at
      "<hordeRoot>/worktrees/<horde>/t-NNN" (per horde, so two hordes never collide on a ticket
      number), and prints the path. "merged" removes the worktree first, then deletes the branch
      — refused while a dependency of the ticket is still unmerged, and requires --sha. It also
      clears "stackedOn" on every ticket stacked on this one: their base is the team branch now.
      "waiting" (the class this item needs is overloaded — no agent of that class can be spawned
      right now) just changes the state, keeping class, branch and worktree exactly as they were;
      "next" never offers a waiting item, and "reconcile" leaves it alone. "set <ticket> queued"
      brings it back. "merged" also appends the merge's bullet to the team's wave journal, so the
      evidence catalogue sees it without a second command.
  dep <ticket> --on <dep> [--team t] [--horde h]
      adds a dependency to an existing item — --on takes the same NNN form as add's --depends. A
      "running" item that gains one goes back to "queued" (its worktree kept) until the
      dependency merges. Refuses a cycle and an unknown dependency.
  next [--class c] [--why] [--stack] [--team t] [--horde h]
      the first ready queued item — every dependency merged, and its declared Files (a ticket with
      none locks every file of every node it names) clear of every "running" ticket's own Files in
      this team. Ranked: quality-kind tickets (tk.mjs new --kind quality) always last, whatever
      their severity; then severity (read live from the ticket); then the longer remaining
      critical path through the ticket wins (queue.mjs plan's own DAG, read in-process, never
      shelled out); then a ticket whose nodes hold no running ticket; then FIFO by queue order.
      A "waiting" item is never a candidate. --why prints every queued item with its rank or
      the reason it did not qualify (an unmet dependency, a file lock naming the running ticket
      and the file, or the --class filter).
      --stack also offers, after every ready item and in the same rank order, a queued item whose
      unmerged dependencies are all in this team, running or landed, and on a branch: it can be
      started now from one of their tips ("set <ticket> running --on <that one>"). Such an item
      comes back marked stack-ready, naming the tickets it could start from. A file lock is a
      refusal there too — the tip it would start from is the very ticket holding the file.
  plan [--team t] [--apply-order] [--out <file>] [--horde h]
      --out writes the plan (rendered, or JSON with --json) to a file instead of stdout, for a reader
      who must see it whole — the architect — rather than a summary relayed through a message
      derives the team's DAG from the tickets themselves and prints it; dispatches nothing.
      Edges come from the ports the tickets declare (a ticket consuming <node>/<port> comes after
      the one producing it) and from the dependencies written by hand — the two added together,
      never one overriding another. Prints the layers, the critical path, the components, the
      tickets that claim the same file with no order between them, the files three or more
      tickets claim, the approvals a port change owes the nodes that consume it, ports nothing
      produces, the charter's evidence rows no ticket names, and what the whole thing costs in
      runs. Refuses, naming the circle, when the
      tickets depend on each other in one. --apply-order records the order it proposes for a
      file clash as an ordinary dependency, with a note.
  quality [--from <path>] [--class c] [--dry-run] [--team t] [--horde h]
      the quality pass (ruling quality-always-authorised): reads a grain-advice/1 document —
      the configured Grain CLI's own "advise --json", or --from a file — and files one
      low-priority "quality" ticket per improvement it names, attributed to the owner of the
      node it is about, queued straight away without an escalation. An advisory already turned
      into a ticket is not filed twice. Prints and files nothing when the charter's quality
      policy is only-the-work, or when no Grain CLI is configured. --dry-run reads and reports
      without filing anything.
  rm <ticket> [--team t] [--horde h]
  render [--team t] [--horde h]
  reconcile [--team t] [--horde h]
      every "running" item: a commit beyond its parent's tip (the team's branch, or the ticket it
      is stacked on) -> "landed"; a dirty worktree -> commits it as "wip: reclaimed" on the
      ticket branch and goes to "queued" (worktree kept, noted);
      a clean worktree with no commit -> "queued", worktree removed. A "waiting" item is left
      untouched — it has nothing running to reconcile.

plan and quality also take --tree <path>: read the graph there instead of the tip of trunk —
--horde alone (no --tree) means trunk for both, which is why "plan --horde h" reads what trunk
holds, never whatever the main checkout happens to have checked out. plan's own output ends with
"tree: <path> · branch: <branch> · <sha>"; --json carries the same three fields.

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
      lines.push(`- ${parts.join('  ')}${it.stackedOn ? `  stacked on ${it.stackedOn}` : ''}`);
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

// The same two reads and writes, named for the one caller outside this file: tick.mjs works the
// queue item by item and must do it against this document, not a second reading of its own.
export function loadQueue(horde, team) { return load(horde, team); }
export function saveQueue(horde, team, doc) { return save(horde, team, doc); }

function normalizeKey(raw) {
  try { return padId(raw); } catch (e) { fail(e.message); return undefined; }
}

function cmdList(horde, positional, flags) {
  const team = flags.team || 'trunk';
  let items = load(horde, team).items;
  if (flags.state) items = items.filter((i) => i.state === flags.state);
  emit(items, flags, () => (items.length ? items.map((i) => `${i.ticket} ${i.state} ${i.class} ${i.branch || '-'}`).join('\n') : '(empty)'));
}

// A dependency string is always a bare ticket number "NNN" in this same team — a team-prefixed
// form ("<team>:NNN", or "<team>:team:<name>" naming another team's own merge-up item) addressed
// a sub-team, and sub-teams no longer exist.
function resolveDepRef(horde, raw, defaultTeam) {
  const str = String(raw).trim();
  if (str.includes(':')) fail(`invalid dependency: "${raw}" — team-scoped dependencies no longer exist, only a ticket number in this same team`);
  let ticket;
  try { ticket = padId(str); } catch (e) { fail(e.message); }
  const doc = load(horde, defaultTeam);
  const item = doc.items.find((i) => i.ticket === ticket);
  return {
    team: defaultTeam, ticket, canonical: ticket, item,
  };
}

function cmdAdd(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('add requires <ticket>');
  const team = flags.team || 'trunk';
  const ticket = findTicket(horde, idRaw);
  if (!ticket) fail(`no such ticket: ${idRaw}`);
  if (acceptanceLines(ticket.text).length === 0) {
    fail(`ticket ${ticket.id} has no acceptance line — nothing a verifier could reproduce, so nothing could ever prove it done. Add at least one "- [ ] …" line under "## Acceptance" (tk.mjs new --evidence "<what a verifier reproduces>", or edit the issue), then add it to the queue.`);
  }
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
  const item = newQueueItem(ticket, dependsOn, flags.proposed ? 'proposed' : 'queued');
  doc.items.push(item);
  save(horde, team, doc);
  emit(item, flags, () => `${item.state}: ${item.ticket}`);
}

// The shape of a queued item, in one place, so a ticket the quality pass files enters the queue as
// the same object an owner's ticket does.
function newQueueItem(ticket, dependsOn = [], state = 'queued') {
  return {
    ticket: ticket.id,
    state,
    class: parseField(ticket.text, 'Class') || 'sonnet',
    branch: null,
    worktree: null,
    dependsOn,
    stackedOn: null,
    agent: null,
    sha: null,
    notes: [],
  };
}

// ---- the quality pass (ruling quality-always-authorised) --------------------------------------
//
// A repository tells you things about itself that nobody put on a ticket: two components that
// always change together with nothing in the architecture joining them, a component its own
// evidence says is two. Grain reads those out of the history as a `grain-advice/1` document, and
// under an autonomous quality policy the horde does not wait to be asked about them: each item
// becomes a low-priority ticket on the node it is about, attributed to that node's owner, queued
// without a ruling and worked in whatever parallelism is free after the mission's own tickets.
//
// Three things keep this from turning into noise. It never files the same advisory twice (what has
// been filed is remembered by what the item says, not by where it sat in a list that is recomputed
// every run). Every ticket it files is `--kind quality`, which `next` ranks after every work ticket
// whatever its severity. And nothing it files changes the architecture by itself — an advisory is
// evidence, so each ticket's acceptance is "the graph answered this, or the node's log says why it
// stands", which is a proposal to the architect either way.

const ADVICE_SCHEMA = 'grain-advice/1';

function grainCommandLine(cfg) {
  const raw = cfg && cfg.grainCommand;
  if (!raw) return null;
  const parts = String(raw).trim().split(/\s+/).filter(Boolean);
  return parts.length ? { cmd: parts[0], prefix: parts.slice(1), display: parts.join(' ') } : null;
}

// The document, from a file or from the CLI itself. Grain prints its progress on stderr and the
// document on stdout, so stdout is what is read; a run that answers something other than the
// document is a refusal naming what was seen, never a guess at what was meant.
function readAdvice(root, cfg, from) {
  if (from) {
    const text = readText(from);
    if (text === null) fail(`no such file: ${from}`);
    return { source: from, text };
  }
  const grain = grainCommandLine(cfg);
  if (!grain) return { source: null, text: null };
  try {
    const out = execFileSync(grain.cmd, [...grain.prefix, 'advise', '--json'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
    return { source: `${grain.display} advise --json`, text: out };
  } catch (e) {
    fail(
      `\`${grain.display} advise --json\` did not run (exit ${e.status === undefined ? '?' : e.status}).\n`
      + 'The quality pass reads what the repository says about itself from that command; without it there is '
      + 'nothing to file tickets from.\n'
      + `Check the command (horde.mjs config set grainCommand "…"), or pass a document you already have: queue.mjs quality --from <path>\n${((e.stderr && e.stderr.toString()) || e.message).trim()}`,
    );
    return { source: null, text: null };
  }
}

function parseAdvice(source, text, fromFile) {
  const body = String(text || '').trim();
  const start = body.indexOf('{');
  let doc = null;
  if (start !== -1) {
    try { doc = JSON.parse(body.slice(start)); } catch { doc = null; }
  }
  if (!doc || doc.schema !== ADVICE_SCHEMA) {
    const saw = doc && doc.schema ? ` (it is a "${doc.schema}" one)` : '';
    fail(
      (fromFile
        ? `\`${source}\` does not hold a ${ADVICE_SCHEMA} document${saw}.\n`
        : `\`${source}\` did not answer with a ${ADVICE_SCHEMA} document${saw}.\n`)
      + 'That document is the whole input to the quality pass — the horde reads what a repository says about '
      + 'itself from it and from nothing else.\n'
      + (fromFile
        ? 'Point --from at a document written by a Grain CLI new enough to answer it.'
        : 'Upgrade the Grain CLI, or point the horde at one that answers it: horde.mjs config set grainCommand "…"'),
    );
  }
  return doc;
}

const ADVICE_TITLE = {
  relation: (nodes) => `Coupling with nothing declared between ${nodes.join(' and ')}`,
  split: (nodes) => `A finer cut beats ${nodes[0]} on its own evidence`,
  port: (nodes) => `A promise between ${nodes.join(' and ')} with no port`,
  rule: (nodes) => `A rule the code already follows in ${nodes.join(', ')}`,
};

const ADVICE_ASK = {
  relation: 'Declare what joins these two, or record in the node\'s log why they move together without it.',
  split: 'Propose the cut to the architect, or record in the node\'s log why the boundary stands as it is.',
  port: 'Propose the port that carries this promise, or record why it stays informal.',
  rule: 'Propose the rule, or record why what the code does is not something to hold it to.',
};

// Where "why it stands" belongs once the advisory is answered — the node's own log for every kind
// but one: a "rule" advisory is proposing a rule, and a rule's reasoning belongs in its own log
// once it exists (152/153), the node earning a line only once the rung reaches enforced. The other
// three kinds (relation, split, port) are genuinely about the node itself, so its log stays right
// for them.
const ADVICE_LOG_HOME = {
  rule: 'the rule\'s own log, once it exists — or, if it does not, the node\'s',
};
function logHome(kind) { return ADVICE_LOG_HOME[kind] || 'the node\'s log'; }

function adviceTicketBody(item, source) {
  const kind = String(item.kind || 'item');
  const ask = ADVICE_ASK[kind] || 'Act on what the evidence below says, or record why it stands as it is.';
  const home = logHome(kind);
  return [
    '## What',
    '',
    ask,
    '',
    '## Why',
    '',
    String(item.text || '').trim(),
    '',
    `Read out of this repository's own history by \`${source}\`. Nobody was asked for it: improving the`,
    'architecture where the evidence allows is the horde\'s own call. It runs after every ticket the mission',
    'itself asked for, never instead of one.',
    '',
    '## Scope',
    '',
    `The graph objects this advisory names, and ${home}. No behaviour changes here — an advisory is evidence,`,
    'and what to do about it is the architect\'s to approve.',
    '',
    '## Acceptance — evidence',
    '',
    `- [ ] the advisory is answered: either the architecture changed and the change is filed, or ${home}`,
    '      carries one entry saying why it stands',
    '',
    '## Notes for the worker',
    '',
    'The evidence above came from the repository\'s history, not from a person. Check it before acting on it: if',
    `the numbers do not hold up, saying so in ${home} is a complete answer to this ticket.`,
    '',
  ].join('\n');
}

function leasedBy(node) {
  const { leases } = readLeases();
  const lease = leases[node];
  return lease && lease.horde ? lease.horde : null;
}
function cmdQuality(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const policy = qualityPolicy(horde);
  if (policy === 'only-the-work') {
    emit({
      policy, ran: false, filed: [], skipped: [],
    }, flags, () => 'the charter sets quality to only-the-work — this mission files no improvement tickets of its own');
    return;
  }
  const cfg = readConfig() || {};
  const info = resolveTree({ tree: flags.tree, horde: flags.horde });
  const root = info.path;
  const { source, text } = readAdvice(root, cfg, flags.from);
  if (!source) {
    emit({
      policy, ran: false, filed: [], skipped: [], why: 'no Grain CLI is configured',
    }, flags, () => 'no Grain CLI is configured, so there is nothing telling this repository what it says about itself — '
      + 'name one with `horde.mjs config set grainCommand "…"`, or pass a document with --from');
    return;
  }
  const doc = parseAdvice(source, text, !!flags.from);

  const already = new Set(readAdvisoryLedger(horde).map((a) => a.key));
  const filed = [];
  const skipped = [];
  for (const item of asArray(doc.items)) {
    const nodes = asArray(item && item.nodes).filter(Boolean);
    const key = advisoryKey(item);
    if (nodes.length === 0) {
      skipped.push({ key, why: 'it names no component, so there is no owner to hand it to' });
      continue;
    }
    if (already.has(key)) {
      skipped.push({ key, node: nodes[0], why: 'already filed as a ticket' });
      continue;
    }
    const node = nodes[0];
    if (!nodeExists(root, cfg, node)) {
      skipped.push({ key, node, why: 'the graph has no such component' });
      continue;
    }
    // An advisory on a node this horde does not lease has no owner here to hand it to and no
    // ticket of this mission touching it: it stays in the feed for whichever horde leases that
    // node, instead of sitting in this queue unowned. --all files them anyway.
    if (!flags.all && leasedBy(node) !== horde) {
      skipped.push({ key, node, why: `outside the mission — ${leasedBy(node) ? `leased by horde ${leasedBy(node)}` : 'leased by no horde'}` });
      continue;
    }
    const kind = String(item.kind || 'item');
    const owner = node;
    const title = (ADVICE_TITLE[kind] || ((n) => `Quality advisory on ${n.join(', ')}`))(nodes);
    if (flags['dry-run']) {
      filed.push({
        key, node, owner, kind, title, ticket: null,
      });
      continue;
    }
    const created = createTicket(horde, {
      slug: `quality-${kind}-${node}`,
      title,
      nodes: [node],
      cls: flags.class || 'sonnet',
      severity: 'low',
      kind: 'quality',
      team,
    });
    setTicketBody(horde, created.id, adviceTicketBody(item, source), owner);
    const ticket = findTicket(horde, created.id);
    const qdoc = load(horde, team);
    qdoc.items.push(newQueueItem(ticket));
    save(horde, team, qdoc);
    already.add(key);
    recordAdvisory(horde, {
      key, node, owner, kind, ticket: created.id, source,
    });
    filed.push({
      key, node, owner, kind, title, ticket: created.id,
    });
  }

  emit(withProvenance({
    policy,
    ran: true,
    source,
    dryRun: !!flags['dry-run'],
    items: asArray(doc.items).length,
    filed,
    skipped,
  }, info), flags, () => {
    const head = `${source}: ${asArray(doc.items).length} item(s) — ${filed.length} ${flags['dry-run'] ? 'would be filed' : 'filed and queued'}, ${skipped.length} skipped`;
    return [head, ...filed.map((f) => `  ${f.ticket || '(dry run)'}  ${f.node}  ${f.owner}  ${f.title}`), provenanceLine(info)].join('\n');
  });
}

function findItem(horde, team, key) {
  const doc = load(horde, team);
  return { doc, item: doc.items.find((i) => i.ticket === key) };
}

// `set NNN running --on MMM`: the ticket starts from MMM's tip rather than the team's, so a chain
// of tickets can be written and reviewed in one wave instead of one per link. What MMM has to be
// is what makes the base honest — a real dependency of this ticket (merge order is the same DAG,
// only now the work rides on top of it), in this same team (only this team's steward merges these
// branches), and unmerged but already on a branch (a merged one's work is on the team branch
// already, and there is nothing else to start from). Anything else is refused here rather than
// cut into a branch nobody can reason about afterwards.
function resolveStackParent(horde, team, key, item, raw) {
  const ref = resolveDepRef(horde, raw, team);
  if (ref.team !== team) {
    fail(`--on ${raw}: ${ref.ticket} belongs to team ${ref.team}, not ${team} — a ticket can only start from a branch its own team owns and merges; drop --on, or move the ticket first`);
  }
  if (!ref.item) fail(`--on ${raw}: no queue item ${ref.ticket} in team ${team}`);
  if (!(item.dependsOn || []).includes(ref.canonical)) {
    fail(`--on ${raw}: ${key} does not depend on ${ref.canonical} — a stack follows a dependency and nothing else, or the merge order and the base say different things; record the dependency first (queue.mjs dep ${key} --on ${ref.canonical}) if that is what you mean`);
  }
  if (ref.item.state === 'merged') {
    fail(`--on ${raw}: ${ref.canonical} is already merged — its work is on ${horde}/${team}, so this ticket starts from the team's tip: run it again without --on`);
  }
  if (ref.item.state !== 'running' && ref.item.state !== 'landed') {
    fail(`--on ${raw}: ${ref.canonical} is ${ref.item.state} — only a running or landed ticket has a tip to start from; start ${ref.canonical} first, or run this one without --on`);
  }
  if (!ref.item.branch) fail(`--on ${raw}: ${ref.canonical} has no branch yet — nothing to start from`);
  if (git(['rev-parse', '--verify', ref.item.branch], resolveTree({}).path) === null) {
    fail(`--on ${raw}: branch ${ref.item.branch} does not exist in this repository — ${ref.canonical} says it is ${ref.item.state}, so reconcile the queue (queue.mjs reconcile) before stacking on it`);
  }
  return { ticket: ref.canonical, branch: ref.item.branch };
}

// Everything recording a merge does to the queue, in one place: the dependency order is checked,
// the worktree and the branch go, the sha is kept, and whatever was stacked on this ticket is
// stacked on nothing any more. `cmdSet` calls it for `set <t> merged --sha`, and the landing gate
// calls recordMerged below the moment it has made the merge commit itself — the two must not drift,
// since a landing that recorded a merge differently from a hand-recorded one would leave two
// shapes of the same event in one queue.
function applyMerged(horde, team, doc, item, key, sha, { tree } = {}) {
  // Merge order is the dependency order, stack or no stack: a ticket written on top of an
  // unmerged one still lands after it.
  const unmerged = (item.dependsOn || []).filter((d) => !dependencySatisfied(horde, doc, team, d));
  if (unmerged.length) {
    fail(`${key} depends on ${unmerged.join(', ')}, still unmerged — merge order follows the dependencies, so ${unmerged.length === 1 ? 'that ticket merges' : 'those tickets merge'} first`);
  }
  const ticket = findTicket(horde, key);
  if (!ticket) fail(`ticket ${key} not found`);
  const mergeRoot = resolveTree({ tree }).path;
  if (item.worktree) git(['worktree', 'remove', '--force', item.worktree], mergeRoot);
  if (item.branch) git(['branch', '-D', item.branch], mergeRoot);
  item.worktree = null;
  item.sha = sha;
  // Whatever was stacked on this ticket is stacked on nothing now: the work is on the team
  // branch and the branch it was cut from is gone. The same write that records the merge moves
  // their parent, so no later reading of the base depends on somebody remembering a second
  // command — from here they catch up with the team branch like any other ticket.
  for (const other of doc.items) {
    if (other === item || other.stackedOn !== key) continue;
    other.stackedOn = null;
    other.notes.push({ at: nowIso(), text: `stack: ${key} merged — base is ${horde}/${team} from now on; catch up with it` });
  }
}

// The landing gate's own way in: it has already made the merge commit, so all that is left is the
// record. Returns the journal bullet the wave close reads, exactly as `set <t> merged` does.
export function recordMerged(horde, team, key, sha, { tree } = {}) {
  const { doc, item } = findItem(horde, team, key);
  if (!item) fail(`no queue item: ${key}`);
  applyMerged(horde, team, doc, item, key, String(sha), { tree });
  item.state = 'merged';
  save(horde, team, doc);
  return { item, journal: noteMerged(horde, team, key, String(sha)) };
}

// The branch a ticket is worked on and the worktree it is worked in, cut where `set <ticket>
// running` cuts them. Its own function because it has two callers now: that command, and tick
// building a dispatch list, which has to cut several in a row against one queue document.
function provisionRunning(horde, team, key, item, { tree, on } = {}) {
  const teamBranch = `${horde}/${team}`;
  const cfg = readConfig() || {};
  const root = resolveTree({ tree }).path;
  const stack = on !== undefined ? resolveStackParent(horde, team, key, item, on) : null;
  let branchName = item.branch;
  if (!branchName) {
    const from = stack ? stack.branch : teamBranch;
    branchName = `${horde}/t-${key}`;
    if (git(['rev-parse', '--verify', branchName], root) !== null) fail(`branch already exists: ${branchName}`);
    const created = git(['branch', branchName, from], root);
    if (created === null) fail(`could not create branch ${branchName} off ${from}`);
    if (stack) {
      item.stackedOn = stack.ticket;
      item.notes.push({ at: nowIso(), text: `stacked on ${stack.ticket} — branch cut from ${stack.branch}` });
    }
  } else if (stack && item.stackedOn !== stack.ticket) {
    fail(`--on ${on}: ${key} is already on branch ${branchName}, cut from somewhere else — a stack is chosen when the branch is cut, and moving one under work already done is a rebase this tool does not do; land or drop what is there first`);
  }
  const worktreePath = join(hordeRoot(), 'worktrees', horde, `t-${key}`);
  try {
    provisionTree(worktreePath, branchName, cfg);
  } catch (e) {
    fail(e.message);
  }
  item.branch = branchName;
  item.worktree = worktreePath;
}

// Everything `set <ticket> running` does to one item, for the caller that has to do it to several
// in a row: tick, building a dispatch list. A ticket on that list has had its branch cut and its
// worktree made already — that is what lets the brief beside it render against a tree that exists,
// and what stops the next run, or a second tick racing this one, from handing it out twice.
export function startRunning(horde, team, key, { tree, on, agent } = {}) {
  const { doc, item } = findItem(horde, team, key);
  if (!item) fail(`no queue item: ${key}`);
  provisionRunning(horde, team, key, item, { tree, on });
  item.state = 'running';
  if (agent) item.agent = agent;
  save(horde, team, doc);
  return item;
}

function cmdSet(horde, positional, flags) {
  const [rawKey, state] = positional;
  if (!rawKey || !state) fail('set requires <ticket> <state>');
  if (!STATES.includes(state)) fail(`unknown state: ${state} (allowed: ${STATES.join(', ')})`);
  const team = flags.team || 'trunk';
  const key = normalizeKey(rawKey);
  const { doc, item } = findItem(horde, team, key);
  if (!item) fail(`no queue item: ${key}`);
  if (flags.on !== undefined && state !== 'running') {
    fail('--on only goes with "set <ticket> running" — it says which branch the ticket is cut from, and nothing else cuts one');
  }

  if (state === 'running') provisionRunning(horde, team, key, item, { tree: flags.tree, on: flags.on });

  if (state === 'merged') {
    if (!flags.sha) fail('set merged requires --sha');
    applyMerged(horde, team, doc, item, key, String(flags.sha), { tree: flags.tree });
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
// doc: a colon-bearing reference is a leaf here, not traversed further — resolveDepRef refuses to
// write one any more, but this stays defensive for a dependsOn a pre-migration mission still
// carries on disk.
function dependsTransitively(doc, from, target, seen = new Set()) {
  if (from === target) return true;
  if (from.includes(':') || seen.has(from)) return false;
  seen.add(from);
  const item = doc.items.find((i) => i.ticket === from);
  if (!item) return false;
  return (item.dependsOn || []).some((d) => dependsTransitively(doc, d, target, seen));
}

// addDependency(horde, team, ticket, on) — the one path that adds an edge to an existing item, and
// the one place the cycle is caught. `tk.mjs edit --depends` is an alias onto this rather than a
// second implementation: a cycle only becomes visible once the whole DAG is built, so a second
// writer that skipped this check would file a plan nothing can start and nobody would know until
// `plan` refused. Returns the item it changed.
export function addDependency(horde, team, ticket, on) {
  const key = normalizeKey(ticket);
  const { doc, item } = findItem(horde, team, key);
  if (!item) fail(`no queue item: ${key} (in team ${team}) — a dependency hangs off a queued ticket; add it to the queue first`);

  const ref = resolveDepRef(horde, on, team);
  if (!ref.item) fail(`no such dependency: "${on}" (team ${ref.team})`);
  if (ref.canonical === key) fail(`cannot depend on itself: ${key}`);
  if (dependsTransitively(doc, ref.canonical, key)) fail(`adding this dependency would create a cycle: ${ref.canonical} already depends on ${key}`);

  if (!item.dependsOn.includes(ref.canonical)) item.dependsOn.push(ref.canonical);
  if (item.state === 'running' && ref.item.state !== 'merged') {
    item.state = 'queued';
    item.notes.push({ at: nowIso(), text: `dep: gained dependency on ${ref.canonical} — back to queued until it merges` });
  }
  save(horde, team, doc);
  return { item, on: ref.canonical };
}

function cmdDep(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('dep requires <ticket>');
  if (!flags.on) fail('dep requires --on <dep>');
  const team = flags.team || 'trunk';
  const { item, on } = addDependency(horde, team, idRaw, flags.on);
  emit(item, flags, () => `${item.ticket} now depends on ${on}`);
}

function severityOf(horde, item) {
  const ticket = findTicket(horde, item.ticket);
  return (ticket && parseField(ticket.text, 'Severity')) || 'medium';
}

// A same-team dependency is checked against `doc` directly; a colon-bearing one — never written
// any more, but still possibly present on disk from before this migration — is checked against
// that team's own queue.json, read fresh.
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

// The tickets a queued item could be started from today, though it is not ready: every dependency
// it still waits on is in this team, running or landed, and on a branch, so the work can be
// written on top of one of those tips instead of after the wave that merges it. Empty when the
// item is ready anyway, and empty when even one dependency is out of reach — another team's
// branch is not this team's to start from, and a queued dependency has no tip at all.
function stackParentsFor(horde, doc, team, item) {
  const unmerged = (item.dependsOn || []).filter((d) => !dependencySatisfied(horde, doc, team, d));
  if (unmerged.length === 0) return [];
  const parents = [];
  for (const d of unmerged) {
    if (d.includes(':')) return [];
    const dep = doc.items.find((i) => i.ticket === d);
    if (!dep || !dep.branch) return [];
    if (dep.state !== 'running' && dep.state !== 'landed') return [];
    parents.push(dep.ticket);
  }
  return parents;
}

// Every currently "running" real ticket's declared lock, in this team: its Files and its Nodes.
// A ticket with no declared Files locks every file of every node it names — the safe degradation
// for a ticket written (or read) before the field carried anything — so it is recorded by its
// nodes instead, and checked against the other side's nodes rather than specific paths.
function runningLocks(horde, doc) {
  return doc.items
    .filter((i) => i.state === 'running')
    .map((i) => {
      const ticket = findTicket(horde, i.ticket);
      return {
        ticket: i.ticket,
        files: ticket ? ticketFiles(ticket.text) : [],
        nodes: ticket ? nodesOf(ticket.text) : [],
      };
    });
}

// The first running lock a candidate collides with, or null. Both sides declaring Files is
// decided by path/glob overlap alone; either side with none falls back to whole-node overlap —
// the case a ticket without Files (or a running item whose ticket vanished) has to degrade to.
function lockConflict(ticketText, ticketId, locks) {
  const files = ticketFiles(ticketText);
  const nodes = nodesOf(ticketText);
  for (const running of locks) {
    if (running.ticket === ticketId) continue;
    if (files.length && running.files.length) {
      const shared = files.filter((f) => filesOverlap([f], running.files));
      if (shared.length) return { by: running.ticket, files: shared, wholeNode: false, nodes: [] };
      continue;
    }
    const sharedNodes = nodes.filter((n) => running.nodes.includes(n));
    if (sharedNodes.length) return { by: running.ticket, files: [], wholeNode: true, nodes: sharedNodes };
  }
  return null;
}

// The `STACKED, parent <t-NNN> unmerged` line a candidate cut from an unmerged dependency carries
// wherever it is listed — `next`'s own output and tick's dispatch list both. It is said on its own
// line rather than folded into the candidate's: somebody scanning a list for what is ready has to
// see at a glance that this one is not, and a suffix on a long line is exactly what gets missed.
export function stackedLine(stackOn) {
  const parents = asArray(stackOn);
  if (!parents.length) return null;
  return `STACKED, parent ${parents.map((p) => `t-${p}`).join(', ')} unmerged`;
}

// Every queued item, ranked the way `next` ranks it. Exported so tick.mjs dispatches from this
// order rather than growing a second queue beside it: the comparator, the file locks and the
// dependency rule are this file's, and there is one of each.
//
// `limit` additionally returns `picked` — the greedy prefix of `eligible` that fits the limit and
// collides with nothing another pick on the same list already holds. `next` answers one at a time,
// so the running locks are enough for it; a list of things to start at once is not, because
// nothing on it is running yet and two of its entries could otherwise be handed the same file.
export function rankedCandidates(horde, team, {
  stack = false, cls = null, tree, limit,
} = {}) {
  const doc = load(horde, team);
  const cfg = readConfig() || {};
  // Reused in-process, never shelled out: the same DAG `queue.mjs plan` derives, read straight off
  // this call's own buildPlan() so "longer remaining critical path" ranks against the plan's own
  // figures rather than a second, possibly stale, reading of the tickets.
  const plan = buildPlan(horde, team, cfg, { tree });
  const remainingPath = new Map(plan.tickets.map((t) => [t.id, t.remainingPath]));
  const locks = runningLocks(horde, doc);
  const busyNodes = new Set(locks.flatMap((l) => l.nodes));

  const entries = doc.items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.state === 'queued')
    .map(({ item, idx }) => {
      const unmet = (item.dependsOn || []).filter((d) => !dependencySatisfied(horde, doc, team, d));
      // A ticket whose unmet dependencies are all running or landed in this team, each on a
      // branch, can be started now on top of one of those tips instead of after the wave that
      // merges it. With --stack it stays a candidate — ranked below every ready one, and held to
      // the same file locks, since the ticket it would start from is often the one holding the
      // file. Without --stack, an unmet dependency is what it always was.
      const stackOn = unmet.length ? stackParentsFor(horde, doc, team, item) : [];
      if (unmet.length && !(stack && stackOn.length)) {
        return {
          item, idx, eligible: false,
          reason: `waiting on dependenc${unmet.length > 1 ? 'ies' : 'y'} ${unmet.join(', ')}`
            + (stackOn.length ? ` — could be started on top of ${stackOn.join(', ')} (--stack)` : ''),
        };
      }
      const ticket = findTicket(horde, item.ticket);
      if (ticket) {
        const conflict = lockConflict(ticket.text, item.ticket, locks);
        if (conflict) {
          const detail = conflict.wholeNode
            ? `node ${conflict.nodes.join(', ')} (declares no files itself — whole-node lock)`
            : `file(s) ${conflict.files.join(', ')}`;
          return {
            item, idx, eligible: false,
            reason: `locked — running ticket ${conflict.by} also holds ${detail}`,
          };
        }
      }
      if (cls && item.class !== cls) {
        return {
          item, idx, eligible: false,
          reason: `excluded by --class ${cls} (this ticket is ${item.class})`,
        };
      }
      const nodes = ticket ? nodesOf(ticket.text) : [];
      return {
        item,
        idx,
        eligible: true,
        stackOn,
        severity: severityOf(horde, item),
        kind: ticket ? ticketKind(ticket.text) : 'work',
        path: remainingPath.get(item.ticket) || 0,
        nodeBusy: nodes.some((n) => busyNodes.has(n)),
      };
    });

  const eligible = entries.filter((e) => e.eligible);
  eligible.sort((a, b) => {
    // A ticket that would start on top of an unmerged dependency comes after every ticket with
    // nothing in front of it, whatever either is ranked on below: a stack buys wall-clock, and
    // the parent's own risk is still ahead of it.
    const astack = a.stackOn.length ? 1 : 0;
    const bstack = b.stackOn.length ? 1 : 0;
    if (astack !== bstack) return astack - bstack;
    // Quality work always sorts after every non-quality ticket, whatever its severity — the
    // quality-always-authorised ruling: quality is raised in free parallelism, never ahead of
    // the mission's own work.
    const ak = a.kind === 'quality' ? 1 : 0;
    const bk = b.kind === 'quality' ? 1 : 0;
    if (ak !== bk) return ak - bk;
    const ra = SEVERITY_RANK[a.severity] ?? 1;
    const rb = SEVERITY_RANK[b.severity] ?? 1;
    if (ra !== rb) return ra - rb;
    if (a.path !== b.path) return b.path - a.path; // longer remaining critical path first
    if (a.nodeBusy !== b.nodeBusy) return a.nodeBusy ? 1 : -1; // prefer a node with nothing running
    return a.idx - b.idx; // FIFO
  });
  eligible.forEach((e, i) => { e.rank = i + 1; });

  let picked = null;
  if (limit !== undefined) {
    picked = [];
    const held = locks.slice();
    for (const e of eligible) {
      if (picked.length >= limit) break;
      const ticket = findTicket(horde, e.item.ticket);
      const text = ticket ? ticket.text : '';
      if (lockConflict(text, e.item.ticket, held)) continue;
      held.push({ ticket: e.item.ticket, files: ticketFiles(text), nodes: nodesOf(text) });
      picked.push(e);
    }
  }

  return {
    doc, entries, eligible, picked,
  };
}

function cmdNext(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const { entries, eligible } = rankedCandidates(horde, team, {
    stack: !!flags.stack, cls: flags.class || null, tree: flags.tree,
  });

  const first = eligible.length ? eligible[0] : null;
  const chosen = first
    ? {
      ...first.item, stackReady: first.stackOn.length > 0, stackOn: first.stackOn, stacked: stackedLine(first.stackOn),
    }
    : null;

  if (flags.why) {
    const rows = entries.map((e) => ({
      ticket: e.item.ticket,
      class: e.item.class,
      eligible: e.eligible,
      reason: e.eligible ? null : e.reason,
      rank: e.eligible ? e.rank : null,
      stackOn: e.eligible ? e.stackOn : [],
      stacked: e.eligible ? stackedLine(e.stackOn) : null,
    }));
    emit({ chosen: chosen ? chosen.ticket : null, entries: rows }, flags, () => (rows.length
      ? rows.flatMap((r) => (r.eligible
        ? [`${r.ticket} (${r.class}) — rank ${r.rank}${r.stackOn.length ? `, stack-ready on ${r.stackOn.join(', ')}` : ''}${chosen && r.ticket === chosen.ticket ? ' (chosen)' : ''}`, ...(r.stacked ? [r.stacked] : [])]
        : [`${r.ticket} (${r.class}) — skipped: ${r.reason}`])).join('\n')
      : '(queue empty)'));
    return;
  }

  emit(chosen, flags, () => (chosen
    ? [`${chosen.ticket} (${chosen.class})${chosen.stackReady ? ` stack-ready on ${chosen.stackOn.join(', ')}` : ''}`, ...(chosen.stacked ? [chosen.stacked] : [])].join('\n')
    : '(none ready)'));
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

export function titleOf(text) {
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

// Exported so `wave.mjs start` can record the plan's own layers in the journal at the moment a
// wave opens — the planned parallelism a wave close is later measured against has to be the
// number this DAG actually produced, not a second derivation of it.
export function buildPlan(horde, team, cfg, { tree } = {}) {
  const root = resolveTree({ tree, horde }).path;
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

  // (a) a consumed port depends on the ticket that produces that exact port — in this team or
  // another one; a cross-team producer is an edge all the same, it just falls outside the layers.
  // No version to compare any more: two tickets naming the same <node>/<port> name the same
  // thing, so the port name alone is the match. (This also absorbs what used to be a second
  // rule here — a ticket declaring a stale port version needed its own edge, derived from the
  // graph's own consumersOf, because a version mismatch made it invisible to this match. With no
  // version left to go stale, every case that second rule caught is one this rule already
  // catches on its own; a separate graph-derived edge would only ever duplicate it.)
  const consumesWithoutProducer = [];
  for (const t of planned) {
    for (const c of ticketPorts(t.text, 'Consumes')) {
      const producers = everyTicket.filter((o) => o.id !== t.id
        && ticketPorts(o.text, 'Produces').some((p) => p.node === c.node && p.port === c.port));
      for (const p of producers) addEdge(t.id, p.team === leafOf(team) ? p.id : `${p.team}:${p.id}`, `consumes ${c.ref}`);
      if (producers.length === 0 && !portExists(root, cfg, c.node, c.port)) {
        consumesWithoutProducer.push({ ticket: t.id, port: c.ref });
      }
    }
  }

  // (b) what a steward or an owner wrote by hand, added to the derived edges, never replacing them.
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

  // The remaining critical path THROUGH each ticket: the longest weighted chain of everything that
  // depends on it, directly or transitively, plus itself — read backwards from `longest` above
  // (which reads forward, from the sources). Processing layers last-to-first guarantees every
  // dependent's own figure is known before the ticket it depends on needs it. `queue.mjs next`
  // reads this off the very same buildPlan() call, in-process, to rank equal-severity tickets by
  // how much of the mission still sits behind each one landing.
  const dependents = new Map(tickets.map((t) => [t.id, []]));
  for (const t of tickets) for (const d of t.dependsOn) if (dependents.has(d)) dependents.get(d).push(t.id);
  const downstream = new Map();
  for (let li = layers.length - 1; li >= 0; li--) {
    for (const id of layers[li]) {
      const t = byId.get(id);
      let best = 0;
      for (const dep of dependents.get(id) || []) best = Math.max(best, downstream.get(dep) || 0);
      downstream.set(id, weightOf(t.class) + best);
    }
  }
  for (const t of tickets) t.remainingPath = downstream.has(t.id) ? downstream.get(t.id) : weightOf(t.class);

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

export function renderPlan(plan) {
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
  const info = resolveTree({ tree: flags.tree, horde: flags.horde });
  const plan = withProvenance(buildPlan(horde, team, cfg, { tree: info.path }), info);
  if (plan.cycles.length && plan.cycles[0].length) {
    fail(`the tickets depend on each other in a circle: ${plan.cycles[0].join(' → ')} — a plan cannot start any of them. Drop one of those dependencies (queue.mjs is not the place: the ticket that should not wait is edited with tk.mjs edit --consumes, or the manual --depends is removed) and run plan again`);
  }
  // --out writes the plan to a file the architect reads whole: a plan relayed through a message
  // gets summarised on the way (a real mission lost its critical path that way), and a steward
  // cannot message the architect directly in any case. JSON with --json, else the terminal
  // rendering; stdout then carries only where it went.
  if (flags.out) {
    const path = String(flags.out);
    writeText(path, flags.json ? `${JSON.stringify(plan, null, 2)}\n` : `${renderPlan(plan)}\n${provenanceLine(info)}\n`);
    console.log(`plan written to ${path} — ${plan.tickets.length} ticket(s)`);
    return;
  }
  if (flags['apply-order']) {
    const applied = applyOrder(horde, team, plan);
    emit({ ...plan, applied }, flags, () => `${renderPlan(plan)}\n\napplied: ${applied.length ? applied.map((a) => `${a.ticket} now depends on ${a.on}`).join(' · ') : 'nothing to apply'}\n${provenanceLine(info)}`);
    return;
  }
  emit(plan, flags, () => `${renderPlan(plan)}\n${provenanceLine(info)}`);
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

function cmdRender(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const doc = load(horde, team);
  save(horde, team, doc);
  emit({ team }, flags, () => queuePath(horde, team).replace(/\.json$/, '.md'));
}

// What a spawn that never came back left behind, settled from the branch rather than from a clock.
// Exported because tick.mjs opens every run with exactly this: an item is "running" because a call
// was made, and once that call has returned without landing a sha, the branch is the only thing
// that still knows what happened. Three answers, and each says out loud what was salvaged, because
// the caller reading this is usually reading it after somebody else's crash.
export function reconcileRunning(horde, team, { tree } = {}) {
  const doc = load(horde, team);
  const root = resolveTree({ tree }).path;
  const results = [];
  for (const item of doc.items) {
    if (item.state !== 'running' || !item.branch) continue;
    // Against the item's own parent: a stacked ticket carries its parent's commits too, and
    // counting those as its own work would call an untouched branch "landed" on the first pass.
    const parent = parentBranchOf(horde, team, item).branch;
    const countOut = git(['rev-list', '--count', `${parent}..${item.branch}`], root);
    const count = countOut === null ? 0 : Number(countOut);
    if (count > 0) {
      item.state = 'landed';
      results.push({ ticket: item.ticket, state: item.state, note: `${count} commit(s) beyond ${parent} on ${item.branch} — the work is safe and the branch is ready for the gate` });
      continue;
    }
    // A worktree git still has on record but that is gone from disk is not an error to throw on:
    // it is the ordinary shape of a killed run, and the branch beside it is what matters.
    const worktreeGone = !!item.worktree && !existsSync(item.worktree);
    const dirty = item.worktree && !worktreeGone
      ? git(['status', '--porcelain'], item.worktree)
      : null;
    if (dirty) {
      git(['add', '-A'], item.worktree);
      git(['commit', '-m', 'wip: reclaimed'], item.worktree);
      item.state = 'queued';
      item.notes.push({ at: nowIso(), text: 'reconcile: worktree was dirty — committed as "wip: reclaimed"' });
      results.push({ ticket: item.ticket, state: item.state, note: `worktree was dirty — committed as "wip: reclaimed" on ${item.branch}, and the worktree is kept` });
      continue;
    }
    item.state = 'queued';
    const hadWorktree = item.worktree;
    if (item.worktree) {
      git(['worktree', 'remove', '--force', item.worktree], root);
      git(['worktree', 'prune'], root);
      item.worktree = null;
    }
    results.push({
      ticket: item.ticket,
      state: item.state,
      note: worktreeGone
        ? `the worktree at ${hadWorktree} is gone from disk and nothing was committed — there was nothing to salvage; ${item.branch} is left as it was and the item is queued again`
        : `nothing was committed and the worktree was clean — worktree removed, ${item.branch} left as it was`,
    });
  }
  save(horde, team, doc);
  return results;
}

function cmdReconcile(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const results = reconcileRunning(horde, team, { tree: flags.tree });
  emit(results, flags, () => (results.length ? results.map((r) => `${r.ticket} -> ${r.state} · ${r.note}`).join('\n') : '(nothing running)'));
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2), { flags: ['apply-order', 'why', 'stack', 'dry-run', 'proposed'] });
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
    case 'render': return cmdRender(horde, positional, flags);
    case 'reconcile': return cmdReconcile(horde, positional, flags);
    case 'quality': return cmdQuality(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
