// Mechanical scenario tests for the horde skill's tools — each scenario is driven entirely
// through the CLIs (--json) on its own temporary git repository, the same way lifecycle.test.mjs
// drives a whole mini-wave.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Merges `sourceBranch` into `targetBranch` from a scratch worktree — a steward never checks out
// another branch in its own worktree, per topology.md's rule (lifecycle.test.mjs does the same).
// roster.mjs now gives a spawned steward a persistent worktree on its own team branch, so a
// second, scratch one on the same branch is refused by git outright — reuse the steward's
// worktree when targetBranch already has one, and only fall back to a scratch worktree (removed
// again afterward) when it doesn't.
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
function landReviewVerifyMerge(dir, {
  id, team, worker, owner, verifier, intoBranch, write, horde,
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
  assert.equal(run('tk.mjs', ['key', id, 'author', '--by', worker, ...hordeFlag], dir).code, 0);
  assert.equal(run('tk.mjs', ['review-request', id, ...hordeFlag], dir).code, 0);
  const review = run('tk.mjs', ['review', id, 'approve', '--by', owner, ...hordeFlag], dir);
  assert.equal(review.code, 0, review.stderr);
  const verdict = run('verify.mjs', [
    'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', verifier,
    '--ran', 'manual', '--saw', 'ok', '--gate', 'green', '--sha', landedSha, ...hordeFlag,
  ], dir);
  assert.equal(verdict.code, 0, verdict.stderr);

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
      const t1 = run('tk.mjs', ['new', 'sample', '--title', 'Sample', '--node', 'x', '--class', 'sonnet', '--horde', horde], dir);
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
    for (const [tool, args] of [['roster.mjs', ['list']], ['tk.mjs', ['list']], ['queue.mjs', ['list']]]) {
      const bare = run(tool, args, dir);
      assert.equal(bare.code, 1, `${tool} ${args.join(' ')} should refuse without --horde`);
      assert.match(bare.stderr, /multiple hordes exist/, `${tool}: expected the multi-horde refusal`);

      const scoped = run(tool, [...args, '--horde', 'red'], dir);
      assert.equal(scoped.code, 0, `${tool} --horde red should work: ${scoped.stderr}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Sub-team merge-up
// ---------------------------------------------------------------------------------------------

// _lib.mjs's teamPath() now does what scripts/README.md's top "the contract" paragraph always
// said it did: `--team` takes the sub-team's short slash path ("trunk/alfa"), and teamPath()
// itself inserts the literal "teams/" segments that separate each level on disk
// ("teams/trunk/teams/alfa"), so every caller — tk.mjs, queue.mjs, wave.mjs, premerge.mjs's own
// team lookup, roster.mjs's own resolveTeamPath() — works from the same short form. The old long
// form ("trunk/teams/alfa") is now refused outright rather than silently landing at a wrong,
// doubly-nested directory.
test('sub-team merge-up: alfa off trunk, ticket lifecycle, wave close, premerge team-level', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1');
  run('node.mjs', ['new', 'feature', '--boundary', 'feature-alfa.mjs,feature-alfa-2.mjs'], dir);

  await t.test('roster spawn steward --team alfa --parent trunk creates the branch, directory and running team: item', () => {
    const spawn = run('roster.mjs', ['spawn', 'steward', '--team', 'alfa', '--parent', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(spawn.code, 0, spawn.stderr);
    assert.match(git(['branch', '--list', 'mission1/alfa'], dir), /mission1\/alfa/);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'teams', 'alfa')), true);
    const trunkQueue = run('queue.mjs', ['list', '--team', 'trunk'], dir);
    const teamItem = trunkQueue.json.find((i) => i.ticket === 'team:alfa');
    assert.ok(teamItem, 'expected a team:alfa item in the trunk queue');
    assert.equal(teamItem.state, 'running');
    assert.equal(teamItem.branch, 'mission1/alfa');
  });

  await t.test('the README\'s literal shorthand ("trunk/alfa") finds the team roster.mjs actually created; the old long form is refused', () => {
    const goodTeam = run('tk.mjs', ['new', 'ghost', '--title', 'Ghost', '--node', 'feature', '--class', 'sonnet', '--team', 'trunk/alfa'], dir);
    assert.equal(goodTeam.code, 0, goodTeam.stderr);
    const rightDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'teams', 'alfa', 'issues');
    assert.equal(existsSync(rightDir), true, 'the short slash path landed the ticket where roster.mjs actually built the team');

    const oldLongForm = run('tk.mjs', ['new', 'ghost2', '--title', 'Ghost 2', '--node', 'feature', '--class', 'sonnet', '--team', 'trunk/teams/alfa'], dir);
    assert.equal(oldLongForm.code, 1);
    assert.match(oldLongForm.stderr, /"teams" is inserted automatically/);
  });

  let ticketId;
  await t.test('a ticket filed with the working --team path (trunk/alfa) lands where roster.mjs put the team', () => {
    const ticket = run('tk.mjs', [
      'new', 'alfa-thing', '--title', 'Alfa thing', '--node', 'feature', '--class', 'sonnet',
      '--team', 'trunk/alfa',
    ], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    ticketId = ticket.json.id;
    assert.equal(run('queue.mjs', ['add', ticketId, '--team', 'trunk/alfa'], dir).code, 0);
  });

  await t.test('run, land, key, review, verify, and a real merge into mission1/alfa', () => {
    const { mergeSha } = landReviewVerifyMerge(dir, {
      id: ticketId,
      team: 'trunk/alfa',
      worker: 'worker-alfa-1',
      owner: 'owner-feature',
      verifier: 'verifier-alfa-1',
      intoBranch: 'mission1/alfa',
      write: (wt) => writeFileSync(join(wt, 'feature-alfa.mjs'), 'export const flag = true;\n'),
    });
    assert.ok(mergeSha);
    const item = run('queue.mjs', ['list', '--team', 'trunk/alfa'], dir).json.find((i) => i.ticket === ticketId);
    assert.equal(item.state, 'merged');
  });

  await t.test('wave close on the child team writes its own plan.md, and the parent tracking item is marked landed', () => {
    assert.equal(run('wave.mjs', ['start', '--team', 'trunk/alfa'], dir).code, 0);
    const close = run('wave.mjs', ['close', '--gate', 'green', '--team', 'trunk/alfa'], dir);
    assert.equal(close.code, 0, close.stderr);
    const planPath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'teams', 'alfa', 'plan.md');
    assert.equal(existsSync(planPath), true);
    assert.match(readFileSync(planPath, 'utf8'), /# Wave 1 — close/);

    const landed = run('queue.mjs', ['set', 'team:alfa', 'landed', '--team', 'trunk'], dir);
    assert.equal(landed.code, 0, landed.stderr);
    assert.equal(landed.json.state, 'landed');
  });

  await t.test('premerge mission1/alfa --level team --no-gate: all six checks ✓', () => {
    const pm = run('premerge.mjs', ['mission1/alfa', '--level', 'team', '--no-gate'], dir);
    assert.equal(pm.code, 0, JSON.stringify(pm.json));
    assert.equal(pm.json.ok, true);
    for (const c of pm.json.checks) assert.equal(c.ok, true, `${c.name}: ${c.note}`);
  });

  await t.test('variant: a second, unmerged alfa ticket flips premerge item 2 (keys) to ✗', () => {
    const ticket2 = run('tk.mjs', [
      'new', 'alfa-second', '--title', 'Alfa second', '--node', 'feature', '--class', 'sonnet',
      '--team', 'trunk/alfa',
    ], dir);
    assert.equal(ticket2.code, 0, ticket2.stderr);
    const id2 = ticket2.json.id;
    assert.equal(run('queue.mjs', ['add', id2, '--team', 'trunk/alfa'], dir).code, 0);
    const running2 = run('queue.mjs', ['set', id2, 'running', '--agent', 'worker-alfa-2', '--team', 'trunk/alfa'], dir);
    assert.equal(running2.code, 0, running2.stderr);
    writeFileSync(join(running2.json.worktree, 'feature-alfa-2.mjs'), 'export const flag2 = true;\n');
    git(['add', '-A'], running2.json.worktree);
    git(['commit', '-qm', `ticket ${id2}`], running2.json.worktree);
    // left running — never landed/keyed/reviewed/verified/merged

    const pm2 = run('premerge.mjs', ['mission1/alfa', '--level', 'team', '--no-gate'], dir);
    assert.equal(pm2.code, 1);
    const keys2 = pm2.json.checks.find((c) => c.name === 'keys');
    assert.equal(keys2.ok, false);
    assert.match(keys2.note, new RegExp(`${id2}: running`));
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Cold boot with three tickets
// ---------------------------------------------------------------------------------------------

test('cold boot: roster reconcile marks everyone dead, queue reconcile sorts three running tickets', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const ids = {};
  for (const slug of ['ticket-a', 'ticket-b', 'ticket-c']) {
    const t1 = run('tk.mjs', ['new', slug, '--title', slug, '--node', 'x', '--class', 'sonnet'], dir);
    assert.equal(t1.code, 0, t1.stderr);
    ids[slug] = t1.json.id;
    assert.equal(run('queue.mjs', ['add', t1.json.id], dir).code, 0);
  }

  const spawnWorker = run('roster.mjs', ['spawn', 'worker', '--team', 'trunk', '--class', 'sonnet', '--ticket', ids['ticket-a']], dir);
  assert.equal(spawnWorker.code, 0, spawnWorker.stderr);

  const runningA = run('queue.mjs', ['set', ids['ticket-a'], 'running', '--agent', spawnWorker.json.name], dir);
  const runningB = run('queue.mjs', ['set', ids['ticket-b'], 'running', '--agent', spawnWorker.json.name], dir);
  const runningC = run('queue.mjs', ['set', ids['ticket-c'], 'running', '--agent', spawnWorker.json.name], dir);
  for (const r of [runningA, runningB, runningC]) assert.equal(r.code, 0, r.stderr);

  // A: a commit beyond the team tip.
  git(['commit', '--allow-empty', '-qm', 'work'], runningA.json.worktree);
  // B: a dirty worktree, no commit.
  writeFileSync(join(runningB.json.worktree, 'scratch.txt'), 'uncommitted\n');
  // C: clean, no commit — left exactly as queue.mjs set it up.

  await t.test('roster reconcile marks every active entry dead', () => {
    const reconciled = run('roster.mjs', ['reconcile'], dir);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    assert.equal(reconciled.json.marked, 1);
    const list = run('roster.mjs', ['list'], dir);
    assert.ok(list.json.every((e) => e.lease === 'dead'));
  });

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

  const t1 = run('tk.mjs', ['new', 'needs-x', '--title', 'Needs X', '--node', 'model', '--class', 'sonnet'], dir);
  const id1 = t1.json.id;
  assert.equal(run('queue.mjs', ['add', id1], dir).code, 0);
  const running1 = run('queue.mjs', ['set', id1, 'running', '--agent', 'worker1'], dir);
  assert.equal(running1.code, 0, running1.stderr);

  const logged = run('tk.mjs', ['log', id1, 'needs X in node ui'], dir);
  assert.equal(logged.code, 0, logged.stderr);

  const t2 = run('tk.mjs', ['new', 'the-x', '--title', 'The X', '--node', 'ui', '--class', 'sonnet'], dir);
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
    landReviewVerifyMerge(dir, {
      id: id2, worker: 'worker2', owner: 'owner-ui', verifier: 'verifier2', intoBranch: 'mission1/trunk',
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
// 5. Contract ticket on two nodes
// ---------------------------------------------------------------------------------------------

test('contract ticket on two nodes: merge blocked until both nodes approve, reviewer-is-author refused', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1');

  const ticket = run('tk.mjs', [
    'new', 'contract-thing', '--title', 'Contract thing', '--node', 'model', '--node', 'ui', '--class', 'sonnet',
  ], dir);
  assert.equal(ticket.code, 0, ticket.stderr);
  const id = ticket.json.id;

  assert.equal(run('tk.mjs', ['key', id, 'author', '--by', 'author1'], dir).code, 0);
  const verdict = run('verify.mjs', [
    'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1', '--ran', 'x', '--saw', 'y', '--gate', 'green', '--sha', 'deadbee',
  ], dir);
  assert.equal(verdict.code, 0, verdict.stderr);

  await t.test('review --by <author> is refused regardless of node targeting', () => {
    const r = run('tk.mjs', ['review', id, 'approve', '--by', 'author1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be the ticket's author/);
  });

  await t.test('approving only the model node leaves queue merge refused for the missing ui approval', () => {
    const reviewModel = run('tk.mjs', ['review', id, 'approve', '--by', 'owner-model', '--node', 'model'], dir);
    assert.equal(reviewModel.code, 0, reviewModel.stderr);
    assert.deepEqual(reviewModel.json.nodes, ['model']);

    assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
    const merged = run('queue.mjs', ['set', id, 'merged', '--sha', 'deadbee'], dir);
    assert.equal(merged.code, 1);
    assert.match(merged.stderr, /missing an approval/);
  });

  await t.test('approving the ui node too allows the merge', () => {
    const reviewUi = run('tk.mjs', ['review', id, 'approve', '--by', 'owner-ui', '--node', 'ui'], dir);
    assert.equal(reviewUi.code, 0, reviewUi.stderr);
    const merged = run('queue.mjs', ['set', id, 'merged', '--sha', 'deadbee'], dir);
    assert.equal(merged.code, 0, merged.stderr);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Owner is the author
// ---------------------------------------------------------------------------------------------

test('owner is the ticket\'s author: owner review refused, architect approves every node at once', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const ticket = run('tk.mjs', ['new', 'owner-authored', '--title', 'Owner authored', '--node', 'model', '--class', 'sonnet'], dir);
  const id = ticket.json.id;
  assert.equal(run('tk.mjs', ['key', id, 'author', '--by', 'owner1'], dir).code, 0);

  await t.test('review --by the owner (who is also the author) is refused', () => {
    const r = run('tk.mjs', ['review', id, 'approve', '--by', 'owner1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be the ticket's author/);
  });

  await t.test('review --by architect (no --node) approves every named node at once', () => {
    const r = run('tk.mjs', ['review', id, 'approve', '--by', 'architect'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.nodes, ['model']);
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, /\*\*Keys:\*\*.*model architect/);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Dissent and decision
// ---------------------------------------------------------------------------------------------

test('escalation ruling records a decision; a dissent against it is answered exactly once', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const ticket = run('tk.mjs', ['new', 'contested', '--title', 'Contested', '--node', 'model', '--class', 'sonnet'], dir);
  const id = ticket.json.id;

  const esc = run('escalate.mjs', ['add', 'boundary is ambiguous', '--kind', 'contract', '--ticket', id, '--by', 'steward'], dir);
  assert.equal(esc.code, 0, esc.stderr);
  const escId = esc.json.id;

  await t.test('escalate rule records a decision esc-<id>', () => {
    const ruled = run('escalate.mjs', ['rule', escId, 'the boundary includes the adapter'], dir);
    assert.equal(ruled.code, 0, ruled.stderr);
    const decisions = run('decide.mjs', ['list'], dir);
    assert.equal(decisions.code, 0, decisions.stderr);
    assert.ok(decisions.json.some((d) => d.slug === `esc-${escId}`), JSON.stringify(decisions.json));
  });

  let dissentId;
  await t.test('dissent add records a disagreement against the decision', () => {
    const dis = run('dissent.mjs', ['add', 'the adapter belongs to a different node', '--ticket', id, '--by', 'owner-model', '--against', `esc-${escId}`], dir);
    assert.equal(dis.code, 0, dis.stderr);
    dissentId = dis.json.id;
  });

  await t.test('dissent answer closes it and appends the answer to decisions.md; a second answer is refused', () => {
    const answered = run('dissent.mjs', ['answer', dissentId, 'the adapter stays with model, noted for the next boundary review', '--by', 'director'], dir);
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(answered.json.state, 'closed');
    const decisionsText = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'decisions.md'), 'utf8');
    assert.match(decisionsText, /dissent-\d+/);
    assert.match(decisionsText, /the adapter stays with model/);

    const secondAnswer = run('dissent.mjs', ['answer', dissentId, 'again', '--by', 'director'], dir);
    assert.equal(secondAnswer.code, 1);
    assert.match(secondAnswer.stderr, /already answered/);
  });

  await t.test('dissent list --open is empty', () => {
    const open = run('dissent.mjs', ['list', '--open'], dir);
    assert.equal(open.code, 0, open.stderr);
    assert.deepEqual(open.json, []);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Cost limit
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

  await t.test('three opus spawns (weighted 30) pass a Limit: 20 charter line', () => {
    setLimit('20');
    for (let i = 0; i < 3; i++) {
      const spawn = run('roster.mjs', ['spawn', 'owner', '--node', `model${i}`, '--class', 'opus'], dir);
      assert.equal(spawn.code, 0, spawn.stderr);
    }
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
// 9. Owner reclaim
// ---------------------------------------------------------------------------------------------

test('owner reclaim: the lease is reclaimed, not the name, and a key remains a fact not a permission', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const first = run('roster.mjs', ['spawn', 'owner', '--node', 'model', '--class', 'sonnet'], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.json.name, /-owner-model-1$/);

  const reclaim = run('roster.mjs', ['reclaim', first.json.name, 'silent'], dir);
  assert.equal(reclaim.code, 0, reclaim.stderr);

  const second = run('roster.mjs', ['spawn', 'owner', '--node', 'model', '--class', 'sonnet'], dir);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.json.name, /-owner-model-2$/);

  const list = run('roster.mjs', ['list', '--json'], dir);
  const firstEntry = list.json.find((e) => e.name === first.json.name);
  assert.equal(firstEntry.lease, 'reclaimed');

  const ticket = run('tk.mjs', ['new', 'after-reclaim', '--title', 'After reclaim', '--node', 'model', '--class', 'sonnet'], dir);
  const id = ticket.json.id;
  const review = run('tk.mjs', ['review', id, 'approve', '--by', first.json.name], dir);
  // A key is a fact, not a permission: tk.mjs's own review refusal is keyed only on
  // "--by === the ticket's author" (never on roster state), and this ticket has no author key
  // set at all yet — so a reclaimed name is still accepted here.
  assert.equal(review.code, 0, review.stderr);
});

// ---------------------------------------------------------------------------------------------
// 10. Yggdrasil mode, read-only
// ---------------------------------------------------------------------------------------------

// Modelled on this repository's own .yggdrasil/model/frontend/yg-node.yaml shape: a scalar
// name/type/description header, then a mapping: dash-list — the minimal shape node.mjs's own
// parseYgNodeYaml understands (see tests/node.test.mjs's own writeYggdrasilNode fixture writer).
function writeYggdrasilNode(dir, node, mapping) {
  const path = join(dir, '.yggdrasil', 'model', node, 'yg-node.yaml');
  mkdirSync(join(dir, '.yggdrasil', 'model', node), { recursive: true });
  const lines = [`name: ${node}`, 'type: domain', `description: "fixture node ${node}"`, '', 'mapping:'];
  for (const m of mapping) lines.push(`  - ${m}`);
  writeFileSync(path, lines.join('\n') + '\n');
}

function nodeCharterEdit(dir, node, stdin) {
  const out = execFileSync('node', [join(SCRIPTS_DIR, 'node.mjs'), 'charter', 'edit', node, '--json'], {
    cwd: dir, input: stdin, encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('yggdrasil mode: node.mjs is read-only against .yggdrasil/model fixtures', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  writeYggdrasilNode(dir, 'core', ['packages/core/**']);
  writeYggdrasilNode(dir, 'frontend', ['apps/frontend/**']);
  initHorde(dir); // auto-detects nodeSource: "yggdrasil" because .yggdrasil/ now exists

  const cfgMode = run('horde.mjs', ['config', 'get', 'nodeSource'], dir);
  assert.equal(cfgMode.json.value, 'yggdrasil');

  await t.test('bind lists both fixture node ids', () => {
    const r = run('node.mjs', ['bind'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.mode, 'yggdrasil');
    assert.deepEqual(r.json.nodes.sort(), ['core', 'frontend']);
  });

  await t.test('map shows a node touched by a roster owner', () => {
    const spawn = run('roster.mjs', ['spawn', 'owner', '--node', 'core', '--class', 'sonnet'], dir);
    assert.equal(spawn.code, 0, spawn.stderr);
    const map = run('node.mjs', ['map'], dir);
    assert.equal(map.code, 0, map.stderr);
    const row = map.json.find((r) => r.node === 'core');
    assert.ok(row, JSON.stringify(map.json));
    assert.equal(row.owner, spawn.json.name);
  });

  await t.test('show reads boundary from mapping:, writes nothing', () => {
    const r = run('node.mjs', ['show', 'frontend'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.boundary, ['apps/frontend/**']);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'frontend', 'node.json')), false);
  });

  await t.test('new prints the yg filing commands and creates no files', () => {
    const r = run('node.mjs', ['new', 'newnode', '--boundary', 'apps/newnode/**'], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /yg-node\.yaml/);
    assert.match(r.stdout, /explicit confirmation/);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'newnode')), false);
  });

  await t.test('charter edit writes charter.md beside the yaml', () => {
    const edited = nodeCharterEdit(dir, 'core', '# Node · core\n\nOwns the core package.\n');
    assert.ok(edited.bytes > 0);
    const charterPath = join(dir, '.yggdrasil', 'model', 'core', 'charter.md');
    assert.equal(existsSync(charterPath), true);
    assert.match(readFileSync(charterPath, 'utf8'), /Owns the core package/);
  });

  await t.test('log prints the yg log add command without running it (no --run)', () => {
    const r = run('node.mjs', ['log', 'core', 'refactor complete'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ran, undefined);
    assert.match(r.json.command, /^yg log add --node core --reason/);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'core', 'log.md')), false);
  });
});

// ---------------------------------------------------------------------------------------------
// 11. Liveness verdicts
// ---------------------------------------------------------------------------------------------

// Moves `branch`'s tip to a new commit with the same content but a backdated author/committer
// date, without checking anything out — a steward's branch normally never gets touched from the
// main tree (topology.md), so this is the only way to make a branch look genuinely stale.
function backdateBranchTip(dir, branch, iso) {
  const tree = execFileSync('git', ['rev-parse', `${branch}^{tree}`], { cwd: dir, encoding: 'utf8' }).trim();
  const parent = execFileSync('git', ['rev-parse', branch], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', 'backdated'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  }).trim();
  execFileSync('git', ['update-ref', `refs/heads/${branch}`, commit], { cwd: dir });
}

// roster.mjs's steward liveness reads three signals — team branch tip commit time, queue.json
// mtime, lastTrace — and takes the newest of the three against config.liveness.stewardMinutes,
// but only once the team's queue is non-empty; an empty queue is always alive. Two stewards get
// an identical stale lastTrace: staleSteward's team (trunk) is left with an empty queue, so it
// reads alive regardless; busySteward's team (alfa) gets an open ticket plus a backdated branch
// tip and a backdated queue.json mtime, so all three of its signals are stale and it reads dead.
test('roster.mjs liveness: an empty queue is always alive; a busy team is dead once branch, queue and trace are all stale', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const staleSteward = run('roster.mjs', ['spawn', 'steward', '--team', 'trunk', '--class', 'sonnet'], dir);
  assert.equal(staleSteward.code, 0, staleSteward.stderr);
  const busySteward = run('roster.mjs', ['spawn', 'steward', '--team', 'alfa', '--parent', 'trunk', '--class', 'sonnet'], dir);
  assert.equal(busySteward.code, 0, busySteward.stderr);

  const staleAt = new Date(Date.now() - 120 * 60000).toISOString();

  // Back-date both entries' lastTrace beyond config.liveness.stewardMinutes (default 60) — the
  // only way to get a stale trace deterministically, since roster.mjs trace only ever sets "now".
  const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  for (const e of roster.entries) e.lastTrace = staleAt;
  writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

  // busySteward's team (alfa) gets an open ticket; staleSteward's team (trunk) is left with no
  // queue activity beyond what horde.mjs init created (empty).
  const ticket = run('tk.mjs', ['new', 'alfa-open', '--title', 'Alfa open', '--node', 'x', '--class', 'sonnet', '--team', 'trunk/alfa'], dir);
  assert.equal(run('queue.mjs', ['add', ticket.json.id, '--team', 'trunk/alfa'], dir).code, 0);

  // Backdate alfa's own two remaining signals: its branch tip and its queue.json's mtime. trunk's
  // branch and queue.json are left fresh — irrelevant, since its empty queue makes it alive
  // regardless of any of the three signals.
  backdateBranchTip(dir, 'mission1/alfa', staleAt);
  const alfaQueuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'teams', 'alfa', 'queue.json');
  const staleDate = new Date(staleAt);
  utimesSync(alfaQueuePath, staleDate, staleDate);

  const list = run('roster.mjs', ['list', '--dead'], dir);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(list.json.map((e) => e.name), [busySteward.json.name]);

  const all = run('roster.mjs', ['list'], dir);
  const staleEntry = all.json.find((e) => e.name === staleSteward.json.name);
  assert.equal(staleEntry.verdict, 'alive');
  const busyEntry = all.json.find((e) => e.name === busySteward.json.name);
  assert.equal(busyEntry.verdict, 'dead');
});

// ---------------------------------------------------------------------------------------------
// 12. Protected path
// ---------------------------------------------------------------------------------------------

test('protected path: premerge scope check (item 3) fails a branch that touches config.protectedPaths', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const setProtected = run('horde.mjs', ['config', 'set', 'protectedPaths', 'package.json'], dir);
  assert.equal(setProtected.code, 0, setProtected.stderr);

  run('node.mjs', ['new', 'x', '--boundary', 'package.json'], dir);

  const ticket = run('tk.mjs', ['new', 'touches-protected', '--title', 'Touches protected', '--node', 'x', '--class', 'sonnet'], dir);
  const id = ticket.json.id;
  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker1'], dir);
  assert.equal(running.code, 0, running.stderr);

  writeFileSync(join(running.json.worktree, 'package.json'), '{"name": "changed"}\n');
  git(['add', '-A'], running.json.worktree);
  git(['commit', '-qm', 'edit protected path'], running.json.worktree);

  const pm = run('premerge.mjs', [running.json.branch, '--level', 'team', '--no-gate'], dir);
  assert.equal(pm.code, 1);
  const scope = pm.json.checks.find((c) => c.name === 'scope');
  assert.equal(scope.ok, false);
  assert.match(scope.note, /protected paths touched: package\.json/);
});

// ---------------------------------------------------------------------------------------------
// 13. Steward dies after a worker landed but before the author key
// ---------------------------------------------------------------------------------------------

test('steward dies after landing but before the author key: reconcile marks it landed, the successor recovers the author key from the queue', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const ticket = run('tk.mjs', ['new', 'orphaned', '--title', 'Orphaned', '--node', 'x', '--class', 'sonnet'], dir);
  assert.equal(ticket.code, 0, ticket.stderr);
  const id = ticket.json.id;
  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'mission1-worker-trunk-1'], dir);
  assert.equal(running.code, 0, running.stderr);

  // the worker lands a commit, but the steward dies before it can set the author key by hand
  git(['commit', '--allow-empty', '-qm', 'work'], running.json.worktree);

  const reconciled = run('queue.mjs', ['reconcile'], dir);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  assert.equal(reconciled.json.find((r) => r.ticket === id).state, 'landed');

  await t.test('a successor steward recovers the author key from the queue item\'s recorded agent', () => {
    const keyed = run('tk.mjs', ['key', id, 'author', '--from-queue'], dir);
    assert.equal(keyed.code, 0, keyed.stderr);
    assert.equal(keyed.json.author, 'mission1-worker-trunk-1');
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, /\*\*Keys:\*\* author mission1-worker-trunk-1/);
  });

  await t.test('--from-queue on a ticket with no queue item recording an agent is refused', () => {
    const other = run('tk.mjs', ['new', 'no-agent', '--title', 'No agent', '--node', 'x', '--class', 'sonnet'], dir);
    assert.equal(run('queue.mjs', ['add', other.json.id], dir).code, 0);
    const failed = run('tk.mjs', ['key', other.json.id, 'author', '--from-queue'], dir);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /no queue item with a recorded agent/);
  });
});

// ---------------------------------------------------------------------------------------------
// 14. Class overloaded — a queue item waits
// ---------------------------------------------------------------------------------------------

test('class overloaded: a queued item waits, next skips it, reconcile leaves it alone, and set queued resumes it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const heavy = run('tk.mjs', ['new', 'heavy', '--title', 'Heavy', '--node', 'x', '--class', 'opus'], dir);
  const light = run('tk.mjs', ['new', 'light', '--title', 'Light', '--node', 'x', '--class', 'sonnet'], dir);
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
// 15. Two hordes, one with a waiting item
// ---------------------------------------------------------------------------------------------

test('two hordes, one with a waiting item and one without: status --json reports the queue state per horde', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'red');
  initHorde(dir, 'blue');

  const redTicket = run('tk.mjs', ['new', 'red-thing', '--title', 'Red thing', '--node', 'x', '--class', 'sonnet', '--horde', 'red'], dir);
  assert.equal(redTicket.code, 0, redTicket.stderr);
  assert.equal(run('queue.mjs', ['add', redTicket.json.id, '--horde', 'red'], dir).code, 0);
  const waited = run('queue.mjs', ['set', redTicket.json.id, 'waiting', '--note', 'class overloaded', '--horde', 'red'], dir);
  assert.equal(waited.code, 0, waited.stderr);

  const blueTicket = run('tk.mjs', ['new', 'blue-thing', '--title', 'Blue thing', '--node', 'x', '--class', 'sonnet', '--horde', 'blue'], dir);
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
