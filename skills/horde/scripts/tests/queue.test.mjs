import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ---- one write per merge -------------------------------------------------------------
//
// A merge is one event. The queue holds the state; the wave journal is what `wave.mjs close`
// reads to work out which evidence rows this wave turned green. Setting the item merged writes
// both, so the catalogue cannot sit at zero because a second, separate command was forgotten.

function writeMergeableTicket(dir, ticket, { evidenceId = 'E1', verifier = 'verifier-1' } = {}) {
  const ticketDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', `${ticket}-slug`);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(join(ticketDir, 'issue.md'), [
    `# ${ticket} · slug`, '',
    '**Status:** landed',
    '**Node:** auth · **Class:** sonnet · **Severity:** medium · **Team:** trunk',
    `**Depends on:** none · **Branch:** mission1/t-${ticket}`,
    `**Keys:** author worker-1 · verifier ${verifier} · auth owner-1`, '',
    '## Acceptance — evidence', '', `- [x] covers ${evidenceId}`, '',
  ].join('\n'));
  writeFileSync(
    join(ticketDir, 'log.md'),
    `## Verdict · ${ticket} · 2026-01-01 · by ${verifier} (sonnet)\n\n**Result:** reproduced\n`,
  );
}

test('queue.mjs set merged: the merge is recorded in the wave journal by the same write', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  writeFileSync(charterPath, readFileSync(charterPath, 'utf8').replace('| | | | |', '| E1 | some check | auth | |'));
  writeMergeableTicket(dir, '001');

  const queuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json');
  const doc = JSON.parse(readFileSync(queuePath, 'utf8'));
  doc.items.push({
    ticket: '001', state: 'landed', class: 'sonnet', branch: null, worktree: null, dependsOn: [], agent: 'worker-1', sha: null, notes: [],
  });
  writeFileSync(queuePath, JSON.stringify(doc, null, 2));

  run('wave.mjs', ['start'], dir);
  const merged = run('queue.mjs', ['set', '001', 'merged', '--sha', 'abc1234'], dir);
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(merged.json.journal.appended, true);

  const plan = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
  assert.match(plan, /merged: 001 abc1234/);

  // …and that one write is enough for the catalogue to go green at wave close.
  const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.equal(closed.json.green, 1);
  assert.equal(closed.json.total, 1);

  // The older habit of also calling wave.mjs merged records nothing twice.
  const again = run('wave.mjs', ['merged', '001', 'abc1234'], dir);
  assert.equal(again.json.appended, false);
  const planAfter = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
  assert.equal(planAfter.match(/merged: 001 abc1234/g).length, 1);
});

// ---- a ticket started from an unmerged dependency (a stack) ---------------------------------
//
// A chain of three tickets used to cost three waves of wall-clock: each one waited for the one
// before it to be merged before it could even be cut. Started from the dependency's own tip
// instead, the second is written and reviewed while the first is still in flight, and only the
// merge order still waits.

function keysFor(dir, ticket, { author = 'worker1', owner = 'owner1', verifier = 'verifier1', branch }) {
  run('tk.mjs', ['key', ticket, 'author', '--by', author], dir);
  const tip = git(['rev-parse', '--short', branch], dir);
  run('verify.mjs', ['record', ticket, '--verdict', 'reproduced', '--revert', 'no-new-tests', '--by', verifier, '--ran', 'x', '--saw', 'y', '--gate', 'green', '--sha', tip], dir);
  run('tk.mjs', ['review', ticket, 'approve', '--by', owner], dir);
}

test('queue.mjs: a ticket started from an unmerged dependency (a stack)', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const first = readyTicket(dir, 'first-link');
  const second = readyTicket(dir, 'second-link');
  const loose = readyTicket(dir, 'loose-end');
  run('queue.mjs', ['add', first], dir);
  run('queue.mjs', ['add', second, '--depends', first], dir);
  run('queue.mjs', ['add', loose], dir);

  await t.test('--on refuses a dependency that has not started — there is no tip to start from', () => {
    const r = run('queue.mjs', ['set', second, 'running', '--on', first], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is queued — only a running or landed ticket has a tip to start from/);
  });

  const parent = run('queue.mjs', ['set', first, 'running', '--agent', 'w1'], dir);
  git(['-C', parent.json.worktree, 'commit', '--allow-empty', '-qm', 'the first link'], dir);

  await t.test('a fully ready ticket is still offered first; --stack offers the dependent one after it', () => {
    assert.equal(run('queue.mjs', ['next'], dir).json.ticket, loose);
    const withReady = run('queue.mjs', ['next', '--stack'], dir);
    assert.equal(withReady.json.ticket, loose);
    assert.equal(withReady.json.stackReady, false);

    run('queue.mjs', ['set', loose, 'running', '--agent', 'w0'], dir);
    assert.equal(run('queue.mjs', ['next'], dir).json, null);

    const offered = run('queue.mjs', ['next', '--stack'], dir);
    assert.equal(offered.json.ticket, second);
    assert.equal(offered.json.stackReady, true);
    assert.deepEqual(offered.json.stackOn, [first]);
    const printed = run('queue.mjs', ['next', '--stack'], dir, { json: false });
    assert.match(printed.stdout, new RegExp(`stack-ready on ${first}`));
  });

  await t.test('--on refuses a ticket in another team, and one this ticket does not depend on', () => {
    run('roster.mjs', ['spawn', 'steward', '--team', 'allies', '--parent', 'trunk', '--class', 'sonnet'], dir);
    const away = run('tk.mjs', ['new', 'away-ticket', '--title', 'Away', '--node', 'core', '--class', 'sonnet', '--team', 'allies'], dir).json.id;
    run('queue.mjs', ['add', away, '--team', 'allies'], dir);
    const otherTeam = run('queue.mjs', ['set', second, 'running', '--on', `allies:${away}`], dir);
    assert.equal(otherTeam.code, 1);
    assert.match(otherTeam.stderr, /belongs to team allies, not trunk/);

    const notADep = run('queue.mjs', ['set', loose, 'running', '--on', first], dir);
    assert.equal(notADep.code, 1);
    assert.match(notADep.stderr, new RegExp(`${loose} does not depend on ${first}`));
  });

  await t.test('--on outside "running" is refused — nothing else cuts a branch', () => {
    const r = run('queue.mjs', ['set', second, 'landed', '--on', first], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--on only goes with "set <ticket> running"/);
  });

  let child = null;
  await t.test('running --on cuts the branch from the dependency\'s tip, not the team\'s, and records it', () => {
    const r = run('queue.mjs', ['set', second, 'running', '--agent', 'w2', '--on', first], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.stackedOn, first);
    child = r.json;

    const parentTip = git(['rev-parse', parent.json.branch], dir);
    assert.equal(git(['merge-base', parentTip, r.json.branch], dir), parentTip);
    assert.notEqual(git(['rev-parse', 'mission1/trunk'], dir), parentTip);
    assert.ok(r.json.notes.some((n) => new RegExp(`stacked on ${first}`).test(n.text)));

    const md = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.md'), 'utf8');
    assert.match(md, new RegExp(`stacked on ${first}`));
  });

  await t.test('merged is refused while the dependency has not merged, keys or no keys', () => {
    keysFor(dir, second, { author: 'w2', branch: child.branch });
    const r = run('queue.mjs', ['set', second, 'merged', '--sha', 'abc1234'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${second} depends on ${first}, still unmerged`));
  });

  await t.test('the dependency merging clears the stack, by the same write', () => {
    keysFor(dir, first, { author: 'w1', branch: parent.json.branch });
    git(['checkout', 'mission1/trunk'], dir);
    git(['merge', '--no-ff', parent.json.branch, '-m', `merge ${first}`], dir);
    const sha = git(['rev-parse', '--short', 'mission1/trunk'], dir);
    const merged = run('queue.mjs', ['set', first, 'merged', '--sha', sha], dir);
    assert.equal(merged.code, 0, merged.stderr);

    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === second);
    assert.equal(item.stackedOn, null);
    assert.ok(item.notes.some((n) => /merged — base is mission1\/trunk from now on/.test(n.text)));
  });

  await t.test('--on refuses a dependency that has already merged — its work is on the team branch', () => {
    const third = readyTicket(dir, 'third-link');
    run('queue.mjs', ['add', third, '--depends', first], dir);
    const r = run('queue.mjs', ['set', third, 'running', '--on', first], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is already merged/);
  });

  await t.test('and then the stacked ticket merges in its turn', () => {
    const sha = git(['rev-parse', '--short', child.branch], dir);
    const r = run('queue.mjs', ['set', second, 'merged', '--sha', sha], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'merged');
  });
});

test('queue.mjs reconcile: a stacked ticket carrying only its parent\'s commits is not mistaken for landed', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const first = readyTicket(dir, 'the-base');
  const second = readyTicket(dir, 'the-stack');
  run('queue.mjs', ['add', first], dir);
  run('queue.mjs', ['add', second, '--depends', first], dir);

  const parent = run('queue.mjs', ['set', first, 'running', '--agent', 'w1'], dir);
  git(['-C', parent.json.worktree, 'commit', '--allow-empty', '-qm', 'the parent works'], dir);
  const stacked = run('queue.mjs', ['set', second, 'running', '--agent', 'w2', '--on', first], dir);
  assert.equal(stacked.code, 0, stacked.stderr);

  // Two commits beyond the team branch, both the parent's. Measured against the team branch this
  // reads as work done; measured against the branch it was actually cut from, as the empty start
  // it is — so the ticket goes back on the queue instead of being reported landed.
  const r = run('queue.mjs', ['reconcile'], dir);
  assert.equal(r.code, 0, r.stderr);
  const states = Object.fromEntries(r.json.map((x) => [x.ticket, x.state]));
  assert.equal(states[first], 'landed');
  assert.equal(states[second], 'queued');

  // …and its own commit does land it.
  const back = run('queue.mjs', ['set', second, 'running', '--agent', 'w2', '--on', first], dir);
  assert.equal(back.code, 0, back.stderr);
  git(['-C', back.json.worktree, 'commit', '--allow-empty', '-qm', 'the stack works'], dir);
  const after = run('queue.mjs', ['reconcile'], dir);
  assert.equal(after.json.find((x) => x.ticket === second).state, 'landed');
});
