import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

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

  await t.test('list finds entries and supports --grep and --node', () => {
    run('decide.mjs', ['add', 'node-decision', 'boundary is fixed', '--node', 'auth'], dir);
    const byNode = run('decide.mjs', ['list', '--node', 'auth'], dir);
    assert.equal(byNode.json.length, 1);
    assert.equal(byNode.json[0].slug, 'node-decision');
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

test('decide.mjs: --node redirects to yg log add when nodeSource is yggdrasil', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // Fake a Yggdrasil repository: horde.mjs init auto-detects nodeSource from .yggdrasil/'s presence.
  const { mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(join(dir, '.yggdrasil'), { recursive: true });
  initHorde(dir);

  const r = run('decide.mjs', ['add', 'arch-1', 'move the boundary', '--node', 'auth'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /graph's own log/);
  assert.match(r.stderr, /yg log add/);
});
