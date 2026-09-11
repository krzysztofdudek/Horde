// Drift check (task 034): Ratatoskr's "What counts as code" section and this repository's own
// `product-language` rule (packages/promises/product-language/check.mjs) name the same categories
// — two dictionaries, in two repositories, kept in step by nothing but this test.
//
// RatatoskrSkill has no test runner and no CI of its own, so the check lives here instead, against
// a checkout named by HORDE_TEST_RATATOSKR_DIR. It skips, with a stated reason, when that checkout
// is not present — the seam-suite idiom from Grain/plugins/grain/tests/seams.test.mjs (a HAVE_X
// flag plus an X_SKIP reason string, never a silent pass; see lines 39-56 there).
//
// No fixture files: the integration test reads the two real files off disk. The parsing itself is
// exercised directly, on string literals, so every refusal path below is proven without needing a
// deliberately-broken checkout on hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HORDE_ROOT = resolve(HERE, '..', '..', '..', '..');
const CHECK_MJS = join(HORDE_ROOT, 'packages', 'promises', 'product-language', 'check.mjs');

const RATATOSKR_DIR = process.env.HORDE_TEST_RATATOSKR_DIR || '';
const SKILL_MD = RATATOSKR_DIR ? join(RATATOSKR_DIR, 'skills', 'ratatoskr', 'SKILL.md') : '';
const HAVE_RATATOSKR = Boolean(RATATOSKR_DIR) && existsSync(SKILL_MD);
const RATATOSKR_SKIP = 'RatatoskrSkill checkout not found (set HORDE_TEST_RATATOSKR_DIR to a '
  + 'checkout of krzysztofdudek/RatatoskrSkill)';

// Every `id: '...'` inside the exported CATEGORIES array of check.mjs. The rule's own header
// comment says this array is "one thing a person can read top to bottom" — a plain regex over the
// array's source is exactly as much parsing as that promise supports. Returns null when the file
// holds no recognisable CATEGORIES array at all, so a caller can refuse by name rather than read a
// missing rule as "zero categories".
function categoriesFromCheckMjs(text) {
  const array = /CATEGORIES\s*=\s*\[([\s\S]*?)\n\];/.exec(text);
  if (!array) return null;
  return [...array[1].matchAll(/id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

// Every backtick-quoted, hyphenated category id inside the "### What counts as code" section of
// SKILL.md, up to the next heading (level 1-3). Returns null when the heading itself is missing,
// so a missing section refuses by naming the heading, not by reading zero categories as "aligned,
// empty on both sides".
function categoriesFromSkillMd(text) {
  const heading = /^### What counts as code\s*$/m.exec(text);
  if (!heading) return null;
  const rest = text.slice(heading.index + heading[0].length);
  const next = /^#{1,3}\s+\S/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  return [...section.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)].map((m) => m[1]);
}

// ── parsing itself, on string literals — proves each refusal path without a broken checkout ──

test('categoriesFromCheckMjs reads every id out of the CATEGORIES array', () => {
  const text = "export const CATEGORIES = [\n  { id: 'table-name', label: 'a table name' },\n  { id: 'field-name', label: 'a field name' },\n];\n";
  assert.deepEqual(categoriesFromCheckMjs(text), ['table-name', 'field-name']);
});

test('categoriesFromCheckMjs refuses (returns null) when there is no recognisable CATEGORIES array', () => {
  assert.equal(categoriesFromCheckMjs('export function check(ctx) { return []; }\n'), null);
});

test('categoriesFromCheckMjs returns an empty list for an empty CATEGORIES array — distinct from refusing outright', () => {
  const result = categoriesFromCheckMjs('export const CATEGORIES = [\n];\n');
  assert.notEqual(result, null);
  assert.deepEqual(result, []);
});

test('categoriesFromSkillMd reads every backtick id out of the section, stopping at the next heading', () => {
  const text = '### What counts as code\n\n'
    + '- **Code identifiers** (`camel-case-identifier`, `snake-case-identifier`) — camelCase, snake_case.\n'
    + '- **Table and field names** (`table-name`, `field-name`) — what the database calls it.\n\n'
    + 'This mirrors the *product-language* rule of the family\'s `promises` package.\n\n'
    + '### Handling code-bait\n\n'
    + 'Some later section mentioning `not-a-real-category` that must not be picked up.\n';
  assert.deepEqual(
    categoriesFromSkillMd(text),
    ['camel-case-identifier', 'snake-case-identifier', 'table-name', 'field-name'],
  );
});

test('categoriesFromSkillMd refuses (returns null) when the "What counts as code" heading is missing', () => {
  assert.equal(categoriesFromSkillMd('### Handling code-bait\n\nNo such section here.\n'), null);
});

test('categoriesFromSkillMd returns an empty list for a heading with no category tokens — distinct from a missing heading', () => {
  const result = categoriesFromSkillMd('### What counts as code\n\nNothing enumerated yet.\n\n### Handling code-bait\n');
  assert.notEqual(result, null);
  assert.deepEqual(result, []);
});

// ── the real check: this repository's rule against a real RatatoskrSkill checkout ──

test('packages/promises/product-language/check.mjs keeps its category list in one readable, parseable place', () => {
  const ids = categoriesFromCheckMjs(readFileSync(CHECK_MJS, 'utf8'));
  assert.notEqual(ids, null, `${CHECK_MJS} does not hold a recognisable CATEGORIES array — the rule must keep its category list in one readable, parseable place`);
  assert.ok(ids.length > 0, `${CHECK_MJS} parsed a CATEGORIES array with no categories in it`);
});

test(
  'RatatoskrSkill\'s "What counts as code" categories are token-set-identical to product-language\'s',
  { skip: HAVE_RATATOSKR ? false : RATATOSKR_SKIP },
  () => {
    const ruleIds = categoriesFromCheckMjs(readFileSync(CHECK_MJS, 'utf8'));
    assert.notEqual(ruleIds, null, `${CHECK_MJS} does not hold a recognisable CATEGORIES array`);
    assert.ok(ruleIds.length > 0, `${CHECK_MJS} holds an empty category list — refusing rather than treating it as vacuously equal to any skill-side list`);

    const skillIds = categoriesFromSkillMd(readFileSync(SKILL_MD, 'utf8'));
    assert.notEqual(skillIds, null, `${SKILL_MD} has no "### What counts as code" heading`);
    assert.ok(skillIds.length > 0, `${SKILL_MD}'s "What counts as code" section names no categories — refusing rather than treating an empty set as equal to product-language's`);

    const ruleSet = new Set(ruleIds);
    const skillSet = new Set(skillIds);

    const missingFromSkill = ruleIds.filter((id) => !skillSet.has(id));
    const missingFromRule = skillIds.filter((id) => !ruleSet.has(id));

    assert.deepEqual(
      missingFromSkill,
      [],
      `categor${missingFromSkill.length === 1 ? 'y' : 'ies'} present in ${CHECK_MJS} but missing from ${SKILL_MD}: ${missingFromSkill.join(', ')}`,
    );
    assert.deepEqual(
      missingFromRule,
      [],
      `categor${missingFromRule.length === 1 ? 'y' : 'ies'} present in ${SKILL_MD} but missing from ${CHECK_MJS}: ${missingFromRule.join(', ')}`,
    );
  },
);
