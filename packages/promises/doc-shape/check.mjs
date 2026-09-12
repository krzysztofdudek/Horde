// One promise, one file, one shape.
//
// Five things are asked, and each one is asked separately so a refusal names the
// thing that is actually wrong rather than "this file is malformed":
//
//   1. the frontmatter is there and parses
//   2. `id` is the filename with its extension taken off
//   3. `status` is one of planned / implemented / disabled
//   4. every section this repository asks for is present
//   5. no section it did not ask for is present
//
// The rule never says where promises live or what they are called. `ctx.files` is
// whatever the repository mapped these rules onto, and that mapping is the whole
// of the repository's say in the matter.
//
// Settings are read through `ctx.config?.` rather than `ctx.config.`: `yg drill`
// runs a check over case files with no graph and therefore no settings, and a
// rule that dereferenced the object would be unrunnable against its own corpus.
// The optional read still names the key in the source, which is what the
// pre-publish check reads to confirm every setting is declared.

const DEFAULT_SECTIONS = 'What it checks, Why it matters, How to see it';

/** The three things a promise can be. Nothing else is a status. */
export const STATUSES = ['planned', 'implemented', 'disabled'];

export function check(ctx) {
  const required = splitList(ctx.config?.sections ?? DEFAULT_SECTIONS);
  const out = [];

  for (const file of ctx.files) {
    const front = readFrontmatter(file.content);

    if (front.kind === 'absent') {
      out.push({
        file: file.path,
        line: 1,
        message:
          'This promise has no frontmatter. A promise opens with a --- block carrying its id and its status; without one there is nothing saying which promise this is or whether anything keeps it yet.',
      });
      continue;
    }

    if (front.kind === 'malformed') {
      out.push({
        file: file.path,
        line: front.line,
        message: `The frontmatter of this promise could not be read at line ${front.line}: ${front.why} Every line between the --- markers is 'key: value'.`,
      });
      continue;
    }

    const expectedId = stemOf(file.path);
    const declaredId = front.fields.id;
    if (declaredId === undefined) {
      out.push({
        file: file.path,
        line: front.startLine,
        message: `This promise declares no id. It must declare 'id: ${expectedId}' — the filename is the promise's name, and the frontmatter is where a reader finds it without opening the directory.`,
      });
    } else if (normalize(declaredId) !== normalize(expectedId)) {
      out.push({
        file: file.path,
        line: front.lineOf.id ?? front.startLine,
        message: `This promise calls itself '${declaredId}' and is filed as '${expectedId}'. Everything that pairs a promise with the thing that keeps it addresses it by one name, so the two cannot differ.`,
      });
    }

    const status = front.fields.status;
    if (status === undefined) {
      out.push({
        file: file.path,
        line: front.startLine,
        message: `This promise declares no status. It must declare one of ${STATUSES.join(', ')} — whether anything runs this yet is the first thing a reader needs and the last thing to leave implicit.`,
      });
    } else if (!STATUSES.includes(status)) {
      out.push({
        file: file.path,
        line: front.lineOf.status ?? front.startLine,
        message: `This promise's status is '${status}', which is not one of ${STATUSES.join(', ')}. A status outside the three is a state nothing downstream knows how to treat.`,
      });
    }

    const headings = sectionHeadings(file.content, front.bodyLine);
    const present = headings.map((h) => h.title);
    for (const want of required) {
      if (present.some((p) => sameHeading(p, want))) continue;
      out.push({
        file: file.path,
        line: front.bodyLine,
        message: `This promise has no '## ${want}' section. This repository asks every promise for ${required.map((s) => `'${s}'`).join(', ')}, so a reader knows where to look without reading the whole file.`,
      });
    }
    for (const heading of headings) {
      if (required.some((want) => sameHeading(heading.title, want))) continue;
      out.push({
        file: file.path,
        line: heading.line,
        message: `This promise carries a '## ${heading.title}' section, which this repository did not ask for. The sections are ${required.map((s) => `'${s}'`).join(', ')}; an extra one is a promise quietly growing a second shape.`,
      });
    }
  }

  return out;
}

/** A comma-separated setting as a list of trimmed, non-empty entries. */
function splitList(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * The filename with its extension taken off, composed.
 *
 * macOS hands back a decomposed filename while the frontmatter carries whatever
 * the author typed, so a promise called `zamówienie` would otherwise differ from
 * itself. Composing both sides before comparing is what makes a non-ASCII name
 * resolve the same way a plain one does.
 */
function stemOf(filePath) {
  const base = filePath.split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function normalize(value) {
  return String(value).normalize('NFC');
}

/** Headings compare on their visible words, not on their spacing or case. */
function sameHeading(a, b) {
  return normalize(a).trim().toLowerCase() === normalize(b).trim().toLowerCase();
}

/** Every `## ` heading in the body, with the line it sits on. */
function sectionHeadings(content, bodyLine) {
  const lines = content.split('\n');
  const out = [];
  let fenced = false;
  for (let i = bodyLine - 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^##\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ title: m[1], line: i + 1 });
  }
  return out;
}

/**
 * The frontmatter block, read as the flat `key: value` document it is.
 *
 * Deliberately not a YAML parser: a promise's frontmatter is a handful of scalar
 * keys, and the one place this rule has to be precise — saying WHICH LINE a
 * reader should look at when the block does not read — is exactly what a general
 * parser makes hardest to report. A line that is not a key, not a comment, not a
 * nested entry and not blank is named by number and the run carries on to the
 * next file.
 */
function readFrontmatter(content) {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return { kind: 'absent' };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return {
      kind: 'malformed',
      line: 1,
      why: 'the block is opened with --- and never closed.',
    };
  }

  const fields = Object.create(null);
  const lineOf = Object.create(null);
  for (let i = 1; i < end; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    // A nested entry belongs to the key above it; this rule reads scalars only
    // and leaves the nesting to whoever declared it.
    if (/^\s/.test(raw) || line.startsWith('- ')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      return {
        kind: 'malformed',
        line: i + 1,
        why: `'${line}' is not 'key: value'.`,
      };
    }
    const key = line.slice(0, idx).trim();
    if (key === '') {
      return { kind: 'malformed', line: i + 1, why: 'the key before the colon is empty.' };
    }
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      return { kind: 'malformed', line: i + 1, why: `'${key}' is given twice.` };
    }
    fields[key] = unquote(line.slice(idx + 1).trim());
    lineOf[key] = i + 1;
  }

  return { kind: 'ok', fields, lineOf, startLine: 1, bodyLine: Math.min(end + 2, lines.length) };
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
