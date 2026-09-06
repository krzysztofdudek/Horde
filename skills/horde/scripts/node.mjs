#!/usr/bin/env node
// horde skill — node.mjs
//
// The graph belongs to Yggdrasil, and this is the only tool that speaks to it. Every fact about
// a node comes from one of Yggdrasil's own versioned machine documents, asked for by running the
// CLI (`config.ygCommand`):
//
//   yg node <path> --json            → yg-node/1     structure: mapping, relations, ports, kin
//   yg context --node|--file <p> --json → yg-context/1  the rules in force, with their status
//   yg impact --node <path> --json   → yg-impact/1   who consumes a port, who depends on the node
//
// Nothing here parses a file the layer below owns. A document Yggdrasil does not produce is a
// refusal that names what to upgrade, never a guess from the files — a graph read two ways is a
// graph that can disagree with itself, and the horde would be the one telling the lie.
//
// Writing to the graph is the architect's, through `yg`. What lives here is the horde's own
// process state — port proposals and graph-change proposals, uncommitted, per horde, in
// hordes/<horde>/graph.json — until an approval turns one into a filing the architect makes.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  repoRoot, hordePath, readJSON, writeJSON, readText, writeText, readConfig, nowIso,
  fail, parseArgs, asArray, emit, isMain, resolveHorde, renderTemplate, claimLease,
} from './_lib.mjs';
import { trace as traceRoster } from './roster.mjs';

const USAGE = `usage: node.mjs <command> [options]

commands:
  bind [--horde h]
      verifies the graph is readable through the Yggdrasil CLI; lists every node id.
  bind <node> [--horde h] [--take --escalation <id>]
      node-lease-across-hordes: leases <node> to this horde in .horde/leases.json, exclusive
      across every live horde on the repository. Refuses a node already leased by another horde
      that is not archived, naming that horde and its last activity. --take overrides that
      refusal but only over a ruled escalation on this horde (--escalation <id>); the take-over
      is written to the node's own log as well as to the lease history.
  map [--horde h]
      this mission's nodes (named by an owner in the roster or by a ticket) with owner, the
      ports they publish, and open port proposals.
  show <node> [--horde h]
      boundary, the rules in force on the node (with the status word that says what a refusal
      costs), the ports it publishes with version and test, charter, last log entries.
  charter edit <node> [--horde h]
      writes charter.md beside the node's yg-node.yaml; seeds it from the template first when
      the node has none yet and stdin is empty.
  log <node> "<reason>" [--run] [--horde h]
      prints the "yg log add --reason" command for the node's own log; runs it too with --run.
  contract propose <node> <port> "<text>" --as <test-path> [--version <n>] --by <owner> [--horde h]
      port-is-contract: proposes adding a port to a node, or bumping the version of one it
      already publishes. --as names the test that IS the contract. --version defaults to the
      next version above what the node publishes today.
  contract approve <id> ["why"] --by <name> [--horde h]
  contract veto <id> "why" --by <name> [--horde h]
      the architect rules on a port proposal; an approved one is filed by editing the node's
      yg-node.yaml and recording the why with "yg log add" — the command prints both.
  contracts [--pending] [--node n] [--horde h]
      the ports of this mission's nodes as the graph declares them (name, version, test), plus
      every port proposal this horde has open.
  verdicts [--at <path>] [--by <name>] [--horde h]
      the prose rules still waiting on a judgement in a tree, each with the exact
      "yg verdict package" and "yg verdict record" commands that judge it. --at names the
      worktree to read (default: this one).
  propose <kind> "<text>" --by <owner> [--node n] [--boundary <glob>[,glob…]] [--horde h]
      kinds: new-node, move-boundary, rename, rule. move-boundary requires --node and --boundary
      so apply can name the exact edit later, not just record that it happened.
  proposals [--open] [--horde h]
  approve <id> ["why"] --by <name> [--horde h]
  veto <id> "why" --by <name> [--horde h]
  apply <proposal-id> [--horde h]
      closes an approved graph-change proposal and prints the filing steps for the architect.

options: --json  --help`;

// ---- talking to the Yggdrasil CLI ------------------------------------------------------------

// How this repository invokes the Yggdrasil CLI: `config.ygCommand`, default the bare `yg` on
// PATH. Written as a command line ("yg", "node ./yg/bin.js") so a checkout that runs a local
// build needs no other change; split into a program plus its fixed leading arguments here, once,
// for every call site.
export function ygCommand(cfg) {
  const raw = (cfg && cfg.ygCommand) || 'yg';
  const parts = String(raw).trim().split(/\s+/).filter(Boolean);
  return { cmd: parts[0] || 'yg', prefix: parts.slice(1), display: parts.join(' ') || 'yg' };
}

// The release these machine documents arrived in. They are not in 5.8.0; a CLI that answers
// `--json` with anything but the document is one from before them, and the horde says which
// release to pass rather than degrading into reading the graph's files itself.
const YG_DOCUMENTS_AFTER = '5.8.0';

const YG_DOCUMENTS = 'yg-node/1, yg-context/1 and yg-impact/1';

function ygVersion(cfg) {
  const { cmd, prefix } = ygCommand(cfg);
  try {
    return execFileSync(cmd, [...prefix, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// The refusal for a CLI that cannot be started at all. Horde requires Yggdrasil: there is no
// second graph to fall back to, so this is a stop, not a degraded mode.
function failNoCli(cfg, command) {
  const { display } = ygCommand(cfg);
  fail(
    `\`${command}\` could not be started — there is no Yggdrasil CLI at "${display}".\n`
    + 'Horde reads the architecture graph only through that CLI, so without it there is nothing to '
    + 'read a node, its rules or its ports from.\n'
    + 'Install it (npm i -g @chrisdudek/yg), or point the horde at a local build: '
    + 'horde.mjs config set ygCommand "node path/to/bin.js"',
  );
}

// The refusal for a CLI that runs but predates the machine documents. `docs` names whichever
// document set this call site reads (defaulting to the three read all over this file); the
// quality index reads a different pair (yg-check/1, yg-aspects/1) and names those instead, so the
// message never claims a CLI is missing documents it never asked for.
function failStaleCli(cfg, command, saw, docs = YG_DOCUMENTS) {
  const { display } = ygCommand(cfg);
  const version = ygVersion(cfg);
  fail(
    `\`${command}\` did not answer with the document Horde reads${saw ? ` (${saw})` : ''}.\n`
    + `The Yggdrasil CLI at "${display}"${version ? ` reports version ${version} and` : ''} predates `
    + `${docs} — the versioned answers Horde reads the graph through. An older CLI cannot be `
    + 'read around: the alternative would be Horde reading the graph a second, fragile way — its own '
    + 'files, or a report meant to be read, parsed as data — which is exactly what these documents '
    + 'exist to remove.\n'
    + `Upgrade to a release later than ${YG_DOCUMENTS_AFTER} (npm i -g @chrisdudek/yg), or point the `
    + 'horde at a newer build: horde.mjs config set ygCommand "node path/to/bin.js"',
  );
}

// Starting the CLI, once. Three outcomes are told apart because they mean different things:
// the program ran and said something (whatever its exit code), the program does not exist, and
// the machine could not start a process at all. The last is not an answer about anything — it
// happens under load, and reading it as "the graph refuses" would turn a busy laptop into an
// architecture verdict — so it is retried once and then named for what it is.
function startCli(cmd, args, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { out: execFileSync(cmd, args, opts), code: 0, err: '' };
    } catch (e) {
      if (e.code === 'ENOENT') return { missing: true };
      const exited = e.status !== undefined && e.status !== null;
      if (exited) {
        return {
          code: e.status,
          out: (e.stdout && e.stdout.toString()) || '',
          err: (e.stderr && e.stderr.toString()) || '',
        };
      }
      if (attempt === 1) return { spawnFailed: e.code || e.message };
    }
  }
  return { spawnFailed: 'unknown' };
}

// One call to the CLI asking for one machine document. Returns a state rather than throwing, so
// each caller decides what "absent" means for it: a node the graph does not have is an ordinary
// answer, while a missing or too-old CLI is a stop.
//
//   ok      — the document, with the schema it claimed
//   absent  — the CLI ran and said the graph has no such node
//   no-cli  — the CLI could not be started
//   stale   — the CLI ran and answered something that is not the document
//   error   — the CLI ran and refused for its own reason (a graph that does not load, say)
function ygJson(root, cfg, args, schema) {
  const { cmd, prefix, display } = ygCommand(cfg);
  const command = `${display} ${args.join(' ')}`;
  const run = startCli(cmd, [...prefix, ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.missing) return { state: 'no-cli', command };
  if (run.spawnFailed) {
    return {
      state: 'error',
      command,
      code: null,
      detail: `this machine could not start the process (${run.spawnFailed}), twice — nothing was `
        + 'read, and this says nothing about the graph. Try again with less running at once.',
    };
  }
  const { code, err } = run;
  const out = run.out;
  const body = out.trim();
  if (body.startsWith('{')) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    if (parsed && parsed.schema === schema) return { state: 'ok', command, doc: parsed };
    if (parsed) return { state: 'stale', command, saw: `it answered a "${parsed.schema || 'nameless'}" document, not ${schema}` };
  }
  if (/does not exist in the graph/.test(err)) return { state: 'absent', command };
  if (/unknown option|unknown command/i.test(err)) return { state: 'stale', command, saw: 'it does not know that option' };
  if (code === 0) return { state: 'stale', command, saw: 'it answered no document at all' };
  return { state: 'error', command, code, detail: (err || body).trim() };
}

// The same call, with every state that is not an answer about this node turned into a stop.
function ygDoc(root, cfg, args, schema) {
  const res = ygJson(root, cfg, args, schema);
  if (res.state === 'ok') return res.doc;
  if (res.state === 'absent') return null;
  if (res.state === 'no-cli') failNoCli(cfg, res.command);
  if (res.state === 'stale') failStaleCli(cfg, res.command, res.saw);
  fail(res.code === null
    ? `\`${res.command}\` — ${res.detail}`
    : `\`${res.command}\` exited ${res.code} — the graph could not be read:\n${res.detail}`);
  return null;
}

// A node's own document. Probed once per node per process: a plan asks about the same node many
// times and the answer cannot change mid-run.
const nodeCache = new Map();
export function ygNode(root, cfg, node) {
  if (nodeCache.has(node)) return nodeCache.get(node);
  const doc = ygDoc(root, cfg, ['node', node, '--json'], 'yg-node/1');
  nodeCache.set(node, doc);
  return doc;
}

// `yg context --node <p> --json` — the rules in force on a node, with the effective status each
// one carries and the channel it reaches the node by. Yggdrasil's own resolution: it accounts
// for every channel (node, cascade, type, ancestor type, flow, port, implies) and for `when:`
// filters, none of which can be worked out from a node's own file.
//
// A graph the CLI itself refuses to assemble a context from — a mapping naming a file nobody
// wrote, say — is not something to abort a read on: the CLI's own words are the answer, and the
// merge gate refuses on the same problem for its own reasons. A missing or too-old CLI is still a
// stop, because that is not an answer at all.
const contextCache = new Map();
export function ygContext(root, cfg, node) {
  if (contextCache.has(node)) return contextCache.get(node);
  const res = ygJson(root, cfg, ['context', '--node', node, '--json'], 'yg-context/1');
  if (res.state === 'no-cli') failNoCli(cfg, res.command);
  if (res.state === 'stale') failStaleCli(cfg, res.command, res.saw);
  const out = res.state === 'ok'
    ? { doc: res.doc }
    : { doc: null, why: res.state === 'absent' ? `the graph has no component '${node}'` : res.detail };
  contextCache.set(node, out);
  return out;
}

// The same document for one file — it names the component that owns the file as well as the
// rules that reach it, which is the one question `blame` asks and the graph alone can answer.
// A file no component owns is an ordinary answer here (`owner.kind` is not "node"), not a stop.
const fileContextCache = new Map();
export function ygFileContext(root, cfg, relFile) {
  if (fileContextCache.has(relFile)) return fileContextCache.get(relFile);
  const res = ygJson(root, cfg, ['context', '--file', relFile, '--json'], 'yg-context/1');
  let doc = null;
  if (res.state === 'ok') doc = res.doc;
  else if (res.state === 'no-cli') failNoCli(cfg, res.command);
  else if (res.state === 'stale') failStaleCli(cfg, res.command, res.saw);
  fileContextCache.set(relFile, doc);
  return doc;
}

// `yg impact --node <path> --json` — Yggdrasil's own answer to "who depends on this node".
const impactCache = new Map();
export function ygImpact(root, cfg, node) {
  if (impactCache.has(node)) return impactCache.get(node);
  const doc = ygDoc(root, cfg, ['impact', '--node', node, '--json'], 'yg-impact/1');
  impactCache.set(node, doc);
  return doc;
}

// Runs `yg check` in one worktree and reports what it found. Never approves anything (that fills
// the lock and can cost money); `check` alone is read-only and keyless. `available: false` means
// the CLI itself could not be started — a different failure from a graph that refuses the tree,
// and the caller says so in those words.
export function runYgCheck(cfg, cwd, extra = []) {
  const { cmd, prefix, display } = ygCommand(cfg);
  const args = ['check', ...extra];
  const command = `${display} ${args.join(' ')}`;
  const run = startCli(cmd, [...prefix, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.missing || run.spawnFailed) {
    return { available: false, ok: false, command, summary: null, out: '' };
  }
  const status = run.code;
  const out = run.out + run.err;
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const verdictLine = lines.find((l) => /^yg check:/.test(l));
  const errorLine = lines.find((l) => /^(enforced|Errors)\b/.test(l));
  return {
    available: true,
    ok: status === 0,
    exit: status,
    command,
    out,
    summary: verdictLine || errorLine || lines[lines.length - 1] || null,
  };
}

// ---- the prose rules a judge still owes a verdict on -----------------------------------------
//
// verifier-is-yggdrasil-reviewer: the free half of a graph gate is `yg check --approve
// --only-deterministic`, which records every verdict a script can reach, costs nothing and needs
// no key. What it leaves behind is the prose rules — the pairs a reader has to judge — and in a
// horde the reader is the verifier, judging under its own name through Yggdrasil's external-judge
// channel. These two functions are how the tools name that work: run the free half, then list
// exactly what is left.

// The free half. Always allowed, in any worktree, before any gate is judged.
export function fillDeterministic(cfg, cwd) {
  const { cmd, prefix, display } = ygCommand(cfg);
  const args = ['check', '--approve', '--only-deterministic'];
  const command = `${display} ${args.join(' ')}`;
  const run = startCli(cmd, [...prefix, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.missing || run.spawnFailed) return { available: false, ok: false, command, out: '' };
  return {
    available: true, ok: run.code === 0, exit: run.code, command, out: run.out + run.err,
  };
}

// `unverified  <node>  No valid verdict for aspect '<id>' on <kind>:<path>.` — the line
// `yg check --details` prints, one block per pair, for a pair the lock holds no valid verdict for.
const PENDING_RE = /No valid verdict for aspect '([^']+)' on (file|node):(.+?)\.\s*$/;

// Which pairs are prose is not guessed from what is left over: the graph says so itself. Each
// unit's context document names every rule reaching it and the kind of reviewer it takes, so a
// pending pair is sorted by the graph's own word — `llm` is a judgement somebody has to make, and
// anything else is a script that has simply not been run yet. Sorting by elimination instead would
// call a script rule a prose one on any tree where the free run had not happened, and send a
// verifier off to judge what a command answers for nothing.
export function pendingProsePairs(cfg, cwd) {
  const res = runYgCheck(cfg, cwd, ['--details']);
  if (!res.available) {
    return {
      available: false, command: res.command, pairs: [], scriptPending: [],
    };
  }
  const candidates = [];
  const seen = new Set();
  for (const raw of (res.out || '').split('\n')) {
    const m = PENDING_RE.exec(raw.trim());
    if (!m) continue;
    const key = `${m[1]} ${m[2]} ${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ aspect: m[1], unitKind: m[2], unit: m[3] });
  }

  const docs = new Map();
  const kindOf = (pair) => {
    const key = `${pair.unitKind}:${pair.unit}`;
    if (!docs.has(key)) {
      const args = pair.unitKind === 'node'
        ? ['context', '--node', pair.unit, '--json']
        : ['context', '--file', pair.unit, '--json'];
      const answer = ygJson(cwd, cfg, args, 'yg-context/1');
      docs.set(key, answer.state === 'ok' ? answer.doc : null);
    }
    const doc = docs.get(key);
    if (!doc) return null;
    const found = asArray(doc.aspects).find((a) => a && a.id === pair.aspect);
    return found ? found.kind : null;
  };

  const pairs = [];
  const scriptPending = [];
  for (const pair of candidates) {
    if (kindOf(pair) === 'llm') pairs.push(pair);
    else scriptPending.push(pair);
  }
  return {
    available: true, command: res.command, green: res.ok, pairs, scriptPending,
  };
}

// The two commands that judge one pending pair, in the order they are run: the package names the
// hash, and the record is bound to it. Written out in full so a verifier copies rather than
// composes — the hash is the one field it cannot invent.
export function verdictCommandsFor(cfg, pair, judge) {
  const { display } = ygCommand(cfg);
  const unit = `--${pair.unitKind} ${pair.unit}`;
  return {
    package: `${display} verdict package --aspect ${pair.aspect} ${unit}`,
    record: `${display} verdict record --aspect ${pair.aspect} ${unit} --by ${judge || '<your name>'} `
      + '--verdict pass|refused --hash <hashes.pass or hashes.refused from the package> '
      + '[--report "<what it breaks, with file:line>"]',
  };
}

// ---- the quality index ----------------------------------------------------------------------
//
// Six numbers that say whether the graph got stronger or weaker over a wave, read from the two
// machine documents the installed Yggdrasil CLI answers with: `check --json` (`yg-check/1`) and
// `aspects --json` (`yg-aspects/1`). This used to parse the two commands' own text report — the
// exact fragility ticket 147 removed everywhere else in this file — so a CLI whose document does
// not carry `schema: "yg-check/1"` (or `"yg-aspects/1"`) is refused with the release to upgrade
// to, never silently read as text again.
//
//   enforced       rules at status "enforced" — the law that actually blocks (yg-aspects/1)
//   advisoryClean  advisory rules this run recorded nothing but "approved" pairs for, of all
//                  advisory rules — a pair the lock does not approve (refused, unverified, stale,
//                  too large, a companion error) is "something against it" (yg-check/1 pairs)
//   baseline       findings that block right now (yg-check/1 totals.errors)
//   noiseFloor     findings that only warn (yg-check/1 totals.warnings) — the standing noise
//   coverage       files a component owns, of all files the graph can see (yg-check/1 coverage)
//   judges         distinct external judges a verdict in force rests on (yg-check/1 judges) —
//                  verifier-is-yggdrasil-reviewer's own count of who is answering outside the
//                  configured reviewer; not part of what "fell" means below, shown for the record
//
// Higher enforced / advisoryClean / coverage and lower baseline / noiseFloor is a stronger
// graph; wave.mjs close compares two readings and escalates when any of those five moved the
// wrong way. `totals.verdicts`, the full `coverage` block and `progressive` (present only on a
// project that measures changes against a branch) are carried through on the returned object for
// a caller that wants more than the six headline figures; wave.mjs's own printed line does not
// grow past them.

const YG_QUALITY_DOCUMENTS = 'yg-check/1 and yg-aspects/1';

// ygQualityIndex(cfg, cwd) — the reading above, taken on the tree at `cwd`. `available: false`
// means the CLI could not be started at all, which is a different answer from a graph that
// refuses the tree: a red check still yields a perfectly good index (that is what a baseline of
// blocking findings IS). Never approves anything — `check --json` and `aspects --json` are both
// read-only and keyless, so this costs nothing and needs no key.
export function ygQualityIndex(cfg, cwd) {
  const checkRes = ygJson(cwd, cfg, ['check', '--json'], 'yg-check/1');
  if (checkRes.state === 'no-cli') {
    return { available: false, command: checkRes.command, why: 'the Yggdrasil CLI could not be started' };
  }
  if (checkRes.state === 'stale') failStaleCli(cfg, checkRes.command, checkRes.saw, YG_QUALITY_DOCUMENTS);
  if (checkRes.state !== 'ok') {
    fail(checkRes.code == null
      ? `\`${checkRes.command}\` — ${checkRes.detail}`
      : `\`${checkRes.command}\` exited ${checkRes.code} — the graph could not be read:\n${checkRes.detail}`);
  }
  const check = checkRes.doc;

  const aspectsRes = ygJson(cwd, cfg, ['aspects', '--json'], 'yg-aspects/1');
  if (aspectsRes.state === 'no-cli') {
    return { available: false, command: aspectsRes.command, why: 'the Yggdrasil CLI could not be started' };
  }
  if (aspectsRes.state === 'stale') failStaleCli(cfg, aspectsRes.command, aspectsRes.saw, YG_QUALITY_DOCUMENTS);
  if (aspectsRes.state !== 'ok') {
    fail(aspectsRes.code == null
      ? `\`${aspectsRes.command}\` — ${aspectsRes.detail}`
      : `\`${aspectsRes.command}\` exited ${aspectsRes.code} — the graph could not be read:\n${aspectsRes.detail}`);
  }
  const aspectList = asArray(aspectsRes.doc.aspects);

  const advisory = aspectList.filter((a) => a.status === 'advisory');
  // "Nothing against it" is read off the lock's own verdicts: an advisory aspect with any pair
  // the lock does not currently approve — refused, unverified, stale, too large, a companion
  // error — has something recorded against it. An aspect no such pair names raised nothing.
  const dirtyAdvisory = new Set(asArray(check.pairs).filter((p) => p.verdict !== 'approved').map((p) => p.aspect));
  const advisoryClean = advisory.filter((a) => !dirtyAdvisory.has(a.id)).length;

  return {
    available: true,
    command: checkRes.command,
    green: check.exit.status === 'pass',
    enforced: aspectList.filter((a) => a.status === 'enforced').length,
    advisoryTotal: advisory.length,
    advisoryClean,
    baseline: check.totals.errors,
    noiseFloor: check.totals.warnings,
    coveredFiles: check.coverage.covered,
    totalFiles: check.coverage.files,
    nodes: check.project.nodes,
    aspects: check.project.aspects,
    judges: check.judges.length,
    verdicts: check.totals.verdicts,
    coverage: check.coverage,
    progressive: check.progressive,
  };
}

// ---- where a node's own files live -----------------------------------------------------------

export function nodeDir(root, node) {
  return join(root, '.yggdrasil', 'model', node);
}

export function nodeExists(root, cfg, node) {
  return ygNode(root, cfg, node) !== null;
}

// Every node id in the graph. Node identity IS the path under `.yggdrasil/model/` — that is the
// one thing all three layers agree on and the only thing read here: directory names, never a
// file's content. Every fact ABOUT a node still comes from `yg node --json`.
export function listAllNodes(root) {
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

// boundary — the path globs the node's mapping covers.
export function nodeBoundary(root, cfg, node) {
  const doc = ygNode(root, cfg, node);
  return doc ? asArray(doc.mapping) : [];
}

// The repo-root-relative directory a node's own graph files live in (yg-node.yaml, charter.md,
// log.md), trailing slash included — the prefix premerge.mjs's scope check treats as inside a
// ticket's node, alongside its code boundary. Nothing else under .yggdrasil/
// (yg-architecture.yaml, aspects, locks, config) is a node's own files, so this names only that
// one directory, never the graph root.
export function nodeGraphPathPrefix(root, cfg, node) {
  return `${relative(root, nodeDir(root, node))}/`;
}

export function nodeCharterPath(root, cfg, node) {
  return join(nodeDir(root, node), 'charter.md');
}

export function readNodeCharterText(root, cfg, node) {
  return readText(nodeCharterPath(root, cfg, node));
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

// ---- ports: the contracts ---------------------------------------------------------------
//
// port-is-contract. A port is one object in the graph, carrying the version a consumer names and
// the test that IS the promise. The horde has no contract object of its own: what it has is a
// PROPOSAL to add or bump one, which the architect files.

export function nodeRelations(root, cfg, node) {
  const doc = ygNode(root, cfg, node);
  return doc ? asArray(doc.relations) : [];
}

// The ports a node publishes, as {name: {description, version, test, aspects}}.
export function nodePorts(root, cfg, node) {
  const doc = ygNode(root, cfg, node);
  return doc && doc.ports && typeof doc.ports === 'object' ? doc.ports : {};
}

export function portExists(root, cfg, node, port) {
  return Object.prototype.hasOwnProperty.call(nodePorts(root, cfg, node), port);
}

// consumersOf(node, port) — every node that consumes one node's port, from `yg impact`. The one
// derivation of this, because three things depend on the same answer: which tickets a version
// bump must come before, whose owner has to approve it, and what the merge checklist then
// requires. A relation that names no port at all consumes the node as a whole, so a bump reaches
// it too — the safe direction.
export function consumersOf(root, cfg, node, port) {
  const out = new Set();
  const doc = ygImpact(root, cfg, node);
  if (!doc) return [];
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

// One node's ports rendered for a brief: what this node promises its neighbours, at which
// version, proved by which test. The verifier reads this instead of a hand-kept contracts table,
// so what it is held to is what the graph actually declares.
export function renderNodePorts(root, cfg, node) {
  const ports = nodePorts(root, cfg, node);
  const names = Object.keys(ports).sort();
  const lines = [`# Ports · ${node}`, ''];
  if (names.length === 0) {
    lines.push('(this component publishes no port — it promises its neighbours nothing by name)');
    return lines.join('\n');
  }
  lines.push('| port | version | the test that is the contract | promise |', '|---|---|---|---|');
  for (const name of names) {
    const p = ports[name] || {};
    lines.push(`| ${name} | ${p.version ?? '(none declared)'} | ${p.test || '(none declared)'} | ${p.description || ''} |`);
  }
  const consumers = names
    .map((n) => ({ port: n, by: consumersOf(root, cfg, node, n) }))
    .filter((r) => r.by.length);
  if (consumers.length) {
    lines.push('', 'Consumed by:', ...consumers.map((r) => `- ${r.port} → ${r.by.join(', ')}`));
  }
  return lines.join('\n');
}

export function readNodePortsText(root, cfg, node) {
  return renderNodePorts(root, cfg, node);
}

// ---- the node's rules ------------------------------------------------------
//
// What the graph forbids and requires of this node's code, with the word that says what a refusal
// costs. Three statuses, and the difference between them is the whole point of showing them:
// `enforced` blocks a merge, `advisory` warns and lets it through, `draft` is inert until someone
// promotes it. All of it from `yg context --json`, Yggdrasil's own resolution — the only one that
// accounts for every channel and for `when:` filters.

const STATUS_MEANING = {
  enforced: 'blocks the merge',
  advisory: 'warns, does not block',
  draft: 'not in force yet — inert until promoted',
};

function aspectsFromContext(doc) {
  return asArray(doc && doc.aspects).map((a) => {
    const channels = asArray(a.channels)
      .map((c) => (typeof c === 'string' ? c : (c && (c.origin || c.kind))))
      .filter(Boolean);
    return {
      id: String(a.id),
      status: String(a.status || 'enforced'),
      kind: a.kind || null,
      description: String(a.name || a.description || ''),
      via: channels.length ? channels.join(' · ') : null,
    };
  });
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

// The rules in force on one node.
export function nodeRules(root, cfg, node) {
  const { display } = ygCommand(cfg);
  const source = `${display} context --node ${node} --json`;
  const res = ygContext(root, cfg, node);
  if (!res.doc) return { source, aspects: [], unresolved: res.why };
  return { source, aspects: aspectsFromContext(res.doc) };
}

// The rules in force on one file, and the component that owns it — one document answers both.
export function fileRules(root, cfg, relFile) {
  const { display } = ygCommand(cfg);
  const doc = ygFileContext(root, cfg, relFile);
  if (!doc) {
    return { available: false, reason: `\`${display} context --file ${relFile} --json\` could not resolve this file` };
  }
  const owner = doc.owner && doc.owner.kind === 'node' ? doc.owner.path : null;
  return {
    available: true,
    node: owner,
    source: `${display} context --file ${relFile} --json`,
    aspects: aspectsFromContext(doc),
  };
}

export function renderRules(rules, inherited) {
  const lines = [`_Resolved from: ${rules.source}_`, ''];
  if (rules.unresolved) {
    lines.push(
      '- **The rules over this node could not be resolved.** The graph itself refuses to assemble',
      '  them, and until that is fixed nobody can say what this code must satisfy:',
      '',
      ...String(rules.unresolved).split('\n').map((l) => `  ${l}`),
    );
  } else if (rules.aspects.length === 0) {
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

// ---- operational graph.json: the horde's own proposals --------------------
//
// The only objects the horde keeps for itself, and they are process, not architecture: a port
// proposal and a graph-change proposal, both waiting on the architect. Uncommitted, per horde,
// gone when the horde is archived. Nothing about the code's currency lives here — the lock binds
// every verdict to the hash of what it judged, so `yg check` is the one answer to "does the graph
// still describe this code", and a second stamp kept beside it could only ever disagree.

function graphJsonPath(horde) {
  return hordePath(horde, 'graph.json');
}

function loadGraph(horde) {
  const doc = readJSON(graphJsonPath(horde), null);
  return {
    proposals: doc && Array.isArray(doc.proposals) ? doc.proposals : [],
    ports: doc && Array.isArray(doc.ports) ? doc.ports : [],
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

// ---- commands ---------------------------------------------------------------

// Writes a take-over to the node's own log for real (never merely prints the command, unlike
// cmdLog's default) — a --take is something that already happened, not something an agent still
// needs to go and do. Best-effort: a node id leased before its graph object exists has nothing to
// append to, and the lease itself — recorded in .horde/leases.json's own history — is the durable
// record either way, so this never blocks the take-over on the node's log succeeding.
function logNodeTakeover(root, cfg, node, reason) {
  try {
    const yg = ygCommand(cfg);
    execFileSync(yg.cmd, [...yg.prefix, 'log', 'add', '--node', node, '--reason', reason], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function cmdBind(horde, root, cfg, positional, flags) {
  const node = positional[0];
  if (!node) {
    const nodes = listAllNodes(root);
    // Ask the graph about one real node, so "readable" means the documents answered rather than
    // that a directory exists: an unreadable graph or a CLI that predates them stops here.
    if (nodes.length) ygNode(root, cfg, nodes[0]);
    emit({ nodes }, flags, () => `graph readable through ${ygCommand(cfg).display} — ${nodes.length} node(s): ${nodes.join(', ') || '(none)'}`);
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

function portSummary(root, cfg, node) {
  const ports = nodePorts(root, cfg, node);
  const names = Object.keys(ports).sort();
  return names.map((n) => `${n}@${ports[n] && ports[n].version != null ? ports[n].version : '-'}`);
}

function cmdMap(horde, root, cfg, flags) {
  const nodes = missionNodes(horde, root, cfg);
  const graph = loadGraph(horde);
  const rows = nodes.map((node) => ({
    node,
    owner: ownerOf(horde, node),
    known: nodeExists(root, cfg, node),
    ports: nodeExists(root, cfg, node) ? portSummary(root, cfg, node) : [],
    openPortProposals: graph.ports.filter((p) => p.node === node && p.status === 'proposed').length,
  }));
  emit(rows, flags, () => {
    if (rows.length === 0) return '(no nodes touched yet)';
    return rows.map((r) => `${r.node}  owner=${r.owner}  ports=${r.ports.join(',') || '-'}  open-port-proposals=${r.openPortProposals}${r.known ? '' : '  (not in the graph yet)'}`).join('\n');
  });
}

function cmdShow(horde, root, cfg, positional, flags) {
  const node = positional[0];
  if (!node) fail('show requires <node>');
  if (!nodeExists(root, cfg, node)) fail(`no such node in the graph: ${node}`);
  const doc = ygNode(root, cfg, node);
  const boundary = asArray(doc.mapping);
  const charter = readNodeCharterText(root, cfg, node) || '(no charter yet)';
  const ports = renderNodePorts(root, cfg, node);
  let log = '(no log yet)';
  try {
    const { cmd, prefix } = ygCommand(cfg);
    log = execFileSync(cmd, [...prefix, 'log', 'read', '--node', node], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() || log;
  } catch { /* no entries yet — keep the placeholder */ }
  const rules = nodeRules(root, cfg, node);
  const inherited = charterInheritedRules(readNodeCharterText(root, cfg, node));
  const result = {
    node,
    type: doc.type || null,
    description: doc.description || null,
    boundary,
    ports: doc.ports || {},
    rules: { ...rules, charterInherited: inherited },
    charter,
    log,
  };
  emit(result, flags, () => [
    `# ${node}${doc.type ? ` [${doc.type}]` : ''}`, '',
    `**Boundary:** ${boundary.join(', ') || '(none)'}`, '',
    '## Rules — what this node\'s code must satisfy', '',
    renderRules(rules, inherited), '',
    '## Ports — what it promises its neighbours', '',
    ports, '',
    '## Charter', charter, '',
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
  if (!nodeExists(root, cfg, node)) {
    fail(`no such node in the graph: ${node} — a new node is filed with \`${ygCommand(cfg).display}\` by the architect, not seeded here`);
  }
  const stdin = readStdin();
  let content = stdin;
  if (!content.trim()) {
    content = renderTemplate('node-charter', {
      node, owner: '(unassigned)', class: '(unassigned)', lease: '(unassigned)',
    });
  }
  writeText(nodeCharterPath(root, cfg, node), content);
  emit({ node, bytes: content.length }, flags, () => `charter written: ${node} (${content.length} bytes)`);
}

function cmdLog(horde, root, cfg, positional, flags) {
  const [node, reason] = positional;
  if (!node || !reason) fail('log requires <node> "<reason>"');
  const yg = ygCommand(cfg);
  const cmd = `${yg.display} log add --node ${node} --reason "${reason.replace(/"/g, '\\"')}"`;
  if (flags.run) {
    try {
      execFileSync(yg.cmd, [...yg.prefix, 'log', 'add', '--node', node, '--reason', reason], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      fail(`${yg.display} log add failed: ${e.message}`);
    }
    emit({ node, reason, ran: true }, flags, () => `ran: ${cmd}`);
    return;
  }
  emit({ node, reason, command: cmd }, flags, () => cmd);
}

// ---- port proposals ---------------------------------------------------------

function cmdContractPropose(horde, root, cfg, positional, flags) {
  const [node, port, text] = positional;
  if (!node || !port || !text) fail('contract propose requires <node> <port> "<text>"');
  if (!flags.as) fail('contract propose requires --as <test-path> — a port\'s promise IS a test, and the graph records which one');
  if (!flags.by) fail('contract propose requires --by <owner>');
  if (!nodeExists(root, cfg, node)) fail(`no such node in the graph: ${node}`);

  const existing = nodePorts(root, cfg, node)[port];
  const current = existing && existing.version != null ? Number(existing.version) : null;
  const version = flags.version !== undefined ? Number(flags.version) : (current === null ? 1 : current + 1);
  if (!Number.isFinite(version) || version < 1) fail(`--version must be a whole number of 1 or more, got: ${flags.version}`);
  if (current !== null && version <= current) {
    fail(`${node}/${port} already publishes version ${current} — a proposal must raise it, not restate it (--version ${current + 1})`);
  }

  const graph = loadGraph(horde);
  const entry = {
    id: nextId(graph.ports),
    node,
    port,
    version,
    test: flags.as,
    kind: current === null ? 'add' : 'bump',
    from: current,
    text,
    status: 'proposed',
    by: flags.by,
    at: nowIso(),
  };
  graph.ports.push(entry);
  saveGraph(horde, graph);
  const consumers = current === null ? [] : consumersOf(root, cfg, node, port);
  emit({ ...entry, consumers }, flags, () => `port ${entry.kind === 'add' ? 'proposed' : 'bump proposed'}: [${entry.id}] ${node}/${port}@${version}`
    + (consumers.length ? ` — ${consumers.length} consumer(s) read the old version: ${consumers.join(', ')}` : ''));
}

// The filing an approved port proposal asks the architect for: the edit to the node's own file,
// and the entry that records why. Both are `yg`'s business, never this tool's — the horde writes
// nothing into the graph.
function portFilingSteps(cfg, p) {
  const yg = ygCommand(cfg);
  return [
    `edit .yggdrasil/model/${p.node}/yg-node.yaml — under ports:, set ${p.port}: { version: ${p.version}, test: ${p.test} }`,
    `${yg.display} log add --node ${p.node} --reason "<why this port exists at version ${p.version}>"`,
    `${yg.display} check --approve --only-deterministic  (records the contract baseline — free, no key)`,
  ];
}

function cmdContractRule(horde, root, cfg, positional, flags, verdict) {
  const [id, why] = positional;
  if (!id) fail(`contract ${verdict === 'approved' ? 'approve' : 'veto'} requires <id>`);
  if (!flags.by) fail('--by is required');
  const graph = loadGraph(horde);
  const p = graph.ports.find((x) => x.id === id);
  if (!p) fail(`no such port proposal: ${id}`);
  if (p.status !== 'proposed') fail(`port proposal ${id} is already ${p.status}`);
  p.status = verdict;
  p.ruling = why || null;
  p.rulingBy = flags.by;
  p.ruledAt = nowIso();
  saveGraph(horde, graph);
  traceRoster(horde, flags.by);
  const steps = verdict === 'approved' ? portFilingSteps(cfg, p) : [];
  emit({ ...p, filing: steps }, flags, () => [
    `port proposal ${id} ${verdict} — ${p.node}/${p.port}@${p.version}`,
    ...(steps.length ? ['file it into the graph yourself:', ...steps.map((s) => `  ${s}`)] : []),
  ].join('\n'));
}

function cmdContracts(horde, root, cfg, flags) {
  const graph = loadGraph(horde);
  const nodes = flags.node ? [flags.node] : missionNodes(horde, root, cfg);
  const declared = [];
  if (!flags.pending) {
    for (const node of nodes) {
      if (!nodeExists(root, cfg, node)) continue;
      const ports = nodePorts(root, cfg, node);
      for (const name of Object.keys(ports).sort()) {
        const p = ports[name] || {};
        declared.push({
          node,
          port: name,
          version: p.version ?? null,
          test: p.test || null,
          description: p.description || '',
          consumers: consumersOf(root, cfg, node, name),
        });
      }
    }
  }
  let proposals = graph.ports;
  if (flags.pending) proposals = proposals.filter((p) => p.status === 'proposed');
  if (flags.node) proposals = proposals.filter((p) => p.node === flags.node);

  emit({ declared, proposals }, flags, () => {
    const lines = [];
    if (!flags.pending) {
      lines.push('Declared in the graph:');
      lines.push(...(declared.length
        ? declared.map((d) => `  ${d.node}/${d.port}@${d.version ?? '-'}  test=${d.test || '(none)'}  consumers=${d.consumers.join(',') || '-'}`)
        : ['  (none)']));
      lines.push('');
    }
    lines.push(flags.pending ? 'Proposals waiting on the architect:' : 'Proposals:');
    lines.push(...(proposals.length
      ? proposals.map((p) => `  [${p.id}] ${p.node}/${p.port}@${p.version}  ${p.status}  test=${p.test}  by ${p.by}  ${p.text}`)
      : ['  (none)']));
    return lines.join('\n');
  });
}

// ---- the prose rules waiting on a judge --------------------------------------

function cmdVerdicts(horde, root, cfg, flags) {
  const cwd = flags.at ? resolve(root, flags.at) : root;
  const res = pendingProsePairs(cfg, cwd);
  if (!res.available) failNoCli(cfg, res.command);
  const rows = res.pairs.map((p) => ({ ...p, ...verdictCommandsFor(cfg, p, flags.by) }));
  const free = res.scriptPending.length
    ? `${res.scriptPending.length} script rule(s) here have no verdict yet either — nobody has to read `
      + `those: run \`${ygCommand(cfg).display} check --approve --only-deterministic\` first, it is free `
      + 'and needs no key.'
    : null;
  emit({ at: cwd, green: res.green, pending: rows, scriptPending: res.scriptPending }, flags, () => {
    const lines = [];
    if (rows.length === 0) {
      lines.push(res.green
        ? `no prose rule is waiting — ${res.command} is green on this tree`
        : `no prose rule is waiting on a judgement; ${res.command} is still red for another reason — read it`);
    } else {
      lines.push(
        `${rows.length} prose rule(s) waiting on a judgement in ${cwd}:`,
        ...rows.flatMap((r) => [
          `- ${r.aspect} on ${r.unitKind}:${r.unit}`,
          `    ${r.package}`,
          `    ${r.record}`,
        ]),
      );
    }
    if (free) lines.push('', free);
    return lines.join('\n');
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
    fail('propose move-boundary requires --node <n> --boundary <glob>[,glob…], so apply can name the exact edit');
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

function cmdApply(horde, root, cfg, positional, flags) {
  const id = positional[0];
  if (!id) fail('apply requires <proposal-id>');
  const graph = loadGraph(horde);
  const p = graph.proposals.find((x) => x.id === id);
  if (!p) fail(`no such proposal: ${id}`);
  if (p.status !== 'approved') fail(`proposal ${id} is not approved (status: ${p.status})`);
  if (p.appliedAt) fail(`proposal ${id} was already applied`);

  p.appliedAt = nowIso();
  saveGraph(horde, graph);
  const yg = ygCommand(cfg);
  const step = p.kind === 'move-boundary' && p.node && p.boundary
    ? `set ${p.node}'s mapping: to ${p.boundary.join(', ')} in .yggdrasil/model/${p.node}/yg-node.yaml`
    : 'edit .yggdrasil/model/**/yg-node.yaml (and yg-architecture.yaml for a new, renamed or moved node)';
  emit(
    { id, kind: p.kind, applied: true, step },
    flags,
    () => `proposal ${id} closed — file it into the graph yourself: ${step}; record the why with \`${yg.display} log add\`. `
      + 'A change to yg-architecture.yaml needs the user\'s explicit confirmation.',
  );
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
  if (cmd === 'contract') {
    const [sub, ...subRest] = rest;
    if (sub === 'propose') return cmdContractPropose(horde, root, cfg, subRest, flags);
    if (sub === 'approve') return cmdContractRule(horde, root, cfg, subRest, flags, 'approved');
    if (sub === 'veto') return cmdContractRule(horde, root, cfg, subRest, flags, 'vetoed');
    fail('contract requires "propose", "approve" or "veto"');
  }
  if (cmd === 'contracts') return cmdContracts(horde, root, cfg, flags);
  if (cmd === 'verdicts') return cmdVerdicts(horde, root, cfg, flags);
  if (cmd === 'propose') return cmdPropose(horde, rest, flags);
  if (cmd === 'proposals') return cmdProposals(horde, flags);
  if (cmd === 'approve') return cmdProposalRule(horde, rest, flags, 'approved');
  if (cmd === 'veto') return cmdProposalRule(horde, rest, flags, 'vetoed');
  if (cmd === 'apply') return cmdApply(horde, root, cfg, rest, flags);
  fail(`unknown command: ${cmd} (see --help)`);
}

if (isMain(import.meta.url)) main();
