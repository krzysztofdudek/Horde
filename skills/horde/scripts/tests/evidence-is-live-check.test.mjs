// A focused, white-box proof for one rule of the `promises` package: `evidence-is-live` refuses a
// live promise whose paired case is switched off, or sits in a file where something else is named
// as the only case that runs. The end-to-end proof for the whole package lives in
// promises-package.test.mjs and drives the real `yg` CLI; this one imports check.mjs directly, so
// every marker of the closed list, every pairing and every narrowing is provable without standing
// up a repository per case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_PATH = join(HERE, '..', '..', '..', '..', 'packages', 'promises', 'evidence-is-live', 'check.mjs');
const { check } = await import(CHECK_PATH);

const PROMISE_PATH = 'promises/orders-are-confirmed.md';
const MIRROR_PATH = 'suite/orders-are-confirmed.test.mjs';

/** A promise, with whatever the caller wants changed about its frontmatter and its body. */
function promise({ status = 'implemented', evidence = 'self', body = '' } = {}) {
  return [
    '---',
    'id: orders-are-confirmed',
    `status: ${status}`,
    ...(evidence === null ? [] : [`evidence: ${evidence}`]),
    '---',
    '',
    '# An order the customer placed comes back confirmed',
    '',
    '## What it checks',
    'A customer who places an order is told, on the spot, that it is confirmed.',
    '',
    '## How to see it',
    body,
    '',
  ].join('\n');
}

/** The rule over a promise that is its own evidence — the shortest way to put one body in front of it. */
function onItsOwn(body, config = {}) {
  return check({ files: [{ path: PROMISE_PATH, content: promise({ body }) }], config });
}

/** The rule over a promise and the file mirroring its name. */
function withMirror(mirror, config = {}) {
  return check({
    files: [
      { path: PROMISE_PATH, content: promise({ evidence: null }) },
      { path: MIRROR_PATH, content: mirror },
    ],
    config,
  });
}

/** The rule over a promise naming one case inside a file that holds more than one. */
function withNamed(suite, config = {}) {
  return check({
    files: [
      {
        path: PROMISE_PATH,
        content: promise({ evidence: `${MIRROR_PATH}#an order comes back confirmed` }),
      },
      { path: MIRROR_PATH, content: suite },
    ],
    config,
  });
}

// ── every marker of the closed list, one per language convention ─────────────

const SWITCHED_OFF = [
  { marker: 'test.skip', language: 'JavaScript', body: "test.skip('an order comes back confirmed', () => { placeOrder(); });" },
  { marker: 'test.fixme', language: 'JavaScript', body: "test.fixme('an order comes back confirmed', () => { placeOrder(); });" },
  { marker: 'xit', language: 'JavaScript', body: "xit('an order comes back confirmed', () => { placeOrder(); });" },
  { marker: 'xdescribe', language: 'JavaScript', body: "xdescribe('orders', () => {\n  it('an order comes back confirmed', () => { placeOrder(); });\n});" },
  { marker: '@pytest.mark.skip', language: 'Python', body: '@pytest.mark.skip(reason="waiting on the payment sandbox")\ndef test_an_order_comes_back_confirmed():\n    place_order()' },
  { marker: 'pytest.skip(', language: 'Python', body: 'def test_an_order_comes_back_confirmed():\n    pytest.skip("waiting on the payment sandbox")' },
  { marker: 't.Skip(', language: 'Go', body: 'func TestAnOrderComesBackConfirmed(t *testing.T) {\n\tt.Skip("waiting on the payment sandbox")\n}' },
  { marker: '[Ignore]', language: '.NET', body: '[Ignore("waiting on the payment sandbox")]\n[Test]\npublic void AnOrderComesBackConfirmed() { PlaceOrder(); }' },
  { marker: 'Skip =', language: '.NET', body: '[Fact(Skip = "waiting on the payment sandbox")]\npublic void AnOrderComesBackConfirmed() { PlaceOrder(); }' },
];

for (const { marker, language, body } of SWITCHED_OFF) {
  test(`a ${language} case switched off with '${marker}' is refused`, () => {
    const out = onItsOwn(body);
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.equal(out[0].file, PROMISE_PATH);
    assert.match(out[0].message, new RegExp(`switches off what keeps the promise 'orders-are-confirmed'`));
    assert.ok(out[0].message.includes(marker), `the refusal does not name '${marker}': ${out[0].message}`);
  });
}

const LIVE = [
  { language: 'JavaScript', body: "test('an order comes back confirmed', () => { placeOrder(); });" },
  { language: 'Python', body: 'def test_an_order_comes_back_confirmed():\n    place_order()' },
  { language: 'Go', body: 'func TestAnOrderComesBackConfirmed(t *testing.T) {\n\tplaceOrder()\n}' },
  { language: '.NET', body: '[Fact]\npublic void AnOrderComesBackConfirmed() { PlaceOrder(); }' },
];

for (const { language, body } of LIVE) {
  test(`a ${language} case that runs is let through`, () => {
    assert.deepEqual(onItsOwn(body), []);
  });
}

test('a case named as the only one to run is refused, and the refusal says what it costs', () => {
  const out = onItsOwn("test.only('an order is paid for', () => {});\ntest('an order comes back confirmed', () => {});");
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].message, /makes one case the only one that runs/);
  assert.ok(out[0].message.includes('test.only'), out[0].message);
});

test('the line the marker sits on is the line reported', () => {
  const out = onItsOwn("test('an order is paid for', () => {});\ntest.skip('an order comes back confirmed', () => {});");
  assert.equal(out.length, 1, JSON.stringify(out));
  const lines = promise({ body: "test('an order is paid for', () => {});\ntest.skip('an order comes back confirmed', () => {});" }).split('\n');
  assert.match(lines[out[0].line - 1], /test\.skip/);
});

test('not every mention of a marker word is a marker', () => {
  assert.deepEqual(onItsOwn('var page = orders.Skip(10).Take(5);'), []);
  assert.deepEqual(onItsOwn('func TestAnOrderComesBackConfirmed(t *testing.T) {\n\tif t.Skipped() {\n\t\treturn\n\t}\n}'), []);
  assert.deepEqual(onItsOwn('const Skip = "the reason nobody gave";'), []);
});

// ── the four pairings ────────────────────────────────────────────────────────

test('a mirror whose case is switched off is refused, and the mirror is what gets named', () => {
  const out = withMirror("test.skip('an order comes back confirmed', () => { placeOrder(); });\n");
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].file, MIRROR_PATH);
});

test('a mirror that runs is let through', () => {
  assert.deepEqual(withMirror("test('an order comes back confirmed', () => { placeOrder(); });\n"), []);
});

test('a promise kept by an accepted artefact has nothing here to run, and is let through', () => {
  const content = [
    '---',
    'id: brand-palette-signed-off',
    'status: implemented',
    'artefact:',
    '  path: docs/brand/palette.pdf',
    '  sha256: 3b1f8a2c9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8',
    '  accepted_by: Maya Lind',
    '  at: 2026-08-14',
    '---',
    '',
    "# The palette is the one that was signed off",
    '',
    "test.skip('this is prose, and nothing here runs at all', () => {});",
    '',
  ].join('\n');
  assert.deepEqual(check({ files: [{ path: 'promises/brand-palette-signed-off.md', content }], config: {} }), []);
});

test('a promise nothing runs yet may be paired with something switched off', () => {
  for (const status of ['planned', 'disabled']) {
    const content = promise({ status, body: "test.skip('an order comes back confirmed', () => {});" });
    assert.deepEqual(check({ files: [{ path: PROMISE_PATH, content }], config: {} }), [], status);
  }
});

// ── a named pairing points at one case, and only that case counts ────────────

test('a named case that is the one switched off is refused', () => {
  const out = withNamed(
    [
      "test('an order is paid for', () => { payForOrder(); });",
      '',
      "test.skip('an order comes back confirmed', () => { placeOrder(); });",
      '',
    ].join('\n'),
  );
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].file, MIRROR_PATH);
});

test("a marker on another promise's case in the same file is not held against this one", () => {
  assert.deepEqual(
    withNamed(
      [
        "test.skip('an order is paid for', () => { payForOrder(); });",
        '',
        "test('an order comes back confirmed', () => { placeOrder(); });",
        '',
      ].join('\n'),
    ),
    [],
  );
});

test("a decorator above the NEXT case belongs to that case, not to this one", () => {
  assert.deepEqual(
    withNamed(
      [
        'def test_an_order_comes_back_confirmed():',
        '    place_order()',
        '',
        '@pytest.mark.skip(reason="waiting on the payment sandbox")',
        'def test_an_order_is_paid_for():',
        '    pay_for_order()',
        '',
      ].join('\n'),
    ),
    [],
  );
});

test('a case named as the only one to run is refused even when the named case itself runs', () => {
  const out = withNamed(
    [
      "test.only('an order is paid for', () => { payForOrder(); });",
      '',
      "test('an order comes back confirmed', () => { placeOrder(); });",
      '',
    ].join('\n'),
  );
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].message, /makes one case the only one that runs/);
});

test('a named pairing pointing at a case that is not in the file says nothing here', () => {
  assert.deepEqual(withNamed("test('an order is paid for', () => { payForOrder(); });\n"), []);
});

// ── the list is closed, and a repository may narrow it ───────────────────────

test('narrowing the markers to a subset lets a marker outside that subset through', () => {
  const body = "xit('an order comes back confirmed', () => {});";
  assert.equal(onItsOwn(body).length, 1);
  assert.deepEqual(onItsOwn(body, { markers: 'test.skip, test.only' }), []);
});

test('an unknown marker in the settings is dropped, keeping the closed list closed', () => {
  const out = onItsOwn("it.skip('an order comes back confirmed', () => {});", { markers: 'it.skip' });
  assert.deepEqual(out, [], 'a marker this rule has no matcher for was accepted from the settings');
});

test('narrowing the markers to nothing at all falls back to the whole list', () => {
  assert.equal(onItsOwn("test.skip('an order comes back confirmed', () => {});", { markers: '   ' }).length, 1);
});

test('nothing mapped is not a finding', () => {
  assert.deepEqual(check({ files: [], config: {} }), []);
});
