#!/usr/bin/env node
// horde skill — vendor.mjs
//
// Horde stands on Jarl's record: the loop a mission keeps (its tickets, rulings, questions and log) is
// written by Jarl's record.mjs, vendored here under a pin. This tool keeps that copy honest. Zero
// dependencies, Node 22+, git on PATH for the commands that fetch.
//
//   check                  sha256 of every vendored file against the pin, the copy holding exactly the
//                          pinned files, and the record API the copy exports against the pin's; offline,
//                          exit 1 on any drift (npm test runs it)
//   check --source <dir>   the offline check, then a byte compare of the copy with a JarlSkill working
//                          tree (CI checks out the Jarl branch of the same name; a developer points it at a
//                          sibling checkout); exit 1 when they differ, naming the update that brings them
//                          together
//   check --ci             the offline check, then a fresh shallow fetch of the pinned commit into
//                          .jarl-vendor/ (ignored by git) and a byte compare with it
//   update --source <dir>  copy the pinned paths from a JarlSkill working tree (its HEAD must be committed
//                          and clean) and rewrite the pin: its commit, the branch it was on, every sha256
//
// Options: --pin <file> (default: vendor/jarl.pin.json beside this script), --work-dir <dir> (default:
// <repository root>/.jarl-vendor). Exit codes: 0 pass, 1 gate failure, 2 usage or environment error.
//
// The pin, every consumer-side path relative to the pin file's directory:
//   source   git URL of JarlSkill
//   ref      the branch or tag the copy was taken from (what CI checks out beside it)
//   commit   the commit the copy was taken from, 40 hex characters
//   api      the record API the copy exports (record.mjs's RECORD_API), e.g. jarl-record/1
//   dest     the directory holding the copy; files keep their JarlSkill-relative paths under it
//   paths    the JarlSkill-relative files vendored
//   files    { <JarlSkill-relative path>: <sha256> } (written by update)
//
// Why a pin on a commit and not on a tag, as Runes' own vendoring tool does: Jarl's release line is not
// tagged while a release is being built, and Horde has to stand on it before it is. The commit is what
// the bytes came from; the ref is only where CI finds the branch to compare with. What the gate proves:
// the copy is byte for byte what the pinned commit holds. It catches accidents and hand edits; it does
// not stop a change that rewrites the pin and the copy together, which is a review question.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync,
} from 'node:fs';
import {
  dirname, join, relative, resolve, sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PIN = join(HERE, 'vendor', 'jarl.pin.json');
const GIT_TIMEOUT_MS = Number(process.env.JARL_VENDOR_GIT_TIMEOUT_MS) > 0 ? Number(process.env.JARL_VENDOR_GIT_TIMEOUT_MS) : 120000;

class UsageError extends Error {}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const toPosix = (p) => p.split(sep).join('/');
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

function parseArgs(argv) {
  const args = { command: argv[0], flags: new Set(), values: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pin' || a === '--work-dir' || a === '--source') {
      if (argv[i + 1] === undefined) throw new UsageError(`${a} needs a value`);
      args.values[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a === '--ci') args.flags.add('ci');
    else throw new UsageError(`unknown argument '${a}'`);
  }
  return args;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function gitError(e) {
  if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return `git timed out after ${GIT_TIMEOUT_MS} ms`;
  return String(e.stderr || e.message).trim();
}

function repositoryRoot(from) {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return from;
  }
}

// A JarlSkill-relative path from the pin: relative, forward slashes, no escape and never into .git.
function safeRelative(p, what) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\')
    || p.split('/').includes('..') || p.split('/').includes('.git')) {
    throw new UsageError(`${what}: '${p}' must be a relative path inside the tree, with forward slashes, never into .git`);
  }
  return p;
}

export function loadPin(pinArg) {
  const pinPath = resolve(pinArg ?? DEFAULT_PIN);
  if (!existsSync(pinPath)) throw new UsageError(`pin file not found: ${pinPath}`);
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch (e) {
    throw new UsageError(`pin file ${pinPath} is not valid JSON: ${e.message}`);
  }
  for (const k of ['source', 'dest']) if (typeof pin[k] !== 'string' || !pin[k]) throw new UsageError(`pin: ${k} is required`);
  if (pin.source.startsWith('-')) throw new UsageError('pin: source must not start with -');
  if (!Array.isArray(pin.paths) || pin.paths.length === 0) throw new UsageError('pin: paths must name at least one file');
  pin.paths = pin.paths.map((p) => safeRelative(p, 'pin.paths'));
  const base = dirname(pinPath);
  const root = repositoryRoot(base);
  const destDir = resolve(base, pin.dest);
  const rel = relative(root, destDir);
  if (rel === '' || rel.startsWith('..')) throw new UsageError(`pin.dest: '${pin.dest}' must resolve inside the repository (${root}) and not to its root`);
  return { pin, pinPath, base, root, destDir };
}

function isFilled(pin) {
  return typeof pin.ref === 'string' && pin.ref !== '' && /^[0-9a-f]{40}$/.test(pin.commit ?? '')
    && typeof pin.api === 'string' && pin.files && typeof pin.files === 'object';
}

function listFiles(dir) {
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(toPosix(relative(dir, full)));
    }
  };
  walk(dir);
  return files.sort();
}

// The record API the copy exports: RECORD_API read out of the vendored record.mjs by importing it, so a
// copy whose API moved (jarl-record/2) never passes for the one Horde was written against.
async function vendoredApi(ctx) {
  const recordPath = ctx.pin.paths.find((p) => p.endsWith('/record.mjs'));
  if (!recordPath) return { api: null, problem: 'pin.paths names no record.mjs — the record is what Horde stands on' };
  const full = join(ctx.destDir, recordPath);
  if (!existsSync(full)) return { api: null, problem: null };
  try {
    const mod = await import(pathToFileURL(full).href);
    return { api: mod.RECORD_API ?? null, problem: null };
  } catch (e) {
    return { api: null, problem: `the vendored record.mjs does not load: ${e.message}` };
  }
}

// The offline gate: the copy against the pin. Returns a list of problems.
export async function offlineProblems(ctx) {
  const { pin, destDir } = ctx;
  if (!isFilled(pin)) return ['the pin has no ref, commit, api or files yet; run update'];
  const problems = [];
  const pinned = Object.keys(pin.files).sort();
  for (const f of pinned) {
    if (!pin.paths.includes(f)) problems.push(`pin lists ${f}, which paths does not name`);
    const full = join(destDir, f);
    if (!existsSync(full)) { problems.push(`missing: ${pin.dest}/${f}`); continue; }
    if (lstatSync(full).isSymbolicLink()) { problems.push(`symlink: ${pin.dest}/${f} must be a real file`); continue; }
    const data = readFileSync(full);
    if (sha256(data) === pin.files[f]) continue;
    const crlfOnly = data.includes(0x0d) && sha256(data.toString('utf8').replace(/\r\n/g, '\n')) === pin.files[f];
    problems.push(crlfOnly
      ? `line endings: ${pin.dest}/${f} was checked out with CRLF; the vendored copy is -text in .gitattributes — check it out again`
      : `modified: ${pin.dest}/${f} (hand edits are not allowed; change Jarl and run update)`);
  }
  for (const p of pin.paths) if (!(p in pin.files)) problems.push(`pin names ${p} under paths but records no sha256 for it; run update`);
  const pinnedSet = new Set(pinned);
  for (const f of listFiles(destDir)) if (!pinnedSet.has(f)) problems.push(`extra: ${pin.dest}/${f} is not in the pin`);
  if (!problems.length) {
    const { api, problem } = await vendoredApi(ctx);
    if (problem) problems.push(problem);
    else if (api !== pin.api) problems.push(`the vendored record exports ${api ?? 'no RECORD_API'}, the pin says ${pin.api} — Horde is written against ${pin.api}`);
  }
  return problems;
}

// The copy against another tree holding the same paths (a JarlSkill checkout, or a fresh fetch).
function compareWith(ctx, tree, label) {
  const problems = [];
  for (const f of ctx.pin.paths) {
    const theirs = join(tree, f);
    const ours = join(ctx.destDir, f);
    if (!existsSync(theirs)) { problems.push(`${label} has no ${f}`); continue; }
    if (!existsSync(ours)) continue; // already said by the offline check
    if (!readFileSync(ours).equals(readFileSync(theirs))) problems.push(`differs from ${label}: ${ctx.pin.dest}/${f}`);
  }
  return problems;
}

function freshFetch(source, commit, dir) {
  rmSync(dir, RM);
  mkdirSync(dir, { recursive: true });
  try {
    git(['init', '--quiet'], dir);
    git(['-c', 'core.autocrlf=false', 'fetch', '--quiet', '--depth', '1', source, commit], dir);
    git(['-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'], dir);
  } catch (e) {
    throw new Error(`could not fetch ${commit} from ${source}: ${gitError(e)}`);
  }
  return git(['rev-parse', 'HEAD'], dir);
}

async function cmdCheck(args) {
  const ctx = loadPin(args.values.pin);
  const problems = await offlineProblems(ctx);
  if (!problems.length && args.values.source) {
    const source = resolve(args.values.source);
    if (!existsSync(source)) throw new UsageError(`--source: no such directory ${source}`);
    let head = null;
    try { head = git(['rev-parse', 'HEAD'], source); } catch { head = null; }
    const label = `the JarlSkill tree at ${source}${head ? ` (${head.slice(0, 12)})` : ''}`;
    const found = compareWith(ctx, source, label);
    if (found.length) found.push(`bring the copy up to that tree: node vendor.mjs update --source ${source}`);
    problems.push(...found);
  }
  if (!problems.length && args.flags.has('ci')) {
    const work = resolve(args.values['work-dir'] ?? join(ctx.root, '.jarl-vendor'));
    const clone = join(work, 'check');
    try {
      const head = freshFetch(ctx.pin.source, ctx.pin.commit, clone);
      if (head !== ctx.pin.commit) problems.push(`${ctx.pin.source} gave ${head} for ${ctx.pin.commit}`);
      else problems.push(...compareWith(ctx, clone, `commit ${ctx.pin.commit.slice(0, 12)} of ${ctx.pin.source}`));
    } finally {
      rmSync(clone, RM);
    }
  }
  if (problems.length) {
    for (const p of problems) err(`vendor: ${p}`);
    return EXIT_FAIL;
  }
  out(`vendor: ${Object.keys(ctx.pin.files).length} file(s) match the pin (${ctx.pin.api}, ${ctx.pin.ref} @ ${ctx.pin.commit.slice(0, 12)})`);
  return EXIT_PASS;
}

async function cmdUpdate(args) {
  const ctx = loadPin(args.values.pin);
  if (!args.values.source) throw new UsageError('update needs --source <JarlSkill working tree>');
  const source = resolve(args.values.source);
  if (!existsSync(source)) throw new UsageError(`--source: no such directory ${source}`);
  let head;
  let ref;
  let dirty;
  try {
    head = git(['rev-parse', 'HEAD'], source);
    ref = git(['rev-parse', '--abbrev-ref', 'HEAD'], source);
    dirty = git(['status', '--porcelain', '--', ...ctx.pin.paths], source);
  } catch (e) {
    throw new UsageError(`--source ${source} is not a git working tree: ${gitError(e)}`);
  }
  if (dirty) throw new UsageError(`--source ${source} has uncommitted changes in the vendored paths — commit them first, so the pin names the commit the bytes came from:\n${dirty}`);
  rmSync(ctx.destDir, RM);
  const files = {};
  for (const f of ctx.pin.paths) {
    const from = join(source, f);
    if (!existsSync(from)) throw new UsageError(`--source ${source} has no ${f}`);
    const to = join(ctx.destDir, f);
    mkdirSync(dirname(to), { recursive: true });
    const data = readFileSync(from);
    writeFileSync(to, data);
    files[f] = sha256(data);
  }
  const { api, problem } = await vendoredApi(ctx);
  if (problem) throw new Error(problem);
  const before = ctx.pin.commit;
  const pin = {
    source: ctx.pin.source, ref: ref === 'HEAD' ? head : ref, commit: head, api, dest: ctx.pin.dest, paths: ctx.pin.paths, files,
  };
  writeFileSync(ctx.pinPath, `${JSON.stringify(pin, null, 2)}\n`);
  out(`vendor: ${ctx.pin.paths.length} file(s) copied from ${source} (${pin.ref} @ ${head.slice(0, 12)}), ${api}`);
  if (before && before !== head) out(`vendor: the pin moved from ${before.slice(0, 12)} to ${head.slice(0, 12)} — read Jarl's CHANGELOG between them before committing`);
  return EXIT_PASS;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'check') return await cmdCheck(args);
    if (args.command === 'update') return await cmdUpdate(args);
    throw new UsageError(args.command ? `unknown command '${args.command}'` : 'missing command');
  } catch (e) {
    if (e instanceof UsageError) {
      err(`vendor: ${e.message}`);
      err('usage: vendor.mjs check [--source <dir> | --ci] [--pin <file>] [--work-dir <dir>]');
      err('       vendor.mjs update --source <JarlSkill working tree> [--pin <file>]');
      return EXIT_USAGE;
    }
    err(`vendor: ${e.message}`);
    return EXIT_USAGE;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
