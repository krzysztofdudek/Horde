import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('roster.mjs: spawn, steward team creation, trace, list --dead, reclaim, stand-down, reconcile', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('spawn refuses an unknown class', () => {
    const r = run('roster.mjs', ['spawn', 'owner', '--node', 'core', '--class', 'bogus'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown class/);
  });

  await t.test('spawn refuses --team and --node together', () => {
    const r = run('roster.mjs', ['spawn', 'owner', '--team', 't', '--node', 'core', '--class', 'sonnet'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not both/);
  });

  await t.test('spawn steward --team without --parent is refused', () => {
    const r = run('roster.mjs', ['spawn', 'steward', '--team', 'allies', '--class', 'sonnet'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires --parent/);
  });

  let ownerName;
  await t.test('spawn reserves a scoped name and books cost', () => {
    const r = run('roster.mjs', ['spawn', 'owner', '--node', 'core', '--class', 'opus'], dir);
    assert.equal(r.code, 0);
    ownerName = r.json.name;
    assert.equal(ownerName, 'mission1-owner-core-1');
    const cost = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'cost.json'), 'utf8'));
    assert.equal(cost.runs.length, 1);
    assert.equal(cost.runs[0].name, ownerName);
    assert.equal(cost.runs[0].role, 'owner');
    assert.equal(cost.runs[0].class, 'opus');
  });

  await t.test('a second spawn for the same node gets N+1', () => {
    const r = run('roster.mjs', ['spawn', 'owner', '--node', 'core', '--class', 'opus'], dir);
    assert.equal(r.json.name, 'mission1-owner-core-2');
  });

  await t.test('spawn steward --team --parent creates the branch, the team directory, and a running item in the parent queue', () => {
    const r = run('roster.mjs', ['spawn', 'steward', '--team', 'allies', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(r.code, 0);
    const stewardName = r.json.name;
    assert.equal(r.json.team, 'allies');

    const branches = git(['branch', '--list', 'mission1/allies'], dir);
    assert.match(branches, /mission1\/allies/);

    const teamList = run('tk.mjs', ['list', '--team', 'trunk/allies'], dir);
    assert.equal(teamList.code, 0);
    assert.deepEqual(teamList.json, []);

    const parentQueue = run('queue.mjs', ['list'], dir);
    const teamItem = parentQueue.json.find((i) => i.ticket === 'team:allies');
    assert.ok(teamItem);
    assert.equal(teamItem.state, 'running');
    assert.equal(teamItem.branch, 'mission1/allies');
    assert.equal(teamItem.agent, stewardName);

    // its own worktree, on its own team branch
    assert.ok(r.json.worktree.endsWith(join('worktrees', 'mission1', 'allies')));
    assert.equal(existsSync(r.json.worktree), true);
    const worktrees = git(['worktree', 'list'], dir);
    assert.match(worktrees, /worktrees\/mission1\/allies.*mission1\/allies/s);
  });

  await t.test('spawn steward --team trunk (no --parent) registers without creating a branch or a parent queue item, but does get a worktree', () => {
    const r = run('roster.mjs', ['spawn', 'steward', '--team', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.team, 'trunk');
    // no new branch beyond the ones already created by init and the allies spawn above —
    // %(refname:short) prints just the branch name, never git's own "* "/"+ " worktree markers
    // (both stewards now have their own worktree, so a marker would otherwise show up here).
    const branches = git(['branch', '--list', '--format=%(refname:short)'], dir).split('\n').map((s) => s.trim());
    assert.deepEqual(
      branches.filter((b) => b.includes('mission1')).sort(),
      ['mission1/allies', 'mission1/trunk'].sort(),
    );
    // trunk has no parent queue to register a "team:trunk" item into
    const trunkQueue = run('queue.mjs', ['list'], dir);
    assert.equal(trunkQueue.json.some((i) => i.ticket === 'team:trunk'), false);

    assert.ok(r.json.worktree.endsWith(join('worktrees', 'mission1', 'trunk')));
    assert.equal(existsSync(r.json.worktree), true);
    const worktrees = git(['worktree', 'list'], dir);
    assert.match(worktrees, /worktrees\/mission1\/trunk.*mission1\/trunk/s);
  });

  await t.test('a second spawn on the same team reuses the existing worktree rather than recreating it', () => {
    const first = run('roster.mjs', ['spawn', 'steward', '--team', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(first.code, 0);
    const before = git(['worktree', 'list'], dir);
    const second = run('roster.mjs', ['spawn', 'steward', '--team', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(second.code, 0);
    assert.equal(second.json.worktree, first.json.worktree);
    const after = git(['worktree', 'list'], dir);
    assert.equal(after, before);
  });

  await t.test('a respawn onto an existing team (branch and directory both present, after a reclaim) re-registers instead of failing, reusing the worktree left in place', () => {
    const firstAllies = run('roster.mjs', ['list'], dir).json.find((e) => e.role === 'steward' && e.team === 'allies');
    const beforeWorktrees = git(['worktree', 'list'], dir);
    run('roster.mjs', ['reclaim', firstAllies.name, 'went quiet'], dir);
    assert.equal(git(['worktree', 'list'], dir), beforeWorktrees, 'reclaim must not touch the worktree');

    const r = run('roster.mjs', ['spawn', 'steward', '--team', 'allies', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.name, 'mission1-steward-allies-2');
    assert.equal(r.json.team, 'allies');
    const parentQueue = run('queue.mjs', ['list'], dir);
    const teamItems = parentQueue.json.filter((i) => i.ticket === 'team:allies');
    assert.equal(teamItems.length, 1);
    assert.equal(teamItems[0].agent, 'mission1-steward-allies-2');
    assert.equal(teamItems[0].state, 'running');

    // the successor picked up the same worktree the reclaimed steward left behind
    assert.ok(r.json.worktree.endsWith(join('worktrees', 'mission1', 'allies')));
    assert.equal(git(['worktree', 'list'], dir), beforeWorktrees);
  });

  await t.test('spawn refuses when a branch exists but its team directory does not', () => {
    git(['branch', 'mission1/orphan'], dir);
    const r = run('roster.mjs', ['spawn', 'steward', '--team', 'orphan', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /team directory is missing/);
  });

  await t.test('spawn refuses a leaf name already claimed under a different parent, but allows the same leaf+parent (respawn)', () => {
    const first = run('roster.mjs', ['spawn', 'steward', '--team', 'falcon', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(first.code, 0, first.stderr);

    const collision = run('roster.mjs', ['spawn', 'steward', '--team', 'falcon', '--parent', 'allies', '--class', 'sonnet'], dir);
    assert.equal(collision.code, 1);
    assert.match(collision.stderr, /already in use under parent "trunk"/);

    const samePlace = run('roster.mjs', ['spawn', 'steward', '--team', 'falcon', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(samePlace.code, 0, samePlace.stderr);
    assert.equal(samePlace.json.name, 'mission1-steward-falcon-2');
  });

  await t.test('trace updates lastTrace', () => {
    const r = run('roster.mjs', ['trace', ownerName], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.name, ownerName);
    assert.match(r.json.lastTrace, /^\d{4}-\d{2}-\d{2}T/);
  });

  await t.test('trace refuses an unknown name', () => {
    const r = run('roster.mjs', ['trace', 'nobody'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such roster entry/);
  });

  await t.test('list --dead flags a steward once its lastTrace is past the configured threshold', () => {
    // A team:<t> item never counts as this steward's own work, and an empty real queue is
    // always alive regardless of threshold — so this needs a steward with a genuine ticket of
    // its own to actually exercise the stale-signals path (trunk, allies and falcon above all
    // have nothing but team: items or an empty queue, and so are alive no matter the threshold).
    const steward = run('roster.mjs', ['spawn', 'steward', '--team', 'plover', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(steward.code, 0, steward.stderr);
    const ticket = run('tk.mjs', ['new', 'plover-open', '--title', 'Plover open', '--node', 'x', '--class', 'sonnet', '--team', 'plover'], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    assert.equal(run('queue.mjs', ['add', ticket.json.id, '--team', 'plover'], dir).code, 0);

    run('horde.mjs', ['config', 'set', 'liveness.stewardMinutes', '0'], dir);
    const dead = run('roster.mjs', ['list', '--dead'], dir);
    assert.equal(dead.code, 0);
    assert.ok(dead.json.some((e) => e.name === steward.json.name && e.verdict === 'dead'));
    run('horde.mjs', ['config', 'set', 'liveness.stewardMinutes', '60'], dir);
  });

  await t.test('list --dead flags an owner with an unanswered review-request past ownerMinutes, and clears once it reviews', () => {
    const billingOwner = run('roster.mjs', ['spawn', 'owner', '--node', 'billing', '--class', 'sonnet'], dir);
    assert.equal(billingOwner.code, 0, billingOwner.stderr);
    const billingOwnerName = billingOwner.json.name;

    const ticket = run('tk.mjs', ['new', 'billing-thing', '--title', 'Billing thing', '--node', 'billing', '--class', 'sonnet'], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    const ticketId = ticket.json.id;
    assert.equal(run('tk.mjs', ['review-request', ticketId], dir).code, 0);

    run('horde.mjs', ['config', 'set', 'liveness.ownerMinutes', '0'], dir);

    const dead = run('roster.mjs', ['list', '--dead'], dir);
    assert.equal(dead.code, 0, dead.stderr);
    assert.ok(dead.json.some((e) => e.name === billingOwnerName && e.verdict === 'dead'));

    // once the owner actually reviews, the request is answered and it reads alive again
    // regardless of ownerMinutes, since there is no longer an open request to be stale about.
    const review = run('tk.mjs', ['review', ticketId, 'approve', '--by', billingOwnerName], dir);
    assert.equal(review.code, 0, review.stderr);
    const aliveAgain = run('roster.mjs', ['list'], dir);
    const entry = aliveAgain.json.find((e) => e.name === billingOwnerName);
    assert.equal(entry.verdict, 'alive');

    run('horde.mjs', ['config', 'set', 'liveness.ownerMinutes', '45'], dir);
  });

  await t.test('reclaim marks the lease reclaimed; the next spawn for the same node gets N+1', () => {
    const r = run('roster.mjs', ['reclaim', ownerName, 'went quiet'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.lease, 'reclaimed');
    const spawned = run('roster.mjs', ['spawn', 'owner', '--node', 'core', '--class', 'opus'], dir);
    assert.equal(spawned.json.name, 'mission1-owner-core-3');
  });

  await t.test('reclaim --lesson requires "<why>" and records a decision', () => {
    const missing = run('roster.mjs', ['reclaim', 'mission1-owner-core-2', '--lesson'], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /requires "<why>"/);
    const r = run('roster.mjs', ['reclaim', 'mission1-owner-core-2', 'kept stalling on review', '--lesson'], dir);
    assert.equal(r.code, 0);
    const decision = run('decide.mjs', ['show', 'lesson-mission1-owner-core-2'], dir);
    assert.equal(decision.code, 0);
    assert.equal(decision.json.body, 'kept stalling on review');
  });

  await t.test('stand-down retires an entry', () => {
    const r = run('roster.mjs', ['stand-down', 'mission1-owner-core-3'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.lease, 'retired');
  });

  await t.test('liveness.stewardSeconds (seconds win over minutes) marks a busy steward dead after a real 1.5s wait', async () => {
    const steward = run('roster.mjs', ['spawn', 'steward', '--team', 'bravo', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(steward.code, 0, steward.stderr);

    // a non-empty queue, so this team isn't trivially alive regardless of any threshold
    const ticket = run('tk.mjs', ['new', 'bravo-open', '--title', 'Bravo open', '--node', 'x', '--class', 'sonnet', '--team', 'trunk/bravo'], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    assert.equal(run('queue.mjs', ['add', ticket.json.id, '--team', 'trunk/bravo'], dir).code, 0);

    const setSeconds = run('horde.mjs', ['config', 'set', 'liveness.stewardSeconds', '1'], dir);
    assert.equal(setSeconds.code, 0, setSeconds.stderr);

    await new Promise((resolve) => { setTimeout(resolve, 1500); });

    const dead = run('roster.mjs', ['list', '--dead'], dir);
    assert.equal(dead.code, 0, dead.stderr);
    assert.ok(dead.json.some((e) => e.name === steward.json.name && e.verdict === 'dead'));

    // stewardSeconds always wins over stewardMinutes once set, and horde.mjs config has no way
    // to unset a key — every later test in this file that needs an enforced threshold has to set
    // stewardSeconds itself from here on, not stewardMinutes alone.
  });

  await t.test('list --dead: an architect is alive with nothing open, dead once an open proposal goes stale, alive again once it rules', () => {
    const architect = run('roster.mjs', ['spawn', 'architect', '--class', 'opus'], dir);
    assert.equal(architect.code, 0, architect.stderr);
    const architectName = architect.json.name;

    const noneOpen = run('roster.mjs', ['list'], dir);
    assert.equal(noneOpen.json.find((e) => e.name === architectName).verdict, 'alive');

    const proposal = run('node.mjs', ['propose', 'rule', 'a graph rule', '--by', 'someone'], dir);
    assert.equal(proposal.code, 0, proposal.stderr);

    run('horde.mjs', ['config', 'set', 'liveness.ownerMinutes', '0'], dir);
    const dead = run('roster.mjs', ['list', '--dead'], dir);
    assert.equal(dead.code, 0, dead.stderr);
    assert.ok(dead.json.some((e) => e.name === architectName && e.verdict === 'dead'));

    const ruled = run('node.mjs', ['approve', proposal.json.id, '--by', architectName], dir);
    assert.equal(ruled.code, 0, ruled.stderr);
    const aliveAgain = run('roster.mjs', ['list'], dir);
    assert.equal(aliveAgain.json.find((e) => e.name === architectName).verdict, 'alive');

    run('horde.mjs', ['config', 'set', 'liveness.ownerMinutes', '45'], dir);
  });

  await t.test('auditor and counsel are never judged dead, even with an aggressively low threshold', () => {
    const auditor = run('roster.mjs', ['spawn', 'auditor', '--class', 'sonnet'], dir);
    assert.equal(auditor.code, 0, auditor.stderr);
    const counsel = run('roster.mjs', ['spawn', 'counsel', '--class', 'sonnet'], dir);
    assert.equal(counsel.code, 0, counsel.stderr);

    run('horde.mjs', ['config', 'set', 'liveness.stewardMinutes', '0'], dir);
    run('horde.mjs', ['config', 'set', 'liveness.ownerMinutes', '0'], dir);
    const list = run('roster.mjs', ['list'], dir);
    assert.equal(list.json.find((e) => e.name === auditor.json.name).verdict, 'alive');
    assert.equal(list.json.find((e) => e.name === counsel.json.name).verdict, 'alive');
    run('horde.mjs', ['config', 'set', 'liveness.stewardMinutes', '60'], dir);
    run('horde.mjs', ['config', 'set', 'liveness.ownerMinutes', '45'], dir);
  });

  await t.test('reclaim refuses a mission-scope entry without --by director, and succeeds with it', () => {
    const architect = run('roster.mjs', ['spawn', 'architect', '--class', 'opus'], dir);
    assert.equal(architect.code, 0, architect.stderr);

    const refused = run('roster.mjs', ['reclaim', architect.json.name, 'stepping down'], dir);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /requires --by director/);

    const ok = run('roster.mjs', ['reclaim', architect.json.name, 'stepping down', '--by', 'director'], dir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json.lease, 'reclaimed');
  });

  await t.test('a steward whose only running item is team:<t> is alive while that sub-team\'s steward is alive, and dead once it isn\'t', () => {
    const parent = run('roster.mjs', ['spawn', 'steward', '--team', 'heron', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(parent.code, 0, parent.stderr);
    const child = run('roster.mjs', ['spawn', 'steward', '--team', 'egret', '--parent', 'heron', '--class', 'sonnet'], dir);
    assert.equal(child.code, 0, child.stderr);

    // heron's queue now holds nothing but a running "team:egret" item; egret itself is fully
    // alive (fresh spawn, default thresholds) — heron should read alive purely on that basis.
    const beforeList = run('roster.mjs', ['list'], dir);
    assert.equal(beforeList.json.find((e) => e.name === parent.json.name).verdict, 'alive');
    assert.equal(beforeList.json.find((e) => e.name === child.json.name).verdict, 'alive');

    // knock egret's subtree dead directly (its own liveness signals are exercised elsewhere) and
    // confirm heron, with nothing else to point to, falls through to its own (untouched, but
    // real) signals — a fresh spawn's branch/queue/lastTrace are all "now", so it stays alive
    // even then, proving the fallthrough runs rather than a hardcoded dead.
    const marked = run('roster.mjs', ['reconcile', '--only-team', 'egret'], dir);
    assert.equal(marked.code, 0, marked.stderr);
    assert.equal(marked.json.marked, 1);
    const afterList = run('roster.mjs', ['list'], dir);
    assert.equal(afterList.json.find((e) => e.name === child.json.name).verdict, 'dead');
    assert.equal(afterList.json.find((e) => e.name === parent.json.name).verdict, 'alive');

    // now also make heron's own signals stale, so the fallthrough actually bites — stewardSeconds
    // (set by an earlier test in this file) wins over stewardMinutes once it exists, so it, not
    // stewardMinutes, is what has to go to zero here.
    run('horde.mjs', ['config', 'set', 'liveness.stewardSeconds', '0'], dir);
    const staleList = run('roster.mjs', ['list'], dir);
    assert.equal(staleList.json.find((e) => e.name === parent.json.name).verdict, 'dead');
  });

  await t.test('reconcile --only-team marks only that team\'s subtree dead, leaving the rest untouched', () => {
    const grandparent = run('roster.mjs', ['spawn', 'steward', '--team', 'osprey', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(grandparent.code, 0, grandparent.stderr);
    const grandchild = run('roster.mjs', ['spawn', 'steward', '--team', 'tern', '--parent', 'osprey', '--class', 'sonnet'], dir);
    assert.equal(grandchild.code, 0, grandchild.stderr);
    const other = run('roster.mjs', ['spawn', 'steward', '--team', 'ibis', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(other.code, 0, other.stderr);

    const r = run('roster.mjs', ['reconcile', '--only-team', 'osprey'], dir);
    assert.equal(r.code, 0, r.stderr);
    // osprey itself, plus tern nested under it — both marked; ibis, elsewhere, is not
    assert.equal(r.json.marked, 2);
    const after = run('roster.mjs', ['list'], dir);
    assert.equal(after.json.find((e) => e.name === grandparent.json.name).lease, 'dead');
    assert.equal(after.json.find((e) => e.name === grandchild.json.name).lease, 'dead');
    assert.equal(after.json.find((e) => e.name === other.json.name).lease, 'active');
  });

  await t.test('trace revives a dead entry; revive is the explicit form and also lifts reclaimed/retired', () => {
    const steward = run('roster.mjs', ['spawn', 'steward', '--team', 'kite', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(steward.code, 0, steward.stderr);
    run('roster.mjs', ['reconcile', '--only-team', 'kite'], dir);
    let entry = run('roster.mjs', ['list'], dir).json.find((e) => e.name === steward.json.name);
    assert.equal(entry.lease, 'dead');

    const traced = run('roster.mjs', ['trace', steward.json.name], dir);
    assert.equal(traced.code, 0, traced.stderr);
    assert.equal(traced.json.lease, 'active');

    const standDown = run('roster.mjs', ['stand-down', steward.json.name], dir);
    assert.equal(standDown.code, 0, standDown.stderr);
    // trace does NOT revive a deliberately retired lease
    const tracedAgain = run('roster.mjs', ['trace', steward.json.name], dir);
    assert.equal(tracedAgain.json.lease, 'retired');

    const revived = run('roster.mjs', ['revive', steward.json.name], dir);
    assert.equal(revived.code, 0, revived.stderr);
    assert.equal(revived.json.lease, 'active');
  });

  await t.test('revive refuses an unknown name', () => {
    const r = run('roster.mjs', ['revive', 'nobody'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such roster entry/);
  });

  await t.test('spawn --agent-id records it; trace --agent-id sets it later; list --json exposes it', () => {
    const spawned = run('roster.mjs', ['spawn', 'owner', '--node', 'billing2', '--class', 'sonnet', '--agent-id', 'a-111'], dir);
    assert.equal(spawned.code, 0, spawned.stderr);
    assert.equal(spawned.json.agentId, 'a-111');
    let entry = run('roster.mjs', ['list'], dir).json.find((e) => e.name === spawned.json.name);
    assert.equal(entry.agentId, 'a-111');

    const spawnedNoId = run('roster.mjs', ['spawn', 'owner', '--node', 'billing3', '--class', 'sonnet'], dir);
    assert.equal(spawnedNoId.json.agentId, null);
    const traced = run('roster.mjs', ['trace', spawnedNoId.json.name, '--agent-id', 'a-222'], dir);
    assert.equal(traced.code, 0, traced.stderr);
    assert.equal(traced.json.agentId, 'a-222');
    entry = run('roster.mjs', ['list'], dir).json.find((e) => e.name === spawnedNoId.json.name);
    assert.equal(entry.agentId, 'a-222');
  });

  await t.test('reconcile marks every active entry dead', () => {
    const spawned = run('roster.mjs', ['spawn', 'architect', '--class', 'fable'], dir);
    assert.equal(spawned.code, 0);
    const r = run('roster.mjs', ['reconcile'], dir);
    assert.equal(r.code, 0);
    assert.ok(r.json.marked >= 1);
    const list = run('roster.mjs', ['list'], dir);
    const active = list.json.filter((e) => e.lease === 'active');
    assert.equal(active.length, 0);
    // an already-retired entry is untouched, not double-marked
    const retired = list.json.find((e) => e.name === 'mission1-owner-core-3');
    assert.equal(retired.lease, 'retired');
  });
});

test('roster.mjs: spawn never staffs a worker or verifier below its ticket\'s class', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  {
    const ticket = run('tk.mjs', ['new', 'classed-thing', '--title', 'Classed', '--node', 'core', '--class', 'sonnet'], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    const below = run('roster.mjs', ['spawn', 'verifier', '--node', 'core', '--class', 'haiku', '--ticket', ticket.json.id], dir);
    assert.equal(below.code, 1);
    assert.match(below.stderr, /below ticket .*'s class sonnet/);
    const same = run('roster.mjs', ['spawn', 'verifier', '--node', 'core', '--class', 'sonnet', '--ticket', ticket.json.id], dir);
    assert.equal(same.code, 0, same.stderr);
    const above = run('roster.mjs', ['spawn', 'worker', '--team', 'trunk', '--class', 'opus', '--ticket', ticket.json.id], dir);
    assert.equal(above.code, 0, above.stderr);
  }
});
