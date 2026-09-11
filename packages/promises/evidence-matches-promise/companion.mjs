// What the reader is shown beside the promise: the paired file, and the modules
// that file reaches for to do its work.
//
// Following imports is the whole reason this hook exists. A test that reads
// `expectConfirmed(order)` from a helper says nothing on its own; the sentence it
// keeps is in the helper. So the fold is TRANSITIVE — the paired file, what it
// imports, what those import — and bounded three ways, because an unbounded fold
// on a real suite reaches the whole repository:
//
//   * by reach — `ctx.fs` refuses anything outside what the component's own
//     mapping, its ancestors and descendants, and its declared relations allow.
//     A module beyond that is skipped, and the skip is said out loud in the label
//     rather than silently narrowing what the reader was given.
//   * by depth — `max_depth` hops from the paired file.
//   * by size — `max_bytes` of paired material, after which the fold stops.
//
// Returning [] is a valid answer: a promise nothing runs yet has nothing to pair.
// Throwing is how this hook says a requirement is unmet — the pair stays
// unverified and nobody is billed for reading half an answer.

const DEFAULT_EVIDENCE = 'auto';
const DEFAULT_SPEC_SUFFIX = '.test';
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_BYTES = 32000;
const PARKED = new Set(['planned', 'disabled']);

/** Extensions tried, in order, when an import names no extension of its own. */
const EXTENSIONS = ['', '.mjs', '.js', '.ts', '.tsx', '.jsx', '.cjs', '/index.mjs', '/index.js', '/index.ts'];

export function companion(ctx) {
  const subject = ctx.subject?.[0];
  if (!subject) return [];

  const front = readFrontmatter(subject.content);
  if (front === null) return []; // not a promise; the shape rule has this one
  if (PARKED.has(front.fields.status)) return []; // nothing runs it yet

  const setting = String(ctx.config?.evidence ?? DEFAULT_EVIDENCE).trim();
  const suffix = String(ctx.config?.spec_suffix ?? DEFAULT_SPEC_SUFFIX);
  const maxDepth = Number(ctx.config?.max_depth ?? DEFAULT_MAX_DEPTH);
  const maxBytes = Number(ctx.config?.max_bytes ?? DEFAULT_MAX_BYTES);

  const adapter = setting === 'auto' ? adapterOf(front) : setting;
  // Nothing to show the reader: the promise file is itself the subject under
  // `self`, and an accepted artefact is judged on its recorded fields by the
  // deterministic rule, not by reading bytes nobody can re-derive here.
  if (adapter === 'self' || adapter === 'artefact') return [];

  const root = adapter === 'named' ? namedTarget(ctx, subject, front) : mirrorTarget(ctx, subject, suffix);

  const notes = [];
  const seen = new Set([root]);
  const out = [];
  let bytes = 0;

  let frontier = [root];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const rel of frontier) {
      let content;
      try {
        content = ctx.fs.read(rel);
      } catch {
        // Out of reach, or gone between the probe and the read. The root was
        // already proved to exist above, so this can only be a followed import.
        notes.push(rel);
        continue;
      }
      if (bytes + content.length > maxBytes) {
        notes.push(`${rel} (the fold reached its ${maxBytes}-byte limit)`);
        continue;
      }
      bytes += content.length;
      out.push({ path: rel, depth });
      if (depth === maxDepth) continue;
      for (const spec of relativeImports(content)) {
        const resolved = resolve(ctx, rel, spec, notes);
        if (resolved === null || seen.has(resolved)) continue;
        seen.add(resolved);
        next.push(resolved);
      }
    }
    frontier = next;
  }

  const skipped = notes.length === 0 ? '' : ` Not shown: ${notes.join('; ')}.`;
  return out.map((entry) => ({
    path: entry.path,
    label:
      entry.depth === 0
        ? `The thing that keeps this promise.${skipped}`
        : `Reached from the thing that keeps this promise, ${entry.depth} step(s) away.`,
  }));
}

/** The paired file under a named pairing, or a throw saying it cannot be found. */
function namedTarget(ctx, subject, front) {
  const raw = front.fields.evidence ?? '';
  const hash = raw.indexOf('#');
  if (hash <= 0) {
    throw new Error(
      `Promise '${front.fields.id ?? subject.path}' names '${raw}' as what keeps it, which is not '<file>#<name>'.`,
    );
  }
  const target = raw.slice(0, hash).trim();
  if (probe(ctx, target) !== 'file') {
    throw new Error(
      `Promise '${front.fields.id ?? subject.path}' says it is kept by '${target}', which is not a file this rule can reach. It must be an exact repository-relative path inside the component's own mapping or a component it is related to.`,
    );
  }
  return target;
}

/** The paired file under a mirror pairing, or a throw saying it is not there. */
function mirrorTarget(ctx, subject, suffix) {
  const dir = subject.path.slice(0, subject.path.lastIndexOf('/') + 1);
  const stem = stemOf(subject.path) + suffix;
  const tried = [];
  for (const candidate of siblingCandidates(ctx, dir, stem)) {
    tried.push(candidate);
    if (probe(ctx, candidate) === 'file') return candidate;
  }
  throw new Error(
    `Nothing keeps promise '${stemOf(subject.path)}'. Looked for ${tried.join(', ')}. Write it, or set the promise's status to one that says nothing runs it yet.`,
  );
}

/**
 * Where a mirror could live.
 *
 * A repository that maps its promises and its suite into one component keeps them
 * in two directories, so the mirror is looked for beside the promise AND in every
 * sibling directory of the promise's own — which is as far as a rule that refuses
 * to know directory names can reasonably go.
 */
function siblingCandidates(ctx, dir, stem) {
  const out = [];
  for (const ext of ['.test.mjs', '.mjs', '.js', '.ts', '.py', '.rb', '.go', '.java', '.cs', '']) {
    out.push(`${dir}${stem}${ext}`);
  }
  const parent = dir.slice(0, Math.max(0, dir.slice(0, -1).lastIndexOf('/') + 1));
  let entries = [];
  try {
    entries = ctx.fs.list(parent === '' ? '.' : parent);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue;
    for (const ext of ['.mjs', '.js', '.ts', '.py', '.rb', '.go', '.java', '.cs']) {
      out.push(`${parent}${entry.name}/${stem}${ext}`);
    }
  }
  return out;
}

function probe(ctx, rel) {
  try {
    return ctx.fs.exists(rel);
  } catch {
    return false;
  }
}

/** Every relative module specifier in a piece of source, import and require alike. */
function relativeImports(content) {
  const out = [];
  const patterns = [
    /(?:^|[\s;{}])import\s+[^;'"]*from\s*['"](\.[^'"]+)['"]/g,
    /(?:^|[\s;{}])import\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{}])export\s+[^;'"]*from\s*['"](\.[^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (let m = re.exec(content); m !== null; m = re.exec(content)) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** A relative specifier as a repository path, or null when nothing answers to it. */
function resolve(ctx, fromRel, spec, notes) {
  const dir = fromRel.slice(0, fromRel.lastIndexOf('/') + 1);
  const joined = flatten(dir + spec);
  for (const ext of EXTENSIONS) {
    const candidate = joined + ext;
    const kind = probe(ctx, candidate);
    if (kind === 'file') return candidate;
  }
  // Either it is outside what this rule may read, or it resolves through a
  // convention this hook does not know. Either way the reader is told.
  notes.push(`${spec} (reached from ${fromRel}, outside what this rule may read)`);
  return null;
}

/** `a/b/../c` as `a/c`, without touching the filesystem. */
function flatten(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function stemOf(filePath) {
  const base = filePath.split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function adapterOf(front) {
  if (front.blocks.artefact !== undefined) return 'artefact';
  if (front.fields.evidence === 'self') return 'self';
  if (front.fields.evidence !== undefined) return 'named';
  return 'mirror';
}

function readFrontmatter(content) {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const fields = Object.create(null);
  const blocks = Object.create(null);
  let openBlock = null;
  for (let i = 1; i < end; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (/^\s+\S/.test(raw) && openBlock !== null) {
      const idx = raw.indexOf(':');
      if (idx !== -1) blocks[openBlock][raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
      continue;
    }
    if (/^\s/.test(raw)) continue;
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (value === '') {
      openBlock = key;
      blocks[key] = Object.create(null);
    } else {
      openBlock = null;
      fields[key] = value;
    }
  }
  return { fields, blocks };
}
