import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

test('horde.mjs: init, list, config, archive', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  await t.test('init creates .horde/, the charter, empty state, and the trunk branch', () => {
    const r = initHorde(dir, 'mission1', ['--title', 'The Mission']);
    assert.equal(r.horde, 'mission1');
    assert.equal(r.branch, 'mission1/trunk');
    assert.equal(existsSync(join(dir, '.horde', '.gitignore')), true);
    const charter = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'charter.md'), 'utf8');
    assert.match(charter, /# Mission · The Mission/);
    assert.match(charter, /`mission1\/trunk` off `develop`/);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission1', 'counter.json')), true);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json')), true);
    const branches = execFileSync('git', ['branch'], { cwd: dir, encoding: 'utf8' });
    assert.match(branches, /mission1\/trunk/);
  });

  await t.test('init refuses a duplicate horde name', () => {
    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists/);
  });

  await t.test('config get/set round-trips through dotted paths with type coercion', () => {
    const before = run('horde.mjs', ['config', 'get', 'liveness.stewardMinutes'], dir);
    assert.equal(before.json.value, 60);

    const setResult = run('horde.mjs', ['config', 'set', 'liveness.stewardMinutes', '90'], dir);
    assert.equal(setResult.code, 0);
    const after = run('horde.mjs', ['config', 'get', 'liveness.stewardMinutes'], dir);
    assert.equal(after.json.value, 90);

    run('horde.mjs', ['config', 'set', 'protectedPaths', 'a/b,c/d'], dir);
    const paths = run('horde.mjs', ['config', 'get', 'protectedPaths'], dir);
    assert.deepEqual(paths.json.value, ['a/b', 'c/d']);
  });

  await t.test('list shows the horde with trunk sha, base and open ticket count', () => {
    const r = run('horde.mjs', ['list'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].name, 'mission1');
    assert.equal(r.json[0].base, 'develop');
    assert.equal(r.json[0].openTickets, 0);
  });

  await t.test('a second horde makes the CLI ambiguous without --horde', () => {
    initHorde(dir, 'mission2');
    const ambiguous = run('decide.mjs', ['list'], dir);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /multiple hordes exist/);
    const scoped = run('decide.mjs', ['list', '--horde', 'mission2'], dir);
    assert.equal(scoped.code, 0);
  });

  await t.test('archive moves the horde and leaves branches untouched; re-archiving refuses', () => {
    const r = run('horde.mjs', ['archive', 'mission2'], dir);
    assert.equal(r.code, 0);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission2')), false);
    assert.match(r.json.to, /_archive\/mission2-/);
    const branches = execFileSync('git', ['branch'], { cwd: dir, encoding: 'utf8' });
    assert.match(branches, /mission2\/trunk/);

    const again = run('horde.mjs', ['archive', 'mission2'], dir);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /no such horde/);
  });
});

test('horde.mjs: unknown horde is refused by any tool, not just horde.mjs', () => {
  const dir = makeRepo();
  try {
    initHorde(dir, 'mission1');
    const r = run('decide.mjs', ['list', '--horde', 'nope'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such horde: nope/);
  } finally {
    rmRepo(dir);
  }
});
