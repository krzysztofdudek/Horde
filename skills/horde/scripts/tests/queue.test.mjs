import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function readyTicket(dir, slug, { severity, node = 'core' } = {}) {
  const extra = severity ? ['--severity', severity] : [];
  const r = run('tk.mjs', ['new', slug, '--title', slug, '--node', node, '--class', 'sonnet', ...extra], dir);
  return r.json.id;
}

test('queue.mjs: add, set (running/merged with real branches+worktrees), next, rm, move, reconcile', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const id1 = readyTicket(dir, 'first', { severity: 'low' });
  const id2 = readyTicket(dir, 'second', { severity: 'high' });

  await t.test('add refuses an unknown ticket', () => {
    const r = run('queue.mjs', ['add', '999'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such ticket/);
  });

  await t.test('add queues both, pulling class from the ticket', () => {
    const r1 = run('queue.mjs', ['add', id1], dir);
    assert.equal(r1.code, 0);
    assert.equal(r1.json.class, 'sonnet');
    run('queue.mjs', ['add', id2], dir);
    const list = run('queue.mjs', ['list'], dir);
    assert.equal(list.json.length, 2);
  });

  await t.test('add refuses a ticket already queued in the team', () => {
    const r = run('queue.mjs', ['add', id1], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already queued/);
  });

  await t.test('next picks the high-severity item first, ahead of the earlier low-severity one', () => {
    const r = run('queue.mjs', ['next'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.ticket, id2);
  });

  await t.test('next honors a dependency that is not yet merged', () => {
    run('queue.mjs', ['rm', id2], dir);
    const third = readyTicket(dir, 'third', { severity: 'high' });
    run('queue.mjs', ['add', third, '--depends', id1], dir);
    const r = run('queue.mjs', ['next'], dir);
    // id1 (low severity, no deps) is the only one actually ready; third depends on id1
    assert.equal(r.json.ticket, id1);
  });

  await t.test('set running on a real ticket creates a branch and a worktree', () => {
    const r = run('queue.mjs', ['set', id1, 'running', '--agent', 'worker1'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.branch, `mission1/t-${id1}`);
    assert.ok(r.json.worktree.endsWith(`worktrees/mission1/t-${id1}`));
    const branches = git(['branch', '--list', `mission1/t-${id1}`], dir);
    assert.match(branches, new RegExp(`mission1/t-${id1}`));
    const worktrees = git(['worktree', 'list'], dir);
    assert.match(worktrees, new RegExp(`t-${id1}`));
  });

  await t.test('set merged refuses without an author key', () => {
    const r = run('queue.mjs', ['set', id1, 'merged', '--sha', 'abc123'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no author key/);
  });

  await t.test('set merged refuses without a verifier key', () => {
    run('tk.mjs', ['key', id1, 'author', '--by', 'worker1'], dir);
    const r = run('queue.mjs', ['set', id1, 'merged', '--sha', 'abc123'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no verifier key/);
  });

  await t.test('set merged refuses without a node approval', () => {
    const tip = git(['rev-parse', '--short', `mission1/t-${id1}`], dir);
    run('verify.mjs', ['record', id1, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1', '--ran', 'x', '--saw', 'y', '--gate', 'green', '--sha', tip], dir);
    const r = run('queue.mjs', ['set', id1, 'merged', '--sha', 'abc123'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /missing an approval/);
  });

  await t.test('set merged succeeds once all keys are present, removing the worktree then the branch', () => {
    run('tk.mjs', ['review', id1, 'approve', '--by', 'owner1'], dir);
    const sha = git(['rev-parse', '--short', `mission1/t-${id1}`], dir);
    const r = run('queue.mjs', ['set', id1, 'merged', '--sha', sha], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.worktree, null);
    const branches = git(['branch', '--list', `mission1/t-${id1}`], dir);
    assert.equal(branches, '');
    const worktrees = git(['worktree', 'list'], dir);
    assert.doesNotMatch(worktrees, new RegExp(`t-${id1}(?!\\d)`));
  });

  await t.test('move relocates the item to another team\'s queue', () => {
    run('roster.mjs', ['spawn', 'steward', '--team', 'allies', '--parent', 'trunk', '--class', 'sonnet'], dir);
    const third = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket !== id1 && !i.ticket.startsWith('team:'));
    const r = run('queue.mjs', ['move', third.ticket, '--team', 'trunk/allies'], dir);
    assert.equal(r.code, 0);
    const destList = run('queue.mjs', ['list', '--team', 'trunk/allies'], dir);
    assert.equal(destList.json.some((i) => i.ticket === third.ticket), true);
  });

  await t.test('dep adds a dependency; a running item that gains one goes back to queued, keeping its worktree', () => {
    const sixth = readyTicket(dir, 'sixth', { severity: 'medium' });
    const seventh = readyTicket(dir, 'seventh', { severity: 'medium' });
    run('queue.mjs', ['add', sixth], dir);
    run('queue.mjs', ['add', seventh], dir);
    const running = run('queue.mjs', ['set', sixth, 'running', '--agent', 'w'], dir);
    assert.equal(running.json.state, 'running');

    const r = run('queue.mjs', ['dep', sixth, '--on', seventh], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.dependsOn, [seventh]);
    assert.equal(r.json.state, 'queued');
    assert.equal(r.json.worktree, running.json.worktree);

    const list = run('queue.mjs', ['list'], dir);
    const item = list.json.find((i) => i.ticket === sixth);
    assert.equal(item.worktree, running.json.worktree);
    assert.equal(item.branch, running.json.branch);
  });

  await t.test('dep refuses an unknown dependency and a cycle', () => {
    const a = readyTicket(dir, 'a-tick', { severity: 'medium' });
    const b = readyTicket(dir, 'b-tick', { severity: 'medium' });
    run('queue.mjs', ['add', a], dir);
    run('queue.mjs', ['add', b], dir);

    const unknown = run('queue.mjs', ['dep', a, '--on', '999'], dir);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no such dependency: "999"/);

    run('queue.mjs', ['dep', a, '--on', b], dir);
    const cycle = run('queue.mjs', ['dep', b, '--on', a], dir);
    assert.equal(cycle.code, 1);
    assert.match(cycle.stderr, /cycle/);
  });

  await t.test('cross-team dependencies: <team>:NNN and <team>:team:<name> are satisfied only once merged in their own team\'s queue.json', () => {
    run('roster.mjs', ['spawn', 'steward', '--team', 'crows', '--parent', 'trunk', '--class', 'sonnet'], dir);
    run('roster.mjs', ['spawn', 'steward', '--team', 'ravens', '--parent', 'trunk', '--class', 'sonnet'], dir);

    const crowsTicket = run('tk.mjs', ['new', 'crows-thing', '--title', 'Crows thing', '--node', 'x', '--class', 'sonnet', '--team', 'crows'], dir).json.id;
    run('queue.mjs', ['add', crowsTicket, '--team', 'crows'], dir);

    const ravensTicket = run('tk.mjs', ['new', 'ravens-thing', '--title', 'Ravens thing', '--node', 'x', '--class', 'sonnet', '--team', 'ravens'], dir).json.id;
    const added = run('queue.mjs', ['add', ravensTicket, '--depends', `crows:${crowsTicket}`, '--team', 'ravens'], dir);
    assert.equal(added.code, 0, added.stderr);
    assert.deepEqual(added.json.dependsOn, [`crows:${crowsTicket}`]);

    const alsoOnMergeUp = run('queue.mjs', ['dep', ravensTicket, '--on', 'trunk:team:crows', '--team', 'ravens'], dir);
    assert.equal(alsoOnMergeUp.code, 0, alsoOnMergeUp.stderr);

    // neither dependency is merged yet — ravens' ticket is not ready
    const notReady = run('queue.mjs', ['next', '--team', 'ravens'], dir);
    assert.equal(notReady.json, null);

    // merge the crows ticket itself — still not ready, because trunk:team:crows isn't merged
    const running = run('queue.mjs', ['set', crowsTicket, 'running', '--agent', 'w', '--team', 'crows'], dir);
    git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work']);
    const tip = git(['rev-parse', '--short', running.json.branch], dir);
    run('tk.mjs', ['key', crowsTicket, 'author', '--by', 'w', '--team', 'crows'], dir);
    run('tk.mjs', ['review', crowsTicket, 'approve', '--by', 'architect', '--team', 'crows'], dir);
    run('verify.mjs', ['record', crowsTicket, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'v', '--ran', 'x', '--saw', 'y', '--gate', 'green', '--sha', tip, '--team', 'crows'], dir);
    const merged = run('queue.mjs', ['set', crowsTicket, 'merged', '--sha', tip, '--team', 'crows'], dir);
    assert.equal(merged.code, 0, merged.stderr);
    const stillNotReady = run('queue.mjs', ['next', '--team', 'ravens'], dir);
    assert.equal(stillNotReady.json, null);

    // merge crows' own team: item into trunk — now both dependencies are satisfied
    const teamMerged = run('queue.mjs', ['set', 'team:crows', 'merged', '--sha', 'def456', '--team', 'trunk'], dir);
    assert.equal(teamMerged.code, 0, teamMerged.stderr);
    const ready = run('queue.mjs', ['next', '--team', 'ravens'], dir);
    assert.equal(ready.json.ticket, ravensTicket);
  });

  await t.test('dep and add refuse a cross-team dependency naming an unknown team or an unknown item in it', () => {
    const own = readyTicket(dir, 'own-tick', { severity: 'medium' });
    run('queue.mjs', ['add', own], dir);

    const unknownTeam = run('queue.mjs', ['dep', own, '--on', 'nosuchteam:001'], dir);
    assert.equal(unknownTeam.code, 1);
    assert.match(unknownTeam.stderr, /no such team/);

    const unknownItem = run('queue.mjs', ['dep', own, '--on', 'trunk:team:nosuchteam'], dir);
    assert.equal(unknownItem.code, 1);
    assert.match(unknownItem.stderr, /no such dependency/);

    const freshTicket = readyTicket(dir, 'fresh-for-add-refusal', { severity: 'medium' });
    const addRefused = run('queue.mjs', ['add', freshTicket, '--depends', 'trunk:team:nosuchteam'], dir);
    assert.equal(addRefused.code, 1);
    assert.match(addRefused.stderr, /no such dependency/);
  });

  await t.test('reconcile: a running item with a commit beyond the tip lands; a clean one without a commit goes back to queued and loses its worktree; a dirty one is committed as wip and goes back to queued keeping its worktree', async () => {
    const fourth = readyTicket(dir, 'fourth', { severity: 'medium' });
    const fifth = readyTicket(dir, 'fifth', { severity: 'medium' });
    const eighth = readyTicket(dir, 'eighth', { severity: 'medium' });
    run('queue.mjs', ['add', fourth], dir);
    run('queue.mjs', ['add', fifth], dir);
    run('queue.mjs', ['add', eighth], dir);
    const runningFourth = run('queue.mjs', ['set', fourth, 'running', '--agent', 'w'], dir);
    run('queue.mjs', ['set', fifth, 'running', '--agent', 'w'], dir);
    const runningEighth = run('queue.mjs', ['set', eighth, 'running', '--agent', 'w'], dir);
    git(['-C', runningFourth.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
    writeFileSync(`${runningEighth.json.worktree}/scratch.txt`, 'dirty work\n');

    const r = run('queue.mjs', ['reconcile'], dir);
    assert.equal(r.code, 0);
    const results = Object.fromEntries(r.json.map((x) => [x.ticket, x.state]));
    assert.equal(results[fourth], 'landed');
    assert.equal(results[fifth], 'queued');
    assert.equal(results[eighth], 'queued');

    const list = run('queue.mjs', ['list'], dir);
    const fifthItem = list.json.find((i) => i.ticket === fifth);
    assert.equal(fifthItem.worktree, null);

    const eighthItem = list.json.find((i) => i.ticket === eighth);
    assert.equal(eighthItem.worktree, runningEighth.json.worktree);
    assert.ok(eighthItem.notes.some((n) => /dirty/.test(n.text)));
    const log = git(['-C', runningEighth.json.worktree, 'log', '-1', '--format=%s'], dir);
    assert.equal(log, 'wip: reclaimed');
  });
});
