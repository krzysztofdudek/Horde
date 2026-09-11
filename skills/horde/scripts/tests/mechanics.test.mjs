// Mechanical scenario tests for the horde skill's tools — each scenario is driven entirely
// through the CLIs (--json) on its own temporary git repository, the same way lifecycle.test.mjs
// drives a whole mini-wave.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, addNode, writeCostRuns,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Merges `sourceBranch` into `targetBranch` from a scratch worktree — nothing checks out another
// branch in the same worktree a ticket branch lives in, per model.md's rule (lifecycle.test.mjs
// does the same). Reuses a worktree already checked out on targetBranch when one exists (git
// refuses a second one on the same branch outright), and only falls back to a scratch worktree
// (removed again afterward) when it doesn't.
function findWorktreeForBranch(dir, branch) {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  for (const block of out.split('\n\n')) {
    const pathMatch = /^worktree (.+)$/m.exec(block);
    const branchMatch = /^branch refs\/heads\/(.+)$/m.exec(block);
    if (pathMatch && branchMatch && branchMatch[1] === branch) return pathMatch[1];
  }
  return null;
}

function mergeBranch(dir, targetBranch, sourceBranch, message) {
  const existing = findWorktreeForBranch(dir, targetBranch);
  const wt = existing || mkdtempSync(join(tmpdir(), 'merge-'));
  if (!existing) git(['worktree', 'add', wt, targetBranch], dir);
  git(['merge', '--no-ff', sourceBranch, '-m', message], wt);
  const sha = git(['rev-parse', '--short', 'HEAD'], wt);
  if (!existing) git(['worktree', 'remove', '--force', wt], dir);
  return sha;
}

// Runs a ticket from "running" all the way to a real merge into `intoBranch`, returning the
// merge sha. `write(worktreePath)` makes whatever change the caller wants inside the worker's
// worktree before it's committed.
//
// This used to also carry a review-and-verify leg (tk.mjs key/review-request/review, the deleted verify tool
// record) between landing and merging — task 014 deleted tk.mjs's review/key commands and
// the deleted verify tool outright, and queue.mjs's own merge no longer checks any keys or approvals at all
// (only dependency order and --sha), so that leg is gone rather than reworked.
function landAndMerge(dir, {
  id, team, worker, intoBranch, write, horde,
}) {
  const hordeFlag = horde ? ['--horde', horde] : [];
  const teamFlag = team ? ['--team', team] : [];
  const running = run('queue.mjs', ['set', id, 'running', '--agent', worker, ...teamFlag, ...hordeFlag], dir);
  assert.equal(running.code, 0, running.stderr);
  const worktree = running.json.worktree;
  const branch = running.json.branch;
  write(worktree);
  git(['add', '-A'], worktree);
  git(['commit', '-qm', `ticket ${id}`], worktree);
  const landedSha = git(['rev-parse', '--short', branch], dir);

  assert.equal(run('tk.mjs', ['log', id, `landed ${landedSha}`, ...hordeFlag], dir).code, 0);

  const mergeSha = mergeBranch(dir, intoBranch, branch, `merge ticket ${id}`);
  const merged = run('queue.mjs', ['set', id, 'merged', '--sha', mergeSha, ...teamFlag, ...hordeFlag], dir);
  assert.equal(merged.code, 0, merged.stderr);
  return { worktree, branch, landedSha, mergeSha };
}

// ---------------------------------------------------------------------------------------------
// 1. Two hordes on one repository
// ---------------------------------------------------------------------------------------------

test('two hordes on one repository: independent state, shared refusal without --horde', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'red');
  initHorde(dir, 'blue');

  await t.test('both create ticket 001 and set it running, each in its own worktree', () => {
    for (const horde of ['red', 'blue']) {
      const t1 = run('tk.mjs', ['new', 'sample', '--title', 'Sample', '--node', 'x', '--class', 'sonnet', '--horde', horde, '--evidence', 'it works'], dir);
      assert.equal(t1.code, 0, t1.stderr);
      assert.equal(t1.json.id, '001');
      const queued = run('queue.mjs', ['add', '001', '--horde', horde], dir);
      assert.equal(queued.code, 0, queued.stderr);
      const running = run('queue.mjs', ['set', '001', 'running', '--agent', 'w', '--horde', horde], dir);
      assert.equal(running.code, 0, running.stderr);
      assert.equal(running.json.branch, `${horde}/t-001`);
      assert.ok(running.json.worktree.endsWith(join('.horde', 'worktrees', horde, 't-001')), running.json.worktree);
      assert.equal(existsSync(join(dir, '.horde', 'worktrees', horde, 't-001')), true);
    }
  });

  await t.test('status --json (no --horde) lists both hordes', () => {
    const status = run('status.mjs', ['--json'], dir);
    assert.equal(status.code, 0, status.stderr);
    const names = status.json.hordes.map((h) => h.name).sort();
    assert.deepEqual(names, ['blue', 'red']);
  });

  await t.test('every horde-scoped tool refuses without --horde, and works with it', () => {
    for (const [tool, args] of [['tk.mjs', ['list']], ['queue.mjs', ['list']]]) {
      const bare = run(tool, args, dir);
      assert.equal(bare.code, 1, `${tool} ${args.join(' ')} should refuse without --horde`);
      assert.match(bare.stderr, /multiple hordes exist/, `${tool}: expected the multi-horde refusal`);

      const scoped = run(tool, [...args, '--horde', 'red'], dir);
      assert.equal(scoped.code, 0, `${tool} --horde red should work: ${scoped.stderr}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Cold boot with three tickets
// ---------------------------------------------------------------------------------------------
// (Formerly test 2 here was "sub-team merge-up: alfa off trunk" — task 014 removed sub-teams
// entirely: the deleted roster tool (the only thing that ever spawned a steward for a non-trunk team, or
// recorded its parent so _lib.mjs's teamPath() could resolve one) is deleted outright, so
// `--team` now only ever resolves to "trunk"; anything else fails with "no such team" since
// nothing can ever create one. land.mjs's own `--level team` is refused for the same reason,
// and queue.mjs's `move` and `<team>:NNN` addressing are gone. There is no way left to construct
// this scenario without inventing a sub-team mechanism the product no longer has, so the whole
// test is removed rather than reworked.)

test('cold boot: queue reconcile sorts three running tickets by their actual git state', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const ids = {};
  for (const slug of ['ticket-a', 'ticket-b', 'ticket-c']) {
    const t1 = run('tk.mjs', ['new', slug, '--title', slug, '--node', 'x', '--class', 'sonnet', '--evidence', 'it works'], dir);
    assert.equal(t1.code, 0, t1.stderr);
    ids[slug] = t1.json.id;
    assert.equal(run('queue.mjs', ['add', t1.json.id], dir).code, 0);
  }

  // A worker is no longer a roster entry — the deleted roster tool is deleted, and there is nothing left to
  // "spawn": it is just a name string used for --agent/branch naming, same as any other worker.
  const workerName = 'w-cold-boot';

  const runningA = run('queue.mjs', ['set', ids['ticket-a'], 'running', '--agent', workerName], dir);
  const runningB = run('queue.mjs', ['set', ids['ticket-b'], 'running', '--agent', workerName], dir);
  const runningC = run('queue.mjs', ['set', ids['ticket-c'], 'running', '--agent', workerName], dir);
  for (const r of [runningA, runningB, runningC]) assert.equal(r.code, 0, r.stderr);

  // A: a commit beyond the team tip.
  git(['commit', '--allow-empty', '-qm', 'work'], runningA.json.worktree);
  // B: a dirty worktree, no commit.
  writeFileSync(join(runningB.json.worktree, 'scratch.txt'), 'uncommitted\n');
  // C: clean, no commit — left exactly as queue.mjs set it up.

  await t.test('queue reconcile: A lands, B is reclaimed with a wip commit and kept worktree, C goes queued with its worktree gone', () => {
    const reconciled = run('queue.mjs', ['reconcile'], dir);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    const byTicket = Object.fromEntries(reconciled.json.map((r) => [r.ticket, r.state]));
    assert.equal(byTicket[ids['ticket-a']], 'landed');
    assert.equal(byTicket[ids['ticket-b']], 'queued');
    assert.equal(byTicket[ids['ticket-c']], 'queued');

    const list = run('queue.mjs', ['list'], dir).json;
    const itemB = list.find((i) => i.ticket === ids['ticket-b']);
    assert.equal(itemB.worktree, runningB.json.worktree);
    assert.ok(itemB.notes.some((n) => /dirty/.test(n.text)));
    assert.equal(git(['log', '-1', '--format=%s'], itemB.worktree), 'wip: reclaimed');

    const itemC = list.find((i) => i.ticket === ids['ticket-c']);
    assert.equal(itemC.worktree, null);
    assert.equal(existsSync(runningC.json.worktree), false);
  });

  await t.test('brief worker for the reclaimed ticket B renders with no unfilled placeholders', () => {
    const brief = run('brief.mjs', ['worker', ids['ticket-b'], '--name', 'x'], dir);
    assert.equal(brief.code, 0, brief.stderr);
    assert.doesNotMatch(brief.json.brief, /\{\{/);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Dependency after the fact
// ---------------------------------------------------------------------------------------------

test('dependency discovered mid-flight: queue dep blocks and unblocks, and refuses a cycle', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const t1 = run('tk.mjs', ['new', 'needs-x', '--title', 'Needs X', '--node', 'model', '--class', 'sonnet', '--evidence', 'it works'], dir);
  const id1 = t1.json.id;
  assert.equal(run('queue.mjs', ['add', id1], dir).code, 0);
  const running1 = run('queue.mjs', ['set', id1, 'running', '--agent', 'worker1'], dir);
  assert.equal(running1.code, 0, running1.stderr);

  const logged = run('tk.mjs', ['log', id1, 'needs X in node ui'], dir);
  assert.equal(logged.code, 0, logged.stderr);

  const t2 = run('tk.mjs', ['new', 'the-x', '--title', 'The X', '--node', 'ui', '--class', 'sonnet', '--evidence', 'it works'], dir);
  const id2 = t2.json.id;
  assert.equal(run('queue.mjs', ['add', id2], dir).code, 0);

  await t.test('queue dep sends the running item back to queued, dependsOn recorded, worktree kept', () => {
    const dep = run('queue.mjs', ['dep', id1, '--on', id2], dir);
    assert.equal(dep.code, 0, dep.stderr);
    assert.equal(dep.json.state, 'queued');
    assert.deepEqual(dep.json.dependsOn, [id2]);
    assert.equal(dep.json.worktree, running1.json.worktree);
    assert.equal(existsSync(running1.json.worktree), true);
  });

  await t.test('queue next returns the dependency (002), not the blocked ticket (001)', () => {
    const next = run('queue.mjs', ['next'], dir);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(next.json.ticket, id2);
  });

  await t.test('once 002 is merged, queue next returns 001', () => {
    landAndMerge(dir, {
      id: id2, worker: 'worker2', intoBranch: 'mission1/trunk',
      write: (wt) => writeFileSync(join(wt, 'x-file.mjs'), 'export const x = 1;\n'),
    });
    const next = run('queue.mjs', ['next'], dir);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(next.json.ticket, id1);
  });

  await t.test('queue dep 002 --on 001 is refused as a cycle', () => {
    const dep = run('queue.mjs', ['dep', id2, '--on', id1], dir);
    assert.equal(dep.code, 1);
    assert.match(dep.stderr, /cycle/);
  });
});

// ---------------------------------------------------------------------------------------------
// Removed: "contract ticket on two nodes" and "owner is the ticket's author"
// ---------------------------------------------------------------------------------------------
// Both tests lived entirely inside the node-approval-keys mechanism: tk.mjs's `key`/`review`
// commands (multi-node approval, author/reviewer-cannot-be-the-same-person, architect approving
// every named node at once) and the deleted verify tool's `record`. Task 014 deleted the deleted verify tool outright, tk.mjs
// no longer has a `key` or `review` command at all, and queue.mjs's `set <ticket> merged` no
// longer checks any keys or approvals — only dependency order and --sha. There is no remaining
// product behavior that either test could exercise, so both are removed rather than reworked.

// ---------------------------------------------------------------------------------------------
// 3. Ask answer records a decision
// ---------------------------------------------------------------------------------------------

// Formerly this test also covered "a dissent against a ruling is answered exactly once" —
// the deleted dissent tool is deleted outright, and the owner role that used to file a dissent doesn't exist
// any more either, so that coverage (an owner formally disagreeing with a ruling) is genuinely
// gone for now, not replaced with anything. Escalation is gone too (019) — the one channel to the
// client is ask.mjs now.
test('ask answer records a decision', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const ticket = run('tk.mjs', ['new', 'contested', '--title', 'Contested', '--node', 'model', '--class', 'sonnet', '--evidence', 'it works'], dir);
  const id = ticket.json.id;

  const opened = run('ask.mjs', ['add', 'boundary is ambiguous', '--kind', 'stop', '--ticket', id], dir);
  assert.equal(opened.code, 0, opened.stderr);
  const askId = opened.json.id;

  await t.test('ask answer records a decision ask-<id>', () => {
    const answered = run('ask.mjs', ['answer', askId, 'the boundary includes the adapter'], dir);
    assert.equal(answered.code, 0, answered.stderr);
    const decisions = run('decide.mjs', ['list'], dir);
    assert.equal(decisions.code, 0, decisions.stderr);
    assert.ok(decisions.json.some((d) => d.slug === `ask-${askId}`), JSON.stringify(decisions.json));
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Cost limit
// ---------------------------------------------------------------------------------------------

test('cost limit: charter Limit line gates limit-reached and cost report', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');

  const setLimit = (text) => {
    const charter = readFileSync(charterPath, 'utf8').replace(/Limit: .* runs-weighted/, `Limit: ${text} runs-weighted`);
    writeFileSync(charterPath, charter);
  };

  await t.test('three opus runs (weighted 30) pass a Limit: 20 charter line', () => {
    setLimit('20');
    // Nothing writes cost.json any more — the deleted roster tool (the only thing that ever spawned an agent
    // and billed the run) is deleted, and that responsibility hasn't moved to another tool yet —
    // so a test that needs cost data seeds the ledger directly, in the shape cost.mjs reads.
    writeCostRuns(dir, 'mission1', [0, 1, 2].map((i) => ({
      name: `worker-${i}`, role: 'worker', class: 'opus', ticket: null, team: null, wave: null, at: new Date().toISOString(),
    })));
    const reached = run('cost.mjs', ['limit-reached'], dir);
    assert.equal(reached.code, 0, reached.stderr);
    assert.equal(reached.json.reached, true);

    const report = run('cost.mjs', ['report', '--mission'], dir);
    assert.equal(report.code, 0, report.stderr);
    assert.equal(report.json.limit, 20);
    assert.equal(report.json.weighted, 30);
    assert.equal(report.json.reached, true);
  });

  await t.test('Limit: none makes limit-reached exit non-zero even over the old threshold', () => {
    setLimit('none');
    const reached = run('cost.mjs', ['limit-reached'], dir);
    assert.notEqual(reached.code, 0);
    assert.equal(reached.json.reached, false);
  });
});

// ---------------------------------------------------------------------------------------------
// Removed: "owner reclaim"
// ---------------------------------------------------------------------------------------------
// This test was entirely about the deleted roster tool's own lease/reclaim bookkeeping for a spawned owner
// (there is no owner role left to spawn, and the deleted roster tool — spawn, reclaim, list — is deleted
// outright), plus a tk.mjs review call at the end (also deleted). Nothing here survives the
// refactor to rework; removed rather than replaced.

// ---------------------------------------------------------------------------------------------
// 5. The graph, read through the CLI and never written by the horde
// ---------------------------------------------------------------------------------------------

test('the graph: node.mjs reads it through the CLI and writes nothing into it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'core', { mapping: ['packages/core/**'] });
  addNode(dir, 'frontend', { mapping: ['apps/frontend/**'] });

  await t.test('bind lists both components', () => {
    const r = run('node.mjs', ['bind'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.nodes.sort(), ['core', 'frontend']);
  });

  // missionNodes() (what `map` lists) has always had two sources: a roster.json owner entry, or a
  // ticket naming the node. The owner role and the deleted roster tool are both gone, so a ticket is now the
  // only way a node shows up here at all — and its owner column has nothing left to ever populate
  // it, so this checks the honest "nobody holds it" state rather than asserting on a role that no
  // longer exists.
  await t.test('map shows a component a ticket names, with no owner recorded (the owner role no longer exists)', () => {
    const ticket = run('tk.mjs', ['new', 'core-thing', '--title', 'Core thing', '--node', 'core', '--class', 'sonnet', '--evidence', 'it works'], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    const map = run('node.mjs', ['map'], dir);
    assert.equal(map.code, 0, map.stderr);
    const row = map.json.find((r) => r.node === 'core');
    assert.ok(row, JSON.stringify(map.json));
    assert.equal(row.owner, '-');
  });

  await t.test('show reads the boundary from the component document, writes nothing', () => {
    const r = run('node.mjs', ['show', 'frontend'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.boundary, ['apps/frontend/**']);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'frontend', 'charter.md')), false);
  });

  // Formerly there was also a "charter edit writes charter.md beside the component file" case
  // here — node.mjs's `charter edit` command is gone outright (node charters no longer exist at
  // all), so there is nothing left for it to test.

  await t.test('log prints the graph\'s own command without running it (no --run)', () => {
    const r = run('node.mjs', ['log', 'core', 'refactor complete'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ran, undefined);
    assert.match(r.json.command, /log add --node core --reason/);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'core', 'log.md')), false);
  });
});

// ---------------------------------------------------------------------------------------------
// Removed: "liveness verdicts"
// ---------------------------------------------------------------------------------------------
// This was entirely about the deleted roster tool's steward liveness verdict (branch tip / queue.json mtime /
// lastTrace against config.liveness.stewardMinutes) across a parent team and a sub-team.
// the deleted roster tool is deleted outright — there is no steward concept, no liveness verdict, and no
// sub-team left to give one team a busy queue and another an empty one. Nothing here survives to
// rework; removed rather than replaced.

// ---------------------------------------------------------------------------------------------
// 6. Protected path
// ---------------------------------------------------------------------------------------------

test('protected path: land.mjs scope check fails a branch that touches config.protectedPaths', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const setProtected = run('horde.mjs', ['config', 'set', 'protectedPaths', 'package.json'], dir);
  assert.equal(setProtected.code, 0, setProtected.stderr);

  addNode(dir, 'x', { mapping: ['package.json'] });

  const ticket = run('tk.mjs', ['new', 'touches-protected', '--title', 'Touches protected', '--node', 'x', '--class', 'sonnet', '--evidence', 'it works'], dir);
  const id = ticket.json.id;
  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker1'], dir);
  assert.equal(running.code, 0, running.stderr);

  writeFileSync(join(running.json.worktree, 'package.json'), '{"name": "changed"}\n');
  git(['add', '-A'], running.json.worktree);
  git(['commit', '-qm', 'edit protected path'], running.json.worktree);

  // --level team no longer exists (sub-teams are gone) — omitting --level defaults internally to
  // the same gate lookup a bare branch landing on the team branch always used.
  const pm = run('land.mjs', [running.json.branch, '--no-gate'], dir);
  assert.equal(pm.code, 1);
  const scope = pm.json.checks.find((c) => c.name === 'scope');
  assert.equal(scope.ok, false);
  assert.match(scope.note, /protected paths touched: package\.json/);
});

// ---------------------------------------------------------------------------------------------
// Removed: "steward dies after landing but before the author key"
// ---------------------------------------------------------------------------------------------
// The unique thing this test proved — tk.mjs key --from-queue recovering an author key from the
// queue item's recorded agent — no longer exists: tk.mjs's `key` command is deleted outright, and
// there is no author key concept left at all. The other half (queue.mjs reconcile marking a
// running ticket with a commit beyond the team tip as "landed") is not unique to this test — the
// "cold boot" test above already covers exactly that case. Removed rather than reworked.

// ---------------------------------------------------------------------------------------------
// 7. Class overloaded — a queue item waits
// ---------------------------------------------------------------------------------------------

test('class overloaded: a queued item waits, next skips it, reconcile leaves it alone, and set queued resumes it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const heavy = run('tk.mjs', ['new', 'heavy', '--title', 'Heavy', '--node', 'x', '--class', 'opus', '--evidence', 'it works'], dir);
  const light = run('tk.mjs', ['new', 'light', '--title', 'Light', '--node', 'x', '--class', 'sonnet', '--evidence', 'it works'], dir);
  assert.equal(run('queue.mjs', ['add', heavy.json.id], dir).code, 0);
  assert.equal(run('queue.mjs', ['add', light.json.id], dir).code, 0);

  const waited = run('queue.mjs', ['set', heavy.json.id, 'waiting', '--note', 'opus class overloaded'], dir);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(waited.json.state, 'waiting');
  assert.equal(waited.json.branch, null);
  assert.ok(waited.json.notes.some((n) => /overloaded/.test(n.text)));

  await t.test('next skips the waiting item and returns the other queued one', () => {
    const next = run('queue.mjs', ['next'], dir);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(next.json.ticket, light.json.id);
  });

  await t.test('reconcile leaves the waiting item untouched', () => {
    const reconciled = run('queue.mjs', ['reconcile'], dir);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    assert.equal(reconciled.json.some((r) => r.ticket === heavy.json.id), false);
    const stillWaiting = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === heavy.json.id);
    assert.equal(stillWaiting.state, 'waiting');
  });

  await t.test('set queued restores it and next (scoped by class) returns it again', () => {
    const requeued = run('queue.mjs', ['set', heavy.json.id, 'queued'], dir);
    assert.equal(requeued.code, 0, requeued.stderr);
    assert.equal(requeued.json.state, 'queued');

    const next = run('queue.mjs', ['next', '--class', 'opus'], dir);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(next.json.ticket, heavy.json.id);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Two hordes, one with a waiting item
// ---------------------------------------------------------------------------------------------

test('two hordes, one with a waiting item and one without: status --json reports the queue state per horde', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'red');
  initHorde(dir, 'blue');

  const redTicket = run('tk.mjs', ['new', 'red-thing', '--title', 'Red thing', '--node', 'x', '--class', 'sonnet', '--horde', 'red', '--evidence', 'it works'], dir);
  assert.equal(redTicket.code, 0, redTicket.stderr);
  assert.equal(run('queue.mjs', ['add', redTicket.json.id, '--horde', 'red'], dir).code, 0);
  const waited = run('queue.mjs', ['set', redTicket.json.id, 'waiting', '--note', 'class overloaded', '--horde', 'red'], dir);
  assert.equal(waited.code, 0, waited.stderr);

  const blueTicket = run('tk.mjs', ['new', 'blue-thing', '--title', 'Blue thing', '--node', 'x', '--class', 'sonnet', '--horde', 'blue', '--evidence', 'it works'], dir);
  assert.equal(blueTicket.code, 0, blueTicket.stderr);
  assert.equal(run('queue.mjs', ['add', blueTicket.json.id, '--horde', 'blue'], dir).code, 0);

  const status = run('status.mjs', ['--json'], dir);
  assert.equal(status.code, 0, status.stderr);
  const red = status.json.hordes.find((h) => h.name === 'red');
  const blue = status.json.hordes.find((h) => h.name === 'blue');
  assert.equal(red.queue.byState.waiting, 1);
  assert.equal(blue.queue.byState.waiting, undefined);
  assert.equal(blue.queue.byState.queued, 1);
});
