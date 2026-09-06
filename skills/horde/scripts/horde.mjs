#!/usr/bin/env node
// horde skill — horde.mjs
//
// Hordes themselves: bringing one into being (its trunk branch, its charter, its empty state),
// listing what's running on this repository, reading/writing the one config shared by every
// horde on it, and archiving a finished one. `.horde/` itself is created here and nowhere else —
// every other tool assumes it already exists.

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  repoRoot, hordeRoot, hordePath, readConfig, writeConfig, listHordes, readJSON,
  writeJSON, readText, git, today, fail, parseArgs, emit, isMain, renderTemplate, resolveHorde,
  readLeases, releaseLeasesForHorde, latestActivity, claimLease, assertLeaseAvailable,
} from './_lib.mjs';
import { currentWaveNumber, parseEvidenceRows } from './wave.mjs';

const DEFAULT_CLASSES = { haiku: 1, sonnet: 3, opus: 10, fable: 30 };

const USAGE = `usage: horde.mjs <command> [options]

commands:
  init <name> --base <branch> [--title "<t>"] [--graph-dir <dir>] [--test-globs <glob>[,glob…]]
       [--nodes <node>[,node…]]
      creates .horde/ if missing, hordes/<name>/ with a charter rendered from the template, an
      empty roster and journals, teams/trunk/, and the branch <name>/trunk off <branch> (not
      checked out). Reads the repository's build files for its gate command and the patterns its
      tests are named with, and says what it found — or what it could not work out, and how to
      tell it. --test-globs names those patterns outright. Refuses an existing name. --nodes binds
      the charter's touched nodes at creation (node-lease-across-hordes): each one is leased to
      this horde in .horde/leases.json, and init refuses outright — before creating anything — a
      node already leased by another horde that is not archived, naming that horde and its last
      activity.
  list
      hordes on this repository: trunk, base, wave, open tickets, leased nodes, last activity.
  config get <key>
  config set <key> <value>
      dotted paths into .horde/config.json, e.g. "gates.trunk", "liveness.stewardMinutes",
      "fixRounds.resume". A list-valued key takes a comma-separated list or a JSON array.
      "keyContext" (default 3) is how much surrounding code a review's key is bound to: an
      owner's approval and a verifier's verdict survive a branch catching up with the team as
      long as nothing landed within this many lines of the ticket's own change. Raise it to send
      more tickets back for a re-review, lower it to send fewer; 1 is the lowest offered.
  charter show [--horde h]
  charter edit [--horde h]
      the mission charter: "show" prints it, "edit" replaces it with what arrives on stdin and
      reports what that did to the evidence catalogue.
  archive <name>
      moves hordes/<name> to hordes/_archive/<name>-<date>. Branches are untouched.

options: --json  --help`;

function detectPackageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// What a repository is built with, read off the files that are actually there — the build files
// are the only honest evidence available to a tool that has never seen this repository before.
// Each match carries the two things a horde needs and cannot invent: the command that runs the
// tests, and the file-name patterns this ecosystem's tests are written under (which is how the
// merge checklist tells "this change adds no tests" apart from "I did not recognise its tests").
// Order is priority: the first match names the gate, and every match contributes its patterns.
function detectEcosystems(root) {
  const has = (...names) => names.some((n) => existsSync(join(root, n)));
  const found = [];

  if (has('package.json')) {
    const pm = detectPackageManager(root);
    const runPrefix = pm === 'npm' ? 'npm run' : `${pm} run`;
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts || {}; } catch { scripts = {}; }
    const gate = scripts.gate ? `${runPrefix} gate` : scripts.test ? `${runPrefix} test` : '';
    if (gate) {
      const hasLefthook = has('lefthook.yml', '.lefthook.yml');
      found.push({
        name: 'npm',
        gate,
        commit: hasLefthook ? `${pm === 'npm' ? 'npx' : `${pm} exec`} lefthook run pre-commit` : gate,
        testGlobs: ['**/*.test.*', '**/*.spec.*'],
      });
    }
  }
  if (has('pom.xml')) {
    found.push({
      name: 'Maven',
      gate: has('mvnw') ? './mvnw -B test' : 'mvn -B test',
      testGlobs: ['**/*Test.java', '**/*Tests.java', '**/*IT.java'],
    });
  }
  if (has('build.gradle', 'build.gradle.kts')) {
    found.push({
      name: 'Gradle',
      gate: has('gradlew') ? './gradlew test' : 'gradle test',
      testGlobs: ['**/*Test.java', '**/*Tests.java', '**/*Test.kt', '**/*Tests.kt'],
    });
  }
  if (has('Cargo.toml')) {
    found.push({ name: 'Cargo', gate: 'cargo test', testGlobs: ['**/tests/**/*.rs'] });
  }
  if (has('go.mod')) {
    found.push({ name: 'Go', gate: 'go test ./...', testGlobs: ['**/*_test.go'] });
  }
  if (has('pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'requirements.txt')) {
    found.push({ name: 'Python', gate: 'pytest', testGlobs: ['**/test_*.py', '**/*_test.py'] });
  }
  if (has('Makefile')) {
    let makefile = '';
    try { makefile = readFileSync(join(root, 'Makefile'), 'utf8'); } catch { makefile = ''; }
    if (/^test:/m.test(makefile)) found.push({ name: 'Make', gate: 'make test', testGlobs: [] });
  }
  return found;
}

// The gate commands to start from: the first ecosystem's test command, with the commit lane
// swapped for a pre-commit hook runner where one is configured. Empty when nothing was
// recognized — and `init` says so out loud rather than leaving a silent empty gate behind.
function detectGates(root) {
  const [first] = detectEcosystems(root);
  if (!first) return { commit: '', team: '', trunk: '' };
  return { commit: first.commit || first.gate, team: first.gate, trunk: first.gate };
}

// The file-name patterns this repository writes its tests under, from every ecosystem detected.
// Empty means "not recognized", which is a state the checklist refuses on — never one it guesses
// past.
function detectTestGlobs(root) {
  return [...new Set(detectEcosystems(root).flatMap((e) => e.testGlobs))];
}

function defaultConfig(root) {
  const nodeSource = existsSync(join(root, '.yggdrasil')) ? 'yggdrasil' : 'manual';
  return {
    base: null,
    gates: detectGates(root),
    nodeSource,
    ygCommand: nodeSource === 'yggdrasil' ? 'yg' : null,
    graphDir: nodeSource === 'manual' ? 'architecture/' : null,
    testGlobs: detectTestGlobs(root),
    // How many lines of surrounding code a review's key is bound to (see _lib.mjs patchIdOf).
    keyContext: 3,
    protectedPaths: [],
    liveness: { stewardMinutes: 60, ownerMinutes: 45 },
    classes: { ...DEFAULT_CLASSES },
    parallelism: 6,
    // The fix-loop breaker (tk.mjs status <ticket> changes): rounds 1..resume ask the steward to
    // resume the same worker; the next "fresh" rounds ask for a new one, one class heavier;
    // beyond resume+fresh the command refuses and names the ruling to make instead.
    fixRounds: { resume: 3, fresh: 2 },
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
    if (flags['test-globs']) cfg.testGlobs = parseListValue(flags['test-globs']);
    writeConfig(cfg);
  }

  // --nodes binds the charter's touched nodes the moment this horde exists (node-lease-across-
  // hordes): a node another live horde already leases refuses the whole init — before the branch
  // or a single file of this horde's own state is created — naming that horde and its last
  // activity.
  const requestedNodes = flags.nodes ? parseListValue(flags.nodes) : [];
  for (const node of requestedNodes) {
    try {
      assertLeaseAvailable(name, node);
    } catch (e) {
      fail(e.message);
    }
  }

  const branch = `${name}/trunk`;
  const created = git(['branch', branch, flags.base], root);
  if (created === null) fail(`could not create branch "${branch}" off "${flags.base}" — does that base exist?`);

  // Already cleared above; this call cannot itself conflict (barring a concurrent claim in the
  // instant between the check and here, which a single CLI invocation never races against).
  const leased = requestedNodes.map((node) => claimLease(name, node));

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

  // Two things a horde cannot invent and must not pretend to know: what command proves this
  // repository still works, and what its tests are called. Say which of them were worked out and
  // which were not, here, at the one moment somebody is reading — an empty gate or an
  // unrecognized test convention discovered later is discovered as a checklist item that refuses.
  const ecosystems = detectEcosystems(root).map((e) => e.name);
  const gateNote = cfg.gates && cfg.gates.team
    ? `gate: \`${cfg.gates.team}\`${ecosystems.length ? ` (${ecosystems[0]})` : ''} — change it with: horde.mjs config set gates.team "<command>"`
    : 'no gate command could be worked out from this repository\'s files, and a merge checklist with an empty gate refuses rather than passes. What proves this repository still works? Set it: horde.mjs config set gates.team "<command>" (and gates.commit, gates.trunk).';
  const globsNote = cfg.testGlobs && cfg.testGlobs.length
    ? `tests recognised by: ${cfg.testGlobs.join(', ')} — change them with: horde.mjs config set testGlobs "<glob>,<glob>"`
    : 'no test convention could be worked out from this repository\'s files, so the merge checklist cannot tell a change that adds no tests from one whose tests it failed to recognise — it will refuse rather than guess. What are this repository\'s tests called? Set it: horde.mjs config set testGlobs "<glob>,<glob>".';

  const leaseNote = leased.length
    ? `leased ${leased.length} node(s): ${leased.map((l) => l.node).join(', ')}`
    : null;

  emit(
    {
      horde: name, branch, base: flags.base, graphGate, ecosystems, gates: cfg.gates, testGlobs: cfg.testGlobs, leased,
    },
    flags,
    () => [
      `horde "${name}" created — trunk branch ${branch} off ${flags.base}`,
      ...(leaseNote ? [leaseNote] : []),
      ...(graphGate ? [graphGate] : []),
      gateNote,
      globsNote,
    ].join('\n'),
  );
}

// writeText — the one local helper this file needs beyond _lib's writeJSON; kept tiny and local
// rather than promoted to _lib since nothing else in this half of the toolset writes plain text
// outside a journal (which goes through appendText instead).
function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
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
  const { leases } = readLeases();
  const rows = hordes.map((name) => {
    const dest = hordePath(name);
    const sha = git(['rev-parse', '--short', `${name}/trunk`]) || '-';
    const wave = currentWaveNumber(readText(join(dest, 'plan.md'))) || '-';
    const openTickets = openTicketCount(dest);
    const lastActivity = latestActivity(dest) || '-';
    // node-lease-across-hordes: the nodes this horde currently holds — every other horde on the
    // repository sees the same file, so this is exactly what a second horde's node.mjs bind
    // checks against.
    const leasedNodes = Object.entries(leases).filter(([, l]) => l.horde === name).map(([node]) => node).sort();
    return {
      name, base: (cfg && cfg.base) || '-', trunkSha: sha, wave, openTickets, lastActivity, leasedNodes,
    };
  });
  emit(rows, flags, () => {
    if (rows.length === 0) return 'no horde';
    return rows.map((r) => `${r.name}  trunk=${r.trunkSha}  base=${r.base}  wave=${r.wave}  open=${r.openTickets}  leases=${r.leasedNodes.join(',') || '-'}  last=${r.lastActivity}`).join('\n');
  });
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// A comma-separated list, or a JSON array written out in full — both are natural to type, and a
// glob like "**/*Tests.java" contains no comma, so neither form is ambiguous in practice.
function parseListValue(raw) {
  const text = String(raw).trim();
  if (text.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { fail(`not a readable list: ${text}`); }
    if (!Array.isArray(parsed)) fail(`not a list: ${text}`);
    return parsed.map((v) => String(v));
  }
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

// Keys whose value is a list whatever the config currently holds — a list-valued key that has
// never been set (or was set to a string once) must still take a list, or `config set` writes the
// string "[\"**/*Tests.java\"]" and every reader of that key breaks on it.
const LIST_KEYS = new Set(['protectedPaths', 'testGlobs']);

function setPath(obj, path, rawValue) {
  const keys = path.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  const existing = node[last];
  const wantsList = Array.isArray(existing) || LIST_KEYS.has(last) || String(rawValue).trim().startsWith('[');
  let value = rawValue;
  if (wantsList) value = parseListValue(rawValue);
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

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// The mission charter, written through a tool like everything else. It is the one file where what
// the chairman asked for actually lands — the goal, the non-goals, the evidence catalogue, the
// amendments — and it was the one file with no way to write it but by hand, which the skill's own
// rule forbids. `show` prints it; `edit` replaces it from stdin, and says what that did to the
// evidence catalogue, because a rewrite that drops a row already recorded as reproduced loses a
// verifier's work silently.
function cmdCharter(positional, flags) {
  const horde = resolveHorde(flags);
  const path = hordePath(horde, 'charter.md');
  const sub = positional[0];

  if (sub === 'show') {
    const text = readText(path);
    if (text === null) fail(`no charter for horde "${horde}"`);
    emit({ horde, path, charter: text }, flags, () => text);
    return;
  }
  if (sub !== 'edit') fail('charter requires "show" or "edit"');

  const before = readText(path) || '';
  const content = readStdin();
  if (!content.trim()) fail('charter edit requires content on stdin');

  const filledBefore = parseEvidenceRows(before).filter((r) => r.reproducedBy);
  const rowsAfter = parseEvidenceRows(content);
  const afterById = new Map(rowsAfter.map((r) => [r.id, r]));
  const dropped = filledBefore
    .filter((r) => !afterById.has(r.id) || !afterById.get(r.id).reproducedBy)
    .map((r) => ({ id: r.id, was: r.reproducedBy }));

  writeText(path, content);
  const result = {
    horde,
    path,
    bytes: content.length,
    evidenceRows: rowsAfter.length,
    evidenceReproduced: rowsAfter.filter((r) => r.reproducedBy).length,
    droppedEvidence: dropped,
  };
  emit(result, flags, () => [
    `charter written: ${horde} (${content.length} bytes) — evidence catalogue: ${result.evidenceRows} row(s), ${result.evidenceReproduced} reproduced`,
    ...dropped.map((d) => `warning: ${d.id} was recorded as reproduced by ${d.was} and this text drops that — put it back with: wave.mjs evidence ${d.id} --by "${d.was}"`),
  ].join('\n'));
}

function cmdArchive(positional, flags) {
  const name = positional[0];
  if (!name) fail('archive requires <name>');
  const src = hordePath(name);
  if (!existsSync(src)) fail(`no such horde: ${name}`);
  const dest = join(hordeRoot(), 'hordes', '_archive', `${name}-${today()}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  // node-lease-across-hordes: an archived horde is no longer live, so every node it held is free
  // the moment it archives — the same instant node.mjs bind and horde.mjs init start treating it
  // as no obstacle for another horde.
  const releasedLeases = releaseLeasesForHorde(name);
  emit({ from: src, to: dest, releasedLeases }, flags, () => [
    `archived: ${name} -> ${dest}`,
    releasedLeases.length ? `released lease(s): ${releasedLeases.join(', ')}` : 'held no node leases',
  ].join('\n'));
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
    case 'charter': return cmdCharter(positional, flags);
    case 'archive': return cmdArchive(positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
