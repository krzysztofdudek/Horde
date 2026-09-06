#!/usr/bin/env node
// horde skill — horde.mjs
//
// Hordes themselves: bringing one into being (its trunk branch, its charter, its empty state),
// listing what's running on this repository, reading/writing the one config shared by every
// horde on it, and archiving a finished one. `.horde/` itself is created here and nowhere else —
// every other tool assumes it already exists.

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  repoRoot, hordeRoot, hordePath, readConfig, writeConfig, listHordes, readJSON,
  writeJSON, readText, git, today, fail, parseArgs, emit, isMain, renderTemplate,
} from './_lib.mjs';
import { currentWaveNumber } from './wave.mjs';

const DEFAULT_CLASSES = { haiku: 1, sonnet: 3, opus: 10, fable: 30 };

const USAGE = `usage: horde.mjs <command> [options]

commands:
  init <name> --base <branch> [--title "<t>"] [--graph-dir <dir>]
      creates .horde/ if missing, hordes/<name>/ with a charter rendered from the template, an
      empty roster and journals, teams/trunk/, and the branch <name>/trunk off <branch> (not
      checked out). Refuses an existing name.
  list
      hordes on this repository: trunk, base, wave, open tickets, last activity.
  config get <key>
  config set <key> <value>
      dotted paths into .horde/config.json, e.g. "gates.trunk", "liveness.stewardMinutes".
  archive <name>
      moves hordes/<name> to hordes/_archive/<name>-<date>. Branches are untouched.

options: --json  --help`;

function detectPackageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// A repository's gate commands can't be guessed reliably, but a package.json with a "gate" or
// "test" script (and a lefthook config, for the commit-time lane) is common enough to be worth
// defaulting from — the horde's `config set gates.*` overrides whatever this guesses.
function detectGates(root) {
  const pm = detectPackageManager(root);
  const runPrefix = pm === 'npm' ? 'npm run' : `${pm} run`;
  let scripts = {};
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try { scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {}; } catch { scripts = {}; }
  }
  const gate = scripts.gate ? `${runPrefix} gate` : scripts.test ? `${runPrefix} test` : '';
  const hasLefthook = existsSync(join(root, 'lefthook.yml')) || existsSync(join(root, '.lefthook.yml'));
  const commit = hasLefthook ? `${pm === 'npm' ? 'npx' : `${pm} exec`} lefthook run pre-commit` : gate;
  return { commit, team: gate, trunk: gate };
}

function defaultConfig(root) {
  const nodeSource = existsSync(join(root, '.yggdrasil')) ? 'yggdrasil' : 'manual';
  return {
    base: null,
    gates: detectGates(root),
    nodeSource,
    ygCommand: nodeSource === 'yggdrasil' ? 'yg' : null,
    graphDir: nodeSource === 'manual' ? 'architecture/' : null,
    protectedPaths: [],
    liveness: { stewardMinutes: 60, ownerMinutes: 45 },
    classes: { ...DEFAULT_CLASSES },
    parallelism: 6,
  };
}

function ensureManualGraphDir(root, graphDir) {
  const dir = join(root, graphDir.replace(/\/$/, ''));
  const nodesDir = join(dir, 'nodes');
  mkdirSync(nodesDir, { recursive: true });
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      `# ${graphDir.replace(/\/$/, '')}\n\n`
      + 'The horde\'s committed node map, used in place of Yggdrasil for this repository: one '
      + 'folder per node under `nodes/`, each holding `node.json` (boundary, depends-on, '
      + 'verification stamp), `charter.md`, `contracts.md` and `log.md`. Written only by '
      + '`node.mjs`; never hand-edited.\n',
    );
  }
}

function cmdInit(positional, flags) {
  const name = positional[0];
  if (!name) fail('init requires <name>');
  if (!flags.base) fail('init requires --base <branch>');
  const root = repoRoot();

  const hr = hordeRoot({ create: true });
  const dest = hordePath(name);
  if (existsSync(dest)) fail(`a horde named "${name}" already exists`);

  let cfg = readConfig();
  if (!cfg) {
    cfg = defaultConfig(root);
    cfg.base = flags.base;
    writeConfig(cfg);
  }

  const branch = `${name}/trunk`;
  const created = git(['branch', branch, flags.base], root);
  if (created === null) fail(`could not create branch "${branch}" off "${flags.base}" — does that base exist?`);

  const user = git(['config', 'user.name'], root) || 'unknown';
  const charter = renderTemplate('charter', {
    title: flags.title || name,
    horde: name,
    base: flags.base,
    date: today(),
    user,
  });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'charter.md'), charter);

  writeJSON(join(dest, 'roster.json'), { entries: [] });
  writeText(join(dest, 'decisions.md'), '# Decisions\n\n');
  writeText(join(dest, 'plan.md'), '# Plan\n\n');
  writeJSON(join(dest, 'escalations.json'), { items: [] });
  writeJSON(join(dest, 'dissents.json'), { items: [] });
  writeJSON(join(dest, 'cost.json'), { runs: [] });
  writeJSON(join(dest, 'counter.json'), { next: 1 });

  writeJSON(join(dest, 'teams', 'trunk', 'queue.json'), { items: [] });
  mkdirSync(join(dest, 'teams', 'trunk', 'issues'), { recursive: true });

  if (cfg.nodeSource === 'manual') ensureManualGraphDir(root, cfg.graphDir || flags['graph-dir'] || 'architecture/');

  // Whatever the repository's own gate command turns out to be, a repository with a graph is
  // judged by that graph too — so say, at the one moment the operator is reading, that the
  // graph's verdict was put into the merge checklist and nothing further is needed to arm it.
  const graphGate = cfg.nodeSource === 'yggdrasil'
    ? `\`${cfg.ygCommand || 'yg'} check\` is part of every merge check on this repository — it runs on the branch's own tree, whatever the gate commands say, and a graph that refuses the tree refuses the merge.`
    : null;

  emit(
    { horde: name, branch, base: flags.base, graphGate },
    flags,
    () => [`horde "${name}" created — trunk branch ${branch} off ${flags.base}`, ...(graphGate ? [graphGate] : [])].join('\n'),
  );
}

// writeText — the one local helper this file needs beyond _lib's writeJSON; kept tiny and local
// rather than promoted to _lib since nothing else in this half of the toolset writes plain text
// outside a journal (which goes through appendText instead).
function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function dirMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function latestActivity(dest) {
  let latest = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else latest = Math.max(latest, dirMtime(full));
    }
  };
  walk(dest);
  return latest;
}

// Walks teams/<team>/queue.json at every depth (sub-teams nest under teams/<team>/teams/…) and
// sums items not yet in a terminal state.
function openTicketCount(dest) {
  let count = 0;
  const teamsRoot = join(dest, 'teams');
  const visitTeam = (teamDir) => {
    const q = readJSON(join(teamDir, 'queue.json'), { items: [] });
    const items = Array.isArray(q.items) ? q.items : [];
    count += items.filter((it) => it.state !== 'merged' && it.state !== 'dropped').length;
    const subTeamsDir = join(teamDir, 'teams');
    if (existsSync(subTeamsDir)) {
      for (const d of readdirSync(subTeamsDir, { withFileTypes: true })) {
        if (d.isDirectory()) visitTeam(join(subTeamsDir, d.name));
      }
    }
  };
  if (existsSync(teamsRoot)) {
    for (const d of readdirSync(teamsRoot, { withFileTypes: true })) {
      if (d.isDirectory()) visitTeam(join(teamsRoot, d.name));
    }
  }
  return count;
}

function cmdList(positional, flags) {
  const hordes = listHordes();
  const cfg = readConfig();
  const rows = hordes.map((name) => {
    const dest = hordePath(name);
    const sha = git(['rev-parse', '--short', `${name}/trunk`]) || '-';
    const wave = currentWaveNumber(readText(join(dest, 'plan.md'))) || '-';
    const openTickets = openTicketCount(dest);
    const lastMs = latestActivity(dest);
    const lastActivity = lastMs ? new Date(lastMs).toISOString() : '-';
    return { name, base: (cfg && cfg.base) || '-', trunkSha: sha, wave, openTickets, lastActivity };
  });
  emit(rows, flags, () => {
    if (rows.length === 0) return 'no horde';
    return rows.map((r) => `${r.name}  trunk=${r.trunkSha}  base=${r.base}  wave=${r.wave}  open=${r.openTickets}  last=${r.lastActivity}`).join('\n');
  });
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, rawValue) {
  const keys = path.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  const existing = node[last];
  let value = rawValue;
  if (Array.isArray(existing)) value = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
  else if (typeof existing === 'number') value = Number(rawValue);
  else if (typeof existing === 'boolean') value = rawValue === 'true';
  node[last] = value;
}

function cmdConfig(positional, flags) {
  const [sub, key, value] = positional;
  const cfg = readConfig();
  if (!cfg) fail('no .horde/config.json — run horde.mjs init first');
  if (sub === 'get') {
    if (!key) fail('config get requires <key>');
    const v = getPath(cfg, key);
    emit({ key, value: v }, flags, () => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    return;
  }
  if (sub === 'set') {
    if (!key || value === undefined) fail('config set requires <key> <value>');
    setPath(cfg, key, value);
    writeConfig(cfg);
    emit({ key, value: getPath(cfg, key) }, flags, () => `${key} = ${JSON.stringify(getPath(cfg, key))}`);
    return;
  }
  fail('config requires "get" or "set"');
}

function cmdArchive(positional, flags) {
  const name = positional[0];
  if (!name) fail('archive requires <name>');
  const src = hordePath(name);
  if (!existsSync(src)) fail(`no such horde: ${name}`);
  const dest = join(hordeRoot(), 'hordes', '_archive', `${name}-${today()}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  emit({ from: src, to: dest }, flags, () => `archived: ${name} -> ${dest}`);
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  switch (cmd) {
    case 'init': return cmdInit(positional, flags);
    case 'list': return cmdList(positional, flags);
    case 'config': return cmdConfig(positional, flags);
    case 'archive': return cmdArchive(positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
