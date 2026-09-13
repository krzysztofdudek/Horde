// A focused, white-box proof for one rule of the `promises` package: `has-evidence`'s `named`
// pairing has to land the name on a real test case's own title — the position a runner's report
// would show — not on the word appearing anywhere else in the paired file. The end-to-end proof
// for the whole package lives in promises-package.test.mjs and drives the real `yg` CLI; this one
// imports check.mjs directly so the exact regression (a bare substring match) is provable without
// standing up a repository or an installed CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_PATH = join(HERE, '..', '..', '..', '..', 'packages', 'promises', 'has-evidence', 'check.mjs');

const PROMISE = [
  '---',
  'id: orders-are-confirmed',
  'status: implemented',
  'evidence: suite/orders.mjs#an order comes back confirmed',
  '---',
  '',
  '# An order the customer placed comes back confirmed',
  '',
  '## What it checks',
  'A customer who places an order is told, on the spot, that it is confirmed.',
  '',
].join('\n');

function run(suiteContent, config = {}) {
  return import(CHECK_PATH).then(({ check }) => check({
    files: [
      { path: 'promises/orders-are-confirmed.md', content: PROMISE },
      { path: 'suite/orders.mjs', content: suiteContent },
    ],
    config,
  }));
}

test('has-evidence named pairing: the name has to be a test case title, not just a substring', async () => {
  await test('a name that only occurs in prose is refused, even though the word is in the file', async () => {
    const suite = "// keeping the order comes back confirmed\nexport function run() {}\n";
    const out = await run(suite);
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.match(out[0].message, /names nothing called 'an order comes back confirmed' as a test case's own title/);
  });

  await test('the same name as a real test(...) title is accepted', async () => {
    const suite = "test('an order comes back confirmed', () => { placeOrder(); });\n";
    const out = await run(suite);
    assert.deepEqual(out, []);
  });

  await test('the same name as a real it(...) title is accepted', async () => {
    const suite = "it('an order comes back confirmed', () => { placeOrder(); });\n";
    const out = await run(suite);
    assert.deepEqual(out, []);
  });

  await test('a Scenario: title is accepted', async () => {
    const suite = 'Feature: orders\n  Scenario: an order comes back confirmed\n    Then it is confirmed\n';
    const out = await run(suite);
    assert.deepEqual(out, []);
  });

  await test('a python def test_<name> title is accepted', async () => {
    const suite = 'def test_an_order_comes_back_confirmed():\n    place_order()\n';
    const out = await run(suite);
    assert.deepEqual(out, []);
  });

  await test('a go func Test<Name> title is accepted', async () => {
    const suite = 'func TestAnOrderComesBackConfirmed(t *testing.T) {\n\tplaceOrder()\n}\n';
    const out = await run(suite);
    assert.deepEqual(out, []);
  });

  await test('narrowing named_case_patterns to a subset refuses a title outside that subset', async () => {
    const suite = "it('an order comes back confirmed', () => {});\n";
    const out = await run(suite, { named_case_patterns: 'test(' });
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.match(out[0].message, /after test\(/);
  });

  await test('an unknown pattern in the config is dropped, keeping the closed list closed', async () => {
    const suite = "it('an order comes back confirmed', () => {});\n";
    const out = await run(suite, { named_case_patterns: 'it(, describe(' });
    assert.deepEqual(out, []);
  });
});
