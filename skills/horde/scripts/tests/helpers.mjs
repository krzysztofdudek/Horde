// Test-only helpers: a fresh temporary git repository per test, and a runner that invokes a
// tool exactly the way a real caller would (a child process, cwd inside the repo), so the tests
// exercise the actual CLI contract rather than the internals.

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YG_DOCUMENTS_AFTER } from '../node.mjs';
import { splitCommandLine, programFor } from '../_lib.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// A commit made through this helper is signed by the sandbox's own commit-signing service
// (global git config: commit.gpgsign=true, gpg.ssh.program) — nothing to do with the code under
// test. Under heavy concurrent load that service intermittently answers 503, and git surfaces the
// failure as the signing program's own stderr followed by "failed to write commit object" (traced
// and reproduced locally by pointing gpg.ssh.program at a script that fails the same way: the
// phrase is git's own commit-object-writing step talking, the same for `commit`, `merge` and
// `revert` alike, whichever one asked for it). Retry ONLY that one signal, a small bounded number
// of times with a short backoff; anything else — a real conflict, a rejected commit-msg hook, a
// bad ref — throws on the first attempt, exactly as before this fix.
//
// The one shared, exported git() every test file in this suite imports — originally two separate,
// narrower copies (this file's own, scoped to what makeRepo() calls, and land.test.mjs's own,
// which already handled the full commit/merge/revert distinction) before both, and every other
// test file's uncoordinated local copy, were consolidated here. A caller can lead with a global
// option that takes a following value (`-C <dir>`, `-c <name>=<value>`) before the actual
// subcommand — tick.test.mjs, queue.test.mjs and ask.test.mjs all commit through a ticket's own
// worktree this way, e.g. `git(['-C', worktree, 'commit', '--allow-empty', '-qm', 'work'], repoDir)`
// — so the retry/recovery logic below locates the real subcommand past any such prefix rather than
// assuming args[0] names it, and reissues the same prefix on recovery.
const COMMIT_WRITING_SUBCOMMANDS = new Set(['commit', 'merge', 'revert']);
const TRANSIENT_SIGNING_SIGNAL = /\b50[234]\b|service unavailable|bad gateway|gateway timeout/i;
const SIGNING_RETRY_ATTEMPTS = 3;
const SIGNING_RETRY_BACKOFF_SECONDS = 0.3;

function isTransientSigningFailure(stderr) {
  return /failed to write commit object/i.test(stderr) && TRANSIENT_SIGNING_SIGNAL.test(stderr);
}

// Splits a git() args array into the leading global-option prefix (`-C <dir>`, `-c <name>=<value>`
// — the only two forms any caller in this suite uses ahead of a subcommand) and the subcommand
// that follows it, so retry/recovery can identify the real subcommand, and reissue the same
// prefix, regardless of what precedes it.
function splitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-C' || a === '-c') { i += 1; continue; }
    if (typeof a === 'string' && a.startsWith('-')) continue;
    return { prefix: args.slice(0, i), subcommand: a };
  }
  return { prefix: args.slice(), subcommand: undefined };
}

export function git(args, cwd) {
  const { prefix, subcommand } = splitSubcommand(args);
  if (!COMMIT_WRITING_SUBCOMMANDS.has(subcommand)) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  for (let attempt = 1; attempt <= SIGNING_RETRY_ATTEMPTS; attempt += 1) {
    // Attempt 1 always runs the caller's own command. A `merge` or `revert` that failed at the
    // signing step has already updated the index and written git's own prepared commit message —
    // re-issuing the same subcommand fails outright ("already in progress" / "local changes would
    // be overwritten"); the correct way to finish it is a plain `git commit --no-edit` (behind the
    // same prefix, if any, so it still targets the right worktree), which reuses that prepared
    // message (verified locally: it reproduces the exact commit `merge` or `revert` would have
    // made). A plain `commit` that failed at signing leaves the index untouched, so re-issuing the
    // exact same command is both correct and simpler — `--no-edit` does NOT recover a `-m` message
    // here (verified locally: it aborts on an empty commit message), so it is only used to finish
    // an already-staged `merge`/`revert`.
    const thisAttempt = (attempt === 1 || subcommand === 'commit') ? args : [...prefix, 'commit', '--no-edit'];
    try {
      return execFileSync('git', thisAttempt, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const transient = isTransientSigningFailure(stderr);
      if (!transient || attempt === SIGNING_RETRY_ATTEMPTS) {
        if (transient) {
          e.message += `\n[git commit-signing] gave up after ${attempt} attempts — stderr names a `
            + '50x/"Service Unavailable" signal alongside "failed to write commit object", which reads as '
            + 'the sandbox\'s signing service struggling under load, not a failure in the code under test.';
        }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SIGNING_RETRY_BACKOFF_SECONDS * attempt * 1000);
    }
  }
  // Unreachable: SIGNING_RETRY_ATTEMPTS >= 1, and every iteration above either returns or throws.
  return undefined;
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

// A background `land.mjs` can still be removing its own scratch trees when a test's result is
// already written, so the first attempt can meet a directory that is not empty yet; retrying is what
// `rmSync` offers for exactly that.
export function rmRepo(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// run(tool, args, cwd, {json}) — invokes `node scripts/<tool> ...args` with cwd inside a test
// repo (never the scripts directory itself, matching how every tool resolves its repo root).
// `json` (default true) appends --json so stdout parses cleanly; pass false to inspect the
// human-readable rendering instead. Never throws on a non-zero exit — the result's `code` and
// `stderr` are how a test asserts a refusal.
export function run(toolName, args, cwd, { json = true, env } = {}) {
  const fullArgs = json ? [...args, '--json'] : args;
  try {
    const stdout = execFileSync('node', [join(SCRIPTS_DIR, toolName), ...fullArgs], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env,
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

// ---- the charter's evidence judgement, for a fixture that needs one ---------------------------
//
// refine.mjs's cut writes one judgement per mission into the charter: what proof means in THIS
// repository. A fixture that needs the charter to already carry one — most of all the "there is
// nothing here to point at" answer — gets it written by the same two functions the real cut uses,
// so what a test measures and what a real mission's charter says can never be two different
// sentences. Never hand-typed prose: that is the drift this avoids.

// detectEvidenceLayer's own shapes for the two answers a fixture asks for.
export const NO_EVIDENCE_LAYER = {
  kind: 'none', promises: null, suites: [], globs: [], looksLikeTests: [], looksLikeCount: 0,
};
export const A_TEST_SUITE = {
  kind: 'suite', promises: null, suites: [{ name: 'npm', gate: 'npm run test' }], globs: ['**/*.test.mjs'],
};

export async function writeEvidenceJudgement(dir, layer, horde = 'mission1') {
  const { renderEvidenceJudgement } = await import('../horde.mjs');
  const { upsertCharterSection, EVIDENCE_SECTION } = await import('../wave.mjs');
  const path = join(dir, '.horde', 'hordes', horde, 'charter.md');
  const text = upsertCharterSection(
    readFileSync(path, 'utf8'),
    EVIDENCE_SECTION,
    renderEvidenceJudgement(layer),
    { before: '## Acceptance' },
  );
  writeFileSync(path, text);
  return path;
}

// requireYg() — the real Yggdrasil CLI, or a refusal that says why the suite cannot run without
// one. Horde requires Yggdrasil; a suite that quietly measured a stand-in instead would be proving
// something no adopter ever runs.
// A mission's tickets live in its Jarl loop: .horde/hordes/<h>/.jarl/issues/NNN-<slug>.md, with the
// ticket's own log beside the loop at teams/<team>/issues/NNN-<slug>/log.md. The path of one ticket's
// file, found by its number.
export function ticketIssuePath(dir, horde, id) {
  const issues = join(dir, '.horde', 'hordes', horde, '.jarl', 'issues');
  const hit = existsSync(issues) ? readdirSync(issues).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md')) : null;
  return hit ? join(issues, hit) : null;
}

// The loop's file for the ticket whose own directory (its log's) is `ticketDir` —
// .horde/hordes/<h>/teams/<team>/issues/NNN-<slug> → .horde/hordes/<h>/.jarl/issues/NNN-<...>.md: the
// file the loop already holds for that number, else NNN-<slug>.md. For a test that writes or edits a
// ticket's text by hand where it used to write the directory's issue.md.
export function issueFileOf(ticketDir) {
  const m = /^(.*)[\\/]\.horde[\\/]hordes[\\/](.+?)[\\/]teams[\\/].+?[\\/]issues[\\/]((\d+)-[^\\/]+)[\\/]?$/.exec(ticketDir);
  if (!m) throw new Error(`not a ticket directory: ${ticketDir}`);
  const [, root, horde, name, id] = m;
  const issues = join(root, '.horde', 'hordes', horde, '.jarl', 'issues');
  mkdirSync(issues, { recursive: true });
  return ticketIssuePath(root, horde, id) || join(issues, `${name}.md`);
}

// A ticket's status written straight into its file — for a fixture that needs a ticket to stand in a
// status no tool would move it to there (merged with no merge behind it, say). The tools refuse that
// move on purpose; a test setting the scene is not a tool.
export function forceTicketStatus(dir, horde, id, status) {
  const path = ticketIssuePath(dir, horde, id);
  if (!path) throw new Error(`no ticket ${id} in ${horde}`);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^\*\*Status:\*\*.*$/m, `**Status:** ${status}`));
}

// A ticket written by hand, the way a test sets one up: its file in the loop (text as given — a
// ticket written with the fields a test needs and nothing else is read like any other), and the
// directory holding its own log. Returns that directory.
export function writeTicketFixture(dir, horde, id, slug, text, { team = 'trunk', log = '' } = {}) {
  const issues = join(dir, '.horde', 'hordes', horde, '.jarl', 'issues');
  mkdirSync(issues, { recursive: true });
  const existing = ticketIssuePath(dir, horde, id);
  writeFileSync(existing || join(issues, `${id}-${slug}.md`), text);
  const side = join(dir, '.horde', 'hordes', horde, 'teams', team, 'issues', `${id}-${slug}`);
  mkdirSync(side, { recursive: true });
  if (log !== null && (log || !existsSync(join(side, 'log.md')))) writeFileSync(join(side, 'log.md'), log);
  return side;
}

export function requireYg() {
  const found = findRealYg();
  if (!found) {
    throw new Error(ygFloorRefusal() || (
      'no Yggdrasil CLI on this machine — Horde requires it, and so does this suite. Put `yg` on '
      + 'PATH, set HORDE_TEST_YG to a command line, or check out Yggdrasil beside this repository.'));
  }
  return found;
}

// yg(dir, args) — run the real CLI in a fixture and hand back what it said, exit code included.
export function yg(dir, args) {
  const { cmd, prefix } = programFor(splitCommandLine(requireYg()));
  try {
    return {
      code: 0,
      out: execFileSync(cmd, [...prefix, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
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
  // Yggdrasil refuses a `mapping:` that is empty, so a node that maps no code leaves the key out.
  if (mapping.length) {
    lines.push('mapping:');
    for (const m of mapping) lines.push(`  - "${m}"`);
  }
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
// `reviewBy`, `when` and `scope` are the three fields a change to a rule can weaken it through, so
// a fixture that exercises the law guard has to be able to write them. `when` and `scope` are
// given as raw YAML blocks (already indented under their key) — the grammar is Yggdrasil's, and
// spelling it out in the fixture is the point: the guard is measured against the real predicate,
// never a stand-in for one.
export function addAspect(dir, id, spec = {}) {
  const {
    name = id, description = `Fixture rule ${id}.`, status = 'enforced', check = null, content = null,
    reviewBy = '2099-01-01', when = null, scope = null,
  } = spec;
  const dest = join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(dest, { recursive: true });
  const head = [`name: ${name}`, `description: ${description}`];
  if (check) head.push('errs: under');
  head.push(`status: ${status}`, `review_by: ${reviewBy}`);
  if (when) head.push('when:', when);
  if (scope) head.push('scope:', scope);
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
//
// Only a CLI at or above Horde's own floor (YG_DOCUMENTS_AFTER) counts. Horde refuses an older one
// by design, so a suite run against it fails in every test that touches a graph — hundreds of
// failures that all say the same thing. An older `yg` on PATH is passed over for a sibling build
// that meets the floor; HORDE_TEST_YG is taken as meant, never second-guessed. When the only CLI
// found is too old, findRealYg answers null and ygFloorRefusal() says which one and what to do.
let resolvedYg;
let belowFloor = null;
export function findRealYg() {
  // Resolved once per process: the probe starts a process, and a machine running the whole suite
  // at once can fail to start one for a moment. Answering "there is no CLI" to that would be a
  // lie about the machine, and every fixture below would then be built on it.
  if (resolvedYg !== undefined) return resolvedYg;
  resolvedYg = locateRealYg();
  return resolvedYg;
}

// The one refusal for a machine whose Yggdrasil is older than Horde's floor, or null when it is not.
export function ygFloorRefusal() {
  findRealYg();
  if (!belowFloor) return null;
  return `the Yggdrasil CLI this suite found is too old: \`${belowFloor.cmdline}\` reports ${belowFloor.version}, `
    + `and Horde needs ${YG_DOCUMENTS_AFTER} or newer, so every test that touches a graph would fail on it. `
    + `Install a newer one (npm i -g @chrisdudek/yg), or point the suite at a build: `
    + `HORDE_TEST_YG="node <path to Yggdrasil>/source/cli/dist/bin.js".`;
}

// Whether a reported version string is at or above the floor. One that cannot be read is not held
// against the CLI: the tools check every document they read by its schema anyway.
function meetsFloor(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!m) return true;
  const floor = YG_DOCUMENTS_AFTER.split('.').map(Number);
  const have = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== floor[i]) return have[i] > floor[i];
  }
  return true;
}

function locateRealYg() {
  const probe = (cmdline) => {
    let program;
    try { program = programFor(splitCommandLine(cmdline)); } catch { return null; }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = execFileSync(program.cmd, [...program.prefix, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return { cmdline, version: String(out).trim() };
      } catch (e) {
        // A program that is not there is not there; a machine that could not start one right now
        // is worth one more ask.
        if (e.code === 'ENOENT' || (e.status !== undefined && e.status !== null)) return null;
      }
    }
    return null;
  };
  const accept = (found) => {
    if (!found) return null;
    if (meetsFloor(found.version)) return found.cmdline;
    if (!belowFloor) belowFloor = { cmdline: found.cmdline, version: found.version };
    return null;
  };
  if (process.env.HORDE_TEST_YG) return accept(probe(process.env.HORDE_TEST_YG));
  // On Windows `yg` on PATH is npm's yg.cmd shim, which nothing can start without a shell; the suite
  // hands the tools, and splits for its own fixtures, the node line the shim stands for instead.
  const onPath = accept(probe('yg'));
  if (onPath) {
    const { cmd, prefix } = programFor(['yg']);
    return cmd === 'yg' ? onPath : [cmd, ...prefix].map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' ');
  }
  let dir = SCRIPTS_DIR;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'Yggdrasil', 'source', 'cli', 'dist', 'bin.js');
    if (existsSync(candidate)) {
      const sibling = accept(probe(`node "${candidate}"`));
      if (sibling) belowFloor = null;
      return sibling;
    }
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// ---- the suite's one refusal for a Yggdrasil below the floor ----------------------------------
//
// Asked once, as each test file loads, rather than left to the tests: a CLI older than Horde's floor
// fails every test that touches a graph, and hundreds of failures that all mean "wrong Yggdrasil"
// hide the one sentence that says so. The file stops before any test runs, naming the CLI it found
// and the release to install. `tests/yg-floor.mjs` asks the same question once for the whole suite.
{
  const refusal = ygFloorRefusal();
  if (refusal) {
    process.stderr.write(`\nerror: ${refusal}\n\n`);
    process.exit(1);
  }
}
