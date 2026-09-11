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

test('handoff.mjs: --by and --team no longer exist — refused on every command', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('write refuses --by and --team', () => {
    const byResult = run('handoff.mjs', ['write', '--summary', 'x', '--by', 'steward'], dir);
    assert.equal(byResult.code, 1);
    assert.match(byResult.stderr, /--by no longer exists/);

    const teamResult = run('handoff.mjs', ['write', '--summary', 'x', '--team', 'x'], dir);
    assert.equal(teamResult.code, 1);
    assert.match(teamResult.stderr, /unknown flag: --team/);
  });

  await t.test('read refuses --by and --team', () => {
    const byResult = run('handoff.mjs', ['read', '--by', 'steward'], dir);
    assert.equal(byResult.code, 1);
    assert.match(byResult.stderr, /--by no longer exists/);

    const teamResult = run('handoff.mjs', ['read', '--team', 'x'], dir);
    assert.equal(teamResult.code, 1);
    assert.match(teamResult.stderr, /unknown flag: --team/);
  });

  await t.test('add-waiting refuses --by and --team', () => {
    const byResult = run('handoff.mjs', ['add-waiting', 'chairman', 'approve', '--by', 'steward'], dir);
    assert.equal(byResult.code, 1);
    assert.match(byResult.stderr, /--by no longer exists/);

    const teamResult = run('handoff.mjs', ['add-waiting', 'chairman', 'approve', '--team', 'x'], dir);
    assert.equal(teamResult.code, 1);
    assert.match(teamResult.stderr, /unknown flag: --team/);
  });

  await t.test('rm-waiting refuses --by and --team', () => {
    const byResult = run('handoff.mjs', ['rm-waiting', 'chairman', '--by', 'steward'], dir);
    assert.equal(byResult.code, 1);
    assert.match(byResult.stderr, /--by no longer exists/);

    const teamResult = run('handoff.mjs', ['rm-waiting', 'chairman', '--team', 'x'], dir);
    assert.equal(teamResult.code, 1);
    assert.match(teamResult.stderr, /unknown flag: --team/);
  });
});

test('handoff.mjs: one file per horde', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('read says fresh start when nothing has been written yet', () => {
    assert.match(run('handoff.mjs', ['read'], dir, { json: false }).stdout, /fresh start — no handoff recorded/);
  });

  await t.test('write requires --summary', () => {
    assert.equal(run('handoff.mjs', ['write'], dir).code, 1);
  });

  await t.test('write --summary records head, summary and next; read reflects it', () => {
    const w = run('handoff.mjs', ['write', '--summary', 'kicked off', '--next', 'spawn worker'], dir);
    assert.equal(w.code, 0);
    assert.equal(w.json.summary, 'kicked off');
    assert.deepEqual(w.json.next, ['spawn worker']);
    assert.match(w.json.head, /@/);
    assert.deepEqual(w.json.inFlight, []);

    const r = run('handoff.mjs', ['read'], dir);
    assert.equal(r.json.summary, 'kicked off');
    assert.deepEqual(r.json.next, ['spawn worker']);
  });

  await t.test('inFlight is drawn from the trunk queue\'s running items, with no team field', () => {
    const id = mkTicket(dir, 'first');
    run('queue.mjs', ['add', id], dir);
    const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker1'], dir);
    assert.equal(running.code, 0);

    const w = run('handoff.mjs', ['write', '--summary', 'work in progress'], dir);
    assert.equal(w.code, 0);
    assert.equal(w.json.inFlight.length, 1);
    assert.equal(w.json.inFlight[0].ticket, id);
    assert.equal(w.json.inFlight[0].agent, 'worker1');
    assert.ok(w.json.inFlight[0].branch);
    assert.ok(!('team' in w.json.inFlight[0]), 'inFlight entries no longer carry a team field');
  });

  await t.test('add-waiting and rm-waiting', () => {
    run('handoff.mjs', ['add-waiting', 'chairman', 'approve node cut'], dir);
    const r = run('handoff.mjs', ['read'], dir);
    assert.equal(r.json.waitingOn.length, 1);
    assert.equal(r.json.waitingOn[0].who, 'chairman');
    assert.equal(r.json.waitingOn[0].what, 'approve node cut');

    const missing = run('handoff.mjs', ['add-waiting', 'chairman'], dir);
    assert.equal(missing.code, 1);

    const removed = run('handoff.mjs', ['rm-waiting', 'chairman'], dir);
    assert.equal(removed.code, 0);
    assert.equal(removed.json.removed, 1);

    const after = run('handoff.mjs', ['read'], dir);
    assert.equal(after.json.waitingOn.length, 0);
  });
});
