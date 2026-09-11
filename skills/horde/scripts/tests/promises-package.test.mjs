// The `promises` package Horde publishes — measured the way a repository that installs it would.
//
// Two layers, and both are here because the package is Yggdrasil's code living in Horde's
// repository. `yg drill` runs each deterministic rule against its own case corpus through the real
// CLI; everything below that builds a real repository, installs the package into it with the real
// `yg pack add`, and reads what the real `yg check` says. Nothing here stands in for Yggdrasil.
//
// One thing the corpus cannot do, and it shapes the split: `yg drill` runs a check over ONE case
// file at a time (core/drill-runner.ts, discoverDrillCases — `files: [relToRoot]`) with no graph
// and therefore no settings, and it skips every `.md` file in a corpus. So a rule about the pairing
// BETWEEN two files, or one that only bites under a particular setting, has no drill case that
// could express it, and is measured here against a real repository instead. The coverage test at
// the bottom holds that split to an exact accounting rather than letting it drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addNode, makeRepo, rmRepo, requireYg, yg, ygInit } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HORDE_ROOT = resolve(HERE, '..', '..', '..', '..');
const PACKAGE_DIR = join(HORDE_ROOT, 'packages', 'promises');
const OWNER = 'krzysztofdudek/Horde';
const INSTALLED = `packages/${OWNER}/promises`;

const DETERMINISTIC = ['doc-shape', 'product-language', 'has-evidence'];
const ALL_ASPECTS = [...DETERMINISTIC, 'evidence-matches-promise'];

// ── the accounting between the corpus and the refusals below ─────────────────
//
// One row per way this package refuses something. `drill` names the case in the rule's own corpus
// that proves it, or null with a `why` when drill v1 cannot express the case at all. `test` is the
// exact title of the test below that proves it here. The last test in this file reads both sides
// off disk and off this file, and reports the difference.

const REFUSALS = [
  { id: 'no frontmatter', drill: 'doc-shape/violates-no-frontmatter', test: 'a promise with no frontmatter is refused' },
  { id: 'unreadable frontmatter', drill: 'doc-shape/violates-unreadable-frontmatter', test: 'frontmatter that does not read names the file and the line, and the rest of the run survives' },
  { id: 'no id', drill: 'doc-shape/violates-no-id', test: 'a promise that declares no id is refused' },
  { id: 'id mismatch', drill: 'doc-shape/violates-id-mismatch', test: 'an id that is not the filename is refused' },
  { id: 'unknown status', drill: 'doc-shape/violates-unknown-status', test: 'a status outside the three is refused' },
  { id: 'missing section', drill: 'doc-shape/violates-missing-section', test: 'a promise missing a section this repository asks for is refused' },
  { id: 'unknown section', drill: 'doc-shape/violates-unknown-section', test: 'a promise carrying a section nobody asked for is refused' },

  { id: 'camelCase identifier', drill: 'product-language/violates-camel-case-identifier', test: 'a code identifier in the body is refused' },
  { id: 'snake_case identifier', drill: 'product-language/violates-snake-case-identifier', test: 'a snake_case identifier in the body is refused' },
  { id: 'PascalCase identifier', drill: 'product-language/violates-pascal-case-identifier', test: 'a code identifier in the title is refused' },
  { id: 'file path', drill: 'product-language/violates-file-path', test: 'a file path in the body is refused' },
  { id: 'address', drill: 'product-language/violates-url-path', test: 'an address in the body is refused' },
  { id: 'HTTP verb', drill: 'product-language/violates-http-verb', test: 'an HTTP verb in the body is refused' },
  { id: 'HTTP status code', drill: 'product-language/violates-http-status-code', test: 'an HTTP status code in the body is refused' },
  { id: 'selector', drill: 'product-language/violates-css-selector', test: 'a selector in the body is refused' },
  { id: 'table name', drill: 'product-language/violates-table-name', test: 'a table name in the body is refused' },
  { id: 'field name', drill: 'product-language/violates-field-name', test: 'a field name in the body is refused' },

  { id: 'no mirror', drill: 'has-evidence/violates-mirror-missing', test: 'an implemented promise with no mirror in the suite is refused' },
  { id: 'malformed named reference', drill: 'has-evidence/violates-named-malformed', test: 'a named pairing that is not file-and-name is refused' },
  { id: 'named target absent', drill: 'has-evidence/violates-named-target-absent', test: 'a promise whose named evidence is not there is refused' },
  { id: 'self with no status', drill: 'has-evidence/violates-self-no-status', test: 'a promise that is its own evidence and says no status is refused' },
  { id: 'artefact missing a field', drill: 'has-evidence/violates-artefact-missing-field', test: 'an artefact with no hash recorded is refused' },
  { id: 'artefact hash is not one', drill: 'has-evidence/violates-artefact-bad-sha', test: 'an artefact whose hash is not a hash is refused' },

  {
    id: 'no suite at all',
    drill: null,
    why: 'the absence of an entire suite is a fact about the repository around the promise, and a drill case is one file with nothing around it',
    test: 'an implemented promise in a repository with no suite at all is refused',
  },
  {
    id: 'two things keep one promise',
    drill: null,
    why: 'it takes three files — a promise and two mirrors — and a drill case is one file',
    test: 'two files claiming to keep one promise are refused',
  },
  {
    id: 'two promises kept by one thing',
    drill: null,
    why: 'it takes three files — two promises and one mirror — and a drill case is one file',
    test: 'two promises kept by the same thing are refused',
  },
  {
    id: 'a test that keeps no promise',
    drill: null,
    why: 'the other direction needs a second file to be missing, which one case file cannot express',
    test: 'a mirror with no promise behind it is refused',
  },
  {
    id: 'unknown pairing',
    drill: null,
    why: 'it bites only when the setting is changed, and a drill runs a check with no settings at all',
    test: 'an unknown way of pairing is refused, naming the four that exist',
  },
];

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * A real repository with the real package installed, promises and a suite written, and the rules
 * attached to one component that maps both.
 *
 * One component for both directories is the layout the package is written for: the pairing rule
 * has to see a promise and the thing that keeps it in the same subject set, and the other two carry
 * a `**` + `*.md` scope of their own so a test file is never read as a malformed promise.
 */
function promisesRepo({ promises = {}, suite = {}, aspects = DETERMINISTIC, config = {} } = {}) {
  const dir = makeRepo();
  ygInit(dir);
  const added = yg(dir, ['pack', 'add', `${HORDE_ROOT}#promises`, '--as', OWNER]);
  assert.equal(added.code, 0, `yg pack add failed:\n${added.out}`);

  write(dir, promises, 'promises');
  write(dir, suite, 'suite');
  addNode(dir, 'evidence', {
    mapping: ['promises/**', 'suite/**'],
    aspects: aspects.map((a) => `${INSTALLED}/${a}`),
  });
  for (const [aspect, settings] of Object.entries(config)) adapt(dir, aspect, settings);
  return dir;
}

function write(dir, files, under) {
  mkdirSync(join(dir, under), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, under, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** The consumer's own settings for one installed rule, written where a consumer writes them. */
function adapt(dir, aspect, settings) {
  const lines = ['config:'];
  for (const [key, value] of Object.entries(settings)) {
    lines.push(`  ${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`);
  }
  writeFileSync(
    join(dir, '.yggdrasil', 'aspects', 'packages', OWNER, 'promises', aspect, 'yg-aspect.adapt.yaml'),
    `${lines.join('\n')}\n`,
  );
}

/** What `yg check --approve` says about this repository. */
function checked(dir) {
  return yg(dir, ['check', '--approve']);
}

/** A well-formed promise, with whatever the caller wants changed about it. */
function promise({ id = 'orders-are-confirmed', status = 'implemented', extra = [], title = 'An order the customer placed comes back confirmed', checks = 'A customer who places an order is told, on the spot, that it is confirmed.' } = {}) {
  return [
    '---',
    `id: ${id}`,
    `status: ${status}`,
    ...extra,
    '---',
    '',
    `# ${title}`,
    '',
    '## What it checks',
    checks,
    '',
    '## Why it matters',
    'An order that vanishes without a word is the one complaint support cannot answer.',
    '',
    '## How to see it',
    'Place an order and watch for the confirmation.',
    '',
  ].join('\n');
}

const MIRROR = "export function run() { if (placeOrder().state !== 'confirmed') throw new Error('not confirmed'); }\n";

// ── publishing, installing, and the package's own boundary ───────────────────

test('the Horde repository is fit to publish what it publishes', () => {
  const parts = requireYg().split(/\s+/);
  const r = execFileSync(parts[0], [...parts.slice(1), 'marketplace', 'check'], {
    cwd: HORDE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(r, /Ready to publish/);
});

test('installing the package copies four rules under the publisher and records what they hashed to', () => {
  const dir = promisesRepo();
  try {
    const base = join(dir, '.yggdrasil', 'aspects', 'packages', OWNER, 'promises');
    for (const aspect of ALL_ASPECTS) {
      assert.ok(existsSync(join(base, aspect, 'yg-aspect.yaml')), `${aspect} was not copied`);
    }
    const lock = readFileSync(join(dir, '.yggdrasil', 'yg-packages.yaml'), 'utf8');
    assert.match(lock, /"promises":/);
    assert.match(lock, new RegExp(`packages/${OWNER}/promises/doc-shape/check\\.mjs`));
  } finally {
    rmRepo(dir);
  }
});

test('no rule in the package reaches outside the package', () => {
  for (const aspect of ALL_ASPECTS) {
    const yaml = readFileSync(join(PACKAGE_DIR, aspect, 'yg-aspect.yaml'), 'utf8');
    const implied = [...yaml.matchAll(/^\s*-\s*(\S+)\s*$/gm)]
      .map((m) => m[1])
      .filter(() => /^implies:/m.test(yaml));
    for (const target of implied) {
      assert.ok(
        ALL_ASPECTS.includes(target),
        `${aspect} implies '${target}', which is not a rule of this package`,
      );
    }
  }
});

// ── layer one: the package's rules against their own corpus, through yg drill ─

for (const aspect of DETERMINISTIC) {
  test(`yg drill on ${aspect} raises no false alarm and misses nothing`, () => {
    const dir = promisesRepo();
    try {
      const r = yg(dir, ['drill', '--aspect', `${INSTALLED}/${aspect}`]);
      const summary = /(\d+) pass · (\d+) MISS · (\d+) FALSE-ALARM · (\d+) unrun · (\d+) unsupported/.exec(r.out);
      assert.ok(summary, `no drill summary in:\n${r.out}`);
      const [, pass, miss, falseAlarm, unrun, unsupported] = summary.map(Number);
      assert.equal(falseAlarm, 0, `${aspect} refused a case it had to let through:\n${r.out}`);
      assert.equal(miss, 0, `${aspect} let a case through it had to refuse:\n${r.out}`);
      assert.equal(unrun, 0, `${aspect} could not be evaluated over some case:\n${r.out}`);
      assert.equal(unsupported, 0, `${aspect} reached for something a drill cannot supply:\n${r.out}`);
      assert.ok(pass > 0, `${aspect} ran no cases at all:\n${r.out}`);
      assert.equal(r.code, 0, r.out);
    } finally {
      rmRepo(dir);
    }
  });
}

// ── the path where everything is right ───────────────────────────────────────

test('a promise with its mirror beside it passes every rule of the package', () => {
  const dir = promisesRepo({
    promises: { 'orders-are-confirmed.md': promise() },
    suite: { 'orders-are-confirmed.test.mjs': MIRROR },
  });
  try {
    const r = checked(dir);
    assert.equal(r.code, 0, `expected a clean repository, got:\n${r.out}`);
    assert.match(r.out, /PASS/);
  } finally {
    rmRepo(dir);
  }
});

// ── each refusal, on its own, naming its own case ────────────────────────────

/** Build a repository, approve it, and hand back what the run said. */
function refusal({ promises, suite = { 'orders-are-confirmed.test.mjs': MIRROR }, config = {} }) {
  const dir = promisesRepo({ promises, suite, config });
  try {
    const r = checked(dir);
    assert.notEqual(r.code, 0, `expected a refusal, got a clean run:\n${r.out}`);
    return r.out;
  } finally {
    rmRepo(dir);
  }
}

test('a promise with no frontmatter is refused', () => {
  const out = refusal({ promises: { 'orders-are-confirmed.md': '# An order comes back confirmed\n' } });
  assert.match(out, /has no frontmatter/);
});

test('a promise that declares no id is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise().replace('id: orders-are-confirmed\n', '') },
  });
  assert.match(out, /declares no id/);
});

test('an id that is not the filename is refused', () => {
  const out = refusal({ promises: { 'orders-are-confirmed.md': promise({ id: 'something-else' }) } });
  assert.match(out, /calls itself 'something-else' and is filed as 'orders-are-confirmed'/);
});

test('a status outside the three is refused', () => {
  const out = refusal({ promises: { 'orders-are-confirmed.md': promise({ status: 'shipped' }) } });
  assert.match(out, /status is 'shipped', which is not one of planned, implemented, disabled/);
});

test('a promise missing a section this repository asks for is refused', () => {
  const text = promise().replace(/## How to see it[\s\S]*$/, '');
  const out = refusal({ promises: { 'orders-are-confirmed.md': text } });
  assert.match(out, /has no '## How to see it' section/);
});

test('a promise carrying a section nobody asked for is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': `${promise()}\n## Notes\nSomething nobody asked for.\n` },
  });
  assert.match(out, /carries a '## Notes' section, which this repository did not ask for/);
});

test('a code identifier in the title is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ title: 'OrderRepository confirms the order' }) },
  });
  assert.match(out, /The title of this promise contains 'OrderRepository' — a code identifier/);
});

test('a code identifier in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told that orderTotal is confirmed.' }) },
  });
  assert.match(out, /The body of this promise contains 'orderTotal' — a code identifier/);
});

test('a snake_case identifier in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told that order_total is confirmed.' }) },
  });
  assert.match(out, /contains 'order_total' — a code identifier/);
});

test('a file path in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told it is confirmed, by src/orders/handler.ts.' }) },
  });
  assert.match(out, /contains 'src\/orders\/handler\.ts' — a file path/);
});

test('an address in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told it is confirmed by a call to /api/orders.' }) },
  });
  assert.match(out, /contains '\/api\/orders' — an address/);
});

test('an HTTP verb in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told it is confirmed once the POST comes back.' }) },
  });
  assert.match(out, /contains 'POST' — an HTTP verb/);
});

test('an HTTP status code in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told it is confirmed and never sees a 404.' }) },
  });
  assert.match(out, /contains '404' — an HTTP status code/);
});

test('a selector in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer sees the confirmation in .order-summary.' }) },
  });
  assert.match(out, /contains '\.order-summary' — a selector/);
});

test('a table name in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The order is written into the orders table.' }) },
  });
  assert.match(out, /contains 'orders' — a table name/);
});

test('a field name in the body is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told so in the delivery_note field.' }) },
  });
  assert.match(out, /contains 'delivery_note' — a field name/);
});

test('an implemented promise with no mirror in the suite is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise() },
    suite: { 'something-else.test.mjs': MIRROR },
  });
  assert.match(out, /Nothing here keeps this promise/);
});

test('an implemented promise in a repository with no suite at all is refused', () => {
  const dir = promisesRepo({ promises: { 'orders-are-confirmed.md': promise() } });
  try {
    const r = checked(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /Nothing here keeps this promise/);
  } finally {
    rmRepo(dir);
  }
});

test('two files claiming to keep one promise are refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise() },
    suite: {
      'orders-are-confirmed.test.mjs': MIRROR,
      'nested/orders-are-confirmed.test.mjs': MIRROR,
    },
  });
  assert.match(out, /2 files claim to keep this promise/);
});

test('two promises kept by the same thing are refused', () => {
  const out = refusal({
    promises: {
      'orders-are-confirmed.md': promise({ extra: ['evidence: suite/shared.mjs#confirmation'] }),
      'orders-are-paid.md': promise({ id: 'orders-are-paid', extra: ['evidence: suite/shared.mjs#confirmation'] }),
    },
    suite: { 'shared.mjs': 'export const confirmation = true;\n' },
  });
  assert.match(out, /2 promises are kept by the same thing/);
});

test('a mirror with no promise behind it is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise() },
    suite: { 'orders-are-confirmed.test.mjs': MIRROR, 'orders-are-paid.test.mjs': MIRROR },
  });
  assert.match(out, /keeps the promise 'orders-are-paid', and there is no such promise here/);
});

test('a named pairing that is not file-and-name is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ extra: ['evidence: the suite somewhere'] }) },
  });
  assert.match(out, /does not name the thing that keeps this promise/);
});

test('a promise whose named evidence is not there is refused', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise({ extra: ['evidence: suite/missing.mjs#confirmation'] }) },
  });
  assert.match(out, /is not among the files these rules were pointed at/);
});

test('a promise that is its own evidence and says no status is refused', () => {
  const text = promise({ extra: ['evidence: self'] }).replace('status: implemented\n', '');
  const out = refusal({ promises: { 'orders-are-confirmed.md': text } });
  assert.match(out, /is its own evidence and says nothing about its status/);
});

test('an artefact with no hash recorded is refused', () => {
  const out = refusal({
    promises: {
      'orders-are-confirmed.md': promise({
        extra: ['artefact:', '  path: docs/palette.pdf', '  accepted_by: Maya Lind', '  at: 2026-08-14'],
      }),
    },
  });
  assert.match(out, /artefact is missing sha256/);
});

test('an artefact whose hash is not a hash is refused', () => {
  const out = refusal({
    promises: {
      'orders-are-confirmed.md': promise({
        extra: ['artefact:', '  path: docs/palette.pdf', '  sha256: not-a-hash', '  accepted_by: Maya Lind', '  at: 2026-08-14'],
      }),
    },
  });
  assert.match(out, /'not-a-hash' is not a sha256/);
});

test('an unknown way of pairing is refused, naming the four that exist', () => {
  const out = refusal({
    promises: { 'orders-are-confirmed.md': promise() },
    config: { 'has-evidence': { evidence: 'whatever' } },
  });
  assert.match(out, /'whatever' is not a way of pairing/);
  for (const adapter of ['mirror', 'named', 'self', 'artefact']) {
    assert.match(out, new RegExp(`\\b${adapter}\\b`), `the refusal does not name '${adapter}'`);
  }
});

// ── the states nobody writes on purpose ──────────────────────────────────────

test('frontmatter that does not read names the file and the line, and the rest of the run survives', () => {
  const dir = promisesRepo({
    promises: {
      'orders-are-confirmed.md': ['---', 'id: orders-are-confirmed', 'status implemented', '---', '', '# A title', ''].join('\n'),
      'orders-are-paid.md': promise({ id: 'orders-are-paid' }),
    },
    suite: { 'orders-are-paid.test.mjs': MIRROR },
  });
  try {
    const r = checked(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /promises\/orders-are-confirmed\.md:3:/, `the file and line were not named:\n${r.out}`);
    assert.match(r.out, /could not be read at line 3/);
    // The run kept going: the second promise was judged rather than lost behind the first.
    assert.doesNotMatch(r.out, /orders-are-paid\.md:\d+:/, `the sound promise was dragged down too:\n${r.out}`);
  } finally {
    rmRepo(dir);
  }
});

test('an empty promises directory refuses nothing', () => {
  const dir = promisesRepo({ promises: { '.keep': '' }, suite: { '.keep': '' } });
  try {
    const r = checked(dir);
    assert.equal(r.code, 0, `an empty promises directory was refused:\n${r.out}`);
  } finally {
    rmRepo(dir);
  }
});

test('a promise named with a space and a non-ASCII letter resolves its id and its mirror', () => {
  const name = 'zamówienie potwierdzone';
  const dir = promisesRepo({
    promises: { [`${name}.md`]: promise({ id: name }) },
    suite: { [`${name}.test.mjs`]: MIRROR },
  });
  try {
    const r = checked(dir);
    assert.equal(r.code, 0, `the promise or its mirror did not resolve:\n${r.out}`);
  } finally {
    rmRepo(dir);
  }
});

test('a symlink out of the promises directory is not followed', () => {
  const dir = promisesRepo({
    promises: { 'orders-are-confirmed.md': promise() },
    suite: { 'orders-are-confirmed.test.mjs': MIRROR },
  });
  try {
    symlinkSync('/etc/passwd', join(dir, 'promises', 'escape.md'));
    const r = checked(dir);
    assert.doesNotMatch(r.out, /root:/, `something outside the repository was read:\n${r.out}`);
    assert.doesNotMatch(r.out, /\/etc\/passwd/, `a path outside the repository reached a verdict:\n${r.out}`);
  } finally {
    rmRepo(dir);
  }
});

test('no vocabulary set means no exceptions, not a crash', () => {
  const dir = promisesRepo({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told by PostgreSQL that it is confirmed.' }) },
    suite: { 'orders-are-confirmed.test.mjs': MIRROR },
  });
  try {
    const r = checked(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /contains 'PostgreSQL' — a code identifier/);
    assert.doesNotMatch(r.out, /threw an exception|TypeError|undefined/);
  } finally {
    rmRepo(dir);
  }
});

test('a word on the vocabulary list is let through', () => {
  const dir = promisesRepo({
    promises: { 'orders-are-confirmed.md': promise({ checks: 'The customer is told by PostgreSQL that it is confirmed.' }) },
    suite: { 'orders-are-confirmed.test.mjs': MIRROR },
    config: { 'product-language': { vocabulary: 'PostgreSQL, OAuth' } },
  });
  try {
    const r = checked(dir);
    assert.equal(r.code, 0, `a word this repository allows was still refused:\n${r.out}`);
  } finally {
    rmRepo(dir);
  }
});

// ── what the reader of the judged rule is handed ─────────────────────────────

test('the companion folds what the evidence imports, and says what it could not reach', async () => {
  const { companion } = await import(join(PACKAGE_DIR, 'evidence-matches-promise', 'companion.mjs'));

  // A repository in memory, with an allowance that stops at the component's own mapping — the same
  // shape ctx.fs enforces, which throws rather than returning false for a path out of reach.
  const repo = {
    'promises/orders-are-confirmed.md': promise(),
    'suite/orders-are-confirmed.test.mjs': "import { expectConfirmed } from './helpers.mjs';\nimport { audit } from '../vendor/audit.mjs';\nexport function run() { expectConfirmed(); audit(); }\n",
    'suite/helpers.mjs': "import { deep } from './deep/one.mjs';\nexport function expectConfirmed() { deep(); }\n",
    'suite/deep/one.mjs': 'export function deep() {}\n',
    'vendor/audit.mjs': 'export function audit() {}\n',
  };
  const reachable = (p) => p.startsWith('promises/') || p.startsWith('suite/');
  const gate = (p) => {
    if (!reachable(p)) throw new Error(`structure-aspect-undeclared-fs-read: ${p}`);
  };
  const ctx = {
    subject: [{ path: 'promises/orders-are-confirmed.md', content: repo['promises/orders-are-confirmed.md'] }],
    config: {},
    fs: {
      exists(p) {
        gate(p);
        if (repo[p] !== undefined) return 'file';
        return Object.keys(repo).some((k) => k.startsWith(`${p}/`)) ? 'dir' : false;
      },
      read(p) {
        gate(p);
        if (repo[p] === undefined) throw new Error('ENOENT');
        return repo[p];
      },
      list(p) {
        if (p !== '.' && p !== '') gate(p);
        const base = p === '.' || p === '' ? '' : `${p.replace(/\/?$/, '/')}`;
        const seen = new Map();
        for (const k of Object.keys(repo)) {
          if (!k.startsWith(base)) continue;
          const rest = k.slice(base.length);
          const name = rest.split('/')[0];
          seen.set(name, { name, kind: rest.includes('/') ? 'dir' : 'file' });
        }
        return [...seen.values()];
      },
    },
  };

  const folded = companion(ctx);
  const paths = folded.map((d) => d.path);
  assert.deepEqual(paths, ['suite/orders-are-confirmed.test.mjs', 'suite/helpers.mjs', 'suite/deep/one.mjs']);
  assert.match(folded[0].label, /Not shown: \.\.\/vendor\/audit\.mjs .*outside what this rule may read/);
  assert.ok(!paths.includes('vendor/audit.mjs'), 'an unreachable module was handed to the reader anyway');
  assert.match(folded[2].label, /2 step\(s\) away/);
});

test('the companion has nothing to pair for a promise nothing runs yet', async () => {
  const { companion } = await import(join(PACKAGE_DIR, 'evidence-matches-promise', 'companion.mjs'));
  const ctx = {
    subject: [{ path: 'promises/orders-are-confirmed.md', content: promise({ status: 'planned' }) }],
    config: {},
    fs: { exists: () => false, read: () => { throw new Error('nothing to read'); }, list: () => [] },
  };
  assert.deepEqual(companion(ctx), []);
});

test('the companion refuses to guess when a promise says it is kept and nothing keeps it', async () => {
  const { companion } = await import(join(PACKAGE_DIR, 'evidence-matches-promise', 'companion.mjs'));
  const ctx = {
    subject: [{ path: 'promises/orders-are-confirmed.md', content: promise() }],
    config: {},
    fs: { exists: () => false, read: () => { throw new Error('nothing to read'); }, list: () => [] },
  };
  assert.throws(() => companion(ctx), /Nothing keeps promise 'orders-are-confirmed'/);
});

test('the fold a reader is handed stays inside the limit a reviewer will accept', async () => {
  const { companion } = await import(join(PACKAGE_DIR, 'evidence-matches-promise', 'companion.mjs'));
  const manifest = readFileSync(join(PACKAGE_DIR, 'yg-package.yaml'), 'utf8');
  const budget = Number(/max_bytes:\s*\n\s*type: number\s*\n\s*default:\s*(\d+)/.exec(manifest)?.[1]);
  const ruleText = readFileSync(join(PACKAGE_DIR, 'evidence-matches-promise', 'content.md'), 'utf8').length;
  // A reviewer tier that names no limit of its own is gated at 50,000 characters
  // (Yggdrasil, llm/prompt.ts — DEFAULT_MAX_PROMPT_CHARS). The rule's own text and the promise
  // ride along with the fold, so the budget has to leave room for both and for the framing.
  assert.ok(Number.isFinite(budget), `no max_bytes default in the manifest:\n${manifest}`);
  assert.ok(budget + ruleText + 4000 < 50000, `a full fold of ${budget} bytes would not fit a default reviewer prompt`);

  // And the fold actually stops there rather than running on.
  const big = 'x'.repeat(budget);
  const repo = {
    'suite/orders-are-confirmed.test.mjs': "import { a } from './a.mjs';\nexport function run() { a(); }\n",
    'suite/a.mjs': `export const pad = '${big}';\n`,
  };
  const ctx = {
    subject: [{
      path: 'promises/orders-are-confirmed.md',
      content: promise({ extra: ['evidence: suite/orders-are-confirmed.test.mjs#run'] }),
    }],
    config: {},
    fs: {
      exists: (p) => (repo[p] !== undefined ? 'file' : false),
      read: (p) => { if (repo[p] === undefined) throw new Error('ENOENT'); return repo[p]; },
      list: () => [],
    },
  };
  const folded = companion(ctx);
  assert.deepEqual(folded.map((d) => d.path), ['suite/orders-are-confirmed.test.mjs']);
  assert.match(folded[0].label, new RegExp(`reached its ${budget}-byte limit`));
});

// ── the corpus and the refusals, counted against each other ──────────────────

test('every case in every corpus answers to a refusal here, and every refusal to a case or a reason', () => {
  const onDisk = [];
  for (const aspect of DETERMINISTIC) {
    const drills = join(PACKAGE_DIR, aspect, 'drills');
    for (const entry of readdirSync(drills, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('violates-')) continue;
      onDisk.push(`${aspect}/${entry.name}`);
    }
  }

  const claimed = REFUSALS.map((r) => r.drill).filter((d) => d !== null);
  const orphanCases = onDisk.filter((c) => !claimed.includes(c)).sort();
  const missingCases = claimed.filter((c) => !onDisk.includes(c)).sort();
  assert.deepEqual(orphanCases, [], 'corpus cases nothing here asserts on');
  assert.deepEqual(missingCases, [], 'refusals naming a corpus case that is not on disk');
  assert.equal(new Set(claimed).size, claimed.length, 'two refusals claim the same corpus case');

  const source = readFileSync(join(HERE, 'promises-package.test.mjs'), 'utf8');
  const titles = new Set([...source.matchAll(/^test\('([^']+)'/gm)].map((m) => m[1]));
  for (const refusal of REFUSALS) {
    assert.ok(titles.has(refusal.test), `no test is titled '${refusal.test}'`);
    if (refusal.drill === null) {
      assert.ok(refusal.why, `'${refusal.id}' has no corpus case and no reason why not`);
    }
  }

  // Every satisfying case is a claim too — that the rule lets something through — so a corpus
  // that only ever refuses is a corpus that cannot show a false alarm.
  for (const aspect of DETERMINISTIC) {
    const cases = readdirSync(join(PACKAGE_DIR, aspect, 'drills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    assert.ok(cases.some((c) => c.startsWith('satisfies-')), `${aspect} has no satisfying case`);
    // A case file named *.md is silently skipped by the drill runner, so a corpus written in
    // markdown would report a clean run over nothing at all.
    for (const name of cases) {
      const files = readdirSync(join(PACKAGE_DIR, aspect, 'drills', name), { recursive: true });
      assert.ok(
        files.some((f) => typeof f === 'string' && !f.endsWith('.md') && f.includes('.')),
        `${aspect}/${name} holds nothing the drill runner will read`,
      );
    }
  }
});
