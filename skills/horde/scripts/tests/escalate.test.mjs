import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

test('escalate.mjs: add, list, rule (direct and via --to-user), show, refusals', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('add refuses an unknown kind', () => {
    const r = run('escalate.mjs', ['add', 'why', '--kind', 'bogus'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--kind is required/);
  });

  let id;
  await t.test('add opens an escalation, listed under --open', () => {
    const r = run('escalate.mjs', ['add', 'scope question', '--kind', 'charter', '--by', 'steward', '--ticket', '3'], dir);
    assert.equal(r.code, 0);
    id = r.json.id;
    assert.equal(r.json.state, 'open');
    const open = run('escalate.mjs', ['list', '--open'], dir);
    assert.equal(open.json.length, 1);
  });

  await t.test('rule closes it directly and records a decision esc-<id>', () => {
    const r = run('escalate.mjs', ['rule', id, 'ruling text'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.state, 'ruled');
    const open = run('escalate.mjs', ['list', '--open'], dir);
    assert.equal(open.json.length, 0);
    const decision = run('decide.mjs', ['show', `esc-${id}`], dir);
    assert.equal(decision.code, 0);
    assert.equal(decision.json.body, 'ruling text');
  });

  await t.test('rule refuses an already-ruled escalation', () => {
    const r = run('escalate.mjs', ['rule', id, 'again'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already ruled/);
  });

  let forwardedId;
  await t.test('rule --to-user forwards without closing; a second rule call finalizes it', () => {
    const opened = run('escalate.mjs', ['add', 'cost question', '--kind', 'cost', '--by', 'steward'], dir);
    forwardedId = opened.json.id;
    const forwarded = run('escalate.mjs', ['rule', forwardedId, 'forwarding this', '--to-user'], dir);
    assert.equal(forwarded.code, 0);
    assert.equal(forwarded.json.state, 'forwarded');
    const stillOpen = run('escalate.mjs', ['list', '--open'], dir);
    assert.equal(stillOpen.json.some((i) => i.id === forwardedId), true);
    const noDecisionYet = run('decide.mjs', ['show', `esc-${forwardedId}`], dir);
    assert.equal(noDecisionYet.code, 1);

    const finalized = run('escalate.mjs', ['rule', forwardedId, 'chairman says proceed'], dir);
    assert.equal(finalized.code, 0);
    assert.equal(finalized.json.state, 'ruled');
    const decision = run('decide.mjs', ['show', `esc-${forwardedId}`], dir);
    assert.equal(decision.code, 0);
    assert.equal(decision.json.body, 'chairman says proceed');
  });

  await t.test('rule refuses an unknown escalation id', () => {
    const r = run('escalate.mjs', ['rule', '9999', 'x'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such escalation/);
  });

  await t.test('add accepts kind "adjudicate" — the fix-loop breaker\'s own next step past its cap', () => {
    const r = run('escalate.mjs', ['add', 'ticket stuck past the fix-loop cap', '--kind', 'adjudicate', '--ticket', '7'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.kind, 'adjudicate');
    assert.equal(r.json.ticket, '7');
  });

  await t.test('rule --by traces that name in the roster when it is one', () => {
    const architect = run('roster.mjs', ['spawn', 'architect', '--class', 'opus'], dir);
    assert.equal(architect.code, 0, architect.stderr);
    const architectName = architect.json.name;

    const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
    const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
    const staleAt = new Date(Date.now() - 120 * 60000).toISOString();
    roster.entries.find((e) => e.name === architectName).lastTrace = staleAt;
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

    const opened = run('escalate.mjs', ['add', 'traced ruling', '--kind', 'rules'], dir);
    const ruled = run('escalate.mjs', ['rule', opened.json.id, 'ruling text', '--by', architectName], dir);
    assert.equal(ruled.code, 0, ruled.stderr);

    const after = run('roster.mjs', ['list'], dir).json.find((e) => e.name === architectName);
    assert.notEqual(after.lastTrace, staleAt);
  });
});
