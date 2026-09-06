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

// A ticket with the full range of fields `queue.mjs next` reads: node, class, severity, the
// declared Files a lock is computed from, the Depends-on field a critical path is derived from,
// and the Kind a quality ticket is told apart by.
function mkTicket(dir, slug, opts = {}) {
  const {
    node = 'core', class: cls = 'sonnet', severity, files, depends, kind,
  } = opts;
  const flags = ['--node', node, '--class', cls];
  if (severity) flags.push('--severity', severity);
  if (files) flags.push('--files', files);
  if (depends) flags.push('--depends', depends);
  if (kind) flags.push('--kind', kind);
  const r = run('tk.mjs', ['new', slug, '--title', slug, ...flags], dir);
  if (r.code !== 0) throw new Error(`tk new (${slug}) failed: ${r.stderr}`);
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

// ---- next: locks, critical path, quality-last, --why ---------------------------------

test('queue.mjs next: a running ticket\'s Files lock any ready ticket that shares them; a ticket without Files locks its whole node', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('two tickets naming an overlapping file: the running one locks the other out', () => {
    const runner = mkTicket(dir, 'file-runner', { node: 'core', severity: 'medium', files: 'src/core/shared.ts' });
    const victim = mkTicket(dir, 'file-victim', { node: 'core', severity: 'high', files: 'src/core/shared.ts,src/core/extra.ts' });
    const clear = mkTicket(dir, 'file-clear', { node: 'core', severity: 'low', files: 'src/core/clear.ts' });
    run('queue.mjs', ['add', runner], dir);
    run('queue.mjs', ['add', victim], dir);
    run('queue.mjs', ['add', clear], dir);
    run('queue.mjs', ['set', runner, 'running', '--agent', 'w'], dir);

    const r = run('queue.mjs', ['next', '--class', 'sonnet'], dir);
    assert.equal(r.code, 0);
    // victim shares src/core/shared.ts with the running runner and is skipped despite the higher
    // severity; clear names a disjoint file and is the only sonnet ticket actually ready.
    assert.equal(r.json.ticket, clear);
  });

  await t.test('a ticket with no declared Files locks its whole node — nothing else on it can go next', () => {
    const wideRunner = mkTicket(dir, 'wide-runner', {
      node: 'wide', severity: 'medium', class: 'haiku',
    });
    const wideVictim = mkTicket(dir, 'wide-victim', {
      node: 'wide', severity: 'high', class: 'haiku', files: 'src/wide/anything.ts',
    });
    run('queue.mjs', ['add', wideRunner], dir);
    run('queue.mjs', ['add', wideVictim], dir);
    run('queue.mjs', ['set', wideRunner, 'running', '--agent', 'w'], dir);

    // wideRunner declares no Files, so it locks every file of node "wide" — wideVictim collides
    // even though the two name no file in common, and no haiku ticket is left ready.
    const r = run('queue.mjs', ['next', '--class', 'haiku'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json, null);
  });
});

test('queue.mjs next: at equal severity, the ticket with the longer remaining critical path goes first', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  // A chain of three (weight 3 each, sonnet): completing the root unblocks two more tickets'
  // worth of weighted work behind it — queue.mjs plan's own DAG, read in-process, says its
  // remaining critical path is 9. Neither chain-2 nor chain-3 is ever queued; they exist only to
  // give chain-1 that downstream weight. "solo" has nothing behind it, so its remaining path is
  // just its own weight, 3.
  const chain1 = mkTicket(dir, 'chain-1', { node: 'core', severity: 'medium' });
  const chain2 = mkTicket(dir, 'chain-2', { node: 'core', severity: 'medium', depends: chain1 });
  mkTicket(dir, 'chain-3', { node: 'core', severity: 'medium', depends: chain2 });
  const solo = mkTicket(dir, 'solo', { node: 'core', severity: 'medium' });

  // Queued in the order that would make FIFO alone pick "solo" — the critical path has to be
  // what actually decides this, not queue order.
  run('queue.mjs', ['add', solo], dir);
  run('queue.mjs', ['add', chain1], dir);

  const r = run('queue.mjs', ['next'], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.ticket, chain1);

  const why = run('queue.mjs', ['next', '--why'], dir);
  const rows = Object.fromEntries(why.json.entries.map((e) => [e.ticket, e]));
  assert.equal(rows[chain1].rank, 1);
  assert.equal(rows[solo].rank, 2);
});

test('queue.mjs next: a quality ticket sorts after every non-quality ticket, whatever its severity', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const work = mkTicket(dir, 'work-item', { node: 'core', severity: 'low' });
  const quality = mkTicket(dir, 'quality-item', { node: 'core', severity: 'high', kind: 'quality' });
  // Queued quality-first, so only the kind ordering — never FIFO — explains the result below.
  run('queue.mjs', ['add', quality], dir);
  run('queue.mjs', ['add', work], dir);

  const r = run('queue.mjs', ['next'], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.ticket, work);

  const why = run('queue.mjs', ['next', '--why'], dir);
  const rows = Object.fromEntries(why.json.entries.map((e) => [e.ticket, e]));
  assert.equal(rows[work].rank, 1);
  assert.equal(rows[quality].rank, 2);
});

test('queue.mjs next --why: every queued ticket prints its rank, or the reason it did not qualify', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const dep = mkTicket(dir, 'dep-target', { node: 'core', severity: 'medium' });
  const blocked = mkTicket(dir, 'blocked', { node: 'core', severity: 'high' });
  run('queue.mjs', ['add', dep], dir);
  run('queue.mjs', ['add', blocked, '--depends', dep], dir);
  // "dep" itself never gets merged — "blocked" waits on it forever in this test.

  const runner = mkTicket(dir, 'lock-runner', { node: 'locked-node', severity: 'medium', files: 'src/x/shared.ts' });
  const locked = mkTicket(dir, 'lock-victim', { node: 'locked-node', severity: 'high', files: 'src/x/shared.ts' });
  run('queue.mjs', ['add', runner], dir);
  run('queue.mjs', ['add', locked], dir);
  run('queue.mjs', ['set', runner, 'running', '--agent', 'w'], dir);

  const wrongClass = mkTicket(dir, 'wrong-class', { node: 'core', severity: 'low' });
  run('queue.mjs', ['add', wrongClass], dir);

  const chosen = mkTicket(dir, 'chosen', { node: 'core', severity: 'low', class: 'haiku' });
  run('queue.mjs', ['add', chosen], dir);

  const r = run('queue.mjs', ['next', '--class', 'haiku', '--why'], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.chosen, chosen);

  const rows = r.json.entries;
  const depRow = rows.find((e) => e.ticket === blocked);
  assert.equal(depRow.eligible, false);
  assert.match(depRow.reason, new RegExp(`waiting on dependency ${dep}`));

  const lockRow = rows.find((e) => e.ticket === locked);
  assert.equal(lockRow.eligible, false);
  assert.match(lockRow.reason, new RegExp(`locked.*${runner}.*shared\\.ts`));

  const classRow = rows.find((e) => e.ticket === wrongClass);
  assert.equal(classRow.eligible, false);
  assert.match(classRow.reason, /excluded by --class haiku \(this ticket is sonnet\)/);

  // "runner" is "running", not "queued" — --why never lists it at all.
  assert.equal(rows.find((e) => e.ticket === runner), undefined);

  const chosenRow = rows.find((e) => e.ticket === chosen);
  assert.equal(chosenRow.eligible, true);
  assert.equal(chosenRow.rank, 1);

  const human = run('queue.mjs', ['next', '--why'], dir, { json: false });
  assert.match(human.stdout, new RegExp(`${blocked} \\(sonnet\\) — skipped: waiting on dependency ${dep}`));
  assert.match(human.stdout, new RegExp(`${locked} \\(sonnet\\) — skipped: locked`));
  assert.match(human.stdout, /rank 1 \(chosen\)/);
});
