import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, initHorde, addNode,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// A node's charter is graph text: what the node is and what must stay true. Who owns it and under
// which lease is the horde's working state and lives with the roster, never in the committed
// charter — owners on a real mission were deleting that line by hand.
test('node.mjs charter edit: the seeded charter carries no owner or lease line', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'nodeA', { mapping: ['src/nodeA/**'] });
  let stderr = '';
  try {
    execFileSync('node', [join(SCRIPTS_DIR, 'node.mjs'), 'charter', 'edit', 'nodeA', '--json'], {
      cwd: dir, input: '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    stderr = String(e.stderr || e.message);
  }
  assert.equal(stderr, '', stderr);
  const charter = readFileSync(join(dir, '.yggdrasil', 'model', 'nodeA', 'charter.md'), 'utf8');
  assert.match(charter, /^# Node · nodeA/m);
  assert.doesNotMatch(charter, /\*\*Owner:\*\*/);
  assert.doesNotMatch(charter, /\*\*Lease:\*\*/);
});
