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

// Yggdrasil's yg-context/1 names two more owners than a node, and neither is a forgotten mapping:
// a file its architecture type covers is covered, and a file the coverage config excludes "cannot
// and need not be mapped to a node". Refusing either would send the worker to map a file the graph
// says must not be, and the ticket could never land.
test('land.mjs unmappedFiles: a type-covered file and a file excluded by design are not unmapped', () => {
  const contexts = new Map([
    ['src/orders/handler.ts', { owner: { kind: 'type', typeId: 'handler', chainTermination: 'type' } }],
    ['docs/guide.md', { owner: { kind: 'none', reason: 'excluded' } }],
    ['src/reports/index.ts', { owner: { kind: 'none', reason: 'unmapped' } }],
  ]);
  assert.deepEqual(unmappedFiles(contexts), ['src/reports/index.ts']);
});
