#!/usr/bin/env node
// horde skill — law.mjs
//
// What a mission did to the law, as a document rather than a sentence. Nobody in the horde audits
// the rules from a seat of their own; the wave close and the mission close read the graph on two
// trees and write down the difference, and whoever renders that for the client (with a veto over
// every line of it) is a separate concern entirely. This file hands back data and never prose.
//
// The two trees are the ones named in the mission's own config: `config.base`, the branch the
// mission was cut from, and the tip of the horde's trunk. So the document answers "what has this
// mission's law gained since it started", cumulatively — the same question at every close, which
// is what makes two consecutive documents subtractable: what wave N did to the law on its own is
// wave-<n>.json minus wave-<n-1>.json, with no second mechanism needed to say so.
//
// Three sections, because the three mean different things to whoever reads them:
//
//   added     a rule the base does not have at all — new law
//   raised    a rule both trees have, standing higher here than there — the same law, biting
//   attached  a rule both trees have at the same rung, reaching units here it did not reach there
//
// Reach comes from `yg check --json --full`, which already enumerates every (aspect, unit) pair it
// verifies: one call per tree, no per-unit walk, and the same reading the landing gate's own law
// guard takes. (`yg impact --aspect` has no --json in any released CLI, so there is nothing to
// read it from; the pairs are the graph's own answer to the same question and are exact.) `--full`
// because a repository with a configured reference branch would otherwise answer about a different
// slice of itself in each tree, and a comparison of two different questions is not a comparison.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  hordePath, readConfig, writeJSON, nowIso, fail, parseArgs, emit, isMain, resolveHorde,
  resolveTree, asArray, git,
} from './_lib.mjs';
import { ygJson, ygCommand } from './node.mjs';

export const LAW_SCHEMA = 'horde-law/1';

const RUNGS = ['draft', 'advisory', 'enforced'];

function rung(status) {
  const i = RUNGS.indexOf(String(status || '').toLowerCase());
  return i === -1 ? RUNGS.length : i;
}

const USAGE = `usage: law.mjs diff [--wave <n>] [--horde h] [--json]

Writes the horde-law/1 document for this mission — what the law has gained between config.base and
the tip of the horde's trunk — to .horde/hordes/<horde>/law/wave-<n>.json, and prints its path.
Called by wave.mjs close and horde.mjs done; run by hand only to look.

options: --json  --help`;

// ---- reading one tree ---------------------------------------------------------------------
//
// Every read below names WHICH tree it failed on. A document read off one of two trees and not the
// other cannot be half-written into a diff: half a comparison is not a smaller answer, it is a
// wrong one, so every failure here stops the whole document.

const LAW_DOCUMENTS = 'yg-check/1, yg-aspects/1 and yg-aspect-log/1';

function docOn(tree, cfg, args, schema, where) {
  const res = ygJson(tree, cfg, args, schema);
  if (res.state === 'ok') return res.doc;
  const { display } = ygCommand(cfg);
  if (res.state === 'no-cli') {
    fail(
      `\`${res.command}\` could not be started — there is no Yggdrasil CLI at "${display}", and what this `
      + 'mission did to the law is read through that CLI or not at all.\n'
      + 'Install it (npm i -g @chrisdudek/yg), or point the horde at a local build: '
      + 'horde.mjs config set ygCommand "node path/to/bin.js"',
    );
  }
  if (res.state === 'stale') {
    const version = ygVersionOf(cfg);
    fail(
      `\`${res.command}\` did not answer with the ${schema} document Horde reads${res.saw ? ` (${res.saw})` : ''}, on ${where}.\n`
      + `The Yggdrasil CLI at "${display}"${version ? ` reports version ${version} and` : ''} predates ${LAW_DOCUMENTS} — `
      + 'the versioned answers the law diff is read from. Reading it a second, fragile way is exactly what those '
      + 'documents exist to remove, so this stops rather than writing half a truth.\n'
      + 'Upgrade to a release later than 5.9.0 (npm i -g @chrisdudek/yg), or point the horde at a newer build: '
      + 'horde.mjs config set ygCommand "node path/to/bin.js"',
    );
  }
  fail(`\`${res.command}\` could not be read on ${where}: ${res.detail || `exit ${res.code}`} — the law diff compares two trees, and one of them did not answer.`);
  return null;
}

function ygVersionOf(cfg) {
  const { cmd, prefix } = ygCommand(cfg);
  try {
    return execFileSync(cmd, [...prefix, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// A tree with no graph of its own is answered here rather than by the CLI. Yggdrasil resolves the
// project by climbing until it finds a `.yggdrasil/`, and a scratch worktree lives inside the
// repository it was cut from — so a base that predates the graph would otherwise be answered with
// the CURRENT working tree's rules, and every comparison against it would come back empty. A base
// with no graph declares no rules, which is the true answer and the one that makes every rule on
// the trunk read as what it is: added.
function hasGraph(tree) {
  return existsSync(join(tree, '.yggdrasil'));
}

// Every rule one tree declares, by id.
function aspectsOn(tree, cfg, where) {
  if (!hasGraph(tree)) return new Map();
  const doc = docOn(tree, cfg, ['aspects', '--json'], 'yg-aspects/1', where);
  const out = new Map();
  for (const a of asArray(doc.aspects)) if (a && a.id) out.set(a.id, a);
  return out;
}

// What every rule on one tree reaches: the units it is verified over, and the components those
// units belong to. A rule that reaches nothing has an entry with both sets empty — it is still a
// rule the document has to be able to talk about.
function reachOn(tree, cfg, where) {
  if (!hasGraph(tree)) return new Map();
  const doc = docOn(tree, cfg, ['check', '--json', '--full'], 'yg-check/1', where);
  const reach = new Map();
  for (const pair of asArray(doc.pairs)) {
    if (!pair || !pair.aspect) continue;
    if (!reach.has(pair.aspect)) reach.set(pair.aspect, { units: new Set(), nodes: new Set() });
    const entry = reach.get(pair.aspect);
    if (pair.unit) entry.units.add(`${pair.unit.kind}:${pair.unit.path}`);
    if (pair.node) entry.nodes.add(pair.node);
  }
  return reach;
}

function unitsOf(reach, id) {
  const e = reach.get(id);
  return e ? e.units : new Set();
}

function nodesOf(reach, id) {
  const e = reach.get(id);
  return e ? [...e.nodes].sort() : [];
}

// Every unit a tree HAS, whatever reaches it — read off git rather than off the reach sets, so a
// rule that lost every pair it had still reads as a rule that lost them. Without this a file the
// mission added would make every rule that governs it look newly attached.
function unitsIn(tree) {
  const units = new Set();
  for (const f of (git(['-c', 'core.quotepath=false', 'ls-files'], tree) || '').split('\n').filter(Boolean)) {
    units.add(`file:${f}`);
    const node = /^\.yggdrasil\/model\/(.+)\/yg-node\.yaml$/.exec(f);
    if (node) units.add(`node:${node[1]}`);
  }
  return units;
}

// The last thing a rule's own history says, which is where the reason for its standing lives.
// `null` for a rule nothing has been recorded about — the ordinary state of a rule nobody has had
// anything to say about yet, never an error.
function whyOf(tree, cfg, id, where) {
  const doc = docOn(tree, cfg, ['aspects', 'log', 'read', '--aspect', id, '--limit', '1', '--json'], 'yg-aspect-log/1', where);
  const entries = asArray(doc && doc.entries);
  if (entries.length === 0) return null;
  const body = String(entries[0].body || '').trim();
  return body || null;
}

// ---- the document ---------------------------------------------------------------------------

export function lawDiff(horde, cfg, { baseTree, trunkTree, base, trunk }) {
  const baseAspects = aspectsOn(baseTree, cfg, `the base (${base})`);
  const trunkAspects = aspectsOn(trunkTree, cfg, `the trunk (${trunk})`);
  const baseReach = reachOn(baseTree, cfg, `the base (${base})`);
  const trunkReach = reachOn(trunkTree, cfg, `the trunk (${trunk})`);

  // Reach is only ever compared over units both trees have, so nothing the mission added or
  // deleted can be mistaken for a change in what a rule covers.
  const trunkUnits = unitsIn(trunkTree);
  const shared = new Set([...unitsIn(baseTree)].filter((u) => trunkUnits.has(u)));
  const comparable = (set) => new Set([...set].filter((u) => shared.has(u)));

  const added = [];
  const raised = [];
  const attached = [];

  const item = (id, from, to) => ({
    aspect: id,
    description: (trunkAspects.get(id) || {}).description || '',
    status: { from, to },
    nodes: nodesOf(trunkReach, id),
    why: whyOf(trunkTree, cfg, id, `the trunk (${trunk})`),
  });

  for (const [id, head] of [...trunkAspects].sort(([a], [b]) => a.localeCompare(b))) {
    const before = baseAspects.get(id);
    if (!before) {
      added.push(item(id, null, head.status));
      continue;
    }
    if (rung(head.status) > rung(before.status)) {
      raised.push(item(id, before.status, head.status));
      continue;
    }
    const gained = [...comparable(unitsOf(trunkReach, id))].filter((u) => !comparable(unitsOf(baseReach, id)).has(u));
    if (gained.length) attached.push(item(id, before.status, head.status));
  }

  return {
    schema: LAW_SCHEMA, horde, base, trunk, at: nowIso(), added, raised, attached,
  };
}

export function lawPath(horde, wave) {
  return hordePath(horde, 'law', `wave-${wave}.json`);
}

// writeLawDiff(horde, cfg, wave) — the document for this mission, on disk, at the path this
// returns. Writing the same wave twice overwrites: the document is a reading of two trees, not a
// journal, so a second close of the same wave replaces it rather than doubling it.
export function writeLawDiff(horde, cfg, wave) {
  const baseBranch = cfg && cfg.base;
  if (!baseBranch) {
    fail('config.base is not set, and the law diff is measured from the branch this mission was cut from — set it: horde.mjs config set base "<branch>"');
  }
  const trunkBranch = `${horde}/trunk`;
  const baseSha = git(['rev-parse', baseBranch]);
  if (!baseSha) {
    fail(`no such branch: ${baseBranch} — the law diff is measured from the branch this mission was cut from, and it is not in this repository any more. Nothing was written; half a comparison is not a smaller answer than none.`);
  }
  const trunkSha = git(['rev-parse', trunkBranch]);
  if (!trunkSha) {
    fail(`no such branch: ${trunkBranch} — the law diff is measured to the tip of this mission's trunk, and there is none.`);
  }

  const baseInfo = resolveTree({ scratch: baseSha });
  let doc;
  try {
    const trunkInfo = resolveTree({ horde });
    doc = lawDiff(horde, cfg, {
      baseTree: baseInfo.path, trunkTree: trunkInfo.path, base: baseSha, trunk: trunkSha,
    });
  } finally {
    baseInfo.cleanup();
  }

  const path = lawPath(horde, wave);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    fail(`the law diff could not be written: ${dirname(path)} cannot be created (${e.message})`);
  }
  try {
    writeJSON(path, doc);
  } catch (e) {
    fail(`the law diff could not be written to ${path}: ${e.message}`);
  }
  return { path, doc };
}

function cmdDiff(horde, flags) {
  const cfg = readConfig() || {};
  const wave = flags.wave === undefined ? '0' : String(flags.wave);
  const { path, doc } = writeLawDiff(horde, cfg, wave);
  emit({ path, ...doc }, flags, () => [
    `what this mission has done to the law: ${path}`,
    `added ${doc.added.length} · raised ${doc.raised.length} · attached ${doc.attached.length}`,
  ].join('\n'));
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd] = positional;
  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');
  const horde = resolveHorde(flags);
  if (cmd === 'diff') return cmdDiff(horde, flags);
  return fail(`unknown command: ${cmd} (see --help)`);
}

if (isMain(import.meta.url)) main();
