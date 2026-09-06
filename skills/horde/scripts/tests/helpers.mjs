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
export function initHorde(dir, name = 'mission1', extra = []) {
  const globs = extra.includes('--test-globs') ? [] : ['--test-globs', '**/*.test.*,**/*.spec.*'];
  const r = run('horde.mjs', ['init', name, '--base', 'develop', ...globs, ...extra], dir);
  if (r.code !== 0) throw new Error(`initHorde failed: ${r.stderr}`);
  return r.json;
}

// findRealYg() — the real, installed Yggdrasil CLI, for the tests that measure a real graph
// rather than a stand-in: the HORDE_TEST_YG environment variable, else `yg` on PATH, else a
// sibling checkout's own build (`<ancestor>/Yggdrasil/source/cli/dist/bin.js`, walking up from
// this repository — the layout of a machine that has both repos out). Returns the command line
// to put in `config.ygCommand`, or null when there is none. A test that gets null asserts the
// honest "not measured" answer the tools give without a CLI; it never fabricates a report.
export function findRealYg() {
  const probe = (cmdline) => {
    const parts = String(cmdline).trim().split(/\s+/).filter(Boolean);
    try {
      execFileSync(parts[0], [...parts.slice(1), '--version'], { stdio: 'ignore' });
      return cmdline;
    } catch {
      return null;
    }
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
