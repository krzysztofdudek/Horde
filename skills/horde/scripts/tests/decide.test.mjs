import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, rmRepo, run, initHorde, requireYg } from './helpers.mjs';

test('decide.mjs: add, list, show, refusals', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('add records an entry and show returns it', () => {
    const r = run('decide.mjs', ['add', 'lesson-1', 'Always check base freshness first.', '--ticket', '7'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.slug, 'lesson-1');
    const shown = run('decide.mjs', ['show', 'lesson-1'], dir);
    assert.equal(shown.code, 0);
    assert.equal(shown.json.body, 'Always check base freshness first.');
    assert.equal(shown.json.ticket, '7');
  });

  await t.test('add refuses a duplicate slug', () => {
    const r = run('decide.mjs', ['add', 'lesson-1', 'anything'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /duplicate slug: lesson-1/);
  });

  await t.test('list supports --grep', () => {
    const byGrep = run('decide.mjs', ['list', '--grep', 'freshness'], dir);
    assert.equal(byGrep.json.length, 1);
    assert.equal(byGrep.json[0].slug, 'lesson-1');
  });

  await t.test('show refuses an unknown slug', () => {
    const r = run('decide.mjs', ['show', 'no-such-slug'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such decision/);
  });
});

// A node's decisions belong in the graph's own log, and there is only one graph — so this redirect
// is unconditional now, not a mode. The command it prints names the CLI this repository actually
// invokes, not a bare `yg` it might not have.
test('decide.mjs: --node always redirects to the graph\'s own log', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const r = run('decide.mjs', ['add', 'arch-1', 'move the boundary', '--node', 'auth'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /graph's own log/);
  assert.match(r.stderr, /log add --node auth/);
  assert.ok(
    r.stderr.includes(`${requireYg()} log add`),
    `the redirect names this repository's own CLI: ${r.stderr}`,
  );
});
