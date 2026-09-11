import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unmappedFiles } from '../land.mjs';

// A new folder's mapping lands in the same commit as its first file: the graph is asked, on the
// branch's own tree, who owns every added file, and a file no node owns is a refusal.
test('land.mjs unmappedFiles: a file whose context names no node as owner is unmapped', () => {
  const contexts = new Map([
    ['src/orders/index.ts', { owner: { kind: 'node', node: 'orders' } }],
    ['src/reports/index.ts', { owner: { kind: 'none' } }],
    ['src/reports/util.ts', null],
  ]);
  assert.deepEqual(unmappedFiles(contexts), ['src/reports/index.ts', 'src/reports/util.ts']);
  assert.deepEqual(unmappedFiles(new Map()), []);
});
