#!/usr/bin/env node
// horde skill — horde.mjs
//
// Hordes themselves: bringing one into being (its trunk branch, its charter, its empty state),
// listing what's running on this repository, reading/writing the one config shared by every
// horde on it, and archiving a finished one. `.horde/` itself is created here and nowhere else —
// every other tool assumes it already exists.

import {
  existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, statSync,
  mkdtempSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import {
  repoRoot, hordeRoot, hordePath, readConfig, writeConfig, listHordes, readJSON,
  writeJSON, readText, appendText, git, today, fail, parseArgs, emit, isMain, renderTemplate, resolveHorde,
  readLeases, releaseLeasesForHorde, latestActivity, claimLease, assertLeaseAvailable,
  qualityPolicyIn, QUALITY_POLICIES, resolveTree,
} from './_lib.mjs';
import {
  currentWaveNumber, lastWaveNumber, parseEvidenceRows, mentionsEvidenceId, wave1Started,
  stampMissionEvidence,
} from './wave.mjs';
import { writeLawDiff } from './law.mjs';
import { sumEntries, readCostLimit } from './cost.mjs';
import { RETRO_SCHEMA, collectRetroInput, missionState } from './retro.mjs';

const DEFAULT_CLASSES = { haiku: 1, sonnet: 3, opus: 10, fable: 30 };

const USAGE = `usage: horde.mjs <command> [options]

commands:
  init <name> --base <branch> [--title "<t>"] [--test-globs <glob>[,glob…]]
       [--nodes <node>[,node…]] [--yg <command>] [--grain <command>]
       [--quality autonomous|only-the-work]
      creates the architecture graph when the repository has none — "yg init" from the repository
      root, and, where a Grain CLI is configured or on PATH, a proposal mined from this
      repository's own code accepted with "yg adopt". Refuses outright, before anything is
      created, when there is no graph and no Yggdrasil CLI to make one. Then: .horde/ if missing,
      hordes/<name>/ with a charter rendered from the template, an
      empty journals, teams/trunk/, and the branch <name>/trunk off <branch> (not
      checked out). Reads the repository's build files for its gate command and the patterns its
      tests are named with, and says what it found — or what it could not work out, and how to
      tell it. --test-globs names those patterns outright. --yg and --grain say how to invoke those
      two CLIs when they are not on PATH (a local build: --yg "node path/to/bin.js"); both are
      written to the config, so they are said once. Refuses an existing name. --nodes binds
      the charter's touched nodes at creation (node-lease-across-hordes): each one is leased to
      this horde in .horde/leases.json, and init refuses outright — before creating anything — a
      node already leased by another horde that is not archived, naming that horde and its last
      activity. --quality writes the charter's quality policy: "autonomous" (the default — the
      horde raises rules the evidence has earned and files the improvements it finds, without
      asking) or "only-the-work" (neither runs). Lowering anything needs the chairman under both.
  list
      hordes on this repository: trunk, base, wave, open tickets, leased nodes, last activity.
  config get <key>
  config set <key> <value>
      dotted paths into .horde/config.json, e.g. "gates.trunk", "territory.maxBytes",
      "fixRounds.resume". A list-valued key takes a comma-separated list or a JSON array.
      "keyContext" (default 3) is how much surrounding code a review's key is bound to: an
      owner's approval and a verifier's verdict survive a branch catching up with the team as
      long as nothing landed within this many lines of the ticket's own change. Raise it to send
      more tickets back for a re-review, lower it to send fewer; 1 is the lowest offered.
      "ygCommand" is how this repository invokes the Yggdrasil CLI (default "yg"); "grainCommand"
      how it invokes Grain, when it has one (default: none). "worktree.copy" (default: none) is a
      list of repository-root-relative paths copied into every ticket, trunk or scratch tree the
      moment it is made — for whatever a worker's tools need that git itself does not check out
      (an untracked env file, a dependency cache); a path git already tracks is refused.
  charter show [--horde h]
  charter edit [--ask id] [--horde h]
      the mission charter: "show" prints it, "edit" replaces it with what arrives on stdin and
      reports what that did to the evidence catalogue. Dropping a row is free before the mission's
      wave 1 has started; after it, dropping one refuses unless --ask names an answered ask of
      kind "charter" whose own text mentions the row's id — removing a promised proof is lowering
      the mission's own promise, and that is the client's call. The Quality section's "**Policy:**" line
      must read "autonomous" or "only-the-work"; anything else is refused rather than read as the
      default, and a charter with no such section reads as "autonomous".
  archive <name>
      moves hordes/<name> to hordes/_archive/<name>-<date> and marks it archived (an "archived"
      file carrying the date and the trunk sha). Branches are untouched, and nothing of it is
      committed — .horde/ carries its own .gitignore of "*".
  done [--horde h]
      the mission's final gate. Refuses, listing every reason, when any evidence row is not
      reproduced, the trunk gate (config.gates.trunk) is not green at the trunk tip, no cost
      has ever been recorded, or the retrospective (retro.mjs) has not been run over the mission
      as it now stands. Otherwise stamps the charter, appends the completion block to the
      mission journal, archives the horde the way "archive" does, and prints what to do next
      (push — that decision is the chairman's, never this tool's).

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

// ---- what counts as evidence here ------------------------------------------------------
//
// Horde does not bring its own idea of proof. It reads the repository once per mission, names
// whatever is most like an evidence layer, and uses that; only when it can see nothing at all does
// it say so and name a package that would add one. The judgement is written into the charter, so
// it is in a file a person can correct rather than in an agent's head, and the next mission makes
// it again from scratch rather than inheriting a stale answer.
//
// The signals are the ones `init` already reads off the build files, plus two this adds: a
// directory of promises (markdown, each with a status field, mirrored by tests) and — when neither
// is there — whether anything in the repository so much as LOOKS like a test. That last one is the
// difference between "this repository has no evidence layer" and "it has one this tool cannot
// read", and telling a mission the first when the second is true is the expensive mistake.

const PROMISE_DIRS = ['promises', 'docs/promises', '.promises', 'doc/promises'];
const PROMISE_STATUS = /^\s*(?:\*\*status:\*\*|status:|- \*\*status:\*\*)/im;
const MIRROR_DIRS = ['tests', 'test', 'spec', 'specs'];
// Deliberately broader than any one ecosystem's globs: this is asked only when nothing was
// recognised, and its whole job is to catch a suite written under a build system outside the eight.
const LOOKS_LIKE_TEST = /(^|\/)(tests?|specs?)\/|[._-](test|spec|tests|specs)[._-]|[._-](test|spec)$|^(test|spec)_/i;

function markdownFilesIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name);
  } catch { return []; }
}

// The tests that mirror a promises directory: a directory under one of the usual test roots
// holding files whose base names are the promises' own. Named rather than counted, because what
// the charter has to say is WHERE the mirror is.
function findPromiseMirror(root, names) {
  const bases = new Set(names.map((n) => n.replace(/\.md$/, '').toLowerCase()));
  const seen = [];
  const walk = (rel, depth) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    let hit = 0;
    for (const e of entries) {
      if (e.isDirectory()) { if (depth < 2) walk(`${rel}/${e.name}`, depth + 1); continue; }
      const base = e.name.replace(/\.[^.]+$/, '').replace(/[._-](test|spec)$/i, '').toLowerCase();
      if (bases.has(base)) hit++;
    }
    if (hit) seen.push({ dir: rel, files: hit });
  };
  for (const rootDir of MIRROR_DIRS) walk(rootDir, 0);
  seen.sort((a, b) => b.files - a.files);
  return seen[0] || null;
}

function detectPromises(root) {
  for (const rel of PROMISE_DIRS) {
    const names = markdownFilesIn(join(root, rel));
    const withStatus = names.filter((n) => {
      try { return PROMISE_STATUS.test(readFileSync(join(root, rel, n), 'utf8')); } catch { return false; }
    });
    if (!withStatus.length) continue;
    return { dir: rel, count: withStatus.length, mirror: findPromiseMirror(root, withStatus) };
  }
  return null;
}

// Tracked files that look like tests under no convention this tool knows. `git ls-files` rather
// than a directory walk: an untracked build output full of test-shaped file names would otherwise
// be reported as this repository's evidence layer.
function testLookingFiles(root) {
  const out = git(['ls-files'], root);
  if (out === null) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean).filter((f) => LOOKS_LIKE_TEST.test(f));
}

// The judgement itself, as data — refine renders it into a paragraph, and the tests read the same
// fields the paragraph is written from. `kind` is the whole of the answer: "suite", "promises",
// "unreadable" (there are tests but nothing here can say what they are called) or "none".
export function detectEvidenceLayer(root, cfg = {}) {
  const ecosystems = detectEcosystems(root);
  const configured = Array.isArray(cfg.testGlobs) ? cfg.testGlobs.filter(Boolean) : [];
  const globs = configured.length ? configured : detectTestGlobs(root);
  const promises = detectPromises(root);
  const suites = ecosystems.map((e) => ({ name: e.name, gate: e.gate, testGlobs: e.testGlobs }));

  if (promises) return { kind: 'promises', promises, suites, globs };
  if (suites.length || globs.length) return { kind: 'suite', promises: null, suites, globs };

  const looksLikeTests = testLookingFiles(root);
  if (looksLikeTests.length) {
    return {
      kind: 'unreadable', promises: null, suites: [], globs: [], looksLikeTests: looksLikeTests.slice(0, 8), looksLikeCount: looksLikeTests.length,
    };
  }
  return {
    kind: 'none', promises: null, suites: [], globs: [], looksLikeTests: [], looksLikeCount: 0,
  };
}

// The one sentence Horde is allowed to say about its own answer, and only when it has seen
// nothing. It names the package and the command and stops there: offering a solution to a
// repository that already has an evidence layer is exactly the behaviour this whole judgement
// exists to prevent.
//
// The command is written the way the tool that runs it actually takes it: where to get the package
// and which package to take, separated by a #. A bare name is refused — a source can publish
// several packages, so the name alone does not say which. The left half stays a blank for the
// reader to fill because this sentence is read inside somebody else's repository, where a path
// written out here would be somebody else's machine.
export const PROMISES_OFFER = 'If this repository wants an evidence layer of its own, the `promises` '
  + 'package adds one — a directory of promises with a status field, mirrored by the tests that keep '
  + "them: `yg pack add <this tool's repository>#promises`.";

function quoteList(items) {
  return items.map((i) => `\`${i}\``).join(', ');
}

// The judgement as the paragraph that goes into the charter. Written from the same fields the
// tests read, so what a mission is told and what this repository is are never two answers.
export function renderEvidenceJudgement(layer, { date = today() } = {}) {
  const judged = `Judged on ${date} by reading this repository; the next mission judges again from scratch.`;

  if (layer.kind === 'promises') {
    const { promises } = layer;
    const mirror = promises.mirror
      ? `mirrored by the tests under \`${promises.mirror.dir}/\` (${promises.mirror.files} of them match a promise by name)`
      : 'with no mirror in the tests that this could find — a promise nothing runs is a claim, so say on the ticket which test keeps it';
    const beside = layer.suites.length
      ? ` Beside it stands the ${layer.suites.map((s) => `${s.name} test suite (\`${s.gate}\`)`).join(' and ')}, written under ${quoteList(layer.globs)}.`
      : '';
    return `Evidence here is the promises directory \`${promises.dir}/\` — ${promises.count} promise(s), each carrying a status field — ${mirror}.${beside} Every row in the catalogue below is reproduced through one of those. The promises directory is maintained by whoever works the ticket, like any other file in it, and its shape is the repository's own law to enforce, not Horde's. ${judged}`;
  }

  if (layer.kind === 'suite') {
    const named = layer.suites.length
      ? `the ${layer.suites.map((s) => `${s.name} test suite (\`${s.gate}\`)`).join(' and ')}`
      : 'this repository\'s test suite';
    const globs = layer.globs.length
      ? `, written under ${quoteList(layer.globs)}`
      : ', whose file patterns are not configured — set them with `horde.mjs config set testGlobs "<glob>,<glob>"`';
    return `Evidence here is ${named}${globs}. Every row in the catalogue below is reproduced by running it, and a row that cannot be is a row that needs a scenario file, a measurement or a film named on its own line instead. There is no promises directory in this repository. ${judged}`;
  }

  if (layer.kind === 'unreadable') {
    return `Evidence here looks like a test suite this tool cannot read: ${layer.looksLikeCount} tracked file(s) are named like tests (${quoteList(layer.looksLikeTests)}${layer.looksLikeCount > layer.looksLikeTests.length ? ', and more' : ''}), but none of the build systems this tool recognises — npm, Maven, Gradle, Cargo, Go, Python, Make — is configured here, so the patterns cannot be read off the build. They have to be given by hand before any landing can tell a new test from an old one: \`horde.mjs config set testGlobs "<glob>,<glob>"\` and \`horde.mjs config set gates.trunk "<command>"\`. This is not "no evidence layer" — it is one nobody has told the tool about. ${judged}`;
  }

  return `No evidence layer found — this repository has no test suite, no promises directory, and no file named like a test, so nothing here can be pointed at as proof. Every row in the catalogue below has to name its own way of being reproduced, in full, on its own line. ${PROMISES_OFFER} ${judged}`;
}

// ---- who judges this repository's prose rules ------------------------------------------
//
// Yggdrasil's rules come in two kinds. A script rule answers for itself, free, in any worktree.
// A prose rule needs a reader, and there are only two ways a repository gets one: it has a
// reviewer configured inside Yggdrasil (a "tier"), or it has none and somebody answers out of band
// one pair at a time. Which of the two it is decides what a worker is told to do before committing
// and what the landing gate does with a rule still waiting on a judgement, so it is worked out
// here, once, rather than guessed at every landing.
//
// The evidence is Yggdrasil's own config: a `reviewer:` block with a provider under it. Read as
// text because Horde has no YAML parser and does not want one — this decides a default that `init`
// prints and `horde.mjs config set judge` overrides, never something that silently gates a merge.
const YG_CONFIG_FILES = ['yg-config.yaml', 'yg-secrets.yaml'];
function detectJudge(root) {
  for (const name of YG_CONFIG_FILES) {
    let text = '';
    try { text = readFileSync(join(root, '.yggdrasil', name), 'utf8'); } catch { continue; }
    const block = /^reviewer:\s*$([\s\S]*?)(?=^\S|\Z)/m.exec(text);
    if (block && /^\s+provider:\s*\S/m.test(block[1])) return 'tier';
  }
  return 'one-shot';
}

// The adopter's own commit hook, and what it runs. A repository with no reviewer cannot pass a
// hook that demands a full `yg check`: the prose rules have nobody to judge them, so every commit
// refuses, and the only thing a worker learns is to reach for `--no-verify`. That is worth
// refusing an init over — teaching the escape hatch is worse than never starting.
const HOOK_FILES = [
  '.git/hooks/pre-commit', '.husky/pre-commit', 'lefthook.yml', '.lefthook.yml', '.pre-commit-config.yaml',
];
function detectCommitHook(root) {
  for (const rel of HOOK_FILES) {
    let text = '';
    try { text = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter((l) => /\byg\b[^\n]*\bcheck\b/.test(l) && !/^\s*#/.test(l));
    if (!lines.length) continue;
    return { file: rel, deterministicOnly: lines.every((l) => /--only-deterministic/.test(l)) };
  }
  return null;
}

function defaultConfig(root) {
  return {
    base: null,
    gates: detectGates(root),
    // How this repository invokes the Yggdrasil CLI, and — when it has one — the Grain CLI that
    // can propose the first graph from the code itself. Both are command lines, so a checkout
    // running a local build needs no other change.
    ygCommand: 'yg',
    grainCommand: null,
    testGlobs: detectTestGlobs(root),
    // Who judges this repository's prose rules — "tier" (Yggdrasil's own reviewer) or "one-shot"
    // (no reviewer here; a judge answers a pair at a time and the landing gate hands them over).
    // Worked out from the graph's own reviewer configuration, never defaulted blindly: the landing
    // gate refuses rather than guess, because guessing wrong either invents a reviewer that does
    // not exist or pays for one twice.
    judge: detectJudge(root),
    // How many lines of surrounding code a review's key is bound to (see _lib.mjs patchIdOf).
    keyContext: 3,
    protectedPaths: [],
    classes: { ...DEFAULT_CLASSES },
    parallelism: 6,
    // The fix-loop breaker (tk.mjs status <ticket> changes): rounds 1..resume ask the steward to
    // resume the same worker; the next "fresh" rounds ask for a new one, one class heavier;
    // beyond resume+fresh the command refuses and names the ruling to make instead.
    fixRounds: { resume: 3, fresh: 2 },
    // How often an unattended loop runs `tick`, in seconds — read by `tick.mjs --watch` and by
    // nothing else. Only a loop with nobody in front of it needs this: a session that runs tick,
    // spawns what it says and runs it again sets its own pace.
    tick: { interval: 300 },
    // Who spins that loop, and — when nobody is in front of it — how a worker is started.
    // "session" (the default) is the client's own session: it runs tick, issues the calls on the
    // dispatch list in one turn, and runs tick again when they come back. "external" puts the loop
    // outside any agent, so it survives a closed session: that one starts each worker itself
    // through `spawn`, the host's own headless CLI, with "<class>" filled in from the ticket and
    // "<brief>" with the path of the rendered brief. Nothing else in this tool set reads either key.
    runner: { kind: 'session', spawn: null },
    // Repository-root-relative paths copied into every worktree provisionTree makes (a ticket's,
    // trunk's, or a landing script's scratch tree) — for whatever a worker's tools need that git
    // itself does not put on a fresh checkout (an untracked env file, a dependency cache). A path
    // git already tracks is refused rather than copied: copying over it would desync the tree
    // from its own branch.
    worktree: { copy: [] },
    // The one size a territory is cut to (refine.mjs --step cut): the bytes of the code its nodes
    // map, plus the text of every rule that reaches those files, plus those nodes' own logs. One
    // number for the whole horde, never one per class — "too big for anyone to hold" is a fact
    // about the area, not about who was sent to it, and the class a territory carries decides only
    // what it costs. Over this, the cut is refused and the architect cuts finer.
    territory: { maxBytes: 400000 },
    // Law maintenance, which belongs to whoever owns the area rather than to a seat.
    // `retireAfterWaves` is how many closed waves a rule may reach nothing at all before the
    // territory's own legislate pass is told it can be removed — removing a rule that judges
    // nothing weakens nothing, so it needs no signature. `qualityDropAsk` is how far the quality
    // index may fall in one wave before the fall becomes a question for the client rather than a
    // line in the wave's own report. Neither is ever a cost figure: a rule is retired for not
    // being used, never for what it costs to run.
    law: { retireAfterWaves: 2, qualityDropAsk: 0.1 },
    // The mission's retrospective (retro.mjs). `judgeSampleRate` is the fraction of landed
    // tickets whose already-judged prose pairs are put to a second judge — 0, so nothing is
    // re-judged and no reviewer is paid twice until somebody asks for the measurement;
    // `judgeTier` names that second judge. `inexpressibleThreshold` is the share of a mission's
    // refusals and remarks the law may turn out unable to express before the number becomes a
    // question for whoever is asking for the work — set it BEFORE a mission runs, never after
    // its number is known, or it measures nothing.
    retro: { judgeSampleRate: 0, judgeTier: null, inexpressibleThreshold: null },
  };
}

// ---- the graph ----------------------------------------------------------------------------
//
// horde-requires-yggdrasil. The node map is Yggdrasil's graph and there is no second one, so a
// repository without `.yggdrasil/` is not a repository the horde works around — it is one where
// the first thing to do is create the graph. That is `yg init`, run from the repository root
// (never a subdirectory: Yggdrasil's own rule), and then, where a Grain CLI is available, a
// proposal mined from this repository's own code and accepted with `yg adopt`, which is the only
// way a first graph arrives with rules that describe how the code is already written.

// A command line ("yg", "node ./yg/bin.js") split into a program and its fixed leading arguments.
function commandLine(raw, fallback) {
  const parts = String(raw || fallback || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return { cmd: parts[0], prefix: parts.slice(1), display: parts.join(' ') };
}

// True when the command line can actually be started. `--version` is the one argument every CLI
// answers without touching a repository.
function resolves(cl) {
  if (!cl) return false;
  try {
    execFileSync(cl.cmd, [...cl.prefix, '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The Grain CLI to mine a proposal with: what the config names, else a bare `grain` on PATH.
// Default: none — a repository that has no Grain still gets a graph, it just gets an empty one.
function grainCommandFor(cfg, override) {
  const configured = override || (cfg && cfg.grainCommand);
  if (configured) {
    const cl = commandLine(configured);
    return resolves(cl) ? cl : null;
  }
  const bare = commandLine('grain');
  return resolves(bare) ? bare : null;
}

function runIn(root, cl, args) {
  try {
    return { ok: true, out: execFileSync(cl.cmd, [...cl.prefix, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return {
      ok: false,
      code: e.status === undefined || e.status === null ? 1 : e.status,
      out: ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || '') || e.message,
    };
  }
}

const PROPOSAL_DIR = '.yggdrasil-proposal';

// Creates the graph when the repository has none. Returns what happened, in the words `init`
// prints; fails outright — before a single file of this horde's own state exists — when there is
// no graph and no way to make one.
function ensureGraph(root, cfg, flags) {
  const yg = commandLine(flags.yg || (cfg && cfg.ygCommand) || 'yg');
  if (existsSync(join(root, '.yggdrasil'))) {
    return { created: false, lines: [`architecture graph: already here (${yg.display} reads it)`] };
  }
  if (!resolves(yg)) {
    fail(
      `this repository has no architecture graph and there is no Yggdrasil CLI at "${yg.display}" to create one.\n`
      + 'A horde reads its node map, the rules over every node, and the verdict that says a merge is '
      + 'safe from that graph — without it there is nothing to cut nodes from and nothing to hold a '
      + 'ticket to.\n'
      + 'Install it and run init again: npm i -g @chrisdudek/yg\n'
      + 'Already have a build? Name it here: init --yg "node path/to/bin.js"',
    );
  }

  const init = runIn(root, yg, ['init']);
  if (!init.ok || !existsSync(join(root, '.yggdrasil'))) {
    fail(`\`${yg.display} init\` did not create a graph (exit ${init.code || 0}):\n${init.out.trim()}`);
  }
  const lines = [`architecture graph created by \`${yg.display} init\``];

  const grain = grainCommandFor(cfg, flags.grain);
  if (!grain) {
    lines.push(
      'the graph is empty — no component, no rule. Cut the first nodes with the user, or mine a '
      + 'proposal from this repository\'s own code with Grain and accept it: '
      + 'init --grain "<how to run grain>" (or horde.mjs config set grainCommand "…") on a '
      + 'repository with no graph.',
    );
    return { created: true, mined: false, lines };
  }

  const propose = runIn(root, grain, ['propose', PROPOSAL_DIR]);
  if (!propose.ok) {
    lines.push(`\`${grain.display} propose\` failed (exit ${propose.code}) — the graph stays empty:\n${propose.out.trim()}`);
    return { created: true, mined: false, lines };
  }
  const adopt = runIn(root, yg, ['adopt', PROPOSAL_DIR, '--replace']);
  if (!adopt.ok) {
    lines.push(`\`${yg.display} adopt ${PROPOSAL_DIR}\` refused the proposal (exit ${adopt.code}) — the graph stays empty:\n${adopt.out.trim()}`);
    return { created: true, mined: false, lines };
  }
  lines.push(
    `graph proposed by \`${grain.display} propose\` and accepted with \`${yg.display} adopt\` — `
    + 'its own report, including how much of the code already here the new rules refuse:',
    adopt.out.trim(),
  );
  return { created: true, mined: true, lines };
}

function cmdInit(positional, flags) {
  const name = positional[0];
  if (!name) fail('init requires <name>');
  if (!flags.base) fail('init requires --base <branch>');
  // Checked before anything at all exists, like every other argument here: an unusable setting is
  // a typo to fix, not a half-created horde to clean up.
  if (flags.quality !== undefined && !QUALITY_POLICIES.includes(flags.quality)) {
    fail(`--quality must be one of: ${QUALITY_POLICIES.join(', ')}`);
  }
  const root = repoRoot();

  // The graph comes first, before `.horde/` exists at all: a repository with no graph and no way
  // to make one is refused here, leaving nothing of this horde behind to clean up.
  const graph = ensureGraph(root, readConfig(), flags);

  // Who will judge the prose rules, and whether this repository's own commit hook can be satisfied
  // at all. A hook that demands a full `yg check` in a repository with no reviewer refuses every
  // commit a worker makes, and the only thing anyone learns from that is `--no-verify`. Refused
  // here, before a single file of this horde exists, with the two ways out named.
  const judge = detectJudge(root);
  const hook = detectCommitHook(root);
  if (judge === 'one-shot' && hook && !hook.deterministicOnly) {
    fail(
      `${hook.file} runs a full \`yg check\` on every commit, and this repository has no Yggdrasil reviewer configured.\n`
      + 'Every prose rule would then be waiting on a judge nobody can call, so every commit a worker makes would refuse — '
      + 'and the only thing that teaches is --no-verify, which switches off the gate this whole tool exists to keep.\n'
      + 'Two ways out, either is fine:\n'
      + `  - narrow the hook to the free half: \`yg check --approve --only-deterministic\` in ${hook.file}. The prose rules are then judged at landing, once, instead of at every commit.\n`
      + '  - give the repository a reviewer: yg init --provider <claude-code|codex|…> --model <model>',
    );
  }

  const hr = hordeRoot({ create: true });
  const dest = hordePath(name);
  if (existsSync(dest)) fail(`a horde named "${name}" already exists`);

  let cfg = readConfig();
  if (!cfg) {
    cfg = defaultConfig(root);
    cfg.base = flags.base;
    if (flags['test-globs']) cfg.testGlobs = parseListValue(flags['test-globs']);
  }
  // How this repository invokes the two CLIs is said once and remembered, whether or not this is
  // the first horde on it — an operator who had to name a local build to get the graph made should
  // not have to name it again for every tool that reads it.
  if (flags.yg || flags.grain) {
    if (flags.yg) cfg.ygCommand = flags.yg;
    if (flags.grain) cfg.grainCommand = flags.grain;
  }
  // A config written before the judge policy existed carries no answer to it, and the landing gate
  // refuses rather than guess — so a second horde on such a repository fills it in here from the
  // same evidence a first one would have used.
  if (!cfg.judge) cfg.judge = judge;
  writeConfig(cfg);

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
    ...(flags.quality ? { quality: flags.quality } : {}),
  });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'charter.md'), charter);

  writeText(join(dest, 'decisions.md'), '# Decisions\n\n');
  writeText(join(dest, 'plan.md'), '# Plan\n\n');
  writeJSON(join(dest, 'dissents.json'), { items: [] });
  writeJSON(join(dest, 'cost.json'), { runs: [] });
  writeJSON(join(dest, 'counter.json'), { next: 1 });

  writeJSON(join(dest, 'teams', 'trunk', 'queue.json'), { items: [] });
  mkdirSync(join(dest, 'teams', 'trunk', 'issues'), { recursive: true });

  // Whatever the repository's own gate command turns out to be, the graph judges the code too —
  // so say, at the one moment the operator is reading, that the graph's verdict was put into the
  // merge checklist and nothing further is needed to arm it.
  const graphGate = `\`${cfg.ygCommand || 'yg'} check\` is part of every merge check on this repository — it runs on the branch's own tree, whatever the gate commands say, and a graph that refuses the tree refuses the merge.`;

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

  // Said out loud at the one moment somebody is reading, because it changes what a worker is told
  // to run before committing and what the landing gate does with an unjudged rule.
  const judgeNote = cfg.judge === 'tier'
    ? 'prose rules are judged by the reviewer configured in this repository\'s graph (judge: tier) — a worker runs `yg check --approve` before committing, and landing only checks that it came back green.'
    : 'this repository has no Yggdrasil reviewer (judge: one-shot) — the commit hook runs the free half only, and landing hands back each prose rule with the two commands that judge it. Change it with: horde.mjs config set judge tier|one-shot';
  const hookNote = hook
    ? `commit hook: ${hook.file} runs \`yg check\`${hook.deterministicOnly ? ' --only-deterministic (the free half — right for this repository)' : ' in full'}`
    : 'no commit hook runs `yg check` here — nothing checks the graph until landing does';

  const leaseNote = leased.length
    ? `leased ${leased.length} node(s): ${leased.map((l) => l.node).join(', ')}`
    : null;

  emit(
    {
      horde: name,
      branch,
      base: flags.base,
      graph: { created: graph.created, mined: !!graph.mined, notes: graph.lines },
      graphGate,
      ecosystems,
      gates: cfg.gates,
      testGlobs: cfg.testGlobs,
      judge: cfg.judge,
      commitHook: hook,
      leased,
    },
    flags,
    () => [
      `horde "${name}" created — trunk branch ${branch} off ${flags.base}`,
      ...(leaseNote ? [leaseNote] : []),
      ...graph.lines,
      graphGate,
      gateNote,
      globsNote,
      judgeNote,
      hookNote,
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
const LIST_KEYS = new Set(['protectedPaths', 'testGlobs', 'copy']);

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
    const shown = qualityPolicyIn(text);
    emit({
      horde, path, charter: text, quality: QUALITY_POLICIES.includes(shown) ? shown : QUALITY_POLICIES[0],
    }, flags, () => text);
    return;
  }
  if (sub !== 'edit') fail('charter requires "show" or "edit"');

  const before = readText(path) || '';
  const content = readStdin();
  if (!content.trim()) fail('charter edit requires content on stdin');

  // The quality policy is the one field of the charter a tool acts on rather than a person reads,
  // so a value nothing recognises is refused here instead of silently falling back to the default
  // and leaving the chairman believing they had turned something off. An absent section is fine —
  // that is the ruling's own default, spelled out in the answer.
  const policy = qualityPolicyIn(content);
  if (policy !== null && !QUALITY_POLICIES.includes(policy)) {
    fail(
      `the charter's Quality section says "**Policy:** ${policy}", which is not a setting this horde has.\n`
      + 'That line decides whether the horde improves the architecture wherever it works or sticks to the '
      + 'tickets alone, and a word nothing recognises would quietly read as the default — the opposite of '
      + 'what an operator writing it meant.\n'
      + `Write one of: ${QUALITY_POLICIES.join(', ')} (or drop the section, which reads as ${QUALITY_POLICIES[0]}).`,
    );
  }

  const rowsBefore = parseEvidenceRows(before);
  const rowsAfter = parseEvidenceRows(content);
  const afterById = new Map(rowsAfter.map((r) => [r.id, r]));

  // A row dropped outright (present before, gone from this text entirely) is free before the
  // mission's wave 1 has started — nothing has been built against it yet — and after it needs an
  // answered ask of kind "charter" whose own text names every id being dropped, so the reason
  // survives in the log ask.mjs already writes (decide.mjs's ask-<id> entry), not just in this
  // command's own stdout. Dropping a promised proof is lowering the mission's own promise, and
  // that is the client's call, not a build decision — the same reasoning "lower" already carries
  // for a rule, applied to the mission card.
  const droppedIds = rowsBefore.filter((r) => !afterById.has(r.id)).map((r) => r.id);
  if (droppedIds.length && wave1Started(readText(hordePath(horde, 'plan.md')) || '')) {
    if (!flags.ask) {
      fail(
        `this rewrite drops evidence row(s) ${droppedIds.join(', ')} after the mission's wave 1 started — that `
        + `needs an answered ask naming them: ask.mjs add "<why>" --kind charter, ask.mjs answer <id> `
        + `"<answer mentioning ${droppedIds.join(', ')}>", then retry with --ask <id>`,
      );
    }
    const askId = String(flags.ask);
    const doc = readJSON(hordePath(horde, 'asks.json'), { items: [] });
    const item = (Array.isArray(doc.items) ? doc.items : []).find((it) => it.id === askId);
    if (!item) fail(`no such ask: ${askId}`);
    if (item.kind !== 'charter') fail(`ask ${askId} is kind "${item.kind}", not "charter" — dropping an evidence row is a charter change and needs an ask of that kind`);
    if (item.state !== 'answered') fail(`ask ${askId} is not answered yet (state: ${item.state}) — answer it first: ask.mjs answer ${askId} "<answer>"`);
    const askText = `${item.why}\n${item.answer || ''}`;
    const notMentioned = droppedIds.filter((id) => !mentionsEvidenceId(askText, id));
    if (notMentioned.length) {
      fail(`ask ${askId}'s text does not mention dropped row(s): ${notMentioned.join(', ')} — answer a new ask that names them, or keep the row(s)`);
    }
  }

  // Separately: a row still present but whose already-recorded "reproduced by" this text erases
  // (kept in the table, cell blanked) loses a verifier's work silently unless flagged — worth a
  // warning on every edit, drop-refusal or not.
  const filledBefore = rowsBefore.filter((r) => r.reproducedBy);
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
    quality: policy === null ? QUALITY_POLICIES[0] : policy,
  };
  emit(result, flags, () => [
    `charter written: ${horde} (${content.length} bytes) — evidence catalogue: ${result.evidenceRows} row(s), ${result.evidenceReproduced} reproduced · quality ${result.quality}`,
    ...dropped.map((d) => `warning: ${d.id} was recorded as reproduced by ${d.was} and this text drops that — put it back with: wave.mjs evidence ${d.id} --by "${d.was}"`),
  ].join('\n'));
}

// ---- archiving -----------------------------------------------------------------------------
//
// Archiving moves the horde's directory to `hordes/_archive/<name>-<date>` and touches no branch.
// That IS "in place" in the sense that matters: inside `.horde/`, automatic, uncommitted, never
// carried outside the repository — `.horde/` carries its own `.gitignore` of `*`, written when it
// is created, so nothing under it ever reaches an index. blame.mjs enumerates `_archive/` and
// treats what it finds there exactly like a live horde, which is why the move stays.
//
// What archiving gains here is the marker: an `archived` file carrying the date and the trunk sha
// the mission was handed over at. The directory alone said when it moved and nothing about what it
// moved from; a mission read back a year later needs the commit.
//
// The marker is written BEFORE the move, into the directory that is about to move, so a horde
// whose directory cannot be written refuses with nothing moved rather than leaving a half-archived
// mission behind. It is written whole every time: a second archive of the same mission overwrites
// the date rather than adding a line under it.
const ARCHIVED_MARKER = 'archived';

function archiveHorde(name) {
  const src = hordePath(name);
  if (!existsSync(src)) fail(`no such horde: ${name}`);
  const sha = git(['rev-parse', `${name}/trunk`]);
  const marker = `${today()} ${sha || '(no trunk branch)'}\n`;
  try {
    writeFileSync(join(src, ARCHIVED_MARKER), marker);
  } catch (e) {
    fail(`${join(src, ARCHIVED_MARKER)} could not be written, so this mission cannot be marked archived: ${e.message}`);
  }
  const dest = join(hordeRoot(), 'hordes', '_archive', `${name}-${today()}`);
  try {
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
  } catch (e) {
    fail(`${src} could not be moved to ${dest}: ${e.message}`);
  }
  // node-lease-across-hordes: an archived horde is no longer live, so every node it held is free
  // the moment it archives — the same instant node.mjs bind and horde.mjs init start treating it
  // as no obstacle for another horde.
  return {
    from: src, to: dest, sha, date: today(), releasedLeases: releaseLeasesForHorde(name),
  };
}

function cmdArchive(positional, flags) {
  const name = positional[0];
  if (!name) fail('archive requires <name>');
  const archived = archiveHorde(name);
  emit(archived, flags, () => [
    `archived: ${name} -> ${archived.to} (${archived.date}, trunk at ${short(archived.sha)})`,
    archived.releasedLeases.length ? `released lease(s): ${archived.releasedLeases.join(', ')}` : 'held no node leases',
  ].join('\n'));
}

// ---- done — the mission's final gate -----------------------------------------------
//
// evidence-is-the-plan: "done" is never "the queue is empty" — it is every promised proof
// reproduced, the trunk gate green at the trunk tip, a cost report on file, and the mission's
// retrospective run over the mission as it now stands. Refuses listing
// every reason at once (never one at a time, forcing a retry
// loop); on success it stamps the charter (via stampMissionEvidence, already called for the
// evidence check itself), appends the completion block to the mission journal, and prints what
// the chairman does next.

function short(sha) { return sha ? sha.slice(0, 7) : '(none)'; }

// Tolerant the same way land.mjs's own gate comparisons are: a short sha, a full sha, or
// either shortened to the other's length all count as the same commit.
function shaMatchesTolerant(a, b) {
  if (!a || !b) return false;
  return a === b || a === short(b) || short(a) === short(b) || String(b).startsWith(a) || String(a).startsWith(b);
}

// Runs `cmd` against the trunk branch's own tree, in a scratch worktree that never touches the
// caller's — the same shape land.mjs's own revert test and gate checks use, since "done" has
// no ticket branch worktree of its own to run in.
function runGateAt(root, cmd, branch) {
  const tmp = mkdtempSync(join(tmpdir(), 'horde-done-gate-'));
  let ok = false;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', '--force', tmp, branch], { cwd: root, stdio: 'pipe' });
    try {
      execSync(cmd, { cwd: tmp, stdio: 'pipe' });
      ok = true;
    } catch {
      ok = false;
    }
  } finally {
    try { execFileSync('git', ['worktree', 'remove', tmp, '--force'], { cwd: root, stdio: 'pipe' }); } catch { rmSync(tmp, { recursive: true, force: true }); }
  }
  return { ok };
}

function cmdDone(positional, flags) {
  const horde = resolveHorde(flags);
  const cfg = readConfig() || {};
  const root = resolveTree({ tree: flags.tree, horde }).path;
  const reasons = [];

  // 1. Every promised proof, reproduced. stampMissionEvidence promotes whatever a merged ticket
  // already proved into the charter's own cell (mission-wide, not scoped to one wave) before the
  // check, so "done" never depends on a wave close the director forgot to run.
  const coverage = stampMissionEvidence(horde);
  if (coverage.length === 0) {
    reasons.push('the charter\'s evidence catalogue is empty — nothing to reproduce is not the same as done; add rows with horde.mjs charter edit');
  }
  const red = coverage.filter((r) => r.state !== 'reproduced');
  if (red.length) {
    reasons.push(`evidence row(s) not reproduced: ${red.map((r) => `${r.id} (${r.state})`).join(', ')} — see status.mjs --horde ${horde} for what each is waiting on`);
  }

  // 2. The trunk gate green at the trunk tip — a matching recorded green is accepted, anything
  // else is run fresh (config.gates.trunk, in a scratch worktree of the trunk branch).
  const trunkBranch = `${horde}/trunk`;
  const trunkSha = git(['rev-parse', trunkBranch]);
  let gateGreen = false;
  if (!trunkSha) {
    reasons.push(`no such branch: ${trunkBranch}`);
  } else {
    const gateCmd = cfg.gates && cfg.gates.trunk;
    if (!gateCmd) {
      reasons.push('no config.gates.trunk configured — set it: horde.mjs config set gates.trunk "<command>"');
    } else {
      const gateCache = readJSON(hordePath(horde, 'cache', 'last-gate.json'), {});
      const cached = gateCache.trunk;
      if (cached && cached.result === 'green' && shaMatchesTolerant(cached.sha, trunkSha)) {
        gateGreen = true;
      } else {
        const ran = runGateAt(root, gateCmd, trunkBranch);
        gateGreen = ran.ok;
        writeJSON(hordePath(horde, 'cache', 'last-gate.json'), {
          ...gateCache,
          trunk: {
            sha: trunkSha, result: gateGreen ? 'green' : 'red', count: null, at: new Date().toISOString(), by: 'horde done',
          },
        });
        if (!gateGreen) reasons.push(`trunk gate red at ${short(trunkSha)} (${gateCmd})`);
      }
    }
  }

  // 3. A cost report on file — cost.json always exists once a horde is init'd, so "missing" here
  // means nobody has ever spawned an agent against it.
  const costDoc = readJSON(hordePath(horde, 'cost.json'), { runs: [] });
  const runsArr = Array.isArray(costDoc.runs) ? costDoc.runs : [];
  if (runsArr.length === 0) {
    reasons.push('no cost has ever been recorded for this mission — nothing has run, so there is nothing to report (cost.mjs report)');
  }

  // 4. The retrospective run, and run over this mission as it stands. What the gate refused and
  // what workers wrote to each other is read exactly once, at the end, by retro.mjs — a mission
  // closed without it throws that away, and one closed on a retrospective taken before the last
  // ticket landed has a document that never saw it.
  const retro = readJSON(hordePath(horde, 'retro.json'), null);
  const state = missionState(collectRetroInput(horde).landed);
  if (!retro || retro.schema !== RETRO_SCHEMA) {
    reasons.push(`no retrospective has been run on this mission — what the gate refused and what workers wrote in their ticket logs is read once, here, and then it is gone: retro.mjs --horde ${horde}`);
  } else if (retro.state !== state) {
    reasons.push(`the retrospective on file is out of date — it was taken over a different set of landed tickets than the mission now has, so it never saw what landed after it: run it again, retro.mjs --horde ${horde}`);
  }

  if (reasons.length) {
    fail(`mission "${horde}" is not done — ${reasons.length} reason(s):\n- ${reasons.join('\n- ')}`);
  }

  const weights = cfg.classes || {};
  const { runs, weighted } = sumEntries(runsArr, weights);
  const limit = readCostLimit(horde);

  // The last word on what this mission did to the law, taken at the trunk it is handing over —
  // which has usually moved since the last wave closed. Written at that wave's own path, because
  // the document measures the same two trees the close measured and is the same answer, taken
  // later: one document per mission-and-wave, never a second copy of one reading.
  const law = writeLawDiff(horde, cfg, String(lastWaveNumber(readText(hordePath(horde, 'plan.md')) || '')));

  const rendered = renderTemplate('mission-close', {
    date: today(),
    green: coverage.length,
    total: coverage.length,
    gate: 'green',
    sha: short(trunkSha),
    runs,
    weighted,
    horde,
    'of limit': limit === null ? '' : ` of ${limit}`,
  });
  appendText(hordePath(horde, 'plan.md'), `\n${rendered}`);

  // The mission is over, so the horde is archived here and not by a separate command somebody has
  // to remember: the same move `archive` makes, with the same marker, releasing the same leases.
  // Everything above has already been written, so the paths this reports are the paths inside the
  // archived directory — where the documents now are, rather than where they were made.
  const lawPath = law.path;
  const retroPath = hordePath(horde, 'retro.json');
  const archived = archiveHorde(horde);
  const relocate = (p) => (p.startsWith(archived.from) ? archived.to + p.slice(archived.from.length) : p);

  const result = {
    horde,
    evidence: { green: coverage.length, total: coverage.length },
    gate: { level: 'trunk', sha: trunkSha, result: 'green' },
    cost: { runs, weighted, limit },
    law: {
      path: relocate(lawPath), added: law.doc.added.length, raised: law.doc.raised.length, attached: law.doc.attached.length,
    },
    retro: { path: relocate(retroPath), law: retro.law.length, inexpressible: retro.inexpressible.length },
    archived: { to: archived.to, date: archived.date, releasedLeases: archived.releasedLeases },
  };
  emit(result, flags, () => [
    `mission "${horde}" is done — evidence ${coverage.length}/${coverage.length} green, trunk gate green at ${short(trunkSha)}, `
      + `cost ${runs} runs (weighted ${weighted}).`,
    `What the law gained over this mission — ${law.doc.added.length} rule(s) added, ${law.doc.raised.length} raised, `
      + `${law.doc.attached.length} newly attached: ${result.law.path}`,
    `What the law still cannot say — ${retro.inexpressible.length} item(s), beside ${retro.law.length} rule proposal(s) `
      + `the retrospective raised: ${result.retro.path}`,
    `Archived: ${archived.to} — marked ${archived.date} at ${short(archived.sha)}, and nothing of it is committed.`,
    `Push when ready: git push <remote> ${trunkBranch} — and open the pull request. That decision is the chairman's, never this tool's.`,
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
    case 'done': return cmdDone(positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
