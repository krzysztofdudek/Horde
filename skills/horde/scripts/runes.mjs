#!/usr/bin/env node
// Runes vendoring tool. A consumer copies this file into its own repository (it is pinned there like every other vendored file) and runs it from its tests and CI. Zero dependencies, Node 22+, git on PATH for the commands that clone.
//
//   check                 sha256 of every vendored file and skill fragment against the pin; offline; exit 1 on any drift
//   check --ci            the offline check, then a fresh shallow clone of the pinned tag into .runes/, rev-parse against the pinned commit, and a byte compare with the clone (also when CI=true, unless --offline)
//   check --local         with RUNES_DIR=<Runes working tree>: a report of how the vendored copy differs from that tree; never a pass (exit 3)
//   update [--tag vX.Y.Z] copy the configured paths from the tag (default: the highest release tag), rewrite the pin, print the changed files and the Runes CHANGELOG between the old and the new tag
//
// Options: --pin <file> (default: $RUNES_PIN, else ./runes.pin.json), --work-dir <dir> (default: <repository root>/.runes).
// Exit codes: 0 pass, 1 gate failure, 2 usage or environment error, 3 local report (never green).
// Environment: RUNES_GIT_TIMEOUT_MS bounds every git call (default 120000).
//
// The pin (JSON), with every consumer-side path relative to the pin file's directory and required to stay inside the consumer's repository:
//   source     git URL of Runes
//   tag, commit the vendored release and the commit its tag pointed at when vendored (written by update)
//   dest       directory that holds the copy; files keep their Runes-relative paths under it (not needed when paths is empty)
//   paths      Runes-relative files or directories to vendor, e.g. "dist/fs", "dist/version.mjs"; empty or left out for a pin that carries only fragments
//   fragments  [{ name, target, sha256 }]: skills/<name>.md lives in target between <!-- RUNES:<name>:START --> and <!-- RUNES:<name>:END -->
//   tool       { path, sha256 }: where this file itself is vendored
//   files      { <Runes-relative path>: <sha256> } (written by update)
//
// What the gate proves: the copy is byte for byte what the pinned tag holds. It catches accidents and hand edits; it does not stop a change that rewrites the pin and its source together, which is a review question.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_REPORT = 3;
const TOOL_SOURCE = 'tools/vendor.mjs';
const GIT_TIMEOUT_MS = Number(process.env.RUNES_GIT_TIMEOUT_MS) > 0 ? Number(process.env.RUNES_GIT_TIMEOUT_MS) : 120000;

class UsageError extends Error {}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const toPosix = (p) => p.split(sep).join('/');
// rmSync retries: on Windows a just-exited git or a virus scanner can still hold a handle in the clone (EBUSY, EPERM).
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const isLink = (p) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true;
const exists = (p) => lstatSync(p, { throwIfNoEntry: false }) !== undefined;

function parseArgs(argv) {
  const args = { command: argv[0], flags: new Set(), values: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag' || a === '--pin' || a === '--work-dir') {
      if (argv[i + 1] === undefined) throw new UsageError(`${a} needs a value`);
      args.values[a.slice(2)] = argv[++i];
    } else if (a === '--ci' || a === '--offline' || a === '--local') args.flags.add(a.slice(2));
    else throw new UsageError(`unknown argument '${a}'`);
  }
  return args;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function gitError(e) {
  if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return `git timed out after ${GIT_TIMEOUT_MS} ms`;
  return (e.stderr || e.message).toString().trim();
}

// The consumer's repository root: the nearest directory upward holding .git, found without running git. Without one, the pin's directory.
function repositoryRoot(from) {
  for (let d = from; ; d = dirname(d)) {
    if (exists(join(d, '.git'))) return d;
    if (dirname(d) === d) return from;
  }
}

// A Runes-relative path from the pin: relative, forward slashes, no escape, not the whole tree, never into .git.
function safeRelative(p, what) {
  const bad = typeof p !== 'string' || p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\');
  const norm = bad ? '' : posix.normalize(p).replace(/\/$/, '');
  if (bad || norm === '.' || norm.split('/').includes('..') || norm.split('/').includes('.git')) {
    throw new UsageError(`${what}: '${p}' must be a relative path inside the tree, with forward slashes, not the tree itself and not into .git`);
  }
  return norm;
}

// A consumer-side path from the pin, relative to the pin's directory: it must resolve inside the repository, never to the root itself and never into .git.
function consumerPath(p, what, base, root) {
  if (typeof p !== 'string' || p === '' || isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new UsageError(`${what}: '${p}' must be a relative path`);
  const full = resolve(base, p);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new UsageError(`${what}: '${p}' must resolve inside the repository (${root}) and not to its root`);
  if (rel.split(sep).includes('.git')) throw new UsageError(`${what}: '${p}' must not point into .git`);
  return full;
}

function loadPin(pinArg) {
  const pinPath = resolve(pinArg ?? process.env.RUNES_PIN ?? 'runes.pin.json');
  if (!existsSync(pinPath)) throw new UsageError(`pin file not found: ${pinPath}`);
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch (e) {
    throw new UsageError(`pin file ${pinPath} is not valid JSON: ${e.message}`);
  }
  const base = dirname(pinPath);
  const root = repositoryRoot(base);
  if (typeof pin.source !== 'string' || !pin.source) throw new UsageError('pin: source is required');
  if (pin.source.startsWith('-')) throw new UsageError('pin: source must not start with -');
  pin.paths = pin.paths ?? [];
  if (!Array.isArray(pin.paths)) throw new UsageError('pin.paths: expected an array');
  pin.paths = pin.paths.map((p) => safeRelative(p, 'pin.paths'));
  pin.fragments = pin.fragments ?? [];
  if (!Array.isArray(pin.fragments)) throw new UsageError('pin.fragments: expected an array');
  if (pin.paths.length === 0 && pin.fragments.length === 0) throw new UsageError('pin: paths or fragments must name at least one thing to vendor');
  // A fragments-only pin vendors no file, so it needs no copy directory; one that still lists vendored files needs it to check or remove them.
  const needsDest = pin.paths.length > 0 || pin.dest !== undefined || Object.keys(pin.files ?? {}).length > 0;
  const destDir = needsDest ? consumerPath(pin.dest, 'pin.dest', base, root) : undefined;
  const targets = new Map();
  for (const f of pin.fragments) {
    if (!f || typeof f.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(f.name)) throw new UsageError('pin.fragments: each needs a name of letters, digits, - or _');
    targets.set(f, consumerPath(f.target, `pin.fragments[${f.name}].target`, base, root));
  }
  let toolPath;
  if (pin.tool !== undefined) {
    if (typeof pin.tool !== 'object' || pin.tool === null) throw new UsageError('pin.tool: expected { path, sha256 }');
    toolPath = consumerPath(pin.tool.path, 'pin.tool.path', base, root);
  }
  for (const k of Object.keys(pin.files ?? {})) safeRelative(k, 'pin.files');
  return { pin, pinPath, base, root, destDir, targets, toolPath };
}

function warnings(ctx) {
  if (!ctx.pin.tool) err('runes: warning: the pin has no tool entry, so this script itself is not checked; add "tool": { "path": "<where this script lives>" } and run update');
}

function isFilled(pin) {
  return typeof pin.tag === 'string' && /^[0-9a-f]{40}$/.test(pin.commit ?? '') && pin.files && typeof pin.files === 'object';
}

// Files under dir (relative, posix, sorted) and every symbolic link met on the way. .git is never entered.
function listTree(dir) {
  const files = [];
  const links = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = join(d, e.name);
      if (e.isSymbolicLink()) links.push(full);
      else if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  if (exists(dir) && !isLink(dir)) walk(dir);
  const rel = (list) => list.map((f) => toPosix(relative(dir, f))).sort();
  return { files: rel(files), links: rel(links) };
}

// The paths git records as symbolic links (mode 120000) in a checkout's index; empty when tree is not a checkout. Git for Windows checks a link out as a plain file holding the target path unless core.symlinks is on, so the file system alone would not show it.
function indexedLinks(tree) {
  if (!exists(join(tree, '.git'))) return new Set();
  let listing;
  try {
    listing = git(['ls-files', '--stage', '-z'], tree);
  } catch {
    return new Set();
  }
  return new Set(listing.split('\0').filter((e) => e.startsWith('120000 ')).map((e) => e.slice(e.indexOf('\t') + 1)));
}

// Every file of the given Runes-relative paths inside a tree (a clone or RUNES_DIR). An absent path or a symbolic link anywhere on the way is an error, whether the file system shows it or only git's index does: a link would vendor whatever it points at.
function filesUnder(tree, paths) {
  const files = [];
  const gitLinks = indexedLinks(tree);
  const refuse = (link) => { throw new Error(`'${link}' is a symbolic link in ${tree}; Runes paths must be real files`); };
  for (const p of paths) {
    const segments = p.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const partial = segments.slice(0, i).join('/');
      if (isLink(join(tree, partial)) || gitLinks.has(partial)) refuse(partial);
    }
    const full = join(tree, p);
    const st = lstatSync(full, { throwIfNoEntry: false });
    if (!st) throw new Error(`'${p}' does not exist in ${tree}`);
    if (st.isDirectory()) {
      const { files: found, links } = listTree(full);
      if (links.length > 0) refuse(`${p}/${links[0]}`);
      const hidden = [...gitLinks].sort().find((l) => l.startsWith(`${p}/`));
      if (hidden !== undefined) refuse(hidden);
      files.push(...found.map((f) => `${p}/${f}`));
    } else files.push(p);
  }
  return [...new Set(files)].sort();
}

const covered = (file, paths) => paths.some((p) => file === p || file.startsWith(`${p}/`));

function markers(name) {
  return { start: `<!-- RUNES:${name}:START -->`, end: `<!-- RUNES:${name}:END -->` };
}

function countOf(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) n++;
  return n;
}

// A fragment as the pin hashes it: LF line endings and a final newline, so neither a CRLF checkout nor a missing last newline changes it.
function canonical(text) {
  const lf = text.replace(/\r\n/g, '\n');
  return lf === '' || lf.endsWith('\n') ? lf : `${lf}\n`;
}

// The text between a fragment's markers: from the line after START up to the start of the END line.
function readBlock(text, name) {
  const { start, end } = markers(name);
  const starts = countOf(text, start);
  const ends = countOf(text, end);
  if (starts !== 1) return { error: starts === 0 ? `no ${start} marker` : `more than one ${start} marker` };
  if (ends !== 1) return { error: ends === 0 ? `no ${end} marker` : `more than one ${end} marker` };
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (e < s) return { error: `${end} comes before ${start}` };
  const bodyStart = text.indexOf('\n', s);
  if (bodyStart === -1 || bodyStart >= e || text.slice(s + start.length, bodyStart).trim() !== '') return { error: `${start} must end its line` };
  const lineStart = text.lastIndexOf('\n', e - 1) + 1;
  if (text.slice(lineStart, e).trim() !== '') return { error: `${end} must start its line` };
  const eol = text[bodyStart - 1] === '\r' ? '\r\n' : '\n';
  return { from: bodyStart + 1, to: lineStart, body: text.slice(bodyStart + 1, lineStart), eol };
}

// Writes a fragment between its markers in the target's own line endings.
function writeBlock(text, block, fragment) {
  const body = canonical(fragment);
  return text.slice(0, block.from) + (block.eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body) + text.slice(block.to);
}

// The source with every comment blanked to spaces (newlines kept), so an import quoted in a comment is not taken for a real one. Strings, template literals (with nested `${}` code) and regular expression literals are copied as they stand: a // or /* inside them opens no comment. A / opens a regular expression where an operand is expected: at the start, after an operator or opening punctuation, or after a keyword such as return.
function stripComments(text) {
  let out = '';
  let i = 0;
  let prev = ''; // the last significant token: a punctuation character, a word, or 'x' for any operand
  const braces = []; // one entry per open { : true when it closes a template's ${
  const n = text.length;
  const blank = (s) => s.replace(/[^\n\r]/g, ' ');
  const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
  const regexAllowed = () => prev === '' || (/^[A-Za-z_$]/.test(prev) ? REGEX_AFTER_WORD.has(prev) : prev !== 'x' && prev !== ')' && prev !== ']' && prev !== '}');
  // Copies a template literal's text from i (just after its opening backtick or a closing }) up to its end or the next ${.
  const templateRun = () => {
    while (i < n) {
      const c = text[i];
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; prev = 'x'; return; }
      if (c === '$' && text[i + 1] === '{') { out += '${'; i += 2; braces.push(true); prev = '{'; return; }
      out += c; i++;
    }
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      let e = i;
      while (e < n && text[e] !== '\n' && text[e] !== '\r') e++;
      out += blank(text.slice(i, e)); i = e; continue;
    }
    if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2);
      const e = close === -1 ? n : close + 2;
      out += blank(text.slice(i, e)); i = e; continue;
    }
    if (c === '"' || c === "'") {
      let e = i + 1;
      while (e < n && text[e] !== c && text[e] !== '\n') e += text[e] === '\\' ? 2 : 1;
      out += text.slice(i, e + 1); i = e + 1; prev = 'x'; continue;
    }
    if (c === '`') { out += c; i++; templateRun(); continue; }
    if (c === '/' && regexAllowed()) {
      let e = i + 1;
      let cls = false;
      while (e < n && text[e] !== '\n') {
        const r = text[e];
        if (r === '\\') { e += 2; continue; }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        e++;
      }
      e++;
      while (e < n && /[A-Za-z]/.test(text[e])) e++;
      out += text.slice(i, e); i = e; prev = 'x'; continue;
    }
    if (c === '{') { braces.push(false); out += c; i++; prev = '{'; continue; }
    if (c === '}') {
      out += c; i++;
      if (braces.pop()) templateRun(); else prev = '}';
      continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let e = i;
      while (e < n && /[A-Za-z_$0-9]/.test(text[e])) e++;
      const word = text.slice(i, e);
      out += word; i = e; prev = /^[0-9]/.test(word) ? 'x' : word; continue;
    }
    if (!/\s/.test(c)) prev = c;
    out += c; i++;
  }
  return out;
}

function danglingImports(destDir, files) {
  const problems = [];
  const set = new Set(files);
  for (const f of files) {
    if (!/\.(mjs|js)$/.test(f)) continue;
    const text = stripComments(readFileSync(join(destDir, f), 'utf8'));
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
    for (const m of text.matchAll(re)) {
      const target = posix.normalize(posix.join(posix.dirname(f), m[1]));
      if (!set.has(target)) problems.push(`${f} imports '${m[1]}', which is not vendored (add ${target} to paths)`);
    }
  }
  return problems;
}

// The offline gate: vendored bytes against the pin. Returns a list of problems.
function offlineProblems(ctx) {
  const { pin, destDir } = ctx;
  if (!isFilled(pin)) return ['the pin has no tag, commit or files yet; run update'];
  const problems = [];
  const pinned = Object.keys(pin.files).sort();
  const present = [];
  for (const f of pinned) {
    const full = join(destDir, f);
    if (!covered(f, pin.paths)) problems.push(`pin lists ${f}, which no entry of paths covers`);
    if (!exists(full)) { problems.push(`missing: ${pin.dest}/${f}`); continue; }
    if (isLink(full)) { problems.push(`symlink: ${pin.dest}/${f} must be a real file`); continue; }
    present.push(f);
    const data = readFileSync(full);
    if (sha256(data) === pin.files[f]) continue;
    const crlfOnly = data.includes(0x0d) && sha256(data.toString('utf8').replace(/\r\n/g, '\n')) === pin.files[f];
    problems.push(crlfOnly
      ? `line endings: ${pin.dest}/${f} was checked out with CRLF; add '${toPosix(relative(ctx.root, destDir))}/** -text' to .gitattributes and check it out again`
      : `modified: ${pin.dest}/${f} (hand edits are not allowed; change Runes and run update)`);
  }
  const pinnedSet = new Set(pinned);
  const tree = destDir ? listTree(destDir) : { files: [], links: [] };
  for (const f of tree.files) if (!pinnedSet.has(f)) problems.push(`extra: ${pin.dest}/${f} is not in the pin`);
  for (const l of tree.links) if (!pinnedSet.has(l)) problems.push(`symlink: ${pin.dest}/${l} is not allowed in the copy`);
  problems.push(...danglingImports(destDir, present));
  for (const frag of pin.fragments) {
    const target = ctx.targets.get(frag);
    if (!existsSync(target)) { problems.push(`fragment ${frag.name}: target ${frag.target} does not exist`); continue; }
    const block = readBlock(readFileSync(target, 'utf8'), frag.name);
    if (block.error) problems.push(`fragment ${frag.name} in ${frag.target}: ${block.error}`);
    else if (sha256(canonical(block.body)) !== frag.sha256) problems.push(`fragment ${frag.name} in ${frag.target}: the block between the markers differs from skills/${frag.name}.md at ${pin.tag}`);
  }
  if (ctx.toolPath) {
    if (!existsSync(ctx.toolPath)) problems.push(`tool: ${pin.tool.path} does not exist`);
    else if (sha256(readFileSync(ctx.toolPath)) !== pin.tool.sha256) problems.push(`tool: ${pin.tool.path} differs from ${TOOL_SOURCE} at ${pin.tag}`);
  }
  return problems;
}

function workDir(ctx, flag) {
  return flag ? resolve(flag) : join(ctx.root, '.runes');
}

function freshClone(source, tag, dir) {
  rmSync(dir, RM);
  mkdirSync(dirname(dir), { recursive: true });
  try {
    git(['-c', 'advice.detachedHead=false', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', '--quiet', '--depth', '1', '--branch', tag, '--', source, dir]);
  } catch (e) {
    throw new Error(`could not clone ${source} at ${tag}: ${gitError(e)}`);
  }
  return git(['rev-parse', 'HEAD'], dir);
}

// The CI gate: the pin against a fresh clone of its tag.
function ciProblems(ctx, work) {
  const { pin, destDir } = ctx;
  const clone = join(work, 'check');
  const problems = [];
  try {
    const head = freshClone(pin.source, pin.tag, clone);
    if (head !== pin.commit) return [`tag ${pin.tag} of ${pin.source} resolves to ${head}, the pin says ${pin.commit}: the tag moved or the pin was edited`];
    let upstream;
    try {
      upstream = filesUnder(clone, pin.paths);
    } catch (e) {
      return [`paths: ${e.message}`];
    }
    const pinned = Object.keys(pin.files).sort();
    const upstreamSet = new Set(upstream);
    for (const f of upstream) if (!(f in pin.files)) problems.push(`pin misses ${f}, which ${pin.tag} has under paths`);
    for (const f of pinned) {
      if (!upstreamSet.has(f)) { problems.push(`pin lists ${f}, which ${pin.tag} does not have`); continue; }
      const theirs = readFileSync(join(clone, f));
      const vendored = join(destDir, f);
      if (exists(vendored) && !isLink(vendored) && !readFileSync(vendored).equals(theirs)) problems.push(`differs from ${pin.tag}: ${pin.dest}/${f}`);
      if (sha256(theirs) !== pin.files[f]) problems.push(`pin sha of ${f} does not match ${pin.tag}`);
    }
    for (const frag of pin.fragments) {
      const src = join(clone, 'skills', `${frag.name}.md`);
      if (!existsSync(src) || isLink(src)) { problems.push(`fragment ${frag.name}: ${pin.tag} has no skills/${frag.name}.md as a real file`); continue; }
      const theirs = canonical(readFileSync(src, 'utf8'));
      if (sha256(theirs) !== frag.sha256) problems.push(`fragment ${frag.name}: pin sha does not match skills/${frag.name}.md at ${pin.tag}`);
      const target = ctx.targets.get(frag);
      const block = existsSync(target) ? readBlock(readFileSync(target, 'utf8'), frag.name) : { error: 'missing' };
      if (!block.error && canonical(block.body) !== theirs) problems.push(`fragment ${frag.name} in ${frag.target}: differs from skills/${frag.name}.md at ${pin.tag}`);
    }
    if (ctx.toolPath) {
      const theirs = readFileSync(join(clone, TOOL_SOURCE));
      if (sha256(theirs) !== pin.tool.sha256) problems.push(`tool: pin sha does not match ${TOOL_SOURCE} at ${pin.tag}`);
      if (existsSync(ctx.toolPath) && !readFileSync(ctx.toolPath).equals(theirs)) problems.push(`tool: ${pin.tool.path} differs from ${TOOL_SOURCE} at ${pin.tag}`);
    }
  } finally {
    rmSync(clone, RM);
  }
  return problems;
}

function cmdCheck(args) {
  const ctx = loadPin(args.values.pin);
  if (args.flags.has('local')) return localReport(ctx);
  warnings(ctx);
  const ci = args.flags.has('ci') || (process.env.CI === 'true' && !args.flags.has('offline'));
  const problems = offlineProblems(ctx);
  if (ci && isFilled(ctx.pin)) problems.push(...ciProblems(ctx, workDir(ctx, args.values['work-dir'])));
  if (problems.length > 0) {
    err(`runes: vendored copy FAILS the gate (${ctx.pin.tag ?? 'no tag'} from ${ctx.pin.source}${ci ? ', against a fresh clone' : ', offline'}):`);
    for (const p of problems) err(`  - ${p}`);
    return EXIT_FAIL;
  }
  const n = Object.keys(ctx.pin.files).length;
  out(`runes: ${n} vendored files, ${ctx.pin.fragments.length} skill fragments${ctx.pin.tool ? ' and the tool' : ''} match ${ctx.pin.tag} (${ctx.pin.commit.slice(0, 12)}) from ${ctx.pin.source}${ci ? ', verified against a fresh clone' : ', offline sha check'}.`);
  return EXIT_PASS;
}

function localReport(ctx) {
  const runesDir = process.env.RUNES_DIR;
  if (!runesDir) throw new UsageError('check --local needs RUNES_DIR set to a Runes working tree');
  const tree = resolve(runesDir);
  const { pin, destDir } = ctx;
  const lines = [];
  let local;
  try {
    local = filesUnder(tree, pin.paths);
  } catch (e) {
    throw new UsageError(`RUNES_DIR: ${e.message}`);
  }
  const vendored = destDir ? listTree(destDir) : { files: [], links: [] };
  for (const l of vendored.links) lines.push(`symlink in the copy: ${l}`);
  const all = [...new Set([...local, ...vendored.files])].sort();
  let same = 0;
  for (const f of all) {
    const a = join(destDir, f);
    const b = join(tree, f);
    if (!existsSync(b)) lines.push(`only vendored:    ${f}`);
    else if (!existsSync(a)) lines.push(`only in RUNES_DIR: ${f}`);
    else if (!readFileSync(a).equals(readFileSync(b))) lines.push(`differs:          ${f}`);
    else same++;
  }
  for (const frag of pin.fragments) {
    const src = join(tree, 'skills', `${frag.name}.md`);
    const target = ctx.targets.get(frag);
    const block = existsSync(target) ? readBlock(readFileSync(target, 'utf8'), frag.name) : { error: 'target missing' };
    if (!existsSync(src)) lines.push(`fragment ${frag.name}: RUNES_DIR has no skills/${frag.name}.md`);
    else if (block.error) lines.push(`fragment ${frag.name}: ${block.error}`);
    else if (canonical(block.body) !== canonical(readFileSync(src, 'utf8'))) lines.push(`fragment ${frag.name}: differs`);
  }
  if (ctx.toolPath && existsSync(join(tree, TOOL_SOURCE)) && existsSync(ctx.toolPath) && !readFileSync(join(tree, TOOL_SOURCE)).equals(readFileSync(ctx.toolPath))) lines.push('tool: differs');
  out(`runes: local report against ${tree} (pin: ${pin.tag ?? 'none'} from ${pin.source})`);
  out(`  ${same} files identical`);
  for (const l of lines) out(`  ${l}`);
  out('This is a report, not a gate verdict. Only check and check --ci against a tag can pass.');
  return EXIT_REPORT;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v ?? '');
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : undefined;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function latestTag(source) {
  let listing;
  try {
    listing = git(['ls-remote', '--tags', '--refs', '--', source]);
  } catch (e) {
    throw new Error(`could not list tags of ${source}: ${gitError(e)}`);
  }
  const tags = listing.split('\n').map((l) => l.split('\trefs/tags/')[1]).filter((t) => t && /^v\d+\.\d+\.\d+$/.test(t)).sort(compareVersions);
  if (tags.length === 0) throw new Error(`${source} has no release tags (vX.Y.Z)`);
  return tags[tags.length - 1];
}

// CHANGELOG sections with a version above `from` and up to `to`.
function changelogBetween(text, from, to) {
  const sections = [];
  let current;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/.exec(line);
    if (m) {
      current = { version: m[1], lines: [line] };
      sections.push(current);
    } else if (/^##\s/.test(line)) current = undefined;
    else if (current) current.lines.push(line);
  }
  return sections
    .filter((s) => (!from || compareVersions(s.version, from) > 0) && compareVersions(s.version, to) <= 0)
    .map((s) => s.lines.join('\n').trimEnd());
}

function removeEmptyDirs(dir, stopAt) {
  let d = dir;
  while (d.startsWith(stopAt) && d !== stopAt && existsSync(d) && readdirSync(d).length === 0) {
    rmdirSync(d);
    d = dirname(d);
  }
}

function writeFileMkdir(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  if (isLink(path)) rmSync(path);
  writeFileSync(path, data);
}

// Fragments grouped by target file, in pin order, so several fragments in one file are applied one after another to the same text.
function fragmentsByTarget(ctx) {
  const groups = new Map();
  for (const frag of ctx.pin.fragments) {
    const target = ctx.targets.get(frag);
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(frag);
  }
  return groups;
}

function cmdUpdate(args) {
  const ctx = loadPin(args.values.pin);
  const { pin, pinPath, destDir } = ctx;
  const groups = fragmentsByTarget(ctx);

  // Fragment targets must carry their markers before anything is fetched or written, so a failed update leaves the copy untouched.
  for (const [target, frags] of groups) {
    if (!existsSync(target)) throw new UsageError(`fragment ${frags[0].name}: target ${frags[0].target} does not exist`);
    const text = readFileSync(target, 'utf8');
    for (const frag of frags) {
      const block = readBlock(text, frag.name);
      if (block.error) throw new UsageError(`fragment ${frag.name} in ${frag.target}: ${block.error}; add the marker lines where the fragment belongs`);
    }
  }

  const tag = args.values.tag ?? latestTag(pin.source);
  if (!parseVersion(tag)) throw new UsageError(`--tag: '${tag}' is not a vX.Y.Z tag`);
  const work = workDir(ctx, args.values['work-dir']);
  const clone = join(work, 'update');
  try {
    const commit = freshClone(pin.source, tag, clone);
    const files = filesUnder(clone, pin.paths);
    const bodies = new Map();
    for (const frag of pin.fragments) {
      const src = join(clone, 'skills', `${frag.name}.md`);
      if (!existsSync(src) || isLink(src)) throw new Error(`fragment ${frag.name}: ${tag} has no skills/${frag.name}.md as a real file`);
      bodies.set(frag, canonical(readFileSync(src, 'utf8')));
    }
    if (ctx.toolPath && (isLink(join(clone, TOOL_SOURCE)) || indexedLinks(clone).has(TOOL_SOURCE))) throw new Error(`${TOOL_SOURCE} is a symbolic link in ${tag}`);

    const oldFiles = pin.files ?? {};
    const newFiles = {};
    const changes = [];
    for (const f of files) {
      const data = readFileSync(join(clone, f));
      newFiles[f] = sha256(data);
      if (!(f in oldFiles)) changes.push(`A ${f}`);
      else if (oldFiles[f] !== newFiles[f]) changes.push(`M ${f}`);
      writeFileMkdir(join(destDir, f), data);
    }
    for (const f of Object.keys(oldFiles).sort()) {
      if (f in newFiles) continue;
      changes.push(`D ${f}`);
      rmSync(join(destDir, f), { force: true });
      removeEmptyDirs(dirname(join(destDir, f)), destDir);
    }

    for (const [target, frags] of groups) {
      const original = readFileSync(target, 'utf8');
      let text = original;
      for (const frag of frags) {
        const before = text;
        text = writeBlock(text, readBlock(text, frag.name), bodies.get(frag));
        if (text !== before) changes.push(`F ${frag.name} -> ${frag.target}`);
        frag.sha256 = sha256(bodies.get(frag));
      }
      if (text !== original) writeFileSync(target, text);
    }

    if (ctx.toolPath) {
      const data = readFileSync(join(clone, TOOL_SOURCE));
      if (!existsSync(ctx.toolPath) || !readFileSync(ctx.toolPath).equals(data)) changes.push(`T ${pin.tool.path}`);
      writeFileMkdir(ctx.toolPath, data);
      pin.tool.sha256 = sha256(data);
    }

    const oldTag = pin.tag;
    const next = { ...pin, tag, commit, files: Object.fromEntries(Object.entries(newFiles).sort(([a], [b]) => (a < b ? -1 : 1))) };
    writeFileSync(pinPath, `${JSON.stringify(next, null, 2)}\n`);

    out(`runes: ${oldTag ?? '(nothing)'} -> ${tag} (${commit.slice(0, 12)}) from ${pin.source}`);
    if (changes.length === 0) out('  no vendored file changed');
    for (const c of changes) out(`  ${c}`);
    const changelogPath = join(clone, 'CHANGELOG.md');
    if (existsSync(changelogPath)) {
      const sections = changelogBetween(readFileSync(changelogPath, 'utf8'), parseVersion(oldTag) ? oldTag : undefined, tag);
      out();
      out(sections.length > 0 ? `Runes CHANGELOG ${oldTag ?? ''}..${tag}:\n\n${sections.join('\n\n')}` : `Runes CHANGELOG has no sections between ${oldTag ?? 'the start'} and ${tag}.`);
    }
    out();
    out('Commit the copy and the pin together, then run check.');
    warnings(ctx);
    return EXIT_PASS;
  } finally {
    rmSync(clone, RM);
  }
}

function usage() {
  out('usage: vendor.mjs check [--ci | --offline | --local] [--pin <file>] [--work-dir <dir>]');
  out('       vendor.mjs update [--tag vX.Y.Z] [--pin <file>] [--work-dir <dir>]');
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.command === 'check') return cmdCheck(args);
    if (args.command === 'update') {
      if (args.flags.size > 0) throw new UsageError('update takes only --tag, --pin and --work-dir');
      return cmdUpdate(args);
    }
    if (args.command === undefined || args.command === 'help' || args.command === '--help') {
      usage();
      return args.command === undefined ? EXIT_USAGE : EXIT_PASS;
    }
    throw new UsageError(`unknown command '${args.command}'`);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`runes: ${e.message}`);
      usage();
      return EXIT_USAGE;
    }
    err(`runes: ${e.message}`);
    return args?.command === 'check' ? EXIT_FAIL : EXIT_USAGE;
  }
}

process.exitCode = main(process.argv.slice(2));
