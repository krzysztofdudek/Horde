// One promise, one thing keeping it — and that thing keeps nothing else.
//
// The pairing runs BOTH ways on purpose. One direction alone lets a promise drift
// away from the test that was written for it: the promise keeps its pair and the
// test quietly grows to cover three more promises nobody wrote down, and the
// count still reads one-to-one from the promise's side.
//
// Four pairings, and a repository may pin one for every promise or let each
// promise say which it is using. Pinning is `evidence:` in the settings; saying so
// per promise is the default, and is read off the promise's own frontmatter.

/** The four ways a promise can be paired with the thing that keeps it. */
export const ADAPTERS = ['mirror', 'named', 'self', 'artefact'];

/** `auto` is not a fifth pairing — it means "read the pairing off each promise". */
export const EVIDENCE_SETTINGS = ['auto', ...ADAPTERS];

/** The four fields an accepted artefact has to carry. */
export const ARTEFACT_FIELDS = ['path', 'sha256', 'accepted_by', 'at'];

const DEFAULT_EVIDENCE = 'auto';
const DEFAULT_SPEC_SUFFIX = '.test';
const DEFAULT_PARKED = 'planned, disabled';

export function check(ctx) {
  const files = ctx.files;
  // Nothing mapped is not a finding. A repository that has written no promises
  // yet must not be told off for the ones it has not written.
  if (files.length === 0) return [];

  const setting = String(ctx.config?.evidence ?? DEFAULT_EVIDENCE).trim();
  const suffix = String(ctx.config?.spec_suffix ?? DEFAULT_SPEC_SUFFIX);
  const parked = new Set(splitList(ctx.config?.parked_markers ?? DEFAULT_PARKED));

  if (!EVIDENCE_SETTINGS.includes(setting)) {
    return [
      {
        file: files[0].path,
        line: 1,
        message: `'${setting}' is not a way of pairing a promise with the thing that keeps it. The four are ${ADAPTERS.join(', ')}; leave the setting at 'auto' to let each promise say which of them it is using.`,
      },
    ];
  }

  const promises = [];
  const others = [];
  for (const file of files) {
    const front = readFrontmatter(file.content);
    if (front === null) others.push(file);
    else promises.push({ file, front, adapter: setting === 'auto' ? adapterOf(front) : setting });
  }

  const out = [];
  const live = promises.filter((p) => !parked.has(p.front.fields.status));

  for (const promise of live) {
    if (promise.adapter === 'mirror') checkMirror(promise, others, suffix, out);
    else if (promise.adapter === 'named') checkNamed(promise, files, out);
    else if (promise.adapter === 'self') checkSelf(promise, out);
    else if (promise.adapter === 'artefact') checkArtefact(promise, out);
  }

  checkNothingKeepsTwo(live, others, suffix, out);

  return out;
}

/** Which pairing a promise is using, read off what its own frontmatter carries. */
function adapterOf(front) {
  if (front.blocks.artefact !== undefined) return 'artefact';
  if (front.fields.evidence === 'self') return 'self';
  if (front.fields.evidence !== undefined) return 'named';
  return 'mirror';
}

// ── the four pairings, promise → evidence ────────────────────────────────────

function checkMirror(promise, others, suffix, out) {
  const want = stemOf(promise.file.path) + suffix;
  const found = others.filter((f) => normalize(stemOf(f.path)) === normalize(want));
  if (found.length === 0) {
    out.push({
      file: promise.file.path,
      line: 1,
      message: `Nothing here keeps this promise. It says it is kept, and the file that would keep it is the one named '${want}' beside the rest of the suite — either write it, or set this promise's status to one that says nothing runs it yet.`,
    });
  } else if (found.length > 1) {
    out.push({
      file: promise.file.path,
      line: 1,
      message: `${found.length} files claim to keep this promise (${found.map((f) => f.path).join(', ')}). A promise is kept by one thing, so a reader who watches it fail knows what to open.`,
    });
  }
}

function checkNamed(promise, files, out) {
  const raw = promise.front.fields.evidence;
  const line = promise.front.lineOf.evidence ?? 1;
  const hash = raw.indexOf('#');
  if (hash <= 0 || hash === raw.length - 1) {
    out.push({
      file: promise.file.path,
      line,
      message: `'${raw}' does not name the thing that keeps this promise. A named pairing is written '<file>#<name of the thing inside it>', so a reader gets to the exact case and not just the file.`,
    });
    return;
  }
  const target = raw.slice(0, hash).trim();
  const name = raw.slice(hash + 1).trim();
  const file = files.find((f) => normalize(f.path) === normalize(target) || normalize(f.path).endsWith('/' + normalize(target)));
  if (file === undefined) {
    out.push({
      file: promise.file.path,
      line,
      message: `This promise says it is kept by '${target}', which is not among the files these rules were pointed at. Either the path is wrong, or the suite that holds it is not mapped alongside the promises.`,
    });
    return;
  }
  if (!file.content.includes(name)) {
    out.push({
      file: promise.file.path,
      line,
      message: `'${target}' contains nothing called '${name}'. The named pairing has to land on something that is actually in the file, or a rename leaves the promise pointing at a gap.`,
    });
  }
}

function checkSelf(promise, out) {
  // Nothing to pair: the promise file IS what the repository's own runner reads.
  // Existence is settled by the file being in front of us, so status is the whole
  // of what is left — and this rule asks for it separately from the shape rule
  // because here it is the pairing, not the paperwork.
  const status = promise.front.fields.status;
  if (status === undefined || status === '') {
    out.push({
      file: promise.file.path,
      line: 1,
      message: 'This promise is its own evidence and says nothing about its status. When the promise file is what gets run, the status is the only thing saying whether it is expected to pass.',
    });
  }
}

function checkArtefact(promise, out) {
  const block = promise.front.blocks.artefact;
  const line = promise.front.lineOf.artefact ?? 1;
  if (block === undefined) {
    out.push({
      file: promise.file.path,
      line,
      message: `This promise is kept by an accepted artefact and carries none. Add an 'artefact:' block with ${ARTEFACT_FIELDS.join(', ')} — what was accepted, what it hashed to, who accepted it and when.`,
    });
    return;
  }
  const missing = ARTEFACT_FIELDS.filter((f) => block[f] === undefined || block[f] === '');
  if (missing.length > 0) {
    out.push({
      file: promise.file.path,
      line,
      message: `This promise's artefact is missing ${missing.join(', ')}. All four are needed: without them nobody can tell which file was accepted, or by whom, or whether it is still the one that was.`,
    });
    return;
  }
  if (!/^[0-9a-f]{64}$/i.test(block.sha256)) {
    out.push({
      file: promise.file.path,
      line,
      message: `'${block.sha256}' is not a sha256. The point of recording one is that a reader can take the file and get the same 64 characters back; anything else records nothing.`,
    });
  }
}

// ── the other direction: nothing keeps two promises ──────────────────────────

function checkNothingKeepsTwo(live, others, suffix, out) {
  const claimedBy = new Map();
  const claim = (key, promise) => {
    const existing = claimedBy.get(key);
    if (existing === undefined) claimedBy.set(key, [promise]);
    else existing.push(promise);
  };

  for (const promise of live) {
    if (promise.adapter === 'mirror') {
      claim(`mirror:${normalize(stemOf(promise.file.path) + suffix)}`, promise);
    } else if (promise.adapter === 'named') {
      const raw = promise.front.fields.evidence ?? '';
      if (raw.includes('#')) claim(`named:${normalize(raw.trim())}`, promise);
    } else if (promise.adapter === 'artefact') {
      const block = promise.front.blocks.artefact;
      if (block?.sha256 !== undefined) claim(`artefact:${String(block.sha256).toLowerCase()}`, promise);
    }
  }

  for (const [key, holders] of claimedBy) {
    if (holders.length < 2) continue;
    const names = holders.map((h) => stemOf(h.file.path)).join(', ');
    for (const holder of holders) {
      out.push({
        file: holder.file.path,
        line: 1,
        message: `${holders.length} promises are kept by the same thing (${names}). One thing that keeps several promises tells a reader which of them broke only by accident — give each promise its own, or write one promise that says what they all say.`,
      });
    }
  }

  // A file shaped like the thing that keeps a promise, keeping none, is the same
  // drift seen from the other end: it will be maintained by whoever wrote it and
  // read by nobody as a claim about the product.
  for (const file of others) {
    const stem = stemOf(file.path);
    if (!stem.endsWith(suffix)) continue;
    const promised = stem.slice(0, stem.length - suffix.length);
    const matches = live.filter(
      (p) => p.adapter === 'mirror' && normalize(stemOf(p.file.path)) === normalize(promised),
    );
    if (matches.length === 0) {
      out.push({
        file: file.path,
        line: 1,
        message: `This is named as the thing that keeps the promise '${promised}', and there is no such promise here. Either write the promise it is keeping, or take the promise's name out of its own.`,
      });
    }
  }
}

// ── reading a promise ────────────────────────────────────────────────────────

function splitList(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function stemOf(filePath) {
  const base = filePath.split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function normalize(value) {
  return String(value).normalize('NFC');
}

/**
 * The frontmatter as scalars plus one level of nesting, or null when there is no
 * frontmatter at all.
 *
 * Null is how this rule tells a promise from everything else it was pointed at:
 * the files that are not promises are the candidates for keeping them. A file
 * whose frontmatter does not read is not treated as a promise either — the shape
 * rule is the one that says so, and refusing it twice helps nobody.
 */
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
  const lineOf = Object.create(null);
  let openBlock = null;

  for (let i = 1; i < end; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    if (/^\s+\S/.test(raw) && openBlock !== null) {
      const idx = raw.indexOf(':');
      if (idx === -1) continue;
      blocks[openBlock][raw.slice(0, idx).trim()] = unquote(raw.slice(idx + 1).trim());
      continue;
    }
    if (/^\s/.test(raw)) continue;

    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    const key = raw.slice(0, idx).trim();
    const value = unquote(raw.slice(idx + 1).trim());
    lineOf[key] = i + 1;
    if (value === '') {
      openBlock = key;
      blocks[key] = Object.create(null);
    } else {
      openBlock = null;
      fields[key] = value;
    }
  }

  return { fields, blocks, lineOf };
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  return value;
}
