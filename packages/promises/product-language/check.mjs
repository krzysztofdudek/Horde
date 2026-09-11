// A promise is written in the product's words, not the code's.
//
// The whole judgement is the table below and nothing else. That is deliberate:
// this list is the vocabulary other tools read to learn what "sounds like code"
// means here, so it has to be one thing a person can read top to bottom, not a
// shape recovered by tracing regular expressions through a function body. Adding
// a category means adding a row; nothing else in this file changes.
//
// Order in the table is precedence. The first category to claim a span owns it,
// so a contextual category ("the order_items table") reports as a table name
// rather than as the snake_case identifier it also is, and a reader gets told the
// thing that is actually wrong.

/**
 * Every kind of code-shaped writing this rule refuses.
 *
 * `id`     — the category's name; it is what a refusal is keyed on and what
 *            another tool addresses when it borrows this vocabulary.
 * `label`  — how the category is named to a reader.
 * `why`    — what to write instead, in one clause.
 * `find`   — a global regular expression. Capture group 1, when there is one, is
 *            the offending span; otherwise the whole match is.
 */
export const CATEGORIES = [
  {
    id: 'table-name',
    label: 'a table name',
    why: 'a promise says what the product remembers, not where it is stored',
    find: /\b(?:table|tables)\s+(?:called\s+|named\s+)?([A-Za-z_][A-Za-z0-9_]*)\b|\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:table|tables)\b/g,
  },
  {
    id: 'field-name',
    label: 'a field name',
    why: 'a promise names what the customer sees, not the column it sits in',
    find: /\b(?:field|column|fields|columns)\s+(?:called\s+|named\s+)?([A-Za-z_][A-Za-z0-9_]*)\b|\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:field|column|fields|columns)\b/g,
  },
  {
    id: 'http-status-code',
    label: 'an HTTP status code',
    why: 'a promise says what the person gets, not the number the wire carried',
    find: /\b(?:200|201|202|204|301|302|304|400|401|403|404|405|409|410|418|422|429|500|501|502|503|504)\b/g,
  },
  {
    id: 'http-verb',
    label: 'an HTTP verb',
    why: 'a promise says what somebody does, not how the request was shaped',
    find: /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
  },
  {
    id: 'css-selector',
    label: 'a selector',
    why: 'a promise names the thing on the screen, not the handle a script grabs it by',
    find: /(?:^|[\s(`"'])([.#][A-Za-z][A-Za-z0-9_-]*)\b|(\[data-[A-Za-z0-9_-]+(?:=[^\]]*)?\])/g,
  },
  {
    id: 'file-path',
    label: 'a file path',
    why: 'a promise is true wherever the code lives; naming a file ties it to today\'s layout',
    find: /\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|sql|ya?ml|json|html?|css|scss|sh|mjs)\b/g,
  },
  {
    id: 'url-path',
    label: 'an address',
    why: 'a promise describes what the product does, not the route it is reached through',
    find: /(?:^|[\s(`"'])(\/[A-Za-z0-9_][A-Za-z0-9_./{}-]*)/g,
  },
  {
    id: 'camel-case-identifier',
    label: 'a code identifier',
    why: 'a promise uses the words the product uses with its customers',
    find: /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g,
  },
  {
    id: 'snake-case-identifier',
    label: 'a code identifier',
    why: 'a promise uses the words the product uses with its customers',
    find: /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g,
  },
  {
    id: 'pascal-case-identifier',
    label: 'a code identifier',
    why: 'a promise uses the words the product uses with its customers',
    find: /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g,
  },
];

/**
 * Words that follow "table" or "field" and name neither.
 *
 * Without these, "the whole table" reads as a table called `whole`. They are
 * grammar, not vocabulary, so they sit here rather than in the repository's
 * `vocabulary` setting — a consumer should never have to allow the word "the".
 */
const GRAMMAR = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'any', 'no', 'one',
  'same', 'whole', 'first', 'second', 'last', 'next', 'other', 'another', 'above', 'below',
  'following', 'right', 'wrong', 'empty', 'full', 'new', 'old', 'its', 'their', 'his', 'her',
  'and', 'or', 'of', 'in', 'on', 'to', 'from', 'per', 'by', 'is', 'are', 'was', 'were', 'be',
]);

export function check(ctx) {
  const allowed = new Set(splitList(ctx.config?.vocabulary ?? ''));
  const out = [];

  for (const file of ctx.files) {
    const parts = readableParts(file.content);
    // A file with no frontmatter is not yet a promise; saying so is the shape
    // rule's job, and repeating it here would refuse the same file twice.
    if (parts === null) continue;

    for (const part of parts) {
      for (const hit of findAll(part.text, allowed)) {
        out.push({
          file: file.path,
          line: part.line + hit.line - 1,
          message: `The ${part.where} of this promise contains '${hit.text}' — ${hit.label}. Write it out in the product's words: ${hit.why}.`,
        });
      }
    }
  }

  return out;
}

/**
 * Every refusal in one piece of text, with the earliest category that claims each
 * span winning it.
 *
 * Spans are tracked rather than positions compared after the fact, because two
 * categories legitimately overlap — a table name IS a snake_case identifier — and
 * reporting both would tell a reader to fix one thing twice.
 */
function findAll(text, allowed) {
  const taken = [];
  const hits = [];

  for (const category of CATEGORIES) {
    const re = new RegExp(category.find.source, category.find.flags);
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const groupIndex = m.slice(1).findIndex((g) => g !== undefined);
      const matched = groupIndex === -1 ? m[0] : m[groupIndex + 1];
      if (matched === undefined) continue;
      // Sentence punctuation is not part of what was written — an address at the
      // end of a sentence must be reported as the address, not the address and a
      // full stop.
      const value = matched.replace(/[.,;:!?]+$/, '');
      if (value === '') continue;
      const start = m.index + m[0].indexOf(matched);
      const end = start + value.length;
      if (allowed.has(value)) continue;
      if (GRAMMAR.has(value.toLowerCase())) continue;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      hits.push({
        text: value,
        label: category.label,
        why: category.why,
        line: text.slice(0, start).split('\n').length,
      });
      // A zero-width match would spin forever; step past it.
      if (m[0] === '') re.lastIndex += 1;
    }
  }

  return hits.sort((a, b) => a.line - b.line);
}

/**
 * The parts of a promise a reader actually reads: its title and its prose.
 *
 * The rest of the frontmatter is deliberately out of reach. It is where a promise
 * legitimately carries an id and, under some pairings, the path of the thing that
 * keeps it — refusing those would be refusing the promise for saying what the
 * other rules require it to say. Returns null when there is no frontmatter at all.
 */
function readableParts(content) {
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

  const parts = [];
  for (let i = 1; i < end; i++) {
    const m = /^title:\s*(.*\S)\s*$/.exec(lines[i] ?? '');
    if (m) parts.push({ where: 'title', line: i + 1, text: unquote(m[1]) });
  }
  for (let i = end + 1; i < lines.length; i++) {
    const m = /^#\s+(.*\S)\s*$/.exec(lines[i] ?? '');
    if (m) parts.push({ where: 'title', line: i + 1, text: m[1] });
  }

  const bodyStart = end + 1;
  const body = lines
    .slice(bodyStart)
    .map((line) => (/^#\s+/.test(line) ? '' : line))
    .join('\n');
  parts.push({ where: 'body', line: bodyStart + 1, text: body });

  return parts;
}

function splitList(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
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
