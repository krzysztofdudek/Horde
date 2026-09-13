// The thing that keeps a live promise has to actually run.
//
// A suite goes green two ways: because every case in it passed, or because the
// ones that would have failed were switched off. The second is the expensive
// one. Nothing in the report says a promise stopped being kept, the promise file
// still reads as implemented months later, and the first person to notice is a
// customer.
//
// So this rule reads the file a live promise is paired with — the same four
// pairings has-evidence knows, read the same way — and refuses two kinds of
// marker on it:
//
//   * a SKIP marker, which turns that case off;
//   * an EXCLUSIVITY marker, which makes one case the only one that runs and so
//     turns every other case in the same file off with it.
//
// The list is closed. A repository may narrow it to the conventions its own
// suite uses; it cannot add one this rule does not know how to look for, because
// a marker nobody wrote a matcher for would be accepted silently. It is a text
// scan and not a parse: a marker written inside a comment counts as one, which is
// why every refusal names the line rather than just the file.
//
// A parked promise is left alone. A promise whose status says nothing runs it yet
// is allowed to be paired with something switched off — that is what the status
// is for, and has-evidence is the rule that asks for the status in the first place.

/** The four ways a promise can be paired with the thing that keeps it. */
export const ADAPTERS = ['mirror', 'named', 'self', 'artefact'];

/** `auto` is not a fifth pairing — it means "read the pairing off each promise". */
export const EVIDENCE_SETTINGS = ['auto', ...ADAPTERS];

/**
 * The closed list, one entry per way a suite says "not this one".
 *
 * `kind` is what the marker does, and it decides how far the search reaches:
 * `skip` turns off the case it sits on, so under a named pairing only that case's
 * own lines count; `exclusive` turns off everything it does not sit on, so it
 * counts anywhere in the paired file.
 *
 * Each matcher is deliberately tighter than the token it is named for. `t.Skip(`
 * asks for `t` as a word of its own, so a chained `list.Skip(` is not one. `Skip =`
 * asks for the attribute argument shape — a bracket or a comma, then the name,
 * then a quoted reason — so an ordinary assignment to a variable called `Skip` is
 * not one either.
 */
const MARKERS = {
  'test.skip': { kind: 'skip', at: /\btest\s*\.\s*skip\b/ },
  'test.fixme': { kind: 'skip', at: /\btest\s*\.\s*fixme\b/ },
  'test.only': { kind: 'exclusive', at: /\btest\s*\.\s*only\b/ },
  xit: { kind: 'skip', at: /\bxit\s*\(/ },
  xdescribe: { kind: 'skip', at: /\bxdescribe\s*\(/ },
  '@pytest.mark.skip': { kind: 'skip', at: /@\s*pytest\s*\.\s*mark\s*\.\s*skip/ },
  'pytest.skip(': { kind: 'skip', at: /\bpytest\s*\.\s*skip\s*\(/ },
  't.Skip(': { kind: 'skip', at: /\bt\s*\.\s*Skip\s*\(/ },
  '[Ignore]': { kind: 'skip', at: /\[\s*Ignore\s*[\](]/ },
  'Skip =': { kind: 'skip', at: /[(,]\s*Skip\s*=\s*["@]/ },
};

const DEFAULT_EVIDENCE = 'auto';
const DEFAULT_SPEC_SUFFIX = '.test';
const DEFAULT_PARKED = 'planned, disabled';
const DEFAULT_MARKERS = Object.keys(MARKERS).join(', ');

/**
 * Where a case begins, under the conventions a named pairing can point at.
 *
 * Used only to find the far end of one case: the search for a skip marker under a
 * named pairing stops at the next case, so a case switched off three cases down
 * is never held against this promise. The variants are allowed here on purpose —
 * the next case being `test.skip(...)` still ends this one.
 */
const CASE_BOUNDARY = /(?:^|[^\w.$])[xf]?(?:test|it|describe)\b(?:\.\w+)*\s*\(\s*[`'"]|^\s*def\s+test_|^\s*func\s+Test|^\s*Scenario:/;

/** A decorator or an attribute — the lines a case carries stacked above its own. */
const DECORATOR = /^\s*[@[]/;

/** A decorator, an attribute, or a blank line — what sits between two cases and belongs to neither. */
const BETWEEN_CASES = /^\s*(?:[@[]|$)/;

/**
 * Where a case with this exact name begins, one matcher per language convention —
 * the same closed set has-evidence accepts a named pairing at, widened to the
 * switched-off spellings so the case can still be found once somebody turns it off.
 */
const CASE_BY_NAME = [
  (name) => new RegExp(`\\b[xf]?(?:test|it)\\b(?:\\.\\w+)*\\s*\\(\\s*[\`'"]${escapeRegExp(name)}[\`'"]`),
  (name) => new RegExp(`Scenario:[ \\t]*${escapeRegExp(name)}[ \\t]*$`),
  (name) => new RegExp(`\\bdef\\s+test_${escapeRegExp(toIdentifier(name))}\\s*\\(`),
  (name) => new RegExp(`\\bfunc\\s+Test${escapeRegExp(toPascal(name))}\\s*\\(`),
];

export function check(ctx) {
  const files = ctx.files;
  // Nothing mapped is not a finding. A repository that has written no promises yet
  // must not be told off for the ones it has not written.
  if (files.length === 0) return [];

  const setting = String(ctx.config?.evidence ?? DEFAULT_EVIDENCE).trim();
  // A pairing nobody has heard of is has-evidence's refusal to make, and saying it
  // twice helps nobody.
  if (!EVIDENCE_SETTINGS.includes(setting)) return [];

  const suffix = String(ctx.config?.spec_suffix ?? DEFAULT_SPEC_SUFFIX);
  const parked = new Set(splitList(ctx.config?.parked_markers ?? DEFAULT_PARKED));
  const markers = markersOf(ctx.config?.markers);

  const promises = [];
  const others = [];
  for (const file of files) {
    const front = readFrontmatter(file.content);
    if (front === null) others.push(file);
    else promises.push({ file, front, adapter: setting === 'auto' ? adapterOf(front) : setting });
  }

  const out = [];
  for (const promise of promises) {
    if (parked.has(promise.front.fields.status)) continue;
    const paired = pairedWith(promise, files, others, suffix);
    if (paired === null) continue; // nothing to read here; has-evidence is the rule that says so
    const lines = paired.file.content.split('\n');
    const id = promise.front.fields.id ?? stemOf(promise.file.path);

    // Exclusivity is a fact about the whole file, whichever case the promise is
    // paired with: one case named as the only one to run leaves every other case
    // in that file unrun, this promise's own included.
    const only = firstMarker(lines, 0, lines.length, markers, 'exclusive');
    if (only !== null) {
      out.push({
        file: paired.file.path,
        line: only.line,
        message: `'${only.token}' here makes one case the only one that runs, so the rest of what keeps the promise '${id}' is switched off with it. A run that goes green over a handpicked case says nothing about the promise — take the marker out before this lands.`,
      });
      continue;
    }

    // A skip marker turns off the case it sits on. Under a named pairing the
    // promise points at one case and a file may hold several, so only that case's
    // own lines count; under the others the whole file is the pairing.
    const window = paired.name === undefined ? { from: 0, to: lines.length } : caseBlock(lines, paired.name);
    if (window === null) continue; // the named case is not in that file; has-evidence says so
    const off = firstMarker(lines, window.from, window.to, markers, 'skip');
    if (off !== null) {
      out.push({
        file: paired.file.path,
        line: off.line,
        message: `'${off.token}' here switches off what keeps the promise '${id}'. A promise nothing runs is a promise nobody is checking, and the suite still goes green — take the marker out, or set the promise's status to one that says nothing runs it yet.`,
      });
    }
  }

  return out;
}

/** Which pairing a promise is using, read off what its own frontmatter carries. */
function adapterOf(front) {
  if (front.blocks.artefact !== undefined) return 'artefact';
  if (front.fields.evidence === 'self') return 'self';
  if (front.fields.evidence !== undefined) return 'named';
  return 'mirror';
}

/**
 * The file that keeps this promise and, under a named pairing, the case inside it —
 * or null when there is nothing here to read.
 *
 * Null covers every shape has-evidence already refuses (no mirror, two mirrors, a
 * malformed or absent named target) plus the one it accepts and this rule has
 * nothing to say about: an accepted artefact is a signature on a file, not
 * something that runs.
 */
function pairedWith(promise, files, others, suffix) {
  if (promise.adapter === 'artefact') return null;
  if (promise.adapter === 'self') return { file: promise.file };
  if (promise.adapter === 'mirror') {
    const want = normalize(stemOf(promise.file.path) + suffix);
    const found = others.filter((f) => normalize(stemOf(f.path)) === want);
    return found.length === 1 ? { file: found[0] } : null;
  }
  const raw = promise.front.fields.evidence ?? '';
  const hash = raw.indexOf('#');
  if (hash <= 0 || hash === raw.length - 1) return null;
  const target = normalize(raw.slice(0, hash).trim());
  const name = raw.slice(hash + 1).trim();
  const file = files.find((f) => normalize(f.path) === target || normalize(f.path).endsWith(`/${target}`));
  return file === undefined ? null : { file, name };
}

/**
 * The lines one named case occupies: the line its own name is on, the decorators
 * and attributes stacked directly above it, and everything up to the next case —
 * minus whatever is stacked above THAT one, which belongs to the next case and not
 * to this one.
 */
function caseBlock(lines, name) {
  const matchers = CASE_BY_NAME.map((build) => build(name));
  let start = -1;
  for (let i = 0; i < lines.length && start === -1; i++) {
    if (matchers.some((re) => re.test(lines[i]))) start = i;
  }
  if (start === -1) return null;

  let from = start;
  while (from > 0 && DECORATOR.test(lines[from - 1])) from--;

  let to = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (CASE_BOUNDARY.test(lines[i])) {
      to = i;
      break;
    }
  }
  while (to - 1 > start && BETWEEN_CASES.test(lines[to - 1])) to--;

  return { from, to };
}

/** The first marker of this kind between two lines, with the line it sits on. */
function firstMarker(lines, from, to, markers, kind) {
  for (let i = from; i < to; i++) {
    for (const token of markers) {
      if (MARKERS[token].kind !== kind) continue;
      if (MARKERS[token].at.test(lines[i])) return { token, line: i + 1 };
    }
  }
  return null;
}

/**
 * The markers this run looks for: the configured list, narrowed to the closed set
 * this rule knows how to find — a repository may turn some off, never invent a new
 * one — and falling back to the full closed list when narrowing it would leave
 * nothing to look for at all.
 */
function markersOf(raw) {
  const configured = splitList(raw ?? DEFAULT_MARKERS).filter((m) => MARKERS[m] !== undefined);
  return configured.length > 0 ? configured : splitList(DEFAULT_MARKERS);
}

function splitList(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A name as a `snake_case` identifier — the shape a Python `def test_<name>` carries. */
function toIdentifier(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** A name as a `PascalCase` identifier — the shape a Go `func Test<Name>` carries. */
function toPascal(name) {
  return String(name)
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
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
 * rule is the one that says so.
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
  let openBlock = null;

  for (let i = 1; i < end; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    if (/^\s+\S/.test(raw) && openBlock !== null) {
      const idx = raw.indexOf(':');
      if (idx !== -1) blocks[openBlock][raw.slice(0, idx).trim()] = unquote(raw.slice(idx + 1).trim());
      continue;
    }
    if (/^\s/.test(raw)) continue;

    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    const key = raw.slice(0, idx).trim();
    const value = unquote(raw.slice(idx + 1).trim());
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

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  return value;
}
