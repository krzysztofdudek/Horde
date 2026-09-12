import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, addNode,
} from './helpers.mjs';

// The architect reads the plan whole, from a file: relayed through a message it gets summarised
// on the way, and a steward cannot message the architect directly in any case.
test('queue.mjs plan --out: writes the plan to a file and says so on stdout', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'nodeA', { mapping: ['src/nodeA/**'] });
  const created = run('tk.mjs', ['new', 'thing', '--title', 'A thing', '--node', 'nodeA', '--class', 'standard', '--evidence', 'it works'], dir);
  assert.equal(run('queue.mjs', ['add', created.json.id], dir).code, 0);
  const out = join(dir, 'plan.json');
  const r = run('queue.mjs', ['plan', '--out', out], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /plan written to .*plan\.json — 1 ticket\(s\)/);
  assert.ok(existsSync(out));
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(plan.tickets.length, 1);
  assert.equal(plan.tickets[0].id, created.json.id);
});
