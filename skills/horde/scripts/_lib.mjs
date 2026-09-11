// Shared internals for the horde skill's scripts. Not a user-facing command — imported only.
// Zero dependencies, Node ESM, node core modules only.
//
// State root: `.horde/` beside the repository's git common dir, so every worktree of a
// repository sees the same state (a worktree's common dir points at the main checkout's .git).

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, rmSync, cpSync,
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

// ---- resolveTree: a command works on the tree it was told, never on cwd by accident -----------
//
// D2 (narrowed by D6, once 014 removed sub-teams and every seat but worker/architect): the tree a
// command reads or writes is always named outright — `--tree` (any worktree of this repository),
// `--ticket` (a worker's own tree), `--scratch` (a throwaway detached tree at a sha — only the
// future landing script uses this), `--horde` (the tip of that horde's trunk, read-only — the
// only writer of trunk is the landing script), or, for a command with no horde scope at all,
// bare cwd. The narrowest scope given wins; a command that took `--horde` never quietly falls
// back to cwd just because that flag was left off by a caller that meant to pass it.
//
// `cleanup()` is always safe to call in a `finally`: for `scratch` it removes the worktree it
// made, for everything else it does nothing — `tree`/`ticket` are worktrees the caller does not
// own, `trunk` is a worktree kept around and resynced on every read (see resolveHordeTrunk), and
// `cwd` was never created by this call at all.

const NOOP = () => {};

// A `git worktree list --porcelain` block, parsed. Fields exactly as git prints them: `path` is
// the worktree's directory, `branch` is the short name (no `refs/heads/`) or null when detached,
// `sha` is HEAD, `prunable` is set (to git's own reason string) when the worktree's directory is
// gone from disk but git has not been told to forget it (`git worktree prune`).
function parseWorktreeList(text) {
  return text.split(/\n\n+/).filter((b) => b.trim().length).map((block) => {
    const entry = {
      path: null, sha: null, branch: null, detached: false, prunable: null,
    };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) entry.sha = line.slice('HEAD '.length);
      else if (line.startsWith('branch refs/heads/')) entry.branch = line.slice('branch refs/heads/'.length);
      else if (line === 'detached') entry.detached = true;
      else if (line.startsWith('prunable')) entry.prunable = line.slice('prunable'.length).trim() || 'gitdir points to non-existent location';
    }
    return entry;
  });
}

// The worktrees git itself knows about for the repository at `cwd` — every worktree of it, main
// checkout included, whichever one of them `cwd` happens to sit inside. fail()s when `cwd` is not
// inside a git repository at all, since nothing below can answer "is this a tree of THIS repo"
// without first knowing what "this repo" is.
function thisRepoWorktrees(cwd) {
  const out = git(['worktree', 'list', '--porcelain'], cwd);
  if (out === null) fail(`not a git repository (or any parent up to the mount point): ${cwd}`);
  return parseWorktreeList(out);
}

function realpathMaybe(path) {
  try { return realpathSync(path); } catch { return null; }
}

// The one place a path given on the command line (`--tree`, or one built from `--ticket`) is
// checked against what git actually knows, telling apart the three ways it can be wrong: never
// registered as a worktree of this repository at all (a plain directory, another repository's
// worktree, or a path that plain does not exist — `notFound` decides the wording), and registered
// but gone from disk (`git worktree prune` is the fix, never a stack trace). `path` is returned
// byte-for-byte as given — never git's own (possibly symlink-resolved) rendering of it — so
// `--json` provenance reproduces exactly what was typed, proof against a caller that builds the
// path by string-concatenation rather than passing it through untouched.
function resolveKnownTreePath(path, cwd, kind, notFound) {
  const entries = thisRepoWorktrees(cwd);
  const real = realpathMaybe(path);
  const match = entries.find((e) => e.path === path || (real && e.path === real));
  if (!match) { notFound(); return null; }
  if (match.prunable) {
    fail(`${path} is a worktree git still knows about, but its directory is gone from disk (${match.prunable}) — run \`git worktree prune\` and recreate it`);
  }
  return {
    path, branch: match.branch, sha: match.sha, kind, cleanup: NOOP,
  };
}

function resolveExplicitTree(rawTree, cwd) {
  const path = resolve(cwd, String(rawTree));
  return resolveKnownTreePath(path, cwd, 'tree', () => {
    if (existsSync(path)) {
      fail(`${rawTree} is not a worktree of this repository (\`git worktree list --porcelain\` does not know it)`);
    }
    fail(`no such tree: ${rawTree} does not exist — create one with \`git worktree add ${path} <branch>\` first`);
  });
}

function padTicketId(id) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10);
  if (Number.isNaN(n)) fail(`invalid ticket id: ${id}`);
  return String(n).padStart(3, '0');
}

function resolveTicketTree(ticket, horde, cwd) {
  if (!horde) fail('--ticket requires --horde (or a single horde already on this repository)');
  const id = padTicketId(ticket);
  const path = join(hordeRoot(), 'worktrees', horde, `t-${id}`);
  return resolveKnownTreePath(path, cwd, 'ticket', () => {
    if (existsSync(path)) {
      fail(`${path} exists but is not a worktree of this repository (\`git worktree list --porcelain\` does not know it)`);
    }
    fail(`no worktree for ticket ${id} — create it with \`queue.mjs set ${id} running --horde ${horde}\` (expected at ${path})`);
  });
}

// resolveHordeTrunk(horde, cwd) — the tip of `<horde>/trunk`, read-only for everything but the
// future landing script. Trunk is a branch that `horde.mjs init` deliberately leaves unchecked
// out, so there is nothing on disk to hand back until something asks: the first ask provisions a
// worktree for it, once, at a fixed path under `.horde/`; every ask after that resyncs that same
// worktree to the branch's current tip (`git reset --hard`, safe because nothing but this resync
// ever writes there) rather than making — and leaking — a fresh one. That is also why its
// `cleanup()` is a no-op: the tree is meant to be kept, not thrown away after one read.
function resolveHordeTrunk(horde, cwd) {
  const branch = `${horde}/trunk`;
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  if (tip === null) fail(`no such horde branch: ${branch} — has horde.mjs init run for "${horde}"?`);
  const path = join(hordeRoot(), 'worktrees', horde, 'trunk');
  const cfg = readConfig() || {};
  if (!existsSync(path)) {
    // Detached at trunk's current tip, never attached to the branch itself: an attached worktree
    // would hold the branch name exclusively, and nothing else on the repository — not the main
    // checkout, not a test, not a future landing script — could then check `<horde>/trunk` out
    // anywhere else. Detached, this tree is free to exist alongside any of that.
    try {
      provisionTree(path, tip, cfg);
    } catch (e) {
      fail(e.message);
    }
  } else if (git(['reset', '--hard', branch], path) === null) {
    fail(`could not sync the trunk tree at ${path} to ${branch}`);
  }
  return {
    path, branch, sha: git(['rev-parse', branch], cwd), kind: 'trunk', cleanup: NOOP,
  };
}

// resolveScratchTree(sha, cwd) — a throwaway detached worktree at a sha already in this
// repository, for the future landing script (015) alone. Unlike every other kind, its `cleanup()`
// really does remove what it made — and it is called here too, the moment provisioning itself
// fails partway (`git worktree add` succeeded, the `worktree.copy` copy did not): a scratch tree
// that failed to finish provisioning is not left behind for `git worktree list` to still know
// about.
function resolveScratchTree(shaArg, cwd) {
  const sha = git(['rev-parse', '--verify', '--quiet', `${shaArg}^{commit}`], cwd);
  if (sha === null) fail(`no such commit: ${shaArg} — --scratch takes a sha already in this repository`);
  const dir = join(hordeRoot(), 'scratch', `${sha.slice(0, 12)}-${process.pid}-${Date.now()}`);
  const cleanup = () => {
    git(['worktree', 'remove', '--force', dir], cwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  };
  try {
    provisionTree(dir, sha, readConfig() || {});
  } catch (e) {
    cleanup();
    fail(e.message);
  }
  return {
    path: dir, branch: null, sha, kind: 'scratch', cleanup,
  };
}

function resolveCwd(cwd) {
  const path = git(['rev-parse', '--show-toplevel'], cwd);
  if (path === null) fail(`not a git repository (or any parent up to the mount point): ${cwd}`);
  const branchOut = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return {
    path: resolve(cwd, path),
    branch: branchOut && branchOut !== 'HEAD' ? branchOut : null,
    sha: git(['rev-parse', 'HEAD'], cwd),
    kind: 'cwd',
    cleanup: NOOP,
  };
}

// resolveTree({tree, ticket, scratch, horde}, {cwd}) — see the block comment above. Precedence is
// the order the flags are checked in below: `--tree` beats `--ticket` beats `--scratch` beats
// `--horde` beats bare cwd, matching the order the skill's own reference documents them in.
export function resolveTree({
  tree, ticket, horde, scratch,
} = {}, { cwd = process.cwd() } = {}) {
  if (tree !== undefined && tree !== null && tree !== false) return resolveExplicitTree(tree, cwd);
  if (ticket !== undefined && ticket !== null && ticket !== false) return resolveTicketTree(ticket, horde, cwd);
  if (scratch !== undefined && scratch !== null && scratch !== false) return resolveScratchTree(scratch, cwd);
  if (horde !== undefined && horde !== null && horde !== false) return resolveHordeTrunk(horde, cwd);
  return resolveCwd(cwd);
}

// assertGraphWritable(info, {horde, cfg}) — the two refusals a graph write (node.mjs log --run,
// promote, demote, bind's take-over log) is held to: trunk is the landing script's alone (kind
// "trunk" is always read-only — the moment a caller means to write it, it says so with an
// explicit `--tree` naming trunk's own path, which resolves as kind "tree" instead and is not
// caught here), and a write from cwd sitting on the mission's own base branch is almost always
// the wrong tree found by accident rather than named on purpose — `--tree` said explicitly is
// exactly how that accident is ruled out.
export function assertGraphWritable(info, { horde, cfg } = {}) {
  if (info.kind === 'trunk') {
    fail(`trunk (${info.path}, branch ${info.branch}) is written only by the landing script — pass --tree ${info.path} if this really is that`);
  }
  const base = cfg && cfg.base;
  if (info.kind === 'cwd' && base && info.branch === base) {
    const trunkPath = horde ? resolveTree({ horde }, { cwd: info.path }).path : null;
    fail(`${info.path} is on "${base}" — a graph write from here is almost certainly the wrong tree found by accident, not named on purpose${trunkPath ? `; the mission's tree is at ${trunkPath}` : ''}. Pass --tree explicitly if this checkout really is what you mean`);
  }
}

// provisionTree(path, ref, cfg) — `git worktree add` at `path` for `ref` (a branch name checks
// out attached to it, anything else — a sha, most often — detached), then copies every
// `config.worktree.copy` entry from the repository root into the new tree. Idempotent: a second
// call at a path that already exists does nothing at all, not even re-validate `worktree.copy` —
// `queue.mjs set <ticket> running` calls this every time a ticket's state is re-read, and the
// worker's own edits to their tree are not something a repeated call should ever touch. Throws
// (never fail()s) on every refusal, the same idiom `claimLease` uses: the two callers that need to
// clean up a half-made tree on failure (resolveScratchTree) or need their own wording (the ticket
// worktree cut in queue.mjs cmdSet) both need the message before anything is printed, not a
// process already gone.
//
// A `worktree.copy` entry git already tracks is refused before the tree is even created — git put
// that file on every branch already, and copying over it would desync the tree from its own
// branch. A `worktree.copy` entry that does not exist is refused instead at copy time, after the
// tree exists: the alternative (checking before `git worktree add`) would mean this function could
// refuse without ever having touched git worktree state at all, which is exactly the case
// resolveScratchTree's own cleanup path exists to handle, and untested here would leave it dead
// code.
export function provisionTree(path, ref, cfg) {
  if (existsSync(path)) return { created: false, copied: [] };
  const root = repoRoot();
  const copyList = cfg && cfg.worktree && Array.isArray(cfg.worktree.copy) ? cfg.worktree.copy : [];
  for (const rel of copyList) {
    if (git(['ls-files', '--error-unmatch', '--', rel], root) !== null) {
      throw new Error(`config.worktree.copy names "${rel}", which git already tracks on this branch — copying over a tracked path would desync the worktree from its own branch`);
    }
  }
  const isBranch = git(['show-ref', '--verify', '--quiet', `refs/heads/${ref}`], root) !== null;
  const args = isBranch ? ['worktree', 'add', path, ref] : ['worktree', 'add', '--detach', path, ref];
  if (git(args, root) === null) throw new Error(`could not create worktree at ${path} for ${ref}`);
  const copied = [];
  for (const rel of copyList) {
    const src = join(root, rel);
    if (!existsSync(src)) throw new Error(`config.worktree.copy names "${rel}", which does not exist at ${src}`);
    const dest = join(path, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    copied.push(rel);
  }
  return { created: true, copied };
}

// provenanceLine(info) / withProvenance(obj, info) — the one line every command that resolved a
// tree ends with ("tree: <path> · branch: <branch> · <sha>"), and the three fields (`tree`,
// `branch`, `sha`) its `--json` carries alongside whatever else it reports. `branch` prints
// literally as `null` for a detached (scratch) tree — the point is telling apart "no branch, on
// purpose" from a field that was simply forgotten.
export function provenanceLine(info) {
  return `tree: ${info.path} · branch: ${info.branch === null ? 'null' : info.branch} · ${info.sha}`;
}

export function withProvenance(obj, info) {
  return {
    ...obj, tree: info.path, branch: info.branch, sha: info.sha,
  };
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

// ---- one counter, three prefixes ---------------------------------------------------------------
//
// Everything the horde numbers comes out of ONE sequence, `hordes/<h>/counter.json`, and wears the
// prefix that says what kind of thing it is: `t-` a ticket, `g-` anything the architect rules on
// (a graph change, a port proposal, a contract proposal, a rule proposal), `a-` a question put to
// the client. Before this there were three independent sequences, so a ticket and a port proposal
// could both be "1" in the same mission and `show 20` was an ambiguous question. There is no `e-`
// or `d-`: escalation and dissent folded into the client channel and have no kind of their own.
//
// The number is the identity and the prefix is how it is read, so an id is rendered with its
// prefix everywhere and accepted either way — a bare number still resolves, for one release, so a
// mission started before this keeps working.
export const ID_PREFIXES = { ticket: 't', graph: 'g', ask: 'a' };

export function counterPath(horde) {
  return hordePath(horde, 'counter.json');
}

// "4" → "004". Three digits, the width tickets have always been written at, so all three kinds
// sort and read alike.
export function padNumber(n) {
  return String(n).padStart(3, '0');
}

// The number inside an identifier, however it was written: "g-004", "004", "4", 4. Null when there
// is no number in it at all.
export function idNumber(id) {
  const m = /(\d+)\s*$/.exec(String(id ?? ''));
  return m ? parseInt(m[1], 10) : null;
}

// allocateId(horde, kind, {floor}) — the next number in the shared sequence, as {n, number, id}.
// `floor` is the highest number a caller already knows about from its own file: a graph.json
// written before this change carries ids from a sequence the counter never saw, and handing out a
// number below them would collide on the very mission this exists to keep working.
export function allocateId(horde, kind, { floor = 0 } = {}) {
  const prefix = ID_PREFIXES[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind} (kinds: ${Object.keys(ID_PREFIXES).join(', ')})`);
  const path = counterPath(horde);
  const doc = readJSON(path, { next: 1 });
  const declared = Number(doc && doc.next);
  const n = Math.max(Number.isFinite(declared) && declared >= 1 ? declared : 1, Number(floor) + 1);
  writeJSON(path, { next: n + 1 });
  return { n, number: padNumber(n), id: `${prefix}-${padNumber(n)}` };
}

// The note a command prints when it was handed a bare number instead of a prefixed id. Null when
// the caller wrote the prefix, so the note only ever appears where it is actually earned.
export function migrationNote(ref, resolvedId) {
  if (String(ref) === String(resolvedId)) return null;
  return `("${ref}" was read as ${resolvedId} — identifiers carry their kind now; a bare number is `
    + 'accepted for one release so a mission started before this keeps working)';
}

// ---- the quality policy (ruling quality-always-authorised) ------------------------------------
//
// The charter's own answer to "may the horde improve what it was not asked to improve": the
// `## Quality` section's `**Policy:**` line. `autonomous` (the default, and what the charter
// template writes) means the horde raises the graph wherever the evidence allows and files the
// improvements it finds, without asking; `only-the-work` means it does nothing beyond the tickets
// the mission names. Neither setting ever authorises LOWERING anything — that is the chairman's,
// under every policy.
//
// Read from the charter rather than kept in config.json because it is a promise made to the
// chairman in the document they read and amend, and a second copy in a config file could disagree
// with it. A charter written before this field existed reads as `autonomous`: that is the ruling's
// own default, and an older mission does not silently opt out of it.

export const QUALITY_POLICIES = ['autonomous', 'only-the-work'];

// The `**Policy:**` line inside the charter's `## Quality` section, or null when there is none.
// Scoped to that section on purpose: `## Cost` carries a policy line of its own, and a loose
// search would read the cost policy as a quality setting.
export function qualityPolicyIn(charterText) {
  const text = String(charterText || '');
  const start = text.search(/^##\s+Quality\s*$/m);
  if (start === -1) return null;
  const rest = text.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  const m = /^\*\*Policy:\*\*\s*([^\n·]*?)\s*(?:·|$)/m.exec(section);
  return m ? m[1].trim() : null;
}

export function qualityPolicy(horde) {
  const found = qualityPolicyIn(readText(hordePath(horde, 'charter.md')));
  return QUALITY_POLICIES.includes(found) ? found : 'autonomous';
}

// Resolves a team's short LEAF name (e.g. "lark") to its full on-disk segment chain
// (["trunk", "lark"]) by walking roster.json's steward entries' own `parent` links back to
// "trunk". Nothing writes a steward entry any more — there is only ever "trunk" — so this always
// takes the "trunk" fast path below in practice; kept as a lookup rather than hard-coded because
// leaf names are the only address that stays correct no matter how deep a team is nested, and a
// pre-migration mission's roster.json may still carry a real chain worth resolving. "trunk" is
// the implicit root and needs no roster lookup at all.
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

// ---- cross-horde leases (node-lease-across-hordes) -------------------------------------------
// Exclusive ownership across every live horde on one repository: `.horde/leases.json` maps a
// SUBJECT to the horde currently bound to it and since when. A subject is a node id (`node.mjs
// bind <node>`) or a territory name (`refine.mjs --step cut`, which leases the cut it just
// validated) — the file, the history and the refusal are one mechanism either way, because the
// question both ask is the same one: is another live horde already working this. This file is NOT
// per-horde — every horde on the repository reads and writes the one shared document, which is
// exactly why it lives beside config.json rather than under hordes/<horde>/. `horde.mjs archive`
// is the only remover (a horde's leases are released the moment it is no longer live). `history`
// is an append-only record of every bind/take/release so a contested subject's story survives past
// the current state; its `node` field keeps that name for the shape's sake and carries whichever
// subject the entry is about.

export function leasesPath() {
  return join(hordeRoot(), 'leases.json');
}

// A lease file that will not parse is NOT an empty one. An interrupted run leaves a truncated
// JSON behind, and reading that as "nothing is leased" would hand out a subject another live horde
// still holds — the one failure this whole file exists to prevent. So it refuses, by name.
export function readLeases() {
  let doc;
  try {
    doc = readJSON(leasesPath(), null);
  } catch (e) {
    fail(
      `${leasesPath()} will not parse as JSON, so what is leased on this repository cannot be read: ${e.message}\n`
      + 'A lease file half-written by an interrupted run is not an empty one — treating it as empty would hand '
      + 'out a subject another live horde still holds.\n'
      + 'Repair the file, or delete it if no horde on this repository holds anything.',
    );
  }
  const leases = doc && doc.leases && typeof doc.leases === 'object' ? doc.leases : {};
  const history = doc && Array.isArray(doc.history) ? doc.history : [];
  return { leases, history };
}

function renderLeases(doc) {
  const entries = Object.entries(doc.leases).sort(([a], [b]) => a.localeCompare(b));
  const lines = ['# Leases', '', '| leased | horde | since |', '|---|---|---|'];
  if (entries.length === 0) lines.push('| | | |');
  for (const [node, lease] of entries) lines.push(`| ${node} | ${lease.horde} | ${lease.since} |`);
  if (doc.history.length > 0) {
    lines.push('', '## History', '');
    for (const h of [...doc.history].reverse()) {
      const bits = [h.at, h.event, h.node, `-> ${h.horde}`];
      if (h.from) bits.push(`(from ${h.from})`);
      if (h.escalation) bits.push(`escalation ${h.escalation}`);
      lines.push(`- ${bits.join(' ')}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function writeLeases(doc) {
  writeJSON(leasesPath(), doc, { render: renderLeases });
}

// releaseLeasesForHorde(horde) — drops every lease this horde holds and records a "release" entry
// per subject in the history. Called by horde.mjs archive so an archived horde's nodes and
// territories are free the moment it stops being live; returns the released subjects (empty when
// it held none).
export function releaseLeasesForHorde(horde) {
  const doc = readLeases();
  const released = Object.entries(doc.leases).filter(([, l]) => l.horde === horde).map(([node]) => node);
  if (released.length === 0) return released;
  const at = nowIso();
  for (const node of released) {
    delete doc.leases[node];
    doc.history.push({
      node, event: 'release', horde, from: null, escalation: null, at,
    });
  }
  writeLeases(doc);
  return released;
}

// leaseConflict(horde, subject) — the live holder blocking `horde` from this subject, or null when
// there is none (never leased, held by `horde` itself, or held by a horde no longer live). A pure
// read, safe to call before mutating anything — which is exactly why horde.mjs init uses it to
// refuse a --nodes overlap BEFORE creating the horde's branch, rather than discovering the
// conflict after state already exists.
export function leaseConflict(horde, subject) {
  const liveHordes = listHordes();
  const { leases } = readLeases();
  const existing = leases[subject];
  return existing && existing.horde !== horde && liveHordes.includes(existing.horde) ? existing : null;
}

// The refusal, in the subject's own words. Both halves matter: WHO holds it and how recently they
// moved (so a horde nobody has touched in a week reads as the stale thing it is), and what the
// taker can actually do about it. That second half differs by kind, because the ways out differ. A
// node can be taken over on a ruled escalation. A territory cannot: who works an area when two
// hordes want it is the client's call, answered once at the frame, and there is no command here
// that overrides it — so this says archive, and otherwise says to go and ask, rather than naming a
// mechanism that would not run.
function leaseRefusalMessage(taker, subject, holder, kind) {
  const activity = latestActivity(hordePath(holder.horde)) || 'no recorded activity';
  const head = `${kind} "${subject}" is leased by horde "${holder.horde}" (since ${holder.since}; last activity `
    + `${activity}) and that horde is not archived — archive it (\`horde.mjs archive ${holder.horde}\`) `;
  return kind === 'territory'
    ? `${head}or put it to the client, whose answer decides which mission gets this area; nothing here takes a territory over`
    : `${head}or take the lease over a ruled escalation: \`node.mjs bind ${subject} --take --escalation <id> --horde ${taker}\``;
}

// assertLeaseAvailable(horde, subject, {kind}) — throws leaseConflict's refusal, otherwise returns
// quietly. horde.mjs init calls this for every requested node before creating anything of its own,
// so the whole command refuses cleanly (no orphaned branch, no half-created horde) on the very
// message node.mjs bind would give later for the same node; refine.mjs calls it for every
// territory of a cut before claiming any of them.
export function assertLeaseAvailable(horde, subject, { kind = 'node' } = {}) {
  const conflict = leaseConflict(horde, subject);
  if (conflict) throw new Error(leaseRefusalMessage(horde, subject, conflict, kind));
}

// claimLease(horde, subject, {take, escalation, kind}) — the one path that acquires a lease, for a
// node and for a territory alike. Ownership is exclusive across every live horde on a repository:
// returns {status: 'held' | 'claimed' | 'taken', ...} on success; throws Error with a
// what/why/next-shaped message the caller passes straight to fail() on any refusal. Shared by
// horde.mjs init (--nodes, at creation, after assertLeaseAvailable has already cleared it),
// node.mjs bind (<node>, any time) and refine.mjs (one territory of a validated cut), so every
// tool refuses the same overlap the same way and writes the same history line — one derivation,
// three callers, per the scripts' own convention (see node.mjs's consumersOf).
//
// The write is the commit point, and it is the LAST thing that happens: everything before it is a
// read or an in-memory edit, so a run killed partway leaves the file exactly as it found it and
// the subject free for the next attempt. Callers claiming several subjects at once hold to the
// same shape by validating all of them before claiming any.
export function claimLease(horde, subject, { take = false, escalation = null, kind = 'node' } = {}) {
  const doc = readLeases();
  const node = subject;
  const existing = doc.leases[node];

  if (existing && existing.horde === horde) {
    return { status: 'held', node, horde, since: existing.since };
  }

  const conflict = leaseConflict(horde, node);
  if (conflict) {
    if (!take) throw new Error(leaseRefusalMessage(horde, node, conflict, kind));
    if (!escalation) {
      throw new Error('--take requires --escalation <id> — a ruled escalation on this horde justifying the take-over');
    }
    const escDoc = readJSON(hordePath(horde, 'escalations.json'), { items: [] });
    const esc = (Array.isArray(escDoc.items) ? escDoc.items : []).find((it) => it.id === String(escalation));
    if (!esc) throw new Error(`no such escalation: ${escalation} (on horde "${horde}")`);
    if (esc.state !== 'ruled') {
      throw new Error(`escalation ${escalation} is not ruled yet — \`escalate.mjs rule ${escalation} "<ruling>" --horde ${horde}\` first`);
    }
    const from = conflict.horde;
    const at = nowIso();
    doc.leases[node] = { horde, since: at };
    doc.history.push({
      node, event: 'take', horde, from, escalation: String(escalation), at,
    });
    writeLeases(doc);
    return {
      status: 'taken', node, horde, from, escalation: String(escalation), ruling: esc.ruling,
    };
  }

  // Free: never leased, or held by a horde no longer live — archiving already releases a horde's
  // leases, so this branch is a defensive fallback for state written before that, not the normal
  // path.
  const freedFrom = existing ? existing.horde : null;
  const at = nowIso();
  doc.leases[node] = { horde, since: at };
  doc.history.push({
    node, event: 'bind', horde, from: freedFrom, escalation: null, at,
  });
  writeLeases(doc);
  return { status: 'claimed', node, horde, freedFrom };
}

// ---- a horde's own last activity (most recent mtime under its directory) ---------------------
// Shared by horde.mjs list (a horde reporting its own last activity) and node.mjs bind (naming
// the last activity of whichever horde currently holds a lease being contested), so a refusal
// message and the `list` column agree on what "last activity" means rather than each tool
// computing its own notion of it.
function dirMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

export function latestActivity(dest) {
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
  return latest ? new Date(latest).toISOString() : null;
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

// parentBranchOf(horde, team, item) — the branch a queue item's own branch is rooted on, merges
// into, and is measured against. Normally the team's branch. A ticket the steward started from an
// unmerged dependency's tip (`queue.mjs set NNN running --on MMM`, recorded as `stackedOn`) is
// rooted on that dependency's branch instead, so a chain of three tickets does not cost three
// waves. The stack lasts exactly as long as the dependency is unmerged: once it merges, its work
// is on the team branch, `stackedOn` is cleared by the write that recorded the merge, its branch
// is gone, and the parent is the team branch again. The state and branch are checked here as well
// as cleared there, so a `stackedOn` left behind by anything resolves to the team branch — the
// answer that is at worst stale, never one naming a branch that no longer exists.
//
// One function, because everything measured against a parent has to name the same one: how fresh
// the base is, what the diff contains, the identity a key binds to, what a new test is reverted
// onto, and what the range-diff of a moved diff is taken against. Two answers here would be a
// ticket whose keys are recorded against one branch and checked against another.
export function parentBranchOf(horde, team, item, { cwd } = {}) {
  const teamBranch = `${horde}/${String(team).split('/').pop()}`;
  const stackedOn = item && item.stackedOn ? String(item.stackedOn) : null;
  const out = {
    branch: teamBranch, teamBranch, stackedOn, stacked: false,
  };
  if (!stackedOn) return out;
  const queue = readJSON(teamPath(horde, team, 'queue.json'), { items: [] });
  const parent = asArray(queue.items).find((i) => String(i.ticket) === stackedOn);
  if (!parent || parent.state === 'merged' || !parent.branch) return out;
  if (git(['rev-parse', '--verify', parent.branch], cwd || repoRoot()) === null) return out;
  return { ...out, branch: parent.branch, stacked: true };
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
