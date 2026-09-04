import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

test('dissent.mjs: add, list, answer, refusals', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('add requires --ticket and --by', () => {
    assert.equal(run('dissent.mjs', ['add', 'why'], dir).code, 1);
    assert.equal(run('dissent.mjs', ['add', 'why', '--ticket', '1'], dir).code, 1);
  });

  let id;
  await t.test('add opens a dissent against a ruling', () => {
    const r = run('dissent.mjs', ['add', 'disagree with esc-1', '--ticket', '007', '--by', 'owner-auth', '--against', 'esc-1'], dir);
    assert.equal(r.code, 0);
    id = r.json.id;
    assert.equal(r.json.state, 'open');
    const open = run('dissent.mjs', ['list', '--open'], dir);
    assert.equal(open.json.length, 1);
  });

  await t.test('answer requires --by', () => {
    const r = run('dissent.mjs', ['answer', id, 'ruling stands'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--by/);
  });

  await t.test('answer closes it once, records who answered, and appends dissent-<id> to decisions.md', () => {
    const r = run('dissent.mjs', ['answer', id, 'ruling stands, here is why', '--by', 'director'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.state, 'closed');
    assert.equal(r.json.answeredBy, 'director');
    const decision = run('decide.mjs', ['show', `dissent-${id}`], dir);
    assert.equal(decision.code, 0);
    assert.match(decision.json.body, /ruling stands, here is why/);
    assert.match(decision.json.body, /by director/);
  });

  await t.test('answer refuses a dissent that was already answered', () => {
    const r = run('dissent.mjs', ['answer', id, 'again', '--by', 'director'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already answered/);
  });

  await t.test('answer refuses an unknown dissent id', () => {
    const r = run('dissent.mjs', ['answer', '9999', 'x', '--by', 'director'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such dissent/);
  });

  await t.test('answer --by traces that name in the roster when it is one', () => {
    const architect = run('roster.mjs', ['spawn', 'architect', '--class', 'opus'], dir);
    assert.equal(architect.code, 0, architect.stderr);
    const architectName = architect.json.name;

    const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
    const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
    const staleAt = new Date(Date.now() - 120 * 60000).toISOString();
    roster.entries.find((e) => e.name === architectName).lastTrace = staleAt;
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

    const opened = run('dissent.mjs', ['add', 'disagree again', '--ticket', '008', '--by', 'owner-x'], dir);
    const answered = run('dissent.mjs', ['answer', opened.json.id, 'ruling stands', '--by', architectName], dir);
    assert.equal(answered.code, 0, answered.stderr);

    const after = run('roster.mjs', ['list'], dir).json.find((e) => e.name === architectName);
    assert.notEqual(after.lastTrace, staleAt);
  });
});
