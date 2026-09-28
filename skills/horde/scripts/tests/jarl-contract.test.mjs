// The contract Horde keeps with Jarl. A mission's record is a Jarl loop (.horde/hordes/<h>/.jarl/,
// loop.mjs), opened with Horde's profile, and Jarl's own tools read and write that loop like any
// other — so what Horde's schedule and gate decide has to hold against them too, as data, not as a
// courtesy:
//
//   - the architect's veto: no ticket leaves "proposed" (or reaches any status the scheduler owns)
//     through `jarl set`: every status is "set-by": "record";
//   - only a merge settles a dependency: a dropped ticket does not release what waited on it;
//   - a question to the client holds what it holds in Horde's schedule whoever filed it — Horde's
//     ask.mjs or Jarl's own `ask` against the mission's loop;
//   - the done guard: a ticket closes (merged) only on a recorded merge its base holds, with an
//     evidence row — never by a status typed in;
//   - Jarl's own resume shows the live mission: the tickets a worker holds, with their leases;
//   - the mission's lifecycle is Horde's: Jarl's own close (which would delete the record for good)
//     and archive (which would move a live mission away) refuse, naming horde.mjs done / archive;
//   - a mission started by Horde 6.0.x (a horde directory with no loop) is refused by name.
//
// The record half runs through the vendored record.mjs with the caller Jarl's command line passes
// ('cli'). The command-line half runs Jarl's own jarl.mjs when one is found — HORDE_TEST_JARL, or a
// JarlSkill checkout beside this repository — and is skipped, with the reason printed, when none is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, git,
} from './helpers.mjs';
import * as R from '../vendor/jarl/skills/jarl/scripts/record.mjs';
import * as JL from '../vendor/jarl/skills/jarl/scripts/jarl-lib.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function siblingPath(...tail) {
  let dir = SCRIPTS_DIR;
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, ...tail);
    if (existsSync(candidate)) return candidate;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function findJarl() {
  const named = process.env.HORDE_TEST_JARL;
  const path = named || siblingPath('JarlSkill', 'skills', 'jarl', 'scripts', 'jarl.mjs');
  if (!path) return { ok: false, reason: 'no Jarl command line — set HORDE_TEST_JARL to JarlSkill\'s skills/jarl/scripts/jarl.mjs, or check JarlSkill out beside this repository' };
  if (!existsSync(path)) return { ok: false, reason: `HORDE_TEST_JARL names ${path}, which does not exist` };
  return { ok: true, path };
}
const JARL = findJarl();

function jarl(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [JARL.path, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

const loopOf = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde);

function newTicket(dir, slug, extra = []) {
  const r = run('tk.mjs', ['new', slug, '--title', slug, '--node', 'core', '--class', 'standard', '--evidence', 'it works', ...extra], dir);
  if (r.code !== 0) throw new Error(`tk new ${slug}: ${r.stderr}`);
  return r.json.id;
}

const statusOf = (dir, id) => R.findIssue(loopOf(dir), id).status;

test('contract: the architect\'s veto — Jarl\'s own set cannot move a ticket out of proposed, nor into any status the scheduler owns', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const id = newTicket(dir, 'vetoed');

  await t.test('the profile marks every status set by the record only', () => {
    const profile = R.describeProfile(R.loadProfile(loopOf(dir)));
    assert.equal(profile.name, 'horde');
    assert.deepEqual(profile.statuses.filter((s) => s.setBy !== 'record').map((s) => s.name), []);
  });

  await t.test('a move made the way the command line makes it is refused, and nothing is written', () => {
    assert.throws(() => R.setStatus(loopOf(dir), id, 'queued', 'skipping the review', { caller: 'cli' }), /set by the record only/);
    assert.equal(statusOf(dir, id), 'proposed');
  });

  await t.test('Jarl\'s own command line refuses it too', (tt) => {
    if (!JARL.ok) { tt.skip(JARL.reason); return; }
    const r = jarl(['set', id, 'queued', 'skipping the review', '--root', loopOf(dir)], dir);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /set by the record only/);
    assert.match(r.stderr, /tick\.mjs/, 'and it names the scheduler that does move it');
    assert.equal(statusOf(dir, id), 'proposed');
  });

  await t.test('the plan review is what moves it (Horde\'s own tools, through the record)', () => {
    run('queue.mjs', ['add', id, '--proposed'], dir);
    const r = run('tk.mjs', ['status', id, 'queued', 'passed the architect\'s plan review'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(dir, id), 'queued');
  });
});

test('contract: only a merge settles a dependency — a dropped ticket does not release what waited on it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const producer = newTicket(dir, 'producer', ['--produces', 'core/policy']);
  const consumer = newTicket(dir, 'consumer', ['--consumes', 'core/policy']);
  const root = loopOf(dir);

  await t.test('a consumed port is a dependency in the loop\'s own terms: the consumer waits on its producer', () => {
    assert.deepEqual(R.findIssue(root, consumer).after, [producer]);
    assert.ok(R.statusData(root).waitingIds.includes(consumer) || R.findIssue(root, consumer).status === 'proposed');
  });

  await t.test('dropped does not settle it: the profile says so, and the record reads it so', () => {
    const profile = R.loadProfile(root);
    assert.equal(profile.is('dropped', 'settles-dependents'), false);
    assert.equal(profile.is('merged', 'settles-dependents'), true);
    assert.deepEqual(profile.with('settles-dependents'), ['merged']);
    // Put the consumer in play and drop the producer the way Horde's record calls do, keeping the
    // After the loop holds: it still waits.
    R.setStatus(root, consumer, 'queued', 'in play', { caller: 'record' });
    R.setStatus(root, producer, 'dropped', 'not needed', { caller: 'record' });
    R.setAfter(root, consumer, producer);
    assert.ok(R.statusData(root).waitingIds.includes(consumer), 'a dropped producer settles nothing');
  });

  await t.test('Horde\'s plan takes a dropped ticket out, so the loop\'s After follows it there', () => {
    const r = run('queue.mjs', ['add', producer], dir);
    assert.equal(r.code, 0, r.stderr);
    run('queue.mjs', ['set', producer, 'dropped', '--note', 'not needed'], dir);
    assert.deepEqual(R.findIssue(root, consumer).after, []);
  });
});

test('contract: a question to the client holds what it holds, whoever filed it — Horde\'s ask or Jarl\'s own', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const id = newTicket(dir, 'held');
  run('queue.mjs', ['add', id], dir);

  await t.test('a "stop" filed through the record the way jarl ask files it holds the whole dispatch list', () => {
    R.ask(loopOf(dir), 'the spec ran out under this mission', { kind: 'stop' });
    const r = run('tick.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.spawn, []);
    assert.ok(r.json.held.some((h) => h.kind === 'stop' && h.holds === 'dispatch'), JSON.stringify(r.json.held));
    assert.ok(r.json.askClient.some((a) => a.kind === 'stop'));
  });

  await t.test('answered through Horde, it holds nothing: the ticket goes out on the next run', () => {
    const open = run('ask.mjs', ['list', '--open'], dir).json;
    assert.equal(open.length, 1);
    const answered = run('ask.mjs', ['answer', open[0].id, 'carry on as planned'], dir);
    assert.equal(answered.code, 0, answered.stderr);
    const r = run('tick.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.spawn.map((s) => s.ticket), [id]);
  });

  await t.test('a "stuck" filed with Jarl\'s own command line holds that one ticket', (tt) => {
    if (!JARL.ok) { tt.skip(JARL.reason); return; }
    const other = newTicket(dir, 'other');
    run('queue.mjs', ['add', other], dir);
    const asked = jarl(['ask', `ticket ${other} cannot go on`, '--kind', 'stuck', '--issue', other, '--root', loopOf(dir)], dir);
    assert.equal(asked.code, 0, asked.stderr);
    const r = run('tick.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.json.spawn.some((s) => s.ticket === other), JSON.stringify(r.json.spawn));
    assert.ok(r.json.held.some((h) => h.ticket === other && h.kind === 'stuck'), JSON.stringify(r.json.held));
  });
});

test('contract: the done guard — a ticket closes only on a recorded merge its base holds', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const id = newTicket(dir, 'guarded');
  const root = loopOf(dir);
  R.setStatus(root, id, 'queued', 'in play', { caller: 'record' });
  R.setStatus(root, id, 'running', 'worked', { caller: 'record', branch: 'mission1/t-001' });

  await t.test('merged through the command line is refused as set by the record only', () => {
    assert.throws(() => R.setStatus(root, id, 'merged', 'done, trust me', { caller: 'cli' }), /set by the record only/);
  });

  await t.test('Horde\'s own tk.mjs status merged is refused, naming the landing', () => {
    const r = run('tk.mjs', ['status', id, 'merged'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /land\.mjs/);
    assert.equal(statusOf(dir, id), 'running');
  });

  await t.test('the record refuses a merge with no merge recorded, and one whose sha its base does not hold', () => {
    R.addEvidence(root, id, undefined, { ran: 'land.mjs 001', saw: 'green' });
    assert.throws(() => R.setStatus(root, id, 'merged', 'x', { caller: 'record', base: 'mission1/trunk' }), /records no merge/);
    git(['checkout', '-q', '-b', 'elsewhere', 'develop'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'not on trunk'], dir);
    const stray = git(['rev-parse', 'HEAD'], dir);
    git(['checkout', '-q', '-'], dir);
    R.recordMerged(root, id, { sha: stray, ci: 'none' });
    assert.throws(() => R.setStatus(root, id, 'merged', 'x', { caller: 'record', base: 'mission1/trunk' }), /not in the base/);
    assert.equal(statusOf(dir, id), 'running');
  });

  await t.test('a merge the base holds, with an evidence row, closes it — the landing\'s own path', () => {
    const trunkTip = git(['rev-parse', 'mission1/trunk'], dir);
    R.recordMerged(root, id, { sha: trunkTip, ci: 'none' });
    R.addEvidence(root, id, undefined, { ran: 'land.mjs 001', saw: `merged into mission1/trunk as ${trunkTip}` });
    R.setStatus(root, id, 'merged', 'landed', { caller: 'record', base: 'mission1/trunk' });
    assert.equal(statusOf(dir, id), 'merged');
  });
});

test('contract: Jarl\'s own resume shows the live mission — the tickets a worker holds, with their leases, and the schedule named', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const id = newTicket(dir, 'in-flight');
  run('queue.mjs', ['add', id], dir);
  const started = run('queue.mjs', ['set', id, 'running', '--agent', 'w-1'], dir);
  assert.equal(started.code, 0, started.stderr);

  await t.test('through the record', () => {
    const data = R.resumeData(loopOf(dir));
    assert.deepEqual(data.inFlight.map((i) => i.id), [id]);
    assert.equal(data.inFlight[0].branch, started.json.branch);
    assert.equal(data.inFlight[0].worker, 'w-1');
    assert.match(data.scheduler, /tick\.mjs/);
    assert.equal(data.status.check.declared, true, 'the loop names the gate it lands through, never testimony alone');
  });

  await t.test('through Jarl\'s own command line', (tt) => {
    if (!JARL.ok) { tt.skip(JARL.reason); return; }
    const r = jarl(['resume', '--json', '--root', loopOf(dir)], dir);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.inFlight.map((i) => i.id), [id]);
    assert.equal(data.inFlight[0].worker, 'w-1');
  });
});

test('contract: a mission started by Horde 6.0.x is refused by name, with what to do', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  // A 6.0.x mission beside it: its own directory, a queue and a ticket folder, and no loop.
  const old = join(dir, '.horde', 'hordes', 'oldmission');
  mkdirSync(join(old, 'teams', 'trunk', 'issues', '001-x'), { recursive: true });
  writeFileSync(join(old, 'teams', 'trunk', 'queue.json'), '{"items":[]}\n');
  writeFileSync(join(old, 'teams', 'trunk', 'issues', '001-x', 'issue.md'), '# 001 · x\n\n**Status:** queued\n');

  for (const [tool, args] of [['tk.mjs', ['list']], ['queue.mjs', ['list']], ['tick.mjs', []], ['ask.mjs', ['list']]]) {
    await t.test(`${tool} refuses it`, () => {
      const r = run(tool, [...args, '--horde', 'oldmission'], dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /started by Horde 6\.0\.x/);
      assert.match(r.stderr, /Finish it with the Horde 6\.0\.x release/);
    });
  }

  await t.test('status names it and goes on with the rest', () => {
    const r = run('status.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    const refused = r.json.hordes.find((h) => h.name === 'oldmission');
    assert.match(refused.refused, /started by Horde 6\.0\.x/);
    assert.ok(r.json.hordes.some((h) => h.name === 'mission1' && !h.refused));
  });
  await t.test('archive still sets it aside, and history still reads it there', () => {
    const r = run('horde.mjs', ['archive', 'oldmission'], dir);
    assert.equal(r.code, 0, r.stderr);
    const history = run('horde.mjs', ['history'], dir);
    assert.equal(history.code, 0, history.stderr);
    assert.ok(JSON.stringify(history.json).includes('oldmission'));
  });

});

// Jarl's views must not lie about a mission: a ticket the director queued (queue.mjs add, no --proposed)
// is one the schedule hands out, so the loop says queued, not proposed as if it still waited on the
// architect. And a loop Jarl's own archive moved away is named as that, with where the record went —
// never as a 6.0.x mission, which would send the director to the wrong release.
test('contract: the loop says queued for a ticket the director queued, and a loop archived by Jarl is named as such', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const direct = newTicket(dir, 'direct');
  const proposed = newTicket(dir, 'proposal');
  assert.equal(run('queue.mjs', ['add', direct], dir).code, 0);
  assert.equal(run('queue.mjs', ['add', proposed, '--proposed'], dir).code, 0);
  assert.equal(statusOf(dir, direct), 'queued');
  assert.equal(statusOf(dir, proposed), 'proposed');

  // Jarl's own archive refuses a mission's loop now (the lifecycle contract below); a loop archived
  // anyway — by a Jarl from before that, or by a library call — is what is named here.
  JL.withLock(loopOf(dir), () => JL.cmdArchive(loopOf(dir), 'oops'));
  const r = run('tk.mjs', ['list'], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Jarl's own archive or close was run on it/);
  assert.match(r.stderr, /\.jarl\/archive\/\d{4}\.\d{2}\.\d{2}-oops\//);
  assert.doesNotMatch(r.stderr, /6\.0\.x/);
});

// A mission's record lives in its loop: Jarl's own close on a finished mission deleted .jarl/ with no
// way back (the loop is out of git), and Jarl's own archive moved a live mission out from under Horde.
// The profile keeps both to Horde ("lifecycle"), so the command line and the MCP tools refuse, name
// Horde's own commands and write nothing.
test('contract: the mission\'s lifecycle is Horde\'s — Jarl\'s own close and archive refuse, naming horde.mjs done and archive', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const live = newTicket(dir, 'live');
  const root = loopOf(dir);

  await t.test('the profile keeps close and archive to the record, and names Horde\'s commands', () => {
    const { lifecycle } = R.describeProfile(R.loadProfile(root));
    assert.equal(lifecycle.close, 'record');
    assert.equal(lifecycle.archive, 'record');
    assert.match(lifecycle.command, /horde\.mjs done --horde <mission>.*horde\.mjs archive <mission>/);
  });

  await t.test('a close or archive made the way the command line makes it is refused, and nothing moves', () => {
    assert.throws(() => JL.cmdClose(root, { caller: 'cli', force: true }), /never by jarl close.*run: Horde's horde\.mjs done/);
    assert.throws(() => JL.cmdArchive(root, 'x', { caller: 'cli' }), /never by jarl archive.*run: Horde's horde\.mjs done/);
    assert.ok(R.hasLiveLoop(root));
    assert.equal(statusOf(dir, live), 'proposed');
  });

  await t.test('Jarl\'s own command line refuses both: archive on a live mission, close on a finished one', (tt) => {
    if (!JARL.ok) { tt.skip(JARL.reason); return; }
    const archived = jarl(['archive', 'oops', '--root', root], dir);
    assert.equal(archived.code, 1, archived.stdout);
    assert.match(archived.stderr, /never by jarl archive/);
    assert.match(archived.stderr, /horde\.mjs archive <mission>/);
    assert.ok(R.hasLiveLoop(root), 'the live mission stays where Horde keeps it');
    R.setStatus(root, live, 'dropped', 'not needed', { caller: 'record' });
    for (const args of [['close'], ['close', '--force']]) {
      const closed = jarl([...args, '--root', root], dir);
      assert.equal(closed.code, 1, closed.stdout);
      assert.match(closed.stderr, /never by jarl close/);
      assert.match(closed.stderr, /horde\.mjs done --horde <mission>/);
    }
    assert.ok(existsSync(join(root, '.jarl', 'issues')), 'the finished mission\'s record is still there');
    assert.equal(statusOf(dir, live), 'dropped');
  });
});

// A mission opened by an earlier build of this release holds a profile without "lifecycle", so Jarl's
// own close and archive would still reach it. The director's tick brings the stored profile up to
// Horde's: the keys it lacks are added, the ones it holds are left as they are, and the log says so.
test('contract: a mission opened before a profile key existed gets it on the next tick, and keeps what it had', (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const root = loopOf(dir);
  const stored = join(root, '.jarl', 'profile.json');
  const old = JSON.parse(readFileSync(stored, 'utf8'));
  delete old.lifecycle;
  old['external-scheduler'] = 'an older wording of the scheduler line';
  writeFileSync(stored, `${JSON.stringify(old, null, 2)}\n`);
  assert.equal(R.describeProfile(R.loadProfile(root)).lifecycle.close, 'any');

  run('tick.mjs', [], dir);
  const now = JSON.parse(readFileSync(stored, 'utf8'));
  assert.equal(now.lifecycle.close, 'record');
  assert.equal(now.lifecycle.archive, 'record');
  assert.equal(now['external-scheduler'], 'an older wording of the scheduler line', 'a key the mission holds is never rewritten');
  assert.throws(() => JL.cmdClose(root, { caller: 'cli', force: true }), /never by jarl close/);
  assert.match(readFileSync(join(root, '.jarl', 'log.md'), 'utf8'), /profile brought up to this Horde's: added lifecycle/);

  const before = readFileSync(stored, 'utf8');
  run('tick.mjs', [], dir);
  assert.equal(readFileSync(stored, 'utf8'), before, 'a profile already up to date is not written again');
});
