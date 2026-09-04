import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

test('handoff.mjs: --by decides the file, not --team', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  // teamPath() resolves a --team leaf through roster.json's own steward entries, so any team
  // this test addresses has to actually exist there first — "orcs" deliberately gets no writes
  // of its own, to prove reading an untouched (but real) team still comes back empty.
  run('roster.mjs', ['spawn', 'steward', '--team', 'goblins', '--parent', 'trunk', '--class', 'sonnet'], dir);
  run('roster.mjs', ['spawn', 'steward', '--team', 'orcs', '--parent', 'trunk', '--class', 'sonnet'], dir);

  await t.test('read says fresh start when nothing has been written, with or without --by', () => {
    assert.match(run('handoff.mjs', ['read'], dir, { json: false }).stdout, /fresh start/);
    assert.match(run('handoff.mjs', ['read', '--by', 'director'], dir, { json: false }).stdout, /fresh start/);
    assert.match(run('handoff.mjs', ['read', '--by', 'steward'], dir, { json: false }).stdout, /fresh start/);
  });

  await t.test('write requires --summary, and refuses a bad --by', () => {
    assert.equal(run('handoff.mjs', ['write'], dir).code, 1);
    assert.equal(run('handoff.mjs', ['write', '--summary', 'x', '--by', 'chairman'], dir).code, 1);
  });

  await t.test('write --by director (the default) writes the mission-level file regardless of --team', () => {
    const w = run('handoff.mjs', ['write', '--summary', 'kicked off', '--next', 'spawn steward'], dir);
    assert.equal(w.code, 0);
    assert.equal(w.json.summary, 'kicked off');
    assert.deepEqual(w.json.next, ['spawn steward']);
    assert.match(w.json.head, /@/);

    const r = run('handoff.mjs', ['read', '--by', 'director'], dir);
    assert.equal(r.json.summary, 'kicked off');

    // The exact bug this fixes: --by director with a --team present must NOT touch that team's file.
    const withStrayTeam = run('handoff.mjs', ['write', '--summary', 'still mission', '--team', 'goblins'], dir);
    assert.equal(withStrayTeam.code, 0);
    const missionAfter = run('handoff.mjs', ['read', '--by', 'director'], dir);
    assert.equal(missionAfter.json.summary, 'still mission');
    const goblinsStillFresh = run('handoff.mjs', ['read', '--by', 'steward', '--team', 'goblins'], dir, { json: false });
    assert.match(goblinsStillFresh.stdout, /fresh start/);
  });

  await t.test('write --by steward --team t writes that team\'s own file, separate from the mission\'s', () => {
    const w = run('handoff.mjs', ['write', '--summary', 'steward state', '--by', 'steward', '--team', 'goblins'], dir);
    assert.equal(w.code, 0);
    assert.equal(w.json.summary, 'steward state');

    const teamRead = run('handoff.mjs', ['read', '--by', 'steward', '--team', 'goblins'], dir);
    assert.equal(teamRead.json.summary, 'steward state');

    const missionRead = run('handoff.mjs', ['read', '--by', 'director'], dir);
    assert.equal(missionRead.json.summary, 'still mission');
  });

  await t.test('read without --by prints both, mission first, when both exist', () => {
    const r = run('handoff.mjs', ['read', '--team', 'goblins'], dir);
    assert.equal(r.json.mission.summary, 'still mission');
    assert.equal(r.json.team.summary, 'steward state');

    const human = run('handoff.mjs', ['read', '--team', 'goblins'], dir, { json: false });
    const directorIdx = human.stdout.indexOf('Director (mission)');
    const stewardIdx = human.stdout.indexOf('Steward (goblins)');
    assert.ok(directorIdx >= 0 && stewardIdx >= 0 && directorIdx < stewardIdx);
  });

  await t.test('read without --by prints only what exists for an untouched team', () => {
    const r = run('handoff.mjs', ['read', '--team', 'orcs'], dir);
    assert.equal(r.json.mission.summary, 'still mission');
    assert.equal(r.json.team, null);
  });

  await t.test('add-waiting and rm-waiting respect --by/--team the same way', () => {
    run('handoff.mjs', ['add-waiting', 'chairman', 'approve node cut'], dir);
    const missionWait = run('handoff.mjs', ['read', '--by', 'director'], dir);
    assert.equal(missionWait.json.waitingOn.length, 1);
    assert.equal(missionWait.json.waitingOn[0].who, 'chairman');

    const stewardWait = run('handoff.mjs', ['read', '--by', 'steward', '--team', 'goblins'], dir);
    assert.equal(stewardWait.json.waitingOn.length, 0);

    run('handoff.mjs', ['add-waiting', 'owner-auth', 'review the boundary', '--by', 'steward', '--team', 'goblins'], dir);
    const stewardWaitAfter = run('handoff.mjs', ['read', '--by', 'steward', '--team', 'goblins'], dir);
    assert.equal(stewardWaitAfter.json.waitingOn.length, 1);

    const removed = run('handoff.mjs', ['rm-waiting', 'chairman'], dir);
    assert.equal(removed.json.removed, 1);
    const missionAfter = run('handoff.mjs', ['read', '--by', 'director'], dir);
    assert.equal(missionAfter.json.waitingOn.length, 0);
    // the team's own waiting-on entry is untouched by a mission-scoped rm-waiting
    const stewardStill = run('handoff.mjs', ['read', '--by', 'steward', '--team', 'goblins'], dir);
    assert.equal(stewardStill.json.waitingOn.length, 1);
  });
});
