// One end-to-end pass through a whole mini-wave, driven through the CLIs exactly as
// reference/roles/steward.md's loop and reference/topology.md describe it — not through any
// tool's internals. Every step asserts the state the tools are supposed to leave on disk or in
// git, not just an exit code.
//
// Two gaps surfaced along the way and are both now fixed at the source rather than worked
// around here:
//
// - "roster: the trunk steward has no way to register" — roster.mjs spawn steward --team trunk
//   used to always try to (re)create the branch "<horde>/trunk", which horde.mjs init already
//   created, so it always refused. "--team trunk" now needs no --parent and creates nothing —
//   the trunk branch and directory already exist from init — it only registers the roster entry.
// - premerge's nested `node --test <file>` inheriting NODE_TEST_CONTEXT from this very test
//   run, and so being silently skipped by Node's own recursive-test-runner guard — checkRevertTest
//   now spawns that child with the inherited test-runner markers stripped from its environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// node.mjs's "charter edit" takes its content on stdin, which the run() helper (a plain argv
// exec) can't supply — invoke it directly, the same way tests/node.test.mjs does.
function charterEdit(dir, node, stdin) {
  const out = execFileSync('node', [join(SCRIPTS_DIR, 'node.mjs'), 'charter', 'edit', node, '--json'], {
    cwd: dir, input: stdin, encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('horde lifecycle: one mini-wave from init to a cold-boot reconcile', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  await t.test('1. horde init', () => {
    const init = run('horde.mjs', ['init', 'pilot', '--base', 'develop', '--title', 'Pilot', '--graph-dir', 'architecture'], dir);
    assert.equal(init.code, 0, init.stderr);
    assert.equal(existsSync(join(dir, '.horde')), true);
    assert.equal(readFileSync(join(dir, '.horde', '.gitignore'), 'utf8').trim(), '*');
    assert.match(git(['branch', '--list', 'pilot/trunk'], dir), /pilot\/trunk/);
    const charter = readFileSync(join(dir, '.horde', 'hordes', 'pilot', 'charter.md'), 'utf8');
    assert.match(charter, /# Mission · Pilot/);
  });

  // "model"'s boundary has to cover its own test file too (tests/hook.test.mjs), not just the
  // source path — premerge.mjs's scope check (item 3) treats a test file like any other diff
  // file, with no built-in exception for config.testGlobs; a node's tests live in its boundary
  // the same way premerge.test.mjs's own fixtures always pair a source glob with its test glob.
  await t.test('2. nodes, charter, contract', () => {
    const nodeModel = run('node.mjs', ['new', 'model', '--boundary', 'src/model/**,tests/hook.test.mjs'], dir);
    assert.equal(nodeModel.code, 0, nodeModel.stderr);
    const nodeUi = run('node.mjs', ['new', 'ui', '--boundary', 'src/ui/**'], dir);
    assert.equal(nodeUi.code, 0, nodeUi.stderr);

    const edited = charterEdit(dir, 'model', '# Node · model\n\nOwns the interview state hook.\n');
    assert.ok(edited.bytes > 0);
    assert.match(readFileSync(join(dir, 'architecture', 'nodes', 'model', 'charter.md'), 'utf8'), /Owns the interview state hook/);

    const contract = run('node.mjs', ['contract', 'propose', 'model', 'ui', '--as', 'tests/contract.test.mjs', 'hook surface'], dir);
    assert.equal(contract.code, 0, contract.stderr);
    const contractApprove = run('node.mjs', ['contract', 'approve', contract.json.id, '--by', 'architect'], dir);
    assert.equal(contractApprove.code, 0, contractApprove.stderr);
    assert.equal(contractApprove.json.status, 'approved');
  });

  let stewardName;
  let stewardWorktree;
  let ownerName;
  let architectName;

  await t.test('3a. roster: the trunk steward registers with no --parent and creates nothing but its own worktree', () => {
    const stewardSpawn = run('roster.mjs', ['spawn', 'steward', '--team', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(stewardSpawn.code, 0, stewardSpawn.stderr);
    stewardName = stewardSpawn.json.name;
    stewardWorktree = stewardSpawn.json.worktree;
    assert.equal(stewardSpawn.json.team, 'trunk');
    assert.ok(stewardWorktree.endsWith(join('worktrees', 'pilot', 'trunk')));
    assert.equal(existsSync(stewardWorktree), true);
    // trunk's branch already existed from init — this spawn created no new one
    const branches = git(['branch', '--list', 'pilot/*'], dir);
    assert.equal(branches.split('\n').map((s) => s.trim()).filter(Boolean).length, 1);
    // trunk has no parent queue to register a "team:trunk" item into
    const trunkQueue = run('queue.mjs', ['list'], dir);
    assert.equal(trunkQueue.json.some((i) => i.ticket === 'team:trunk'), false);
  });

  await t.test('3b. roster: owner, architect; cost --mission', () => {
    const ownerSpawn = run('roster.mjs', ['spawn', 'owner', '--node', 'model', '--class', 'sonnet'], dir);
    assert.equal(ownerSpawn.code, 0, ownerSpawn.stderr);
    ownerName = ownerSpawn.json.name;

    const architectSpawn = run('roster.mjs', ['spawn', 'architect', '--class', 'opus'], dir);
    assert.equal(architectSpawn.code, 0, architectSpawn.stderr);
    architectName = architectSpawn.json.name;

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
    assert.equal(ticketId, '001');

    const queued = run('queue.mjs', ['add', ticketId], dir);
    assert.equal(queued.code, 0, queued.stderr);

    const waveStart = run('wave.mjs', ['start'], dir);
    assert.equal(waveStart.code, 0, waveStart.stderr);
    assert.equal(waveStart.json.n, '1');
  });

  let workerName;
  let worktreePath;
  await t.test('5. worker: spawn, running, brief', () => {
    const workerSpawn = run('roster.mjs', ['spawn', 'worker', '--team', 'trunk', '--class', 'sonnet', '--ticket', ticketId], dir);
    assert.equal(workerSpawn.code, 0, workerSpawn.stderr);
    workerName = workerSpawn.json.name;

    const running = run('queue.mjs', ['set', ticketId, 'running', '--agent', workerName], dir);
    assert.equal(running.code, 0, running.stderr);
    assert.equal(running.json.branch, 'pilot/t-001');
    assert.ok(running.json.worktree.endsWith(join('worktrees', 'pilot', 't-001')));
    assert.match(git(['branch', '--list', 'pilot/t-001'], dir), /pilot\/t-001/);
    worktreePath = running.json.worktree;
    assert.equal(existsSync(worktreePath), true);

    const workerBrief = run('brief.mjs', ['worker', ticketId, '--name', workerName], dir);
    assert.equal(workerBrief.code, 0, workerBrief.stderr);
    assert.doesNotMatch(workerBrief.json.brief, /\{\{/);
    assert.match(workerBrief.json.brief, /worktree is `.*t-001`/);
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
    landedSha = git(['rev-parse', '--short', 'pilot/t-001'], dir);

    const tkLog = run('tk.mjs', ['log', ticketId, `landed ${landedSha}`], dir);
    assert.equal(tkLog.code, 0, tkLog.stderr);
    const tkKey = run('tk.mjs', ['key', ticketId, 'author', '--by', workerName], dir);
    assert.equal(tkKey.code, 0, tkKey.stderr);
  });

  let verifierName;
  await t.test('7. review, verify, and the refused self-verification', () => {
    const reviewRequest = run('tk.mjs', ['review-request', ticketId], dir);
    assert.equal(reviewRequest.code, 0, reviewRequest.stderr);
    const review = run('tk.mjs', ['review', ticketId, 'approve', '--by', ownerName], dir);
    assert.equal(review.code, 0, review.stderr);
    assert.deepEqual(review.json.nodes, ['model']);

    const verifierSpawn = run('roster.mjs', ['spawn', 'verifier', '--team', 'trunk', '--class', 'sonnet', '--ticket', ticketId], dir);
    assert.equal(verifierSpawn.code, 0, verifierSpawn.stderr);
    verifierName = verifierSpawn.json.name;

    const verifierBrief = run('brief.mjs', ['verifier', ticketId, '--name', verifierName], dir);
    assert.equal(verifierBrief.code, 0, verifierBrief.stderr);
    assert.doesNotMatch(verifierBrief.json.brief, /\{\{/);

    const verdict = run('verify.mjs', [
      'record', ticketId, '--verdict', 'reproduced', '--revert', 'failed', '--by', verifierName,
      '--item', '1|node --test|1 pass', '--gate', 'green', '--sha', landedSha,
    ], dir);
    assert.equal(verdict.code, 0, verdict.stderr);

    const selfVerify = run('verify.mjs', [
      'record', ticketId, '--verdict', 'reproduced', '--revert', 'failed', '--by', workerName,
      '--item', '1|node --test|1 pass', '--gate', 'green', '--sha', landedSha,
    ], dir);
    assert.equal(selfVerify.code, 1);
    assert.match(selfVerify.stderr, /cannot be the ticket's author/);
  });

  await t.test('8a/8b. premerge — all six items pass, including the revert test under this test suite', () => {
    // The revert test spawns its own nested `node --test <file>`; this whole suite already runs
    // under `node --test`, which is exactly the case that used to leak NODE_TEST_CONTEXT into
    // the child and get it silently skipped. Asserting a real "N fail / N tests" here (not
    // "? fail / ? tests") is the regression check for that fix.
    const premerge = run('premerge.mjs', ['pilot/t-001', '--level', 'team', '--no-gate'], dir);
    const byName = Object.fromEntries(premerge.json.checks.map((c) => [c.name, c]));
    for (const name of ['base freshness', 'keys', 'scope', 'gate', 'journal', 'revert test']) {
      assert.equal(byName[name].ok, true, `${name}: ${byName[name].note}`);
    }
    assert.match(byName['revert test'].note, /1 fail \/ \d+ tests/);
  });

  // The rest of the wave doesn't depend on premerge's own verdict — queue.mjs's "merged" refusal
  // only checks the ticket's Keys line — so it can still be driven and verified for real despite
  // the gap above; the merge itself happens in the trunk steward's own worktree (roster.mjs spawn
  // gave it one on "pilot/trunk" in step 3a) — merging a ticket branch into your own team branch
  // from inside that team's own worktree is exactly what a steward does, not a violation of
  // topology.md's "never check out another branch in your own worktree" rule, which is about
  // checking out something else, not merging into what's already checked out.
  let mergeSha;
  await t.test('8c. a real merge into trunk, then queue set merged', () => {
    git(['merge', '--no-ff', 'pilot/t-001', '-m', 'merge ticket 001'], stewardWorktree);
    mergeSha = git(['rev-parse', '--short', 'HEAD'], stewardWorktree);

    const merged = run('queue.mjs', ['set', ticketId, 'merged', '--sha', mergeSha], dir);
    assert.equal(merged.code, 0, merged.stderr);
    assert.equal(merged.json.worktree, null);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(git(['branch', '--list', 'pilot/t-001'], dir), '');
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

    const waveCost = run('cost.mjs', ['report', '--wave', '1'], dir);
    assert.equal(waveCost.code, 0, waveCost.stderr);
    assert.equal(waveCost.json.runs, 2); // worker + verifier, both sonnet — steward/owner/architect predate wave 1
    assert.equal(waveCost.json.weighted, 3 + 3);

    const status = run('status.mjs', ['--horde', 'pilot'], dir);
    assert.equal(status.code, 0, status.stderr);
    const h = status.json.hordes[0];
    assert.equal(h.queue.byState.queued, undefined);
    assert.equal(h.queue.byState.merged, 1);
  });

  await t.test('10. cold boot: roster reconcile, a dirty running item, handoff', () => {
    const reconciled = run('roster.mjs', ['reconcile'], dir);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    assert.equal(reconciled.json.marked, 5); // steward, owner, architect, worker, verifier
    const rosterAfter = run('roster.mjs', ['list'], dir);
    assert.equal(rosterAfter.json.every((e) => e.lease === 'dead'), true);

    const ticket2 = run('tk.mjs', ['new', 'second-thing', '--title', 'A second thing', '--node', 'model', '--class', 'sonnet'], dir);
    assert.equal(ticket2.code, 0, ticket2.stderr);
    const ticket2Id = ticket2.json.id;
    assert.equal(ticket2Id, '002');
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
    // handoff.mjs read without --by now prints both the mission-level and the team's handoff
    // (mission first); --by director asks for the single mission-level doc this test wrote.
    const handoffRead = run('handoff.mjs', ['read', '--by', 'director'], dir);
    assert.equal(handoffRead.code, 0, handoffRead.stderr);
    assert.equal(handoffRead.json.summary, 'x');
    assert.deepEqual(handoffRead.json.next, ['y']);
  });
});
