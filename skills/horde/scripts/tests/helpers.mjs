// Test-only helpers: a fresh temporary git repository per test, and a runner that invokes a
// tool exactly the way a real caller would (a child process, cwd inside the repo), so the tests
// exercise the actual CLI contract rather than the internals.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// makeRepo() — a temp git repo with one commit on the default branch and a "develop" branch,
// ready for `horde.mjs init --base develop`. Returns the directory; the caller should rmRepo()
// it when done (each test uses its own, so leaking a few temp dirs on a thrown assertion is an
// acceptable cost against the alternative of a shared, order-dependent fixture).
export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'horde-test-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  git(['add', 'README.md'], dir);
  git(['commit', '-qm', 'init'], dir);
  git(['branch', 'develop'], dir);
  return dir;
}

export function rmRepo(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// run(tool, args, cwd, {json}) — invokes `node scripts/<tool> ...args` with cwd inside a test
// repo (never the scripts directory itself, matching how every tool resolves its repo root).
// `json` (default true) appends --json so stdout parses cleanly; pass false to inspect the
// human-readable rendering instead. Never throws on a non-zero exit — the result's `code` and
// `stderr` are how a test asserts a refusal.
export function run(toolName, args, cwd, { json = true } = {}) {
  const fullArgs = json ? [...args, '--json'] : args;
  try {
    const stdout = execFileSync('node', [join(SCRIPTS_DIR, toolName), ...fullArgs], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '', json: safeJSON(stdout) };
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : '';
    return { code: e.status ?? 1, stdout, stderr, json: safeJSON(stdout) };
  }
}

// initHorde(dir, name, extra) — the one setup step almost every other test needs first. The
// fixture repository is a bare git repo with no build files at all, so nothing tells `init` what
// its tests are called; every test that reaches the merge checklist declares it here the way a
// real adopter would, unless it passes its own --test-globs to exercise the detection itself.
//
// `--yg` names the real Yggdrasil build on this machine, because Horde requires Yggdrasil: on a
// repository with no graph `init` creates one through that CLI, so every fixture below gets a real
// `.yggdrasil/` made by the real thing, never a hand-written stand-in.
export function initHorde(dir, name = 'mission1', extra = []) {
  const globs = extra.includes('--test-globs') ? [] : ['--test-globs', '**/*.test.*,**/*.spec.*'];
  const ygFlag = extra.includes('--yg') ? [] : ['--yg', requireYg()];
  const r = run('horde.mjs', ['init', name, '--base', 'develop', ...globs, ...ygFlag, ...extra], dir);
  if (r.code !== 0) throw new Error(`initHorde failed: ${r.stderr}`);
  return r.json;
}

// requireYg() — the real Yggdrasil CLI, or a refusal that says why the suite cannot run without
// one. Horde requires Yggdrasil; a suite that quietly measured a stand-in instead would be proving
// something no adopter ever runs.
export function requireYg() {
  const found = findRealYg();
  if (!found) {
    throw new Error(
      'no Yggdrasil CLI on this machine — Horde requires it, and so does this suite. Put `yg` on '
      + 'PATH, set HORDE_TEST_YG to a command line, or check out Yggdrasil beside this repository.',
    );
  }
  return found;
}

// yg(dir, args) — run the real CLI in a fixture and hand back what it said, exit code included.
export function yg(dir, args) {
  const parts = requireYg().split(/\s+/);
  try {
    return {
      code: 0,
      out: execFileSync(parts[0], [...parts.slice(1), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (e) {
    return {
      code: e.status ?? 1,
      out: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''),
    };
  }
}

// ygInit(dir) — the real `yg init`, for a fixture that needs a graph in place before
// `horde.mjs init` ever runs.
export function ygInit(dir) {
  const r = yg(dir, ['init']);
  if (r.code !== 0) throw new Error(`yg init failed: ${r.out}`);
  return dir;
}

// addNode(dir, path, spec) — a real component in the real graph: the `yg-node.yaml` Yggdrasil
// itself reads, at the path that IS the node's identity. Written by hand because no `yg` command
// authors a component; every tool under test then reads it back through `yg node --json`, which is
// the only way any of them sees a node at all.
export function addNode(dir, path, spec = {}) {
  const {
    type = 'module',
    description = `Fixture component ${path}.`,
    mapping = [],
    relations = [],
    aspects = [],
    ports = {},
  } = spec;
  const lines = [
    `name: ${path.split('/').pop()}`,
    `type: ${type}`,
    `description: ${description}`,
  ];
  if (aspects.length) {
    lines.push('aspects:');
    for (const a of aspects) lines.push(`  - ${a}`);
  }
  lines.push('mapping:');
  if (mapping.length) for (const m of mapping) lines.push(`  - "${m}"`);
  else lines.push('  []');
  if (relations.length) {
    lines.push('relations:');
    for (const r of relations) {
      lines.push(`  - target: ${r.target}`);
      lines.push(`    type: ${r.type || 'uses'}`);
      if (r.consumes && r.consumes.length) {
        lines.push('    consumes:');
        for (const c of r.consumes) lines.push(`      - ${c}`);
      }
    }
  } else {
    lines.push('relations: []');
  }
  const portNames = Object.keys(ports);
  if (portNames.length) {
    lines.push('ports:');
    for (const name of portNames) {
      const p = ports[name] || {};
      lines.push(`  ${name}:`);
      lines.push(`    description: ${p.description || `The ${name} promise.`}`);
      if (p.version !== undefined) lines.push(`    version: ${p.version}`);
      if (p.test !== undefined) lines.push(`    test: ${p.test}`);
      lines.push('    aspects: []');
    }
  }
  const dest = join(dir, '.yggdrasil', 'model', path);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'yg-node.yaml'), `${lines.join('\n')}\n`);
  return dest;
}

// addAspect(dir, id, spec) — a real rule in the real graph. `check` makes it a script rule (run
// locally, free); `content` makes it a prose rule, which a reader has to judge — the work the
// verifier's own channel exists for.
export function addAspect(dir, id, spec = {}) {
  const {
    name = id, description = `Fixture rule ${id}.`, status = 'enforced', check = null, content = null,
  } = spec;
  const dest = join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(dest, { recursive: true });
  const head = [`name: ${name}`, `description: ${description}`];
  if (check) head.push('errs: under');
  head.push(`status: ${status}`, 'review_by: 2099-01-01');
  writeFileSync(join(dest, 'yg-aspect.yaml'), `${head.join('\n')}\n`);
  if (check) writeFileSync(join(dest, 'check.mjs'), check);
  if (content) writeFileSync(join(dest, 'content.md'), content);
  return dest;
}

// A script rule that refuses any file carrying the marker — small, real and deterministic, so a
// fixture can make `yg check` red on purpose and green again by deleting one line.
export const MARKER_CHECK = [
  'export function check(ctx) {',
  '  const out = [];',
  '  for (const file of ctx.files) {',
  "    const lines = file.content.split('\\n');",
  '    for (let i = 0; i < lines.length; i++) {',
  "      if (lines[i].includes('UNFINISHED')) {",
  "        out.push({ file: file.path, line: i + 1, column: 0, message: 'unfinished-work marker left behind.' });",
  '      }',
  '    }',
  '  }',
  '  return out;',
  '}',
  '',
].join('\n');

// findRealYg() — the real, installed Yggdrasil CLI, for the tests that measure a real graph
// rather than a stand-in: the HORDE_TEST_YG environment variable, else `yg` on PATH, else a
// sibling checkout's own build (`<ancestor>/Yggdrasil/source/cli/dist/bin.js`, walking up from
// this repository — the layout of a machine that has both repos out). Returns the command line
// to put in `config.ygCommand`, or null when there is none. A test that gets null asserts the
// honest "not measured" answer the tools give without a CLI; it never fabricates a report.
let resolvedYg;
export function findRealYg() {
  // Resolved once per process: the probe starts a process, and a machine running the whole suite
  // at once can fail to start one for a moment. Answering "there is no CLI" to that would be a
  // lie about the machine, and every fixture below would then be built on it.
  if (resolvedYg !== undefined) return resolvedYg;
  resolvedYg = locateRealYg();
  return resolvedYg;
}

function locateRealYg() {
  const probe = (cmdline) => {
    const parts = String(cmdline).trim().split(/\s+/).filter(Boolean);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        execFileSync(parts[0], [...parts.slice(1), '--version'], { stdio: 'ignore' });
        return cmdline;
      } catch (e) {
        // A program that is not there is not there; a machine that could not start one right now
        // is worth one more ask.
        if (e.code === 'ENOENT' || (e.status !== undefined && e.status !== null)) return null;
      }
    }
    return null;
  };
  if (process.env.HORDE_TEST_YG) return probe(process.env.HORDE_TEST_YG);
  const onPath = probe('yg');
  if (onPath) return onPath;
  let dir = SCRIPTS_DIR;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'Yggdrasil', 'source', 'cli', 'dist', 'bin.js');
    if (existsSync(candidate)) return probe(`node ${candidate}`);
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// writeCostRuns(dir, horde, runs) — cost.json is written only by roster.mjs spawn (out of this
// half's scope), so tests that need spawned-run cost data seed the file directly in the shape
// roster.mjs is contracted to write: {runs: [{name, role, class, ticket, team, wave, at}]}.
export function writeCostRuns(dir, horde, runs) {
  const path = join(dir, '.horde', 'hordes', horde, 'cost.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ runs }, null, 2) + '\n');
}
