import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, readFileSync, writeFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function readyTicket(dir, slug, { severity, node = 'core' } = {}) {
  const extra = severity ? ['--severity', severity] : [];
  const r = run('tk.mjs', ['new', slug, '--title', slug, '--node', node, '--class', 'sonnet', ...extra, '--evidence', 'it works'], dir);
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
  const r = run('tk.mjs', ['new', slug, '--title', slug, ...flags, '--evidence', 'it works'], dir);
  if (r.code !== 0) throw new Error(`tk new (${slug}) failed: ${r.stderr}`);
  return r.json.id;
}

test('queue.mjs: add, set (running/merged with real branches+worktrees), next, rm, reconcile', async (t) => {
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

  await t.test('set merged refuses without --sha — no approval/keys gate exists any more', () => {
    const r = run('queue.mjs', ['set', id1, 'merged'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires --sha/);
  });

  await t.test('set merged succeeds with just --sha once dependencies are satisfied, removing the worktree then the branch', () => {
    const sha = git(['rev-parse', '--short', `mission1/t-${id1}`], dir);
    const r = run('queue.mjs', ['set', id1, 'merged', '--sha', sha], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.worktree, null);
    const branches = git(['branch', '--list', `mission1/t-${id1}`], dir);
    assert.equal(branches, '');
    const worktrees = git(['worktree', 'list'], dir);
    assert.doesNotMatch(worktrees, new RegExp(`t-${id1}(?!\\d)`));
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

  await t.test('add --depends refuses a colon-bearing dependency — team-scoped dependencies no longer exist', () => {
    const freshTicket = readyTicket(dir, 'fresh-for-add-refusal', { severity: 'medium' });
    const r = run('queue.mjs', ['add', freshTicket, '--depends', 'sometat:007'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /team-scoped dependencies no longer exist/);
  });

  await t.test('dep --on refuses a colon-bearing dependency — team-scoped dependencies no longer exist', () => {
    const own = readyTicket(dir, 'own-tick', { severity: 'medium' });
    run('queue.mjs', ['add', own], dir);
    const r = run('queue.mjs', ['dep', own, '--on', 'someteam:team:x'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /team-scoped dependencies no longer exist/);
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

// ---- a ticket started from an unmerged dependency (a stack) ---------------------------------
//
// A chain of three tickets used to cost three waves of wall-clock: each one waited for the one
// before it to be merged before it could even be cut. Started from the dependency's own tip
// instead, the second is written and reviewed while the first is still in flight, and only the
// merge order still waits.

test('queue.mjs: a ticket started from an unmerged dependency (a stack)', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  // The shape a chain actually has: the second consumes what the first delivers, so they sit on
  // different nodes and touch different files. Sharing a file with the ticket you would stand on
  // is the case the file lock refuses, and it has its own test below.
  const first = mkTicket(dir, 'first-link', { node: 'core', files: 'src/core/a.ts' });
  const second = mkTicket(dir, 'second-link', { node: 'edge', files: 'src/edge/b.ts' });
  const loose = mkTicket(dir, 'loose-end', { node: 'far', files: 'src/far/c.ts' });
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

  await t.test('--on refuses a colon-bearing (team-scoped) dependency, and a ticket this one does not depend on', () => {
    const colonRef = run('queue.mjs', ['set', second, 'running', '--on', 'allies:999'], dir);
    assert.equal(colonRef.code, 1);
    assert.match(colonRef.stderr, /team-scoped dependencies no longer exist/);

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

  await t.test('merged is refused while the dependency has not merged', () => {
    const r = run('queue.mjs', ['set', second, 'merged', '--sha', 'abc1234'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${second} depends on ${first}, still unmerged`));
  });

  await t.test('the dependency merging clears the stack, by the same write', () => {
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

// The two orderings meeting: a stack-ready ticket is offered after every ready one, ranked among
// its own kind by the same rules, and it is held to the same file lock — the tip it would start
// from is usually the very ticket holding the file, and two workers editing it at once is what
// the lock exists to stop.
test('queue.mjs next --stack: stack-ready tickets rank below every ready one, and a shared file locks them out too', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const running = mkTicket(dir, 'in-flight', { node: 'core', files: 'src/core/a.ts', severity: 'low' });
  const sharesFile = mkTicket(dir, 'shares-the-file', { node: 'core', files: 'src/core/a.ts', severity: 'high' });
  const clearLow = mkTicket(dir, 'clear-but-low', { node: 'edge', files: 'src/edge/b.ts', severity: 'low' });
  const clearHigh = mkTicket(dir, 'clear-and-high', { node: 'far', files: 'src/far/c.ts', severity: 'high' });
  const ready = mkTicket(dir, 'nothing-in-front', { node: 'sky', files: 'src/sky/d.ts', severity: 'low' });
  for (const id of [running, sharesFile, clearLow, clearHigh, ready]) run('queue.mjs', ['add', id], dir);
  run('queue.mjs', ['dep', sharesFile, '--on', running], dir);
  run('queue.mjs', ['dep', clearLow, '--on', running], dir);
  run('queue.mjs', ['dep', clearHigh, '--on', running], dir);
  run('queue.mjs', ['set', running, 'running', '--agent', 'w1'], dir);

  await t.test('a ready ticket comes first even at the lowest severity', () => {
    const r = run('queue.mjs', ['next', '--stack'], dir);
    assert.equal(r.json.ticket, ready);
    assert.equal(r.json.stackReady, false);
  });

  await t.test('with nothing ready, the stack-ready ones are ranked by the usual rules', () => {
    run('queue.mjs', ['set', ready, 'running', '--agent', 'w2'], dir);
    assert.equal(run('queue.mjs', ['next'], dir).json, null);
    const r = run('queue.mjs', ['next', '--stack'], dir);
    assert.equal(r.json.ticket, clearHigh, 'high severity leads among the stack-ready ones');
    assert.equal(r.json.stackReady, true);
    assert.deepEqual(r.json.stackOn, [running]);
  });

  await t.test('the ticket sharing a file with the one it would stand on is never offered', () => {
    const why = run('queue.mjs', ['next', '--stack', '--why'], dir);
    const rows = Object.fromEntries(why.json.entries.map((e) => [e.ticket, e]));
    assert.equal(rows[sharesFile].eligible, false);
    assert.match(rows[sharesFile].reason, new RegExp(`locked — running ticket ${running} also holds file\\(s\\) src/core/a.ts`));
    assert.equal(rows[clearHigh].eligible, true);
    assert.deepEqual(rows[clearHigh].stackOn, [running]);
    assert.equal(rows[clearLow].rank > rows[clearHigh].rank, true);
  });

  await t.test('without --stack, --why says which tip each of them could have started from', () => {
    const why = run('queue.mjs', ['next', '--why'], dir);
    const row = why.json.entries.find((e) => e.ticket === clearHigh);
    assert.equal(row.eligible, false);
    assert.match(row.reason, new RegExp(`waiting on dependency ${running} — could be started on top of ${running} \\(--stack\\)`));
  });
});

// provisionTree (_lib.mjs), through the one CLI path that calls it today: "set <ticket> running"
// cutting a ticket's own worktree. config.worktree.copy names repository-root-relative paths
// copied into that worktree the moment it is made.
test('queue.mjs set running: provisionTree copies config.worktree.copy into the new worktree', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('an untracked file named in worktree.copy is copied into the new worktree', () => {
    writeFileSync(join(dir, 'env.local'), 'secret=1\n');
    run('horde.mjs', ['config', 'set', 'worktree.copy', 'env.local'], dir);
    const id = readyTicket(dir, 'copies-env');
    run('queue.mjs', ['add', id], dir);
    const set = run('queue.mjs', ['set', id, 'running'], dir);
    assert.equal(set.code, 0, set.stderr);
    assert.equal(readFileSync(join(set.json.worktree, 'env.local'), 'utf8'), 'secret=1\n');
  });

  await t.test('a worktree.copy entry git already tracks is refused before the tree is created', () => {
    run('horde.mjs', ['config', 'set', 'worktree.copy', 'README.md'], dir);
    const id = readyTicket(dir, 'tracked-copy');
    run('queue.mjs', ['add', id], dir);
    const set = run('queue.mjs', ['set', id, 'running'], dir);
    assert.equal(set.code, 1);
    assert.match(set.stderr, /README\.md/);
    assert.match(set.stderr, /already tracks/);
    assert.equal(existsSync(join(dir, '.horde', 'worktrees', 'mission1', `t-${id}`)), false);
  });

  await t.test('a worktree.copy entry that does not exist is refused, naming the path — not a silent skip', () => {
    run('horde.mjs', ['config', 'set', 'worktree.copy', 'never-written.txt'], dir);
    const id = readyTicket(dir, 'missing-copy');
    run('queue.mjs', ['add', id], dir);
    const set = run('queue.mjs', ['set', id, 'running'], dir);
    assert.equal(set.code, 1);
    assert.match(set.stderr, /never-written\.txt/);
  });

  await t.test('two "set running" calls at the same ticket: the second is a no-op, never a crash, never a second copy', () => {
    writeFileSync(join(dir, 'once.txt'), 'v1\n');
    run('horde.mjs', ['config', 'set', 'worktree.copy', 'once.txt'], dir);
    const id = readyTicket(dir, 'idempotent-copy');
    run('queue.mjs', ['add', id], dir);
    const first = run('queue.mjs', ['set', id, 'running'], dir);
    assert.equal(first.code, 0, first.stderr);
    const copiedPath = join(first.json.worktree, 'once.txt');
    assert.equal(readFileSync(copiedPath, 'utf8'), 'v1\n');

    // Changing the source after the tree exists must not leak into it on a second call — the
    // worktree, once made, is the worker's own; a repeated "set running" does not reach back in.
    writeFileSync(join(dir, 'once.txt'), 'v2\n');
    const second = run('queue.mjs', ['set', id, 'running'], dir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(readFileSync(copiedPath, 'utf8'), 'v1\n');
  });
});
