import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, rmRepo, run, initHorde, writeCostRuns } from './helpers.mjs';

test('cost.mjs: report, limit-reached (cost.json is read-only from here — the deleted roster tool spawn writes it)', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('report on a missing/empty cost.json is zero runs, not an error', () => {
    const r = run('cost.mjs', ['report'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.runs, 0);
    assert.equal(r.json.weighted, 0);
    assert.equal(r.json.limit, null);
  });

  await t.test('report sums runs and weighted cost from cost.json', () => {
    writeCostRuns(dir, 'mission1', [
      { name: 'mission1-worker-trunk-1', role: 'worker', class: 'standard', ticket: '001', team: 'trunk', wave: '1', at: new Date().toISOString() },
      { name: 'mission1-worker-trunk-2', role: 'worker', class: 'standard', ticket: '001', team: 'trunk', wave: '1', at: new Date().toISOString() },
      { name: 'mission1-owner-auth-1', role: 'owner', class: 'heavy', ticket: '002', team: 'trunk', wave: '1', at: new Date().toISOString() },
    ]);
    const r = run('cost.mjs', ['report'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.runs, 3);
    assert.equal(r.json.weighted, 3 + 3 + 10);
    assert.equal(r.json.limit, null);
  });

  await t.test('report --ticket scopes to one ticket', () => {
    const r = run('cost.mjs', ['report', '--ticket', '002'], dir);
    assert.equal(r.json.runs, 1);
    assert.equal(r.json.weighted, 10);
  });

  await t.test('report --wave scopes to one wave', () => {
    writeCostRuns(dir, 'mission1', [
      { name: 'a', role: 'worker', class: 'light', ticket: '003', team: 'trunk', wave: '1', at: new Date().toISOString() },
      { name: 'b', role: 'worker', class: 'light', ticket: '004', team: 'trunk', wave: '2', at: new Date().toISOString() },
    ]);
    const r = run('cost.mjs', ['report', '--wave', '2'], dir);
    assert.equal(r.json.runs, 1);
    assert.equal(r.json.weighted, 1);
  });

  await t.test('limit-reached exits 1 with no limit set', () => {
    const r = run('cost.mjs', ['limit-reached'], dir);
    assert.equal(r.code, 1);
    assert.equal(r.json.reached, false);
  });
});

test('cost.mjs: limit-reached against the charter\'s Limit line', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const { join } = await import('node:path');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  const charter = readFileSync(charterPath, 'utf8').replace('Limit: none runs-weighted', 'Limit: 20 runs-weighted');
  writeFileSync(charterPath, charter);

  writeCostRuns(dir, 'mission1', [
    { name: 'a', role: 'owner', class: 'heavy', ticket: null, team: 'trunk', wave: '1', at: new Date().toISOString() },
    { name: 'b', role: 'owner', class: 'heavy', ticket: null, team: 'trunk', wave: '1', at: new Date().toISOString() },
    { name: 'c', role: 'owner', class: 'heavy', ticket: null, team: 'trunk', wave: '1', at: new Date().toISOString() },
  ]); // 30 weighted, over the 20 limit

  const reached = run('cost.mjs', ['limit-reached'], dir);
  assert.equal(reached.code, 0);
  assert.equal(reached.json.reached, true);

  const report = run('cost.mjs', ['report', '--mission'], dir);
  assert.equal(report.json.limit, 20);
  assert.equal(report.json.reached, true);
});

test('a bare "Limit: 20" line without the unit is the same limit', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const { join } = await import('node:path');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  writeFileSync(charterPath, readFileSync(charterPath, 'utf8').replace('Limit: none runs-weighted', 'Limit: 20'));
  writeCostRuns(dir, 'mission1', [
    { name: 'a', role: 'owner', class: 'heavy', ticket: null, team: 'trunk', wave: '1', at: new Date().toISOString() },
  ]); // 10 weighted, under 20
  const under = run('cost.mjs', ['limit-reached'], dir);
  assert.equal(under.code, 1);
  assert.equal(under.json.limit, 20);
  assert.equal(under.json.reached, false);
});
