// Shared internals for the horde skill's scripts. Not a user-facing command — imported only.
// Zero dependencies, Node ESM, node core modules only.
//
// State root: `.horde/` beside the repository's git common dir, so every worktree of a
// repository sees the same state (a worktree's common dir points at the main checkout's .git).

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

// git(args, cwd) — execFileSync wrapper, trimmed stdout on success, null on any failure
// (not a repo, no such ref, git not found, …). Every other git-touching export goes through this.
export function git(args, cwd = process.cwd()) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return null;
  }
}

// patchIdOf(branch, parent, {context, cwd}) — the 40-hex `git patch-id --stable` of what the
// branch adds on top of the parent (`git diff -U<context> <parent>...<branch>`), or null when
// there is nothing to identify (an empty diff, an unknown ref, no git at all). This is what a
// key binds to: it names the CONTENT of a ticket's change, so catching the branch up with a
// landing elsewhere leaves it identical, a landing that reaches into a hunk's own context
// changes it, and a landing that overlaps the change conflicts before this is ever asked.
//
// `context` is the number of context lines the identity is computed over — the sensitivity knob
// (`config.keyContext`, default 3): more context means a key survives fewer nearby landings, less
// means it survives more. Zero is deliberately not offered — it calls a change on the very next
// line the same diff, which no reviewer would — so anything that is not a whole number of at
// least one falls back to 3.
export function patchIdOf(branch, parent, { context = 3, cwd = process.cwd() } = {}) {
  const asked = Math.trunc(Number(context));
  const n = Number.isFinite(asked) && asked >= 1 ? asked : 3;
  let diff;
  try {
    diff = execFileSync('git', ['diff', `-U${n}`, `${parent}...${branch}`], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (diff.length === 0) return null;
  try {
    const out = execFileSync('git', ['patch-id', '--stable'], {
      cwd, input: diff, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    }).toString().trim();
    const id = out.split(/\s+/)[0];
    return /^[0-9a-f]{40}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// repoRoot() — the working tree root of the repository at the current directory, found via
// `git rev-parse --show-toplevel`. Independent of where the scripts themselves live, so the
// same install works against whatever repository the caller's cwd is inside.
export function repoRoot() {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top) return top;
  throw new Error(`not a git repository (or any parent up to the mount point): ${process.cwd()}`);
}

// gitCommonDir() — the shared `.git` directory: for a worktree this resolves to the main
// checkout's, which is exactly what lets every worktree find the same `.horde/`. Git prints it
// relative to cwd for the main checkout but absolute for a worktree, so resolve() (a no-op on
// an already-absolute path) normalizes both.
function gitCommonDir() {
  const out = git(['rev-parse', '--git-common-dir']);
  if (!out) throw new Error(`not a git repository (or any parent up to the mount point): ${process.cwd()}`);
  return resolve(process.cwd(), out);
}

// hordeRoot({create}) — `.horde/` beside the repository root (dirname of the git common dir).
// Only `horde.mjs init` should pass `create: true`: that is the one call site allowed to bring
// `.horde/` into existence, with its `.gitignore` written at the same time so the directory is
// never accidentally committed even for one commit.
export function hordeRoot({ create = false } = {}) {
  const common = gitCommonDir();
  const dir = join(dirname(common), '.horde');
  if (create && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '*\n');
  }
  return dir;
}

export function configPath() {
  return join(hordeRoot(), 'config.json');
}

export function readConfig() {
  return readJSON(configPath(), null);
}

export function writeConfig(cfg) {
  writeJSON(configPath(), cfg);
}

export function hordePath(horde, ...parts) {
  return join(hordeRoot(), 'hordes', horde, ...parts);
}

// Resolves a team's short LEAF name (e.g. "lark") to its full on-disk segment chain
// (["trunk", "lark"]) by walking roster.json's steward entries' own `parent` links back to
// "trunk" — the same lookup roster.mjs's own spawn logic does, duplicated here in miniature
// (rather than importing roster.mjs, which would make this foundational module depend on
// something that itself depends on it) because every tool needs it and leaf names are the only
// address that stays correct no matter how deep a team is nested — a caller never has to know or
// spell out its ancestry. "trunk" is the implicit root and needs no roster lookup at all.
function resolveTeamSegments(horde, leaf, seen = new Set()) {
  if (!leaf || leaf === 'trunk') return ['trunk'];
  if (seen.has(leaf)) fail(`team "${leaf}" has a cyclical parent chain in roster.json`);
  seen.add(leaf);
  const doc = readJSON(hordePath(horde, 'roster.json'), { entries: [] });
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const entry = entries.find((e) => e.role === 'steward' && e.team === leaf);
  if (!entry) fail(`no such team: "${leaf}" — has its steward been spawned yet?`);
  return [...resolveTeamSegments(horde, entry.parent, seen), leaf];
}

// teamPath(horde, team, ...parts) — `team` is normally just the short LEAF name a steward was
// spawned with ("lark"), unique per horde; this resolves its real nesting from roster.json and
// inserts the literal "teams/" segments that actually separate each level on disk
// ("teams/trunk/teams/lark"), so every caller works from the one name a brief or a queue item
// already carries, never having to spell out or track the ancestry itself. A full slash path
// ("trunk/lark") is also accepted, but only when it matches what the roster independently
// resolves for that same leaf — anything else (a stale or guessed path, or the literal segment
// "teams") is refused rather than silently landing in a wrong or doubly-nested directory.
export function teamPath(horde, team, ...parts) {
  const given = String(team).split('/').filter(Boolean);
  if (given.length === 0) fail('--team is required');
  if (given.includes('teams')) {
    fail(`invalid --team "${team}" — "teams" is inserted automatically and must not be written`);
  }
  const leaf = given[given.length - 1];
  const resolved = resolveTeamSegments(horde, leaf);
  if (given.length > 1 && given.join('/') !== resolved.join('/')) {
    fail(`--team "${team}" does not match "${leaf}"'s actual location ("${resolved.join('/')}") — pass just the leaf name "${leaf}"`);
  }
  return hordePath(horde, ...resolved.flatMap((s) => ['teams', s]), ...parts);
}

// listHordes() — names under hordes/, excluding the archive.
export function listHordes() {
  const dir = join(hordeRoot(), 'hordes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_archive')
    .map((d) => d.name)
    .sort();
}

// resolveHorde(args) — args is a parsed-flags object (or {flags} from parseArgs). `--horde name`
// wins outright; otherwise the sole existing horde is the default; anything else is a refusal
// (fail() exits the process, matching every other tool's error contract).
export function resolveHorde(args) {
  const flags = args && args.flags ? args.flags : args || {};
  const hordes = listHordes();
  if (flags.horde) {
    if (!hordes.includes(flags.horde)) fail(`no such horde: ${flags.horde}`);
    return flags.horde;
  }
  if (hordes.length === 1) return hordes[0];
  if (hordes.length === 0) fail('no horde exists — run horde.mjs init <name> --base <branch>');
  fail(`multiple hordes exist (${hordes.join(', ')}) — pass --horde <name>`);
}

export function readJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${e.message}`);
  }
}

// writeJSON(file, obj, {render}) — obj is always the source of truth; when `render` is given
// (obj) => mdText, the sibling `.md` (same path, `.json` swapped for `.md`) is written alongside,
// never the other way around.
export function writeJSON(file, obj, { render } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  if (render) {
    const mdFile = file.replace(/\.json$/, '.md');
    writeFileSync(mdFile, render(obj));
  }
}

export function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function appendText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const existing = readText(file);
  const sep = existing && existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(file, sep + text, { flag: 'a' });
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return nowIso().slice(0, 10);
}

export function fail(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

// emit(result, args, human) — JSON when `--json` was passed (args may be a parsed-flags object
// or the {flags} shape parseArgs returns), else the human-readable rendering: `human` may be a
// string or a zero-arg function returning one; when omitted, `result` itself is printed.
export function emit(result, args, human) {
  const flags = args && args.flags ? args.flags : args || {};
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (human === undefined) {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return;
  }
  console.log(typeof human === 'function' ? human() : human);
}

// True when this module was invoked directly as a script (not imported by another tool, e.g.
// escalate.mjs importing decide.mjs's appendDecision).
// compared as paths, not as URL strings: a directory with a space is percent-encoded in the
// module URL and plain in argv, and a string comparison would silently never match
export function isMain(moduleUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return resolve(fileURLToPath(moduleUrl)) === resolve(process.argv[1]);
  } catch {
    return false;
  }
}

// parseArgs(argv, {flags, aliases}) — `flags` names booleans that never consume the next token
// (in addition to the always-boolean `json`/`help`); `aliases` maps a short name to its long
// form before classification. `--k v`, `--k=v`, repeated `--k` (collects into an array, in
// order), and bare `--k` (true, when it's declared boolean or is trailing/followed by another
// flag) are all supported. Everything not starting with `--` is positional.
export function parseArgs(argv, { flags: boolNames = [], aliases = {} } = {}) {
  const bools = new Set(['json', 'help', ...boolNames]);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    name = aliases[name] || name;
    if (value === undefined) {
      const next = argv[i + 1];
      if (bools.has(name) || next === undefined || next.startsWith('--')) {
        value = true;
      } else {
        value = next;
        i++;
      }
    }
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      flags[name] = Array.isArray(flags[name]) ? [...flags[name], value] : [flags[name], value];
    } else {
      flags[name] = value;
    }
  }
  return { positional, flags };
}

export function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => cells.map((s, i) => s.padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(columns.map((c) => c.header)));
  for (const r of rows) console.log(line(columns.map((c) => String(r[c.key] ?? ''))));
}

// renderTemplate(name, vars) — loads templates/<name>.md and replaces every `{{key}}` or
// `{{key | default}}` token. `key` is whatever sits before the first `|` (spaces, hyphens and
// all — the templates use it loosely, e.g. `{{n-1}}`, `{{ of limit}}`, `{{clean | findings}}`,
// not only identifier-shaped names), trimmed. A token with a value in `vars` (anything but
// undefined/null) is replaced by that value; one without a value but with a default is replaced
// by the default text; one with neither throws — the whole template is rendered first so the
// thrown message can list every unfilled key at once, not just the first.
export function renderTemplate(name, vars = {}) {
  const file = join(TEMPLATES_DIR, `${name}.md`);
  const text = readFileSync(file, 'utf8');
  const unfilled = [];
  const rendered = text.replace(/\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?))?\s*\}\}/g, (whole, rawKey, def) => {
    const key = rawKey.trim();
    const value = vars[key];
    if (value !== undefined && value !== null) return String(value);
    if (def !== undefined) return def;
    unfilled.push(key);
    return whole;
  });
  if (unfilled.length > 0) {
    throw new Error(`template ${name}.md: unfilled placeholder(s): ${[...new Set(unfilled)].join(', ')}`);
  }
  return rendered;
}
