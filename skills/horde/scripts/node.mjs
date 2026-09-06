#!/usr/bin/env node
// horde skill — node.mjs
//
// The only tool that knows which graph mode a horde runs in. With Yggdrasil, node ids, boundaries
// and descriptions are read from .yggdrasil/model/**/yg-node.yaml (never written by this tool —
// the architect files graph changes through `yg`, with the user's confirmation where the repo's
// own rules require it); charter.md and contracts.md live beside the yaml, committed. Without it
// (config.nodeSource = "manual"), this tool is the sole writer of the whole committed node map
// under <graphDir>/nodes/<node>/. Either way, graph *proposals* and contract negotiations are
// operational state — uncommitted, per horde, in hordes/<horde>/graph.json — until an approval
// turns one into a committed charter/contracts.md write (manual) or a `yg` filing the architect
// runs by hand (Yggdrasil).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  repoRoot, hordePath, readJSON, writeJSON, readText, writeText, appendText, readConfig, nowIso,
  fail, parseArgs, asArray, emit, isMain, resolveHorde, renderTemplate, claimLease,
} from './_lib.mjs';
import { trace as traceRoster } from './roster.mjs';

const USAGE = `usage: node.mjs <command> [options]

commands:
  bind [--horde h]
      verifies the graph is readable; lists every node id.
  bind <node> [--horde h] [--take --escalation <id>]
      node-lease-across-hordes: leases <node> to this horde in .horde/leases.json, exclusive
      across every live horde on the repository. Refuses a node already leased by another horde
      that is not archived, naming that horde and its last activity. --take overrides that refusal
      but only over a ruled escalation on this horde (--escalation <id>); the take-over is written
      to the node's own log as well as to the lease history.
  map [--horde h]
      this mission's nodes (named by an owner in the roster or by a ticket) with owner, stamp,
      open contract proposals.
  show <node> [--horde h]
      boundary, the rules in force on the node (with the status word that says what a refusal
      costs), charter, contracts, last log entries, stamp.
  charter edit <node> [--horde h]
      writes charter.md from stdin; seeds it from the template first when the node has none yet
      and stdin is empty.
  log <node> "<reason>" [--run] [--horde h]
      manual mode: appends to the node's log.md. Yggdrasil mode: prints the "yg log add --reason"
      command; runs it too when --run is given.
  stamp <node> <sha> [--horde h]
      manual mode: records verifiedAt on the node. Yggdrasil mode: the graph computes its own
      verification status — this prints how to refresh it instead of writing anything.
  contract propose <a> <b> --as <path> "<text>" [--horde h]
  contract approve <id> ["why"] --by <name> [--horde h]
  contract veto <id> "why" --by <name> [--horde h]
  contracts [--pending] [--node n] [--horde h]
  propose <kind> "<text>" --by <owner> [--node n] [--boundary <glob>[,glob…]] [--horde h]
      kinds: new-node, move-boundary, rename, rule. move-boundary requires --node and --boundary
      so apply can carry it out later, not just record that it happened.
  proposals [--open] [--horde h]
  approve <id> ["why"] --by <name> [--horde h]
  veto <id> "why" --by <name> [--horde h]
  new <node> --boundary <glob>[,glob…] [--depends a,b] [--horde h]
      manual mode only: creates the node's committed files. Yggdrasil mode prints the yg-side
      steps instead (they need the user's confirmation).
  boundary set <node> --boundary <glob>[,glob…] [--horde h]
  boundary add <node> --boundary <glob>[,glob…] [--horde h]
      manual mode: rewrites (set) or extends (add) node.json's boundary, logs the change.
      Yggdrasil mode prints the yg-side steps instead.
  apply <proposal-id> [--horde h]
      manual mode only: closes an approved graph-change proposal. Yggdrasil mode prints the
      filing steps instead.

options: --json  --help`;

// ---- mode ----------------------------------------------------------------

function mode(cfg) {
  return cfg && cfg.nodeSource === 'yggdrasil' ? 'yggdrasil' : 'manual';
}

// How this repository invokes the Yggdrasil CLI: `config.ygCommand`, default the bare `yg` on
// PATH. Written as a command line ("yg", "node ./yg/bin.js") so a checkout that runs a local
// build needs no other change; split into a program plus its fixed leading arguments here, once,
// for every call site.
export function ygCommand(cfg) {
  const raw = (cfg && cfg.ygCommand) || 'yg';
  const parts = String(raw).trim().split(/\s+/).filter(Boolean);
  return { cmd: parts[0] || 'yg', prefix: parts.slice(1), display: parts.join(' ') || 'yg' };
}

// True when the graph — not the horde's own node map — is what says the code is right, and so
// `yg check` is part of every merge gate whatever `config.gates` holds.
export function graphIsLaw(cfg) {
  return mode(cfg) === 'yggdrasil';
}

// Runs `yg check` in one worktree and reports what it found. Never approves anything (that fills
// the lock and can cost money); `check` alone is read-only and keyless. `available: false` means
// the CLI itself could not be started — a different failure from a graph that refuses the tree,
// and the caller says so in those words.
export function runYgCheck(cfg, cwd) {
  const { cmd, prefix, display } = ygCommand(cfg);
  let out = '';
  let status = 0;
  try {
    out = execFileSync(cmd, [...prefix, 'check'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOENT') return { available: false, ok: false, command: `${display} check`, summary: null };
    status = e.status === undefined || e.status === null ? 1 : e.status;
    out = ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || '');
  }
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const verdictLine = lines.find((l) => /^yg check:/.test(l));
  const errorLine = lines.find((l) => /^(enforced|Errors)\b/.test(l));
  return {
    available: true,
    ok: status === 0,
    exit: status,
    command: `${display} check`,
    summary: verdictLine || errorLine || lines[lines.length - 1] || null,
  };
}

function graphDir(cfg) {
  return (cfg && cfg.graphDir) || 'architecture/';
}

function manualNodeDir(root, cfg, node) {
  return join(root, graphDir(cfg).replace(/\/$/, ''), 'nodes', node);
}

function yggdrasilNodeDir(root, node) {
  return join(root, '.yggdrasil', 'model', node);
}

function nodeDir(root, cfg, node) {
  return mode(cfg) === 'yggdrasil' ? yggdrasilNodeDir(root, node) : manualNodeDir(root, cfg, node);
}

// ---- manual mode: node.json -----------------------------------------------

function manualNodeJsonPath(root, cfg, node) {
  return join(manualNodeDir(root, cfg, node), 'node.json');
}

function readManualNode(root, cfg, node) {
  return readJSON(manualNodeJsonPath(root, cfg, node), null);
}

// ---- yggdrasil mode: a minimal, targeted yg-node.yaml reader --------------
//
// Not a general YAML parser — this repository's yg-node.yaml files are generated by `yg` in a
// narrow, predictable shape (scalar fields, `mapping:`/`aspects:` as flat dash-lists, `relations:`
// as a dash-list of {type, target} pairs), and node.mjs only ever reads this file, never writes
// it. A parser that tried to be a general YAML implementation would be both larger and no more
// correct for the one shape it actually has to handle.
function parseYgNodeYaml(text) {
  const lines = text.split('\n');
  const result = {
    name: null, type: null, description: null, mapping: [], relations: [], aspects: [], ports: {},
  };
  let section = null;
  let pendingRelation = null;
  let pendingList = null;
  let relationIndent = 0;
  let pendingPort = null;
  const flushRelation = () => {
    if (pendingRelation && (pendingRelation.target || pendingRelation.type)) result.relations.push(pendingRelation);
    pendingRelation = null;
    pendingList = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const topMatch = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (topMatch && !line.startsWith(' ')) {
      flushRelation();
      const [, key, rest] = topMatch;
      if (key === 'name') result.name = unquote(rest.trim());
      else if (key === 'type') result.type = unquote(rest.trim());
      else if (key === 'description') result.description = unquote(rest.trim());
      pendingPort = null;
      section = ['mapping', 'aspects', 'relations', 'ports'].includes(key) ? key : null;
      continue;
    }
    if (section === 'mapping') {
      const m = /^\s*-\s*(.+)$/.exec(line);
      if (m) result.mapping.push(unquote(m[1].trim()));
      continue;
    }
    // The aspects attached to the node itself (channel 1) — and, because a node's aspects cascade
    // to every node below it, to its descendants too (channel 2). Each entry is either a bare id
    // or an `- id: <id>` block whose `status:` (and `when:`) lines follow it, indented further.
    if (section === 'aspects') {
      const dash = /^\s*-\s*(.+)$/.exec(line);
      const kv = /^\s+([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (dash) {
        const body = dash[1].trim();
        const inline = /^id:\s*(.+)$/.exec(body);
        result.aspects.push(inline
          ? { id: unquote(inline[1].trim()), status: null }
          : { id: unquote(body), status: null });
      } else if (kv && kv[1] === 'status' && result.aspects.length) {
        result.aspects[result.aspects.length - 1].status = unquote(kv[2].trim());
      }
      continue;
    }
    // A relation is a dash item whose keys follow it, indented further; a key with no value on its
    // own line (`consumes:`) opens a nested list, whose own dash items are indented deeper than the
    // dash that opened the relation — that indent is what tells the two kinds of dash apart, so a
    // `consumes:` list is read as the relation's ports rather than as three more relations.
    if (section === 'relations') {
      const indent = line.length - line.trimStart().length;
      const dash = /^\s*-\s*(.+)$/.exec(line);
      const kv = /^\s+([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (dash && pendingRelation && pendingList && indent > relationIndent) {
        pendingRelation[pendingList].push(unquote(dash[1].trim()));
      } else if (dash) {
        flushRelation();
        pendingRelation = {};
        relationIndent = indent;
        const inline = /^([A-Za-z_-]+):\s*(.*)$/.exec(dash[1]);
        if (inline) pendingRelation[inline[1]] = parseYamlValue(inline[2].trim());
      } else if (kv && pendingRelation) {
        const value = kv[2].trim();
        if (value === '') {
          pendingList = kv[1];
          pendingRelation[kv[1]] = [];
        } else {
          pendingList = null;
          pendingRelation[kv[1]] = parseYamlValue(value);
        }
      }
      continue;
    }
    // `ports:` is a map, not a list: each port is a key two spaces in, its own fields deeper. Only
    // the fields the layers above agreed on are read (`version`, `test`); anything else is kept as
    // written, so a field added later reaches a caller that knows to look for it.
    if (section === 'ports') {
      const indent = line.length - line.trimStart().length;
      const kv = /^\s+([A-Za-z0-9._-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      if (indent <= 2) {
        pendingPort = unquote(kv[1].trim());
        result.ports[pendingPort] = { version: null, test: null };
        const inline = kv[2].trim();
        if (inline && inline !== '{}') result.ports[pendingPort].value = parseYamlValue(inline);
      } else if (pendingPort) {
        const value = parseYamlValue(kv[2].trim());
        const numeric = kv[1] === 'version' && typeof value === 'string' && /^\d+$/.test(value);
        result.ports[pendingPort][kv[1]] = numeric ? Number(value) : (value === '' ? null : value);
      }
      continue;
    }
  }
  flushRelation();
  return result;
}

function unquote(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

// One scalar, or the inline list form `[a, b]` that `yg` uses for short lists — the only two
// shapes a value takes in these files.
function parseYamlValue(raw) {
  const s = String(raw).trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map((p) => unquote(p.trim())).filter(Boolean);
  }
  return unquote(s);
}

function readYggdrasilNode(root, node) {
  const file = join(yggdrasilNodeDir(root, node), 'yg-node.yaml');
  const text = readText(file);
  if (!text) return null;
  return parseYgNodeYaml(text);
}

// ---- shared node reads (exported for brief.mjs / premerge.mjs) ------------

export function nodeExists(root, cfg, node) {
  if (mode(cfg) === 'yggdrasil') return existsSync(join(yggdrasilNodeDir(root, node), 'yg-node.yaml'));
  return existsSync(manualNodeJsonPath(root, cfg, node));
}

export function listAllNodes(root, cfg) {
  if (mode(cfg) === 'yggdrasil') {
    const base = join(root, '.yggdrasil', 'model');
    const found = [];
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'yg-node.yaml') found.push(relative(base, dir));
      }
    };
    walk(base);
    return found.sort();
  }
  const dir = join(root, graphDir(cfg).replace(/\/$/, ''), 'nodes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

// boundary — array of path globs the node covers.
export function nodeBoundary(root, cfg, node) {
  if (mode(cfg) === 'yggdrasil') {
    const y = readYggdrasilNode(root, node);
    return y ? y.mapping : [];
  }
  const n = readManualNode(root, cfg, node);
  return n && Array.isArray(n.boundary) ? n.boundary : [];
}

// The repo-root-relative directory a node's own graph files live in (yg-node.yaml, charter.md,
// contracts.md, log.md in Yggdrasil mode; node.json and the same three .md files in manual mode),
// trailing slash included — the prefix premerge.mjs's scope check treats as inside a ticket's
// node, alongside its code boundary. Nothing else under .yggdrasil/ (yg-architecture.yaml,
// aspects, locks, config) is a node's own files, so this names only that one directory, never
// the graph root.
export function nodeGraphPathPrefix(root, cfg, node) {
  return `${relative(root, nodeDir(root, cfg, node))}/`;
}

export function nodeCharterPath(root, cfg, node) {
  return join(nodeDir(root, cfg, node), 'charter.md');
}

export function nodeContractsPath(root, cfg, node) {
  return join(nodeDir(root, cfg, node), 'contracts.md');
}

export function readNodeCharterText(root, cfg, node) {
  return readText(nodeCharterPath(root, cfg, node));
}

export function readNodeContractsText(root, cfg, node) {
  return readText(nodeContractsPath(root, cfg, node));
}

// ---- boundary matching (shared with premerge.mjs and tk.mjs) ---------------
//
// One reading of "inside the node", used by the merge checklist's scope item and by the ticket
// tool when it accepts a declared file list: the same globs, matched the same way, so a path a
// ticket is allowed to declare is exactly a path the checklist will allow it to touch.

// "**/" — zero or more path segments, i.e. an optional prefix ending in one slash, so a pattern
// like "**/*.test.*" also matches a root-level file with no directory at all. A lone "**" (not
// followed by "/") maps to ".*"; a lone "*" to "[^/]*" (one path segment).
export function globToRegExp(glob) {
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let out = '';
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3; } else if (glob.startsWith('**', i)) { out += '.*'; i += 2; } else if (glob[i] === '*') { out += '[^/]*'; i += 1; } else { out += esc(glob[i]); i += 1; }
  }
  return new RegExp(`^${out}$`);
}

export function pathInBoundary(path, boundary) {
  return boundary.some((pat) => (pat.includes('*') ? globToRegExp(pat).test(path) : path === pat || path.startsWith(pat)));
}

// The whole boundary of a ticket: every named node's code boundary plus that node's own graph
// files. A node the graph does not know contributes nothing, and a ticket whose nodes are all
// unknown gets an empty boundary — which the callers read as "nothing to check against", never
// as "everything is inside".
export function ticketBoundary(root, cfg, nodes) {
  return nodes.flatMap((n) => (nodeExists(root, cfg, n) ? [...nodeBoundary(root, cfg, n), nodeGraphPathPrefix(root, cfg, n)] : []));
}

// ---- ports and the nodes that consume them ---------------------------------

// The relations a node declares. Yggdrasil mode reads them from `yg-node.yaml` (a relation may
// name the ports it consumes); manual mode has no ports at all, so `dependsOn` — the only edge
// it records — stands in, naming no port.
export function nodeRelations(root, cfg, node) {
  if (mode(cfg) === 'yggdrasil') {
    const y = readYggdrasilNode(root, node);
    return y ? y.relations : [];
  }
  const n = readManualNode(root, cfg, node);
  return n && Array.isArray(n.dependsOn) ? n.dependsOn.map((t) => ({ target: t, type: 'depends' })) : [];
}

// The ports a node offers, as {name: {version, test}} — empty in manual mode, which has none.
export function nodePorts(root, cfg, node) {
  if (mode(cfg) === 'yggdrasil') {
    const y = readYggdrasilNode(root, node);
    return y && y.ports ? y.ports : {};
  }
  const n = readManualNode(root, cfg, node);
  return n && n.ports && typeof n.ports === 'object' ? n.ports : {};
}

export function portExists(root, cfg, node, port) {
  return Object.prototype.hasOwnProperty.call(nodePorts(root, cfg, node), port);
}

// `<ygCommand> impact --node <path> --json` — Yggdrasil's own answer to "who depends on this
// node", the versioned document the layers agreed on. Accepted only when the document says so
// itself (`schema` = "yg-impact/1"); anything else — an older CLI, no CLI, a different shape —
// is a null, and the caller reads the graph files instead. Probed once per node per process:
// a plan asks about the same node many times and the answer cannot change mid-run.
const impactCache = new Map();
export function ygImpact(cfg, node) {
  if (!cfg || !cfg.ygCommand) return null;
  if (impactCache.has(node)) return impactCache.get(node);
  const { cmd, prefix } = ygCommand(cfg);
  let doc = null;
  try {
    const out = execFileSync(cmd, [...prefix, 'impact', '--node', node, '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out);
    if (parsed && parsed.schema === 'yg-impact/1') doc = parsed;
  } catch {
    doc = null;
  }
  impactCache.set(node, doc);
  return doc;
}

// consumersOf(node, port) — every node that consumes one node's port: from `yg impact` when the
// installed CLI produces the document, else from the relations in the graph files. The one
// derivation of this, because three things depend on the same answer: which tickets a version
// bump must come before, whose owner has to approve it, and what the merge checklist then
// requires. A relation that names no port at all consumes the node as a whole, so a bump reaches
// it too — the safe direction, and the only reading manual mode's `dependsOn` supports.
export function consumersOf(root, cfg, node, port) {
  const out = new Set();
  const doc = ygImpact(cfg, node);
  if (doc) {
    for (const p of asArray(doc.ports)) {
      if (p && p.name === port) for (const c of asArray(p.consumers)) if (c && c.node) out.add(c.node);
    }
    for (const d of asArray(doc.dependents)) {
      if (!d || !d.node) continue;
      for (const r of asArray(d.relations)) {
        const ports = asArray(r && r.ports);
        if (ports.length === 0 || ports.includes(port)) out.add(d.node);
      }
    }
    return [...out].sort();
  }
  for (const other of listAllNodes(root, cfg)) {
    if (other === node) continue;
    for (const rel of nodeRelations(root, cfg, other)) {
      if (!rel || rel.target !== node) continue;
      const consumes = asArray(rel.consumes);
      if (consumes.length === 0 || consumes.includes(port)) out.add(other);
    }
  }
  return [...out].sort();
}

// ---- the node's rules ------------------------------------------------------
//
// What the graph forbids and requires of this node's code, with the word that says what a refusal
// costs. Three statuses, and the difference between them is the whole point of showing them:
// `enforced` blocks a merge, `advisory` warns and lets it through, `draft` is inert until someone
// promotes it. Two ways of getting them, in order of authority:
//
//   1. `yg <sub> context --node <node>` — Yggdrasil's own resolution, the only one that accounts
//      for every channel (node, cascade, type, ancestor type, flow, port, implies) and for `when:`
//      filters. Its JSON form is used when the installed CLI has one, its text form otherwise.
//   2. the graph files, read directly, when the CLI is not installed at all — the node's and its
//      ancestors' own `aspects:`, plus the aspects on their types in `yg-architecture.yaml`,
//      resolved to an effective status the way the graph documents it (highest wins). Flows,
//      ports and implied aspects are not resolved this way, and the reading says so rather than
//      letting a short list read as a complete one.

const STATUS_MEANING = {
  enforced: 'blocks the merge',
  advisory: 'warns, does not block',
  draft: 'not in force yet — inert until promoted',
};
const STATUS_RANK = { draft: 0, advisory: 1, enforced: 2 };

function strongerStatus(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (STATUS_RANK[a] ?? 0) >= (STATUS_RANK[b] ?? 0) ? a : b;
}

// `Must satisfy (N aspects):` followed by one indented block per aspect:
//   "  <id> [<status>] — <description>" then "    Source: <where it comes from>".
function parseYgContextText(text) {
  const aspects = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const head = /^\s{1,3}(\S+)\s+\[(\w+)\]\s+—\s+(.*)$/.exec(raw);
    if (head) {
      current = { id: head[1], status: head[2], description: trimStatusSentence(head[3]), via: null };
      aspects.push(current);
      continue;
    }
    const src = /^\s{3,}Source:\s*(.+)$/.exec(raw);
    if (src && current) current.via = src[1].trim();
  }
  return aspects;
}

// The JSON form of the same thing, whatever the installed CLI happens to call the fields — this
// tool reads it defensively (id/status/description under any of a few plausible names) and falls
// back to the text form when it recognizes nothing, so a CLI that grows `--json` later is picked
// up without a release here, and one that never does keeps working.
function parseYgContextJson(doc) {
  const list = [doc && doc.aspects, doc && doc.mustSatisfy, doc && doc.must_satisfy]
    .find((x) => Array.isArray(x));
  if (!list) return null;
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const id = a.id || a.aspect;
    if (!id) continue;
    const channels = Array.isArray(a.channels)
      ? a.channels.map((c) => (typeof c === 'string' ? c : c.origin || c.kind)).filter(Boolean)
      : [];
    out.push({
      id: String(id),
      status: String(a.status || a.effectiveStatus || 'enforced'),
      description: trimStatusSentence(String(a.name || a.description || a.summary || '')),
      via: channels.length ? channels.join(' · ') : (a.source || a.via || null),
    });
  }
  return out.length ? out : null;
}

// Yggdrasil's own rendering of an aspect ends with a sentence restating what its status means
// ("This rule is advisory: `yg check` reports …"). The status word is printed beside the rule
// here already, so that sentence is dropped rather than said twice.
function trimStatusSentence(text) {
  return text.replace(/\s*This rule is (?:not in force yet|advisory|enforced)[^]*$/, '').trim();
}

function rulesFromYg(root, cfg, node) {
  const { cmd, prefix, display } = ygCommand(cfg);
  const call = (extra) => {
    try {
      return execFileSync(cmd, [...prefix, 'context', '--node', node, ...extra], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      return e.stdout ? e.stdout.toString() : '';
    }
  };
  const asJson = call(['--json']);
  if (asJson === null) return null; // no CLI at all — the caller reads the graph files instead
  if (asJson.trim().startsWith('{')) {
    try {
      const parsed = parseYgContextJson(JSON.parse(asJson));
      if (parsed) return { source: `${display} context --node ${node} --json`, aspects: parsed };
    } catch { /* not the JSON this reads — fall through to the text form */ }
  }
  const text = call([]);
  if (text === null) return null;
  return { source: `${display} context --node ${node}`, aspects: parseYgContextText(text) };
}

// ---- reading the graph files directly (no CLI installed) --------------------

function aspectDefaults(root, id) {
  const text = readText(join(root, '.yggdrasil', 'aspects', ...String(id).split('/'), 'yg-aspect.yaml'));
  if (!text) return { status: 'enforced', description: null };
  let status = null;
  let description = null;
  let name = null;
  for (const raw of text.split('\n')) {
    if (raw.startsWith(' ') || raw.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    if (m[1] === 'status') status = unquote(m[2].trim());
    else if (m[1] === 'description') description = unquote(m[2].trim());
    else if (m[1] === 'name') name = unquote(m[2].trim());
  }
  return { status: status || 'enforced', description: description || name };
}

// node_types.<type>.aspects from yg-architecture.yaml, as {type: [{id, status}]}. Indentation is
// the only structure this needs: types are the keys two spaces in under `node_types:`, their
// `aspects:` four in, its entries six in.
function parseArchitectureTypeAspects(text) {
  const byType = {};
  if (!text) return byType;
  let inNodeTypes = false;
  let type = null;
  let inAspects = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) { inNodeTypes = /^node_types:/.test(line); type = null; inAspects = false; continue; }
    if (!inNodeTypes) continue;
    if (indent === 2) {
      const m = /^\s{2}([^\s:]+):\s*$/.exec(line);
      type = m ? unquote(m[1]) : null;
      inAspects = false;
      continue;
    }
    if (!type) continue;
    if (indent === 4) { inAspects = /^\s{4}aspects:\s*$/.test(line); continue; }
    if (!inAspects || indent < 6) continue;
    const dash = /^\s*-\s*(.+)$/.exec(line);
    const kv = /^\s*([A-Za-z_-]+):\s*(.*)$/.exec(line);
    byType[type] = byType[type] || [];
    if (dash) {
      const body = dash[1].trim();
      const inline = /^id:\s*(.+)$/.exec(body);
      byType[type].push(inline ? { id: unquote(inline[1].trim()), status: null } : { id: unquote(body), status: null });
    } else if (kv && kv[1] === 'status' && byType[type].length) {
      byType[type][byType[type].length - 1].status = unquote(kv[2].trim());
    }
  }
  return byType;
}

// The node itself and every node above it, nearest last — the chain an aspect cascades down.
function nodeAncestry(root, node) {
  const parts = String(node).split('/').filter(Boolean);
  const chain = [];
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('/');
    if (existsSync(join(yggdrasilNodeDir(root, path), 'yg-node.yaml'))) chain.push(path);
  }
  return chain;
}

function rulesFromGraphFiles(root, cfg, node) {
  const typeAspects = parseArchitectureTypeAspects(readText(join(root, '.yggdrasil', 'yg-architecture.yaml')));
  const found = new Map();
  const attach = (id, declaredStatus, via) => {
    const defaults = aspectDefaults(root, id);
    const status = strongerStatus(declaredStatus || null, defaults.status);
    const existing = found.get(id);
    if (existing) {
      existing.status = strongerStatus(existing.status, status);
      if (!existing.via.includes(via)) existing.via.push(via);
      return;
    }
    found.set(id, {
      id, status, description: defaults.description || '', via: [via],
    });
  };
  for (const ancestor of nodeAncestry(root, node)) {
    const y = readYggdrasilNode(root, ancestor);
    if (!y) continue;
    const here = ancestor === node;
    for (const a of y.aspects) {
      attach(a.id, a.status, here ? 'this node' : `cascades from node ${ancestor}`);
    }
    for (const a of typeAspects[y.type] || []) {
      attach(a.id, a.status, here ? `type ${y.type}` : `type ${y.type}, on node ${ancestor}`);
    }
  }
  return {
    source: 'the graph files (no Yggdrasil CLI on this machine — flows, ports and implied aspects are not resolved here)',
    aspects: [...found.values()].map((a) => ({ ...a, via: a.via.join(' · ') })),
  };
}

// The section a node's charter carries naming the rules that reach its files from above — written
// by whoever generated the graph, not by this tool, and reproduced verbatim when it is there.
export function charterInheritedRules(charterText) {
  if (!charterText) return null;
  const idx = charterText.search(/^##\s+Rules inherited from above\s*$/m);
  if (idx === -1) return null;
  const rest = charterText.slice(idx);
  const next = rest.indexOf('\n## ', 1);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

// The rules in force on one node, however they can be got at. Manual mode has no aspects at all —
// the node map carries no rules, and saying so is the honest answer, not an empty list.
export function nodeRules(root, cfg, node) {
  if (mode(cfg) !== 'yggdrasil') {
    return {
      source: 'the horde\'s own node map, which carries no rules — this node\'s charter and its contracts are its law',
      aspects: [],
    };
  }
  return rulesFromYg(root, cfg, node) || rulesFromGraphFiles(root, cfg, node);
}

export function renderRules(rules, inherited) {
  const lines = [`_Resolved from: ${rules.source}_`, ''];
  if (rules.aspects.length === 0) {
    lines.push('- (no rule reaches this node)');
  } else {
    for (const a of rules.aspects) {
      const meaning = STATUS_MEANING[a.status] || 'unknown status';
      lines.push(`- **${a.id}** [${a.status}] — ${meaning}${a.description ? `. ${a.description}` : ''}${a.via ? ` _(${a.via})_` : ''}`);
    }
  }
  if (inherited) lines.push('', inherited);
  return lines.join('\n');
}

// ---- operational graph.json: proposals + contracts + stamps ---------------

function graphJsonPath(horde) {
  return hordePath(horde, 'graph.json');
}

function loadGraph(horde) {
  const doc = readJSON(graphJsonPath(horde), null);
  return {
    proposals: doc && Array.isArray(doc.proposals) ? doc.proposals : [],
    contracts: doc && Array.isArray(doc.contracts) ? doc.contracts : [],
    stamps: doc && doc.stamps && typeof doc.stamps === 'object' ? doc.stamps : {},
  };
}

function saveGraph(horde, graph) {
  writeJSON(graphJsonPath(horde), graph);
}

function nextId(items) {
  let max = 0;
  for (const it of items) { const n = Number(it.id); if (Number.isFinite(n)) max = Math.max(max, n); }
  return String(max + 1);
}

// ---- contracts.md rendering (per node, from graph.json — the source of truth) --

function renderContractsTable(node, contracts) {
  const rows = contracts.filter((c) => c.a === node || c.b === node);
  const lines = [
    `# Contracts · ${node}`, '',
    '| id | with | promise | expressed as | status |', '|---|---|---|---|---|',
  ];
  if (rows.length === 0) lines.push('| | | | | |');
  for (const c of rows) {
    const other = c.a === node ? c.b : c.a;
    lines.push(`| ${c.id} | ${other} | ${c.text} | ${c.as} | ${c.status} |`);
  }
  return lines.join('\n') + '\n';
}

function writeContractsMd(root, cfg, horde, node, contracts) {
  if (!nodeExists(root, cfg, node)) return; // nothing to write beside yet
  writeText(nodeContractsPath(root, cfg, node), renderContractsTable(node, contracts));
}

// ---- commands ---------------------------------------------------------------

// Writes a take-over to the node's own log for real (never merely prints the command, unlike
// cmdLog's default) — a --take is something that already happened, not something an agent still
// needs to go and do. Best-effort: a node id leased before its graph object exists (or a
// repository whose `yg` isn't on PATH) has nothing to append to, and the lease itself — recorded
// in .horde/leases.json's own history — is the durable record either way, so this never blocks
// the take-over on the node's log succeeding.
function logNodeTakeover(root, cfg, node, reason) {
  try {
    if (mode(cfg) === 'yggdrasil') {
      const yg = ygCommand(cfg);
      execFileSync(yg.cmd, [...yg.prefix, 'log', 'add', '--node', node, '--reason', reason], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    }
    if (!nodeExists(root, cfg, node)) return false;
    appendText(join(manualNodeDir(root, cfg, node), 'log.md'), `## [${nowIso()}]\n${reason}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function cmdBind(horde, root, cfg, positional, flags) {
  const node = positional[0];
  if (!node) {
    const nodes = listAllNodes(root, cfg);
    emit({ mode: mode(cfg), nodes }, flags, () => `graph readable (${mode(cfg)}) — ${nodes.length} node(s): ${nodes.join(', ') || '(none)'}`);
    return;
  }

  let result;
  try {
    result = claimLease(horde, node, { take: !!flags.take, escalation: flags.escalation || null });
  } catch (e) {
    fail(e.message);
    return;
  }

  if (result.status === 'held') {
    emit(result, flags, () => `"${node}" is already leased by "${horde}" (since ${result.since})`);
    return;
  }
  if (result.status === 'taken') {
    const reason = `took the lease on "${node}" from horde "${result.from}" over escalation ${result.escalation}: ${result.ruling}`;
    const logged = logNodeTakeover(root, cfg, node, reason);
    emit({ ...result, logged }, flags, () => `"${node}" taken from "${result.from}" over escalation ${result.escalation} — ${logged ? 'logged on the node' : 'recorded in the lease history only (no node log to append to)'}`);
    return;
  }
  emit(result, flags, () => (result.freedFrom
    ? `"${node}" bound to "${horde}" — its previous lease by archived horde "${result.freedFrom}" is released`
    : `"${node}" bound to "${horde}"`));
}

// Nodes "this mission touches": named by an owner in the roster, or by a ticket anywhere under
// teams/**/issues/*/issue.md (walked recursively for sub-teams).
// Exported for status.mjs's leases block: the nodes this horde touches are exactly the set a
// foreign lease on one of them would matter to. root/cfg are accepted but unused — kept so the
// signature matches every other node-reading export's own (horde, root, cfg) shape.
export function missionNodes(horde, root, cfg) {
  const nodes = new Set();
  const roster = readJSON(hordePath(horde, 'roster.json'), { entries: [] });
  for (const e of asArray(roster.entries)) {
    if (e.role === 'owner' && e.node) nodes.add(e.node);
  }
  const teamsRoot = hordePath(horde, 'teams');
  const walk = (teamDir) => {
    const issuesDir = join(teamDir, 'issues');
    if (existsSync(issuesDir)) {
      for (const d of readdirSync(issuesDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const text = readText(join(issuesDir, d.name, 'issue.md'));
        for (const n of ticketNodes(text)) nodes.add(n);
      }
    }
    const subTeamsDir = join(teamDir, 'teams');
    if (existsSync(subTeamsDir)) {
      for (const d of readdirSync(subTeamsDir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(join(subTeamsDir, d.name));
      }
    }
  };
  if (existsSync(teamsRoot)) {
    for (const d of readdirSync(teamsRoot, { withFileTypes: true })) {
      if (d.isDirectory()) walk(join(teamsRoot, d.name));
    }
  }
  return [...nodes].sort();
}

// The **Node:** field of a rendered ticket.md — one node, or several comma-separated for a
// contract ticket (`tk.mjs new` accepts a repeatable --node; nothing in the shared templates
// fixes a multi-node separator, so this reads the plain, unambiguous one: comma-separated).
export function ticketNodes(issueText) {
  if (!issueText) return [];
  const m = /\*\*Node:\*\*\s*([^·\n]+)·/.exec(issueText) || /\*\*Node:\*\*\s*([^\n]+)/.exec(issueText);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function ownerOf(horde, node) {
  const roster = readJSON(hordePath(horde, 'roster.json'), { entries: [] });
  const owners = asArray(roster.entries).filter((e) => e.role === 'owner' && e.node === node && e.state !== 'dead' && e.state !== 'retired');
  return owners.length ? owners[owners.length - 1].name : '-';
}

function stampOf(root, cfg, horde, node) {
  if (mode(cfg) === 'yggdrasil') {
    const graph = loadGraph(horde);
    return graph.stamps[node] ? `${graph.stamps[node].sha} (horde-recorded — see yg check for the graph's own status)` : 'graph-managed — see yg check';
  }
  const n = readManualNode(root, cfg, node);
  return n && n.verifiedAt ? `${n.verifiedAt.sha} @ ${n.verifiedAt.at}` : 'unverified';
}

function cmdMap(horde, root, cfg, flags) {
  const nodes = missionNodes(horde, root, cfg);
  const graph = loadGraph(horde);
  const rows = nodes.map((node) => ({
    node,
    owner: ownerOf(horde, node),
    stamp: stampOf(root, cfg, horde, node),
    openProposals: graph.contracts.filter((c) => (c.a === node || c.b === node) && c.status === 'proposed').length,
  }));
  emit(rows, flags, () => {
    if (rows.length === 0) return '(no nodes touched yet)';
    return rows.map((r) => `${r.node}  owner=${r.owner}  stamp=${r.stamp}  open-proposals=${r.openProposals}`).join('\n');
  });
}

function cmdShow(horde, root, cfg, positional, flags) {
  const node = positional[0];
  if (!node) fail('show requires <node>');
  if (!nodeExists(root, cfg, node)) fail(`no such node: ${node}`);
  const boundary = nodeBoundary(root, cfg, node);
  const charter = readNodeCharterText(root, cfg, node) || '(no charter yet)';
  const contracts = readNodeContractsText(root, cfg, node) || renderContractsTable(node, loadGraph(horde).contracts);
  let log = '(no log yet)';
  if (mode(cfg) === 'yggdrasil') {
    try {
      const { cmd, prefix } = ygCommand(cfg);
      log = execFileSync(cmd, [...prefix, 'log', 'read', '--node', node], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() || log;
    } catch { /* yg not on PATH or no entries yet — keep the placeholder */ }
  } else {
    const text = readText(join(manualNodeDir(root, cfg, node), 'log.md'));
    if (text) log = text.trim();
  }
  const stamp = stampOf(root, cfg, horde, node);
  const rules = nodeRules(root, cfg, node);
  const inherited = charterInheritedRules(readNodeCharterText(root, cfg, node));
  const result = {
    node, boundary, stamp, rules: { ...rules, charterInherited: inherited }, charter, contracts, log,
  };
  emit(result, flags, () => [
    `# ${node}`, '',
    `**Boundary:** ${boundary.join(', ') || '(none)'}`,
    `**Stamp:** ${stamp}`, '',
    '## Rules — what this node\'s code must satisfy', '',
    renderRules(rules, inherited), '',
    '## Charter', charter, '',
    '## Contracts', contracts, '',
    '## Log', log,
  ].join('\n'));
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function cmdCharterEdit(horde, root, cfg, positional, flags) {
  const node = positional[0];
  if (!node) fail('charter edit requires <node>');
  const stdin = readStdin();
  const exists = nodeExists(root, cfg, node);
  let content = stdin;
  if (!content.trim()) {
    if (exists) fail('charter edit requires content on stdin');
    content = renderTemplate('node-charter', {
      node, owner: '(unassigned)', class: '(unassigned)', lease: '(unassigned)',
    });
  }
  if (!exists) {
    if (mode(cfg) === 'manual') {
      writeJSON(manualNodeJsonPath(root, cfg, node), { id: node, boundary: [], dependsOn: [], verifiedAt: null });
      writeText(nodeContractsPath(root, cfg, node), renderContractsTable(node, loadGraph(horde).contracts));
      writeText(join(manualNodeDir(root, cfg, node), 'log.md'), `# Log · ${node}\n\n`);
    } else {
      fail(`no such node in the Yggdrasil graph: ${node} — a new node is filed with \`yg\` by the architect, not seeded here`);
    }
  }
  writeText(nodeCharterPath(root, cfg, node), content);
  emit({ node, bytes: content.length }, flags, () => `charter written: ${node} (${content.length} bytes)`);
}

function cmdLog(horde, root, cfg, positional, flags) {
  const [node, reason] = positional;
  if (!node || !reason) fail('log requires <node> "<reason>"');
  if (mode(cfg) === 'yggdrasil') {
    const yg = ygCommand(cfg);
    const cmd = `${yg.display} log add --node ${node} --reason "${reason.replace(/"/g, '\\"')}"`;
    if (flags.run) {
      try {
        execFileSync(yg.cmd, [...yg.prefix, 'log', 'add', '--node', node, '--reason', reason], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        fail(`yg log add failed: ${e.message}`);
      }
      emit({ node, reason, ran: true }, flags, () => `ran: ${cmd}`);
      return;
    }
    emit({ node, reason, command: cmd }, flags, () => cmd);
    return;
  }
  if (!nodeExists(root, cfg, node)) fail(`no such node: ${node}`);
  appendText(join(manualNodeDir(root, cfg, node), 'log.md'), `## [${nowIso()}]\n${reason}\n\n`);
  emit({ node, reason }, flags, () => `logged: ${node}`);
}

function cmdStamp(horde, root, cfg, positional, flags) {
  const [node, sha] = positional;
  if (!node || !sha) fail('stamp requires <node> <sha>');
  if (mode(cfg) === 'yggdrasil') {
    emit(
      { node, sha, written: false },
      flags,
      () => `Yggdrasil computes its own verification status for ${node} — this is not written here. `
        + `Run \`yg check --node ${node}\` (or \`yg aspect-test --node ${node}\`) to refresh it.`,
    );
    return;
  }
  if (!nodeExists(root, cfg, node)) fail(`no such node: ${node}`);
  const n = readManualNode(root, cfg, node);
  n.verifiedAt = { sha, at: nowIso() };
  writeJSON(manualNodeJsonPath(root, cfg, node), n);
  emit({ node, sha }, flags, () => `stamped: ${node} @ ${sha}`);
}

// ---- contracts --------------------------------------------------------------

function cmdContractPropose(horde, root, cfg, positional, flags) {
  const [a, b, text] = positional;
  if (!a || !b || !text) fail('contract propose requires <a> <b> "<text>"');
  if (!flags.as) fail('contract propose requires --as <test-or-scenario-path>');
  const graph = loadGraph(horde);
  const entry = {
    id: nextId(graph.contracts), a, b, as: flags.as, text, status: 'proposed', by: flags.by || null, at: nowIso(),
  };
  graph.contracts.push(entry);
  saveGraph(horde, graph);
  writeContractsMd(root, cfg, horde, a, graph.contracts);
  writeContractsMd(root, cfg, horde, b, graph.contracts);
  emit(entry, flags, () => `contract proposed: [${entry.id}] ${a} <-> ${b}`);
}

function cmdContractRule(horde, root, cfg, positional, flags, verdict) {
  const [id, why] = positional;
  if (!id) fail(`contract ${verdict === 'approved' ? 'approve' : 'veto'} requires <id>`);
  if (!flags.by) fail('--by is required');
  const graph = loadGraph(horde);
  const c = graph.contracts.find((x) => x.id === id);
  if (!c) fail(`no such contract: ${id}`);
  if (c.status !== 'proposed') fail(`contract ${id} is already ${c.status}`);
  c.status = verdict;
  c.ruling = why || null;
  c.rulingBy = flags.by;
  c.ruledAt = nowIso();
  saveGraph(horde, graph);
  writeContractsMd(root, cfg, horde, c.a, graph.contracts);
  writeContractsMd(root, cfg, horde, c.b, graph.contracts);
  traceRoster(horde, flags.by);
  emit(c, flags, () => `contract ${id} ${verdict}`);
}

function cmdContracts(horde, positional, flags) {
  const graph = loadGraph(horde);
  let rows = graph.contracts;
  if (flags.pending) rows = rows.filter((c) => c.status === 'proposed');
  if (flags.node) rows = rows.filter((c) => c.a === flags.node || c.b === flags.node);
  emit(rows, flags, () => {
    if (rows.length === 0) return '(none)';
    return rows.map((c) => `[${c.id}] ${c.a} <-> ${c.b}  ${c.status}  ${c.text}`).join('\n');
  });
}

// ---- graph-change proposals ---------------------------------------------------

const PROPOSAL_KINDS = ['new-node', 'move-boundary', 'rename', 'rule'];

function parseBoundaryList(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function cmdPropose(horde, positional, flags) {
  const [kind, text] = positional;
  if (!kind || !text) fail(`propose requires <kind> "<text>" (kinds: ${PROPOSAL_KINDS.join(', ')})`);
  if (!PROPOSAL_KINDS.includes(kind)) fail(`unknown kind: ${kind} (kinds: ${PROPOSAL_KINDS.join(', ')})`);
  if (!flags.by) fail('propose requires --by <owner>');
  if (kind === 'move-boundary' && (!flags.node || !flags.boundary)) {
    fail('propose move-boundary requires --node <n> --boundary <glob>[,glob…], so apply can carry it out');
  }
  const graph = loadGraph(horde);
  const entry = {
    id: nextId(graph.proposals),
    kind,
    text,
    by: flags.by,
    status: 'open',
    at: nowIso(),
    node: flags.node || null,
    boundary: flags.boundary ? parseBoundaryList(flags.boundary) : null,
  };
  graph.proposals.push(entry);
  saveGraph(horde, graph);
  emit(entry, flags, () => `proposed: [${entry.id}] ${kind}`);
}

function cmdProposals(horde, flags) {
  const graph = loadGraph(horde);
  let rows = graph.proposals;
  if (flags.open) rows = rows.filter((p) => p.status === 'open');
  emit(rows, flags, () => {
    if (rows.length === 0) return '(none)';
    return rows.map((p) => `[${p.id}] ${p.kind}  ${p.status}  by ${p.by}  ${p.text}`).join('\n');
  });
}

function cmdProposalRule(horde, positional, flags, verdict) {
  const [id, why] = positional;
  if (!id) fail(`${verdict === 'approved' ? 'approve' : 'veto'} requires <id>`);
  if (!flags.by) fail('--by is required');
  const graph = loadGraph(horde);
  const p = graph.proposals.find((x) => x.id === id);
  if (!p) fail(`no such proposal: ${id}`);
  if (p.status !== 'open') fail(`proposal ${id} is already ${p.status}`);
  p.status = verdict;
  p.ruling = why || null;
  p.rulingBy = flags.by;
  p.ruledAt = nowIso();
  saveGraph(horde, graph);
  traceRoster(horde, flags.by);
  emit(p, flags, () => `proposal ${id} ${verdict}`);
}

// ---- manual-only new / apply (yggdrasil prints instead of acting) -----------

function cmdNew(horde, root, cfg, positional, flags) {
  const node = positional[0];
  if (!node) fail('new requires <node>');
  if (!flags.boundary) fail('new requires --boundary <glob>[,glob…]');
  const boundary = parseBoundaryList(flags.boundary);
  const dependsOn = flags.depends ? parseBoundaryList(flags.depends) : [];

  if (mode(cfg) === 'yggdrasil') {
    emit(
      { node, boundary, dependsOn, written: false },
      flags,
      () => `Yggdrasil mode — this does not write a node. Create `
        + `.yggdrasil/model/${node}/yg-node.yaml (mapping: ${boundary.join(', ')}) and add it to `
        + `yg-architecture.yaml; both need the user's explicit confirmation.`,
    );
    return;
  }

  if (nodeExists(root, cfg, node)) fail(`node already exists: ${node}`);
  writeJSON(manualNodeJsonPath(root, cfg, node), { id: node, boundary, dependsOn, verifiedAt: null });
  const charter = renderTemplate('node-charter', {
    node, owner: '(unassigned)', class: '(unassigned)', lease: '(unassigned)',
  });
  writeText(nodeCharterPath(root, cfg, node), charter);
  writeText(nodeContractsPath(root, cfg, node), renderContractsTable(node, loadGraph(horde).contracts));
  writeText(join(manualNodeDir(root, cfg, node), 'log.md'), `# Log · ${node}\n\n`);
  emit({ node, boundary, dependsOn }, flags, () => `node created: ${node}`);
}

// boundary set|add <node> --boundary <glob>… — the one place a manual-mode node's boundary
// changes after `new`, so a move doesn't need going through node.json by hand. "set" replaces
// the list; "add" extends it, de-duplicated.
function cmdBoundary(horde, root, cfg, sub, positional, flags) {
  const node = positional[0];
  if (!node) fail(`boundary ${sub} requires <node>`);
  if (!flags.boundary) fail(`boundary ${sub} requires --boundary <glob>[,glob…]`);
  const globs = parseBoundaryList(flags.boundary);

  if (mode(cfg) === 'yggdrasil') {
    emit(
      { node, boundary: globs, written: false },
      flags,
      () => `Yggdrasil mode — this does not write a node. ${sub === 'set' ? 'Replace' : 'Extend'} the `
        + `mapping: list in .yggdrasil/model/${node}/yg-node.yaml with: ${globs.join(', ')}; `
        + `needs the user's explicit confirmation.`,
    );
    return;
  }

  if (!nodeExists(root, cfg, node)) fail(`no such node: ${node}`);
  const n = readManualNode(root, cfg, node);
  const before = Array.isArray(n.boundary) ? n.boundary : [];
  n.boundary = sub === 'set' ? globs : [...new Set([...before, ...globs])];
  writeJSON(manualNodeJsonPath(root, cfg, node), n);
  appendText(
    join(manualNodeDir(root, cfg, node), 'log.md'),
    `## [${nowIso()}]\nboundary ${sub === 'set' ? 'set to' : 'extended with'}: ${globs.join(', ')}\n\n`,
  );
  emit({ node, boundary: n.boundary }, flags, () => `boundary ${sub}: ${node} -> ${n.boundary.join(', ')}`);
}

function cmdApply(horde, root, cfg, positional, flags) {
  const id = positional[0];
  if (!id) fail('apply requires <proposal-id>');
  const graph = loadGraph(horde);
  const p = graph.proposals.find((x) => x.id === id);
  if (!p) fail(`no such proposal: ${id}`);
  if (p.status !== 'approved') fail(`proposal ${id} is not approved (status: ${p.status})`);
  if (p.appliedAt) fail(`proposal ${id} was already applied`);

  if (mode(cfg) === 'yggdrasil') {
    p.appliedAt = nowIso();
    saveGraph(horde, graph);
    const step = p.kind === 'move-boundary' && p.node && p.boundary
      ? `set ${p.node}'s mapping: to ${p.boundary.join(', ')} in .yggdrasil/model/${p.node}/yg-node.yaml`
      : `edit .yggdrasil/model/**/yg-node.yaml (and yg-architecture.yaml for a new/renamed/moved node)`;
    emit(
      { id, kind: p.kind, applied: true },
      flags,
      () => `proposal ${id} closed — file it into Yggdrasil yourself: ${step}; needs the user's explicit confirmation.`,
    );
    return;
  }

  // A move-boundary proposal carries the target node and the globs it's moving to (required at
  // propose time), so apply can actually rewrite the boundary — not just mark the proposal done
  // and leave the architect to redo by hand what the proposal already specified.
  if (p.kind === 'move-boundary' && p.node && p.boundary) {
    if (!nodeExists(root, cfg, p.node)) fail(`no such node: ${p.node}`);
    const n = readManualNode(root, cfg, p.node);
    n.boundary = p.boundary;
    writeJSON(manualNodeJsonPath(root, cfg, p.node), n);
    appendText(
      join(manualNodeDir(root, cfg, p.node), 'log.md'),
      `## [${nowIso()}]\nboundary moved (proposal ${id}): ${p.boundary.join(', ')}\n\n`,
    );
    p.appliedAt = nowIso();
    saveGraph(horde, graph);
    emit(
      {
        id, kind: p.kind, applied: true, node: p.node, boundary: p.boundary,
      },
      flags,
      () => `proposal ${id} applied — ${p.node}'s boundary set to: ${p.boundary.join(', ')}`,
    );
    return;
  }

  p.appliedAt = nowIso();
  saveGraph(horde, graph);
  const followUp = p.kind === 'new-node'
    ? `run \`node.mjs new <node> --boundary …\` to create the node's files`
    : `edit the node's files directly (\`node.mjs charter edit\`, or \`new\` again is not needed) to realize "${p.text}"`;
  emit({ id, kind: p.kind, applied: true }, flags, () => `proposal ${id} applied (bookkeeping) — ${followUp}`);
}

// ---- main ---------------------------------------------------------------------

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2), { flags: ['run', 'pending', 'open', 'take'] });
  const [cmd, ...rest] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);
  const root = repoRoot();
  const cfg = readConfig() || {};

  if (cmd === 'bind') return cmdBind(horde, root, cfg, rest, flags);
  if (cmd === 'map') return cmdMap(horde, root, cfg, flags);
  if (cmd === 'show') return cmdShow(horde, root, cfg, rest, flags);
  if (cmd === 'charter') {
    if (rest[0] !== 'edit') fail('charter requires "edit"');
    return cmdCharterEdit(horde, root, cfg, rest.slice(1), flags);
  }
  if (cmd === 'log') return cmdLog(horde, root, cfg, rest, flags);
  if (cmd === 'stamp') return cmdStamp(horde, root, cfg, rest, flags);
  if (cmd === 'contract') {
    const [sub, ...subRest] = rest;
    if (sub === 'propose') return cmdContractPropose(horde, root, cfg, subRest, flags);
    if (sub === 'approve') return cmdContractRule(horde, root, cfg, subRest, flags, 'approved');
    if (sub === 'veto') return cmdContractRule(horde, root, cfg, subRest, flags, 'vetoed');
    fail('contract requires "propose", "approve" or "veto"');
  }
  if (cmd === 'contracts') return cmdContracts(horde, rest, flags);
  if (cmd === 'propose') return cmdPropose(horde, rest, flags);
  if (cmd === 'proposals') return cmdProposals(horde, flags);
  if (cmd === 'approve') return cmdProposalRule(horde, rest, flags, 'approved');
  if (cmd === 'veto') return cmdProposalRule(horde, rest, flags, 'vetoed');
  if (cmd === 'new') return cmdNew(horde, root, cfg, rest, flags);
  if (cmd === 'boundary') {
    const [sub, ...subRest] = rest;
    if (sub === 'set' || sub === 'add') return cmdBoundary(horde, root, cfg, sub, subRest, flags);
    fail('boundary requires "set" or "add"');
  }
  if (cmd === 'apply') return cmdApply(horde, root, cfg, rest, flags);
  fail(`unknown command: ${cmd} (see --help)`);
}

if (isMain(import.meta.url)) main();
