// One end-to-end pass through a whole mini-wave, driven through the CLIs exactly as
// reference/topology.md describes it — not through any tool's internals. Every step asserts the
// state the tools are supposed to leave on disk or in git, not just an exit code.
//
// task 014 ("seat cassation") removed the deleted roster tool, the deleted dissent tool and the deleted verify tool outright, along with
// the steward/owner/verifier/auditor/counsel seats, node charters, tk.mjs's review/key commands,
// wave.mjs's audit commands, and sub-teams — and with them reference/roles/steward.md, which this
// file used to cite. What follows is the part of the loop that still exists: a worker lands a
// ticket, the merge checklist runs, a steward's own worktree (cut straight from git below —
// nothing in this tool set creates one any more) merges it into trunk, and the wave closes. Where
// a step's whole point was one of the deleted seats or gates, it is gone rather than worked
// around; see this task's report for what could not be preserved.
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
    addNode(dir, 'model', { mapping: ['src/model/**', 'tests/hook.test.mjs'] });
    addNode(dir, 'ui', { mapping: ['src/ui/**'], relations: [{ target: 'model', type: 'uses' }] });

    // node.mjs's "charter edit" (task 014) is gone — node charters no longer exist at all, and
    // node.mjs contract propose/approve never read one, so the step drops straight to the port.
    //
    // port-is-contract: the contract is a port on the component, proposed by name — there is no
    // version, in the graph or in Horde; the architect files it into the graph.
    const port = run('node.mjs', ['contract', 'propose', 'model', 'hook-surface', 'the hook the ui reads', '--by', 'owner-model'], dir);
    assert.equal(port.code, 0, port.stderr);
    assert.equal(port.json.kind, 'add');
    const approved = run('node.mjs', ['contract', 'approve', port.json.id, '--by', 'architect'], dir);
    assert.equal(approved.code, 0, approved.stderr);
    assert.equal(approved.json.status, 'approved');
    assert.ok(approved.json.filing.some((f) => f.includes('yg-node.yaml')), 'the approval names the edit the architect makes');
  });

  let stewardWorktree;
  let costRuns;

  // the deleted roster tool (task 014) is gone; nothing in this tool set creates a persistent worktree for
  // trunk any more (it used to be the one thing left of "spawn steward --team trunk" once
  // horde.mjs init started making the branch itself). A steward still needs one to merge a
  // ticket into, so the fixture takes it straight from git.
  await t.test('3a. trunk gets its own worktree, cut straight from git', () => {
    stewardWorktree = join(dir, '.horde', 'worktrees', 'pilot', 'trunk');
    git(['worktree', 'add', stewardWorktree, 'pilot/trunk'], dir);
    assert.equal(existsSync(stewardWorktree), true);
    // trunk's branch already existed from init — checking it out into a new worktree created no
    // new one
    const branches = git(['branch', '--list', 'pilot/*'], dir);
    assert.equal(branches.split('\n').map((s) => s.trim()).filter(Boolean).length, 1);
  });

  // the deleted roster tool (task 014) is gone, and with it the only thing that ever wrote cost.json — that
  // responsibility moves to a future task, so a mission-level report is exercised by seeding the
  // ledger directly, in the shape cost.mjs is still contracted to read.
  await t.test('3b. cost: seeded runs sum in a mission-level report', () => {
    costRuns = [
      { name: 'steward1', role: 'steward', class: 'sonnet', ticket: null, wave: null, at: '2026-01-01T00:00:00.000Z' },
      { name: 'owner-model', role: 'owner', class: 'sonnet', ticket: null, wave: null, at: '2026-01-01T00:00:00.000Z' },
      { name: 'architect1', role: 'architect', class: 'opus', ticket: null, wave: null, at: '2026-01-01T00:00:00.000Z' },
    ];
    writeCostRuns(dir, 'pilot', costRuns);

    const missionCost = run('cost.mjs', ['report', '--mission'], dir);
    assert.equal(missionCost.code, 0, missionCost.stderr);
    assert.equal(missionCost.json.runs, 3);
    assert.equal(missionCost.json.weighted, 3 + 3 + 10); // sonnet(3) + sonnet(3) + opus(10)
  });

  let ticketId;
  await t.test('4. ticket, queue, wave start', () => {
    const ticket = run('tk.mjs', [
      'new', 'extract-hook', '--title', 'Extract the hook', '--node', 'model', '--class', 'sonnet',
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
  // the deleted roster tool (task 014) is gone — queue.mjs's own --agent was always a free-text name, never
  // validated against a roster, so a worker is simply named here rather than spawned.
  await t.test('5. worker: running, brief', () => {
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
  await t.test('6. the worker lands its commit', () => {
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
    // tk.mjs key (task 014) is gone; nothing downstream reads the author key it used to set —
    // queue.mjs's "merged" no longer checks it either (see step 8c) — so the step is dropped.
  });

  // tk.mjs review/key, the verifier seat and the deleted verify tool (task 014) are all gone: there is no
  // owner approval, no independent verification, and so no self-verification to refuse any more.
  // review-request is the one piece of the old flow still alive, so it is the only thing left to
  // exercise here — the rest of what this step used to check could not be preserved (see report).
  await t.test('7. review requested', () => {
    const reviewRequest = run('tk.mjs', ['review-request', ticketId], dir);
    assert.equal(reviewRequest.code, 0, reviewRequest.stderr);
  });

  await t.test('8a/8b. the landing gate — every remaining item passes, including the revert test under this test suite', () => {
    // The revert test spawns its own nested `node --test <file>`; this whole suite already runs
    // under `node --test`, which is exactly the case that used to leak NODE_TEST_CONTEXT into
    // the child and get it silently skipped. Asserting a real "N fail / N tests" here (not
    // "? fail / ? tests") is the regression check for that fix.
    //
    // "--level team" is refused now (task 014) — omitting --level still defaults to the team
    // gate, so it is simply dropped. "keys" is gone from the checklist entirely.
    const gate = run('land.mjs', [`pilot/t-${ticketId}`, '--no-gate'], dir);
    const byName = Object.fromEntries(gate.json.checks.map((c) => [c.name, c]));
    for (const name of ['base freshness', 'scope', 'gate', 'journal', 'revert test']) {
      assert.equal(byName[name].ok, true, `${name}: ${byName[name].note}`);
    }
    assert.match(byName['revert test'].note, /1 fail \/ \d+ tests/);
  });

  // The rest of the wave doesn't depend on the landing gate's own verdict — queue.mjs's "merged" (task
  // 014) no longer checks keys/approvals at all, only dependency order and --sha — so it can
  // still be driven and verified for real despite the gap above; the merge itself happens in the
  // trunk steward's own worktree (created straight from git in step 3a) — merging a ticket
  // branch into your own team branch from inside that team's own worktree is exactly what a
  // steward does, not a violation of topology.md's "never check out another branch in your own
  // worktree" rule, which is about checking out something else, not merging into what's already
  // checked out.
  let mergeSha;
  await t.test('8c. a real merge into trunk, then queue set merged', () => {
    git(['merge', '--no-ff', `pilot/t-${ticketId}`, '-m', `merge ticket ${ticketId}`], stewardWorktree);
    mergeSha = git(['rev-parse', '--short', 'HEAD'], stewardWorktree);

    const merged = run('queue.mjs', ['set', ticketId, 'merged', '--sha', mergeSha], dir);
    assert.equal(merged.code, 0, merged.stderr);
    assert.equal(merged.json.worktree, null);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(git(['branch', '--list', `pilot/t-${ticketId}`], dir), '');
  });

  await t.test('9. wave journal, ticket status, wave close, cost, status', () => {
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

    // The verifier seat (task 014) is gone, so only the worker's run belongs to this wave —
    // seeded the same way the mission-level runs were, in step 3b.
    costRuns.push({
      name: workerName, role: 'worker', class: 'sonnet', ticket: ticketId, wave: '1', at: '2026-01-01T00:00:00.000Z',
    });
    writeCostRuns(dir, 'pilot', costRuns);

    const waveCost = run('cost.mjs', ['report', '--wave', '1'], dir);
    assert.equal(waveCost.code, 0, waveCost.stderr);
    assert.equal(waveCost.json.runs, 1); // just the worker, sonnet — steward/owner/architect predate wave 1
    assert.equal(waveCost.json.weighted, 3);

    const status = run('status.mjs', ['--horde', 'pilot'], dir);
    assert.equal(status.code, 0, status.stderr);
    const h = status.json.hordes[0];
    assert.equal(h.queue.byState.queued, undefined);
    assert.equal(h.queue.byState.merged, 1);
  });

  // the deleted roster tool (task 014) is gone — the "roster reconcile" half of this step (marking every
  // spawned agent's lease dead on a cold boot) went with it; nothing here replaces it, so only
  // queue.mjs's own reconcile (a dirty running item) and handoff survive below.
  await t.test('10. cold boot: a dirty running item, handoff', () => {
    const ticket2 = run('tk.mjs', ['new', 'second-thing', '--title', 'A second thing', '--node', 'model', '--class', 'sonnet', '--evidence', 'it works'], dir);
    assert.equal(ticket2.code, 0, ticket2.stderr);
    const ticket2Id = ticket2.json.id;
    assert.equal(ticket2Id, '003', 'the shared counter has issued 001 (the port proposal) and 002 (the first ticket)');
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
    // handoff.mjs no longer takes --by or --team at all (task 014) — there is only ever one
    // handoff per horde now.
    const handoffRead = run('handoff.mjs', ['read'], dir);
    assert.equal(handoffRead.code, 0, handoffRead.stderr);
    assert.equal(handoffRead.json.summary, 'x');
    assert.deepEqual(handoffRead.json.next, ['y']);
  });
});
