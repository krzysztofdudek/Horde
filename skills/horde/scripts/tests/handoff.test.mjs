// handoff.mjs is a view now: the state a session picks the mission up from, assembled live from the
// mission's Jarl loop — the same data `jarl.mjs resume --root .horde/hordes/<h>` reads. Nothing is
// written by hand any more, so the three writing commands are refused by name, saying where intent
// lives instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

function mkTicket(dir, slug) {
  const r = run('tk.mjs', ['new', slug, '--title', slug, '--node', 'core', '--class', 'standard', '--evidence', 'it works'], dir);
  if (r.code !== 0) throw new Error(`tk new (${slug}) failed: ${r.stderr}`);
  return r.json.id;
}

test('handoff.mjs: write, add-waiting and rm-waiting are retired, and say where intent lives now', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  for (const args of [['write', '--summary', 'x'], ['add-waiting', 'chairman', 'approve'], ['rm-waiting', 'chairman']]) {
    await t.test(`${args[0]} refuses, naming read and the homes of intent`, () => {
      const r = run('handoff.mjs', args, dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /handoff write is retired: nothing written/);
      assert.match(r.stderr, /handoff\.mjs read/);
      assert.match(r.stderr, /jarl\.mjs resume --root \.horde\/hordes\/<h>/);
    });
  }
});

test('handoff.mjs read: the mission as its loop holds it — the goal, the tickets a worker holds with their lease, the questions, the rulings', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('a fresh mission reads its goal and says the schedule is tick.mjs\'s', () => {
    const r = run('handoff.mjs', ['read'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.goal, /charter\.md/);
    assert.match(r.json.scheduler, /tick\.mjs/);
    assert.deepEqual(r.json.inFlight, []);
  });

  const first = mkTicket(dir, 'first');
  mkTicket(dir, 'second');
  run('queue.mjs', ['add', first], dir);
  const started = run('queue.mjs', ['set', first, 'running', '--agent', 'w-first'], dir);
  assert.equal(started.code, 0, started.stderr);
  run('ask.mjs', ['add', 'which tier is the default?', '--kind', 'stop'], dir);
  run('decide.mjs', ['add', 'tiers-by-weight', 'Tiers are ranked by weight, never by name.'], dir);

  await t.test('a ticket handed to a worker is in flight, with its branch, its worker and its worktree', () => {
    const r = run('handoff.mjs', ['read'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.inFlight.map((i) => i.id), [first]);
    assert.equal(r.json.inFlight[0].branch, started.json.branch);
    assert.equal(r.json.inFlight[0].worker, 'w-first');
  });

  await t.test('the question waiting on the client and the ruling in force are there', () => {
    const r = run('handoff.mjs', ['read'], dir);
    assert.equal(r.json.questions.length, 1);
    assert.match(r.json.questions[0].question, /which tier is the default/);
    assert.ok(r.json.rulings.some((d) => d.slug === 'tiers-by-weight'));
  });

  await t.test('the human rendering names the same things', () => {
    const r = run('handoff.mjs', ['read'], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`t-${first}`));
    assert.match(r.stdout, /which tier is the default/);
    assert.match(r.stdout, /tiers-by-weight/);
  });
});
