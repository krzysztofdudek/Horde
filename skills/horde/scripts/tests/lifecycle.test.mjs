// The seatless ticket cycle, end to end, driven through the CLIs exactly as reference/model.md
// describes it — not through any tool's internals. Every step asserts the state the tools are
// supposed to leave on disk or in git, not just an exit code.
//
// The states a ticket moves through are the spine of this file: `queued → running → landed →
// merged` on the path that works, `proposed` for a ticket nobody has ruled on yet, and `blocked`
// for one whose fix rounds are spent. Nobody holds a seat anywhere in it. A worker is a name on a
// queue item and nothing else; there is no roll of agents to be on, no second signature to collect
// before a merge, and no separate tool that merges.
//
// The one thing that inverted: `land.mjs` makes the merge commit itself. This file used to reach
// the end of the gate and then run `git merge --no-ff` by hand, because no script did it. Landing
// is now the last command of a ticket — when every item is green it merges, removes the worktree
// and the branch, and records the sha — so what this walk does at that step is CHECK that merge
// (its trailers, its parents, what it left behind), never perform one.
//
// One older gap stays fixed at the source rather than worked around here: the landing gate's nested
// `node --test <file>` used to inherit NODE_TEST_CONTEXT from this very test run, and so be
// silently skipped by Node's own recursive-test-runner guard — checkRevertTest now spawns that
// child with the inherited test-runner markers stripped from its environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, addNode, requireYg, writeCostRuns,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('horde lifecycle: one mini-wave from init to a cold-boot reconcile', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  await t.test('1. horde init', () => {
    const init = run('horde.mjs', ['init', 'pilot', '--base', 'develop', '--title', 'Pilot', '--yg', requireYg(), '--test-globs', '**/*.test.*'], dir);
    assert.equal(init.code, 0, init.stderr);
    // The gate this repository is held to for the rest of the walk, and the judge policy, said
    // once here rather than at each step that needs them.
    assert.equal(run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir).code, 0);
    assert.equal(run('horde.mjs', ['config', 'set', 'judge', 'one-shot'], dir).code, 0);
    assert.equal(existsSync(join(dir, '.horde')), true);
    // horde-requires-yggdrasil: a repository with no graph gets one, made by the real CLI.
    assert.equal(existsSync(join(dir, '.yggdrasil', 'yg-architecture.yaml')), true);
    assert.equal(init.json.graph.created, true);
    assert.equal(readFileSync(join(dir, '.horde', '.gitignore'), 'utf8').trim(), '*');
    assert.match(git(['branch', '--list', 'pilot/trunk'], dir), /pilot\/trunk/);
    const charter = readFileSync(join(dir, '.horde', 'hordes', 'pilot', 'charter.md'), 'utf8');
    assert.match(charter, /# Mission · Pilot/);
  });

  // "model"'s boundary has to cover its own test file too (tests/hook.test.mjs), not just the
  // source path — land.mjs's scope check treats a test file like any other diff
  // file, with no built-in exception for config.testGlobs; a node's tests live in its boundary
  // the same way land.test.mjs's own fixtures always pair a source glob with its test glob.
  await t.test('2. components, a port proposed and approved', () => {
    addNode(dir, 'model', { mapping: ['src/model/**', 'tests/**'] });
    addNode(dir, 'ui', { mapping: ['src/ui/**'], relations: [{ target: 'model', type: 'uses' }] });

    // node.mjs's "charter edit" no longer exists — node charters no longer exist at all, and
    // node.mjs contract propose/approve never read one, so the step drops straight to the port.
    //
    // port-is-contract: the contract is a port on the component, proposed by name — there is no
    // version, in the graph or in Horde; the architect files it into the graph. `--by` is a free
    // name on the record, never looked up anywhere: nothing in this tool set holds a roll of who
    // may propose.
    const port = run('node.mjs', ['contract', 'propose', 'model', 'hook-surface', 'the hook the ui reads', '--by', 'model'], dir);
    assert.equal(port.code, 0, port.stderr);
    assert.equal(port.json.kind, 'add');
    const approved = run('node.mjs', ['contract', 'approve', port.json.id, '--by', 'architect'], dir);
    assert.equal(approved.code, 0, approved.stderr);
    assert.equal(approved.json.status, 'approved');
    assert.ok(approved.json.filing.some((f) => f.includes('yg-node.yaml')), 'the approval names the edit the architect makes');
  });

  let costRuns;

  // The graph rides on the branch: `land` reads it by running the real `yg check` in a fresh tree
  // at the ticket branch's own tip, so the components filed above have to be committed before any
  // ticket branches off trunk — exactly the order an architect files one on a real mission.
  await t.test('3. the graph, and the code it governs, are committed to trunk before anything branches off it', () => {
    git(['checkout', '-q', 'pilot/trunk'], dir);
    // A component's mapping is a claim about where its code is; `yg check` refuses a glob that
    // reaches nothing, so each of the two components above gets a file to govern. The ticket's own
    // work lands beside these, which is what makes it that component's work.
    mkdirSync(join(dir, 'src', 'model'), { recursive: true });
    mkdirSync(join(dir, 'src', 'ui'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src', 'model', 'base.mjs'), "export const base = 'base';\n");
    writeFileSync(join(dir, 'src', 'ui', 'view.mjs'), "export const view = 'view';\n");
    writeFileSync(join(dir, 'tests', 'base.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { base } from '../src/model/base.mjs';",
      "test('base', () => { assert.equal(base, 'base'); });",
      '',
    ].join('\n'));
    git(['add', '.yggdrasil', 'src', 'tests'], dir);
    git(['commit', '-qm', 'graph: the components this mission touches, and the code they govern'], dir);
    assert.equal(git(['branch', '--show-current'], dir), 'pilot/trunk');
  });

  // Nothing in this tool set writes cost.json yet, so a mission-level report is exercised by
  // seeding the ledger directly, in the shape cost.mjs is contracted to read. The roles on it are
  // the ones that still exist — a run is booked against the kind of agent that made it.
  await t.test('4. cost: seeded runs sum in a mission-level report', () => {
    costRuns = [
      { name: 'architect1', role: 'architect', class: 'heavy', ticket: null, wave: null, at: '2026-01-01T00:00:00.000Z' },
      { name: 'legislate-1', role: 'legislate', class: 'standard', ticket: null, wave: null, at: '2026-01-01T00:00:00.000Z' },
      { name: 'retro-1', role: 'retro', class: 'standard', ticket: null, wave: null, at: '2026-01-01T00:00:00.000Z' },
    ];
    writeCostRuns(dir, 'pilot', costRuns);

    const missionCost = run('cost.mjs', ['report', '--mission'], dir);
    assert.equal(missionCost.code, 0, missionCost.stderr);
    assert.equal(missionCost.json.runs, 3);
    assert.equal(missionCost.json.weighted, 3 + 3 + 10); // standard(3) + standard(3) + heavy(10)
  });

  let ticketId;
  await t.test('5. ticket, queue, wave start', () => {
    const ticket = run('tk.mjs', [
      'new', 'extract-hook', '--title', 'Extract the hook', '--node', 'model', '--class', 'standard',
      '--evidence', 'tests/hook.test.mjs green',
    ], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    ticketId = ticket.json.id;
    // One counter for the whole mission: the port proposal in step 2 took 001, so the first
    // ticket is 002. A ticket and a graph item never wear the same number any more, which is what
    // makes an id on its own an unambiguous question.
    assert.equal(ticketId, '002');
    assert.equal(ticket.json.ref, 't-002', 'a ticket reads with its kind on it');

    const queued = run('queue.mjs', ['add', ticketId], dir);
    assert.equal(queued.code, 0, queued.stderr);

    const waveStart = run('wave.mjs', ['start'], dir);
    assert.equal(waveStart.code, 0, waveStart.stderr);
    assert.equal(waveStart.json.n, '1');
  });

  let workerName;
  let worktreePath;
  // A worker is a name on the queue item and nothing else: `--agent` is free text, checked against
  // nothing, and `queued → running` is the transition that cuts the branch and the worktree.
  await t.test('6. queued → running: the branch and worktree are cut, and the brief renders against them', () => {
    workerName = 'worker1';

    const running = run('queue.mjs', ['set', ticketId, 'running', '--agent', workerName], dir);
    assert.equal(running.code, 0, running.stderr);
    assert.equal(running.json.branch, `pilot/t-${ticketId}`);
    assert.ok(running.json.worktree.endsWith(join('worktrees', 'pilot', `t-${ticketId}`)));
    assert.match(git(['branch', '--list', `pilot/t-${ticketId}`], dir), new RegExp(`pilot/t-${ticketId}`));
    worktreePath = running.json.worktree;
    assert.equal(existsSync(worktreePath), true);

    const workerBrief = run('brief.mjs', ['worker', ticketId, '--name', workerName], dir);
    assert.equal(workerBrief.code, 0, workerBrief.stderr);
    assert.doesNotMatch(workerBrief.json.brief, /\{\{/);
    assert.match(workerBrief.json.brief, new RegExp(`worktree is \`.*t-${ticketId}\``));
  });

  let landedSha;
  await t.test('7. running → landed: the worker commits, and says so on the ticket', () => {
    mkdirSync(join(worktreePath, 'src', 'model'), { recursive: true });
    mkdirSync(join(worktreePath, 'tests'), { recursive: true });
    writeFileSync(join(worktreePath, 'src', 'model', 'hook.mjs'), "export function useHook() { return 'hooked'; }\n");
    writeFileSync(join(worktreePath, 'tests', 'hook.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { useHook } from '../src/model/hook.mjs';",
      "test('useHook', () => { assert.equal(useHook(), 'hooked'); });",
      '',
    ].join('\n'));
    git(['add', join('src', 'model', 'hook.mjs'), join('tests', 'hook.test.mjs')], worktreePath);
    git(['commit', '-qm', 'extract the hook'], worktreePath);
    landedSha = git(['rev-parse', '--short', `pilot/t-${ticketId}`], dir);

    const tkLog = run('tk.mjs', ['log', ticketId, `landed ${landedSha}`], dir);
    assert.equal(tkLog.code, 0, tkLog.stderr);

    const landedState = run('queue.mjs', ['set', ticketId, 'landed'], dir);
    assert.equal(landedState.code, 0, landedState.stderr);
    assert.equal(landedState.json.state, 'landed');
  });

  // review-request only appends a line to the ticket's log now. Nothing downstream reads it and
  // nothing waits on it — a landing asks no second party for anything — so this is here as the
  // one surviving piece of the old flow, not as a gate.
  await t.test('8. review requested — a line on the log, and nothing waits on it', () => {
    const reviewRequest = run('tk.mjs', ['review-request', ticketId], dir);
    assert.equal(reviewRequest.code, 0, reviewRequest.stderr);
  });

  // "proposed" (016) is the state a ticket nobody has ruled on sits in: in the queue, listed and
  // counted, and never a candidate for anyone to start.
  await t.test('9. proposed: a ticket nobody has ruled on is counted, and never handed out', () => {
    const proposal = run('tk.mjs', ['new', 'maybe-later', '--title', 'Maybe later', '--node', 'ui', '--class', 'standard', '--evidence', 'it works'], dir);
    assert.equal(proposal.code, 0, proposal.stderr);
    const added = run('queue.mjs', ['add', proposal.json.id, '--proposed'], dir);
    assert.equal(added.code, 0, added.stderr);
    assert.equal(added.json.state, 'proposed');

    assert.deepEqual(
      run('queue.mjs', ['list', '--state', 'proposed'], dir).json.map((i) => i.ticket),
      [proposal.json.id],
    );
    const next = run('queue.mjs', ['next'], dir);
    assert.notEqual(next.json && next.json.ticket, proposal.json.id, 'a proposal is never what comes next');
  });

  let mergeSha;
  await t.test('10. landed → merged: the gate runs and lands, and the merge commit is land\'s own', () => {
    // The revert test spawns its own nested `node --test <file>`; this whole suite already runs
    // under `node --test`, which is exactly the case that used to leak NODE_TEST_CONTEXT into
    // the child and get it silently skipped. Asserting a real "N fail / N tests" here (not
    // "? fail / ? tests") is the regression check for that fix.
    //
    // "--level team" is refused now — omitting --level defaults to the same gate lookup a branch
    // landing directly on the team branch always used.
    const landed = run('land.mjs', [`pilot/t-${ticketId}`], dir);
    const byName = Object.fromEntries(landed.json.checks.map((c) => [c.name, c]));
    for (const [name, check] of Object.entries(byName)) {
      assert.equal(check.ok, true, `${name}: ${check.note}`);
    }
    assert.equal(landed.code, 0, landed.stderr);
    assert.equal(landed.json.ok, true);
    assert.match(byName['revert test'].note, /1 fail \/ \d+ tests/);
    // "merge" is an item on the checklist, not something the caller does afterwards.
    assert.equal(byName.merge.ok, true, byName.merge && byName.merge.note);

    // What land left in git: one merge commit on trunk, with both parents — the trunk tip it
    // merged into and the ticket branch's own tip.
    mergeSha = git(['rev-parse', '--short', 'pilot/trunk'], dir);
    assert.equal(landed.json.landed.sha, git(['rev-parse', 'pilot/trunk'], dir));
    assert.equal(git(['rev-list', '--count', '--merges', `${landedSha}..pilot/trunk`], dir), '1');
    assert.equal(git(['rev-list', '--parents', '-n', '1', 'pilot/trunk'], dir).split(' ').length, 3, 'a --no-ff merge has two parents');

    // And what it wrote into that commit: ordinary git trailers, read with git's own parser.
    assert.equal(
      git(['show', '-s', '--format=%(trailers:key=Ticket,valueonly)', 'pilot/trunk'], dir).trim(),
      `t-${ticketId}`,
    );

    // The branch and the worktree are gone, and the queue says merged — all of it land's doing.
    assert.equal(existsSync(worktreePath), false);
    assert.equal(git(['branch', '--list', `pilot/t-${ticketId}`], dir), '');
    assert.equal(run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === ticketId).state, 'merged');
  });

  await t.test('11. wave journal, ticket status, wave close, cost, status', () => {
    const waveMerged = run('wave.mjs', ['merged', ticketId, mergeSha], dir);
    assert.equal(waveMerged.code, 0, waveMerged.stderr);
    const tkMerged = run('tk.mjs', ['status', ticketId, 'merged'], dir);
    assert.equal(tkMerged.code, 0, tkMerged.stderr);
    assert.equal(tkMerged.json.status, 'merged');

    const waveClose = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(waveClose.code, 0, waveClose.stderr);
    const planText = readFileSync(join(dir, '.horde', 'hordes', 'pilot', 'plan.md'), 'utf8');
    assert.match(planText, /# Wave 1 — close/);
    assert.match(planText, /\*\*Merged:\*\* 1 tickets/);

    // One run belongs to this wave — the worker's — seeded the same way the mission-level runs
    // were, in step 4.
    costRuns.push({
      name: workerName, role: 'worker', class: 'standard', ticket: ticketId, wave: '1', at: '2026-01-01T00:00:00.000Z',
    });
    writeCostRuns(dir, 'pilot', costRuns);

    const waveCost = run('cost.mjs', ['report', '--wave', '1'], dir);
    assert.equal(waveCost.code, 0, waveCost.stderr);
    assert.equal(waveCost.json.runs, 1); // just the worker, standard — the mission-level runs predate wave 1
    assert.equal(waveCost.json.weighted, 3);

    const status = run('status.mjs', ['--horde', 'pilot'], dir);
    assert.equal(status.code, 0, status.stderr);
    const h = status.json.hordes[0];
    assert.equal(h.queue.byState.queued, undefined);
    assert.equal(h.queue.byState.merged, 1);
  });

  // Cold boot: nothing lives between runs, so the only thing that can say what a returned worker
  // left behind is the git state of its branch. queue.mjs's own reconcile is what reads it.
  await t.test('12. cold boot: a dirty running item is reclaimed, and handoff survives the restart', () => {
    const ticket2 = run('tk.mjs', ['new', 'second-thing', '--title', 'A second thing', '--node', 'model', '--class', 'standard', '--evidence', 'it works'], dir);
    assert.equal(ticket2.code, 0, ticket2.stderr);
    const ticket2Id = ticket2.json.id;
    run('queue.mjs', ['add', ticket2Id], dir);
    const running2 = run('queue.mjs', ['set', ticket2Id, 'running', '--agent', workerName], dir);
    assert.equal(running2.code, 0, running2.stderr);
    writeFileSync(join(running2.json.worktree, 'scratch.txt'), 'uncommitted work\n');

    const reconcileQueue = run('queue.mjs', ['reconcile'], dir);
    assert.equal(reconcileQueue.code, 0, reconcileQueue.stderr);
    const result2 = reconcileQueue.json.find((r) => r.ticket === ticket2Id);
    assert.equal(result2.state, 'queued');
    const queueList = run('queue.mjs', ['list'], dir);
    const item2 = queueList.json.find((i) => i.ticket === ticket2Id);
    assert.equal(item2.worktree, running2.json.worktree); // worktree kept, not removed
    assert.ok(item2.notes.some((n) => /dirty/.test(n.text)));
    const wipLog = git(['log', '-1', '--format=%s'], running2.json.worktree);
    assert.equal(wipLog, 'wip: reclaimed');

    const handoffWrite = run('handoff.mjs', ['write', '--summary', 'x', '--next', 'y'], dir);
    assert.equal(handoffWrite.code, 0, handoffWrite.stderr);
    // There is only ever one handoff per horde — it takes neither a name nor a team.
    const handoffRead = run('handoff.mjs', ['read'], dir);
    assert.equal(handoffRead.code, 0, handoffRead.stderr);
    assert.equal(handoffRead.json.summary, 'x');
    assert.deepEqual(handoffRead.json.next, ['y']);
  });

  // "blocked" (017) is where a ticket stops. The fix rounds are counted off the ticket's own log,
  // so spending them is a matter of writing the lines a red gate would have written; the cap is
  // config.fixRounds.resume + .fresh, which init writes as 3 + 2.
  await t.test('13. blocked: a ticket whose fix rounds are spent stops, and is never handed out again', () => {
    const stuck = run('tk.mjs', ['new', 'going-nowhere', '--title', 'Going nowhere', '--node', 'model', '--class', 'standard', '--evidence', 'it works'], dir);
    assert.equal(stuck.code, 0, stuck.stderr);
    const stuckId = stuck.json.id;
    assert.equal(run('queue.mjs', ['add', stuckId], dir).code, 0);

    const blocked = run('queue.mjs', ['set', stuckId, 'blocked'], dir);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(blocked.json.state, 'blocked');

    // Blocked is a stop, not a pause: it is listed and counted, and `next` never returns it.
    assert.deepEqual(
      run('queue.mjs', ['list', '--state', 'blocked'], dir).json.map((i) => i.ticket),
      [stuckId],
    );
    const next = run('queue.mjs', ['next'], dir);
    assert.notEqual(next.json && next.json.ticket, stuckId, 'a blocked ticket is never what comes next');

    // And the whole ladder is one closed list, named in the refusal when something else is asked for.
    const bogus = run('queue.mjs', ['set', stuckId, 'nonsense'], dir);
    assert.equal(bogus.code, 1);
    assert.match(bogus.stderr, /allowed: proposed, queued, waiting, running, landed, blocked, merged, escalated, dropped/);
  });
});
