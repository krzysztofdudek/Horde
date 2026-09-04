import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, rmRepo, run, initHorde, writeCostRuns } from './helpers.mjs';

const charterPath = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'charter.md');
const planPath = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'plan.md');

// A minimal ticket folder — issue.md with an Acceptance checklist mentioning the evidence id,
// log.md with a verify.mjs-shaped verdict block — written directly rather than through tk.mjs /
// verify.mjs, so this test doesn't depend on that other tool's exact CLI.
function writeTicketFixture(dir, { team = 'trunk', ticket, evidenceId, verifier, result = 'reproduced' }) {
  const ticketDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', team, 'issues', `${ticket}-slug`);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(
    join(ticketDir, 'issue.md'),
    `# ${ticket} · slug\n\n**Status:** landed\n\n## Acceptance — evidence\n\n- [x] covers ${evidenceId}\n`,
  );
  writeFileSync(
    join(ticketDir, 'log.md'),
    `## Verdict · ${ticket} · 2026-01-01 · by ${verifier} (sonnet)\n\n**Result:** ${result}\n`,
  );
}

test('wave.mjs: start, note, merged, audit, close, current', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('current is "none" with no wave started', () => {
    const r = run('wave.mjs', ['current'], dir);
    assert.equal(r.json.current, null);
  });

  await t.test('close refuses when no wave is open', () => {
    const r = run('wave.mjs', ['close'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no open wave/);
  });

  await t.test('start opens wave 1, auto-incrementing when no number is given', () => {
    const r = run('wave.mjs', ['start'], dir);
    assert.equal(r.json.n, '1');
    const current = run('wave.mjs', ['current'], dir);
    assert.equal(current.json.current, '1');
  });

  await t.test('note, merged and audit append dated bullets to the journal', () => {
    run('wave.mjs', ['note', 'DAG composed'], dir);
    writeCostRuns(dir, 'mission1', [
      { name: 'mission1-worker-trunk-1', role: 'worker', class: 'sonnet', ticket: '001', team: 'trunk', wave: '1', at: new Date().toISOString() },
    ]);
    run('wave.mjs', ['merged', '001', 'abc1234'], dir);
    run('wave.mjs', ['audit', '001', 'clean', 'reproduced evidence'], dir);
    const text = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
    assert.match(text, /# Wave 1 — start/);
    assert.match(text, /DAG composed/);
    assert.match(text, /merged: 001 abc1234/);
    assert.match(text, /audit: 001 clean — reproduced evidence/);
  });

  await t.test('audit refuses an invalid verdict', () => {
    const r = run('wave.mjs', ['audit', '002', 'maybe', 'text'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /clean.*findings/);
  });

  await t.test('close with --sha records the level gate; --evidence fills rows the gate proves; a wrong id is refused', () => {
    const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
    const charter = readFileSync(charterPath, 'utf8').replace(/\| +\| +\| +\| +\|\n/, '| E9 | gate green on trunk | checks | |\n');
    writeFileSync(charterPath, charter);
    const bad = run('wave.mjs', ['close', '--gate', 'green', '--sha', 'abc1234', '--evidence', 'E42'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /E42 is not in the charter/);
    const red = run('wave.mjs', ['close', '--gate', 'red', '--evidence', 'E9'], dir);
    assert.equal(red.code, 1);
    assert.match(red.stderr, /gate is not green/);
    assert.equal(run('wave.mjs', ['current'], dir).json.current, '1');
  });

  await t.test('close renders wave-close.md and appends it, then the wave is no longer current', () => {
    const r = run('wave.mjs', ['close', '--gate', 'green', '--sha', 'abc1234', '--evidence', 'E9'], dir);
    assert.equal(r.code, 0);
    const gateCache = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'cache', 'last-gate.json'), 'utf8'));
    assert.equal(gateCache.trunk.sha, 'abc1234');
    assert.equal(gateCache.trunk.result, 'green');
    assert.match(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'charter.md'), 'utf8'), /\| E9 \|[^\n]*\| wave 1 gate on abc1234 \|/);
    assert.equal(r.json.n, '1');
    assert.equal(r.json.gate, 'green');
    const text = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
    assert.match(text, /# Wave 1 — close/);
    assert.match(text, /\*\*Cost:\*\* 1 runs · weighted 3 · mission to date 3/);
    assert.match(text, /Ticket 001 — clean:/);
    const current = run('wave.mjs', ['current'], dir);
    assert.equal(current.json.current, null);
  });

  await t.test('close refuses --gate with a bad value', () => {
    run('wave.mjs', ['start'], dir);
    const r = run('wave.mjs', ['close', '--gate', 'purple'], dir);
    assert.equal(r.code, 1);
  });
});

test('wave.mjs: a non-trunk --team gets its own plan.md, not the mission root', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  // teamPath() resolves "goblins" through its own roster.json steward entry.
  run('roster.mjs', ['spawn', 'steward', '--team', 'goblins', '--parent', 'trunk', '--class', 'sonnet'], dir);

  run('wave.mjs', ['start', '1', '--team', 'goblins'], dir);
  const teamPlan = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'teams', 'goblins', 'plan.md'), 'utf8');
  assert.match(teamPlan, /# Wave 1 — start/);

  const missionPlan = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
  assert.doesNotMatch(missionPlan, /# Wave 1 — start/);
});

test('wave.mjs close: a row goes green from a merged ticket\'s reproduced verdict, and the charter is stamped', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  // Give the charter a real evidence row (the template ships one empty placeholder row).
  const charter = readFileSync(charterPath(dir), 'utf8').replace('| | | | |', '| E1 | some check | auth | |');
  writeFileSync(charterPath(dir), charter);

  writeTicketFixture(dir, { ticket: '001', evidenceId: 'E1', verifier: 'verifier-1', result: 'reproduced' });

  run('wave.mjs', ['start'], dir);
  run('wave.mjs', ['merged', '001', 'abc1234'], dir);
  const r = run('wave.mjs', ['close', '--gate', 'green'], dir);

  assert.equal(r.code, 0);
  assert.equal(r.json.green, 1);
  assert.equal(r.json.total, 1);

  const stamped = readFileSync(charterPath(dir), 'utf8');
  assert.match(stamped, /\| E1 \| some check \| auth \| verifier-1 \|/);

  const plan = readFileSync(planPath(dir), 'utf8');
  assert.match(plan, /\*\*Evidence catalogue:\*\* 1\/1 green/);
});

test('wave.mjs close: a merged ticket without a "reproduced" verdict leaves the row red', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const charter = readFileSync(charterPath(dir), 'utf8').replace('| | | | |', '| E1 | some check | auth | |');
  writeFileSync(charterPath(dir), charter);

  writeTicketFixture(dir, { ticket: '001', evidenceId: 'E1', verifier: 'verifier-1', result: 'not-reproduced' });

  run('wave.mjs', ['start'], dir);
  run('wave.mjs', ['merged', '001', 'abc1234'], dir);
  const r = run('wave.mjs', ['close'], dir);

  assert.equal(r.json.green, 0);
  assert.equal(r.json.total, 1);
  const stamped = readFileSync(charterPath(dir), 'utf8');
  assert.match(stamped, /\| E1 \| some check \| auth \| \|/);
});

test('wave.mjs close: audit line falls back to "pending" when no audit was recorded for a ticket merged this wave', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  run('wave.mjs', ['start'], dir);
  run('wave.mjs', ['merged', '001', 'abc1234'], dir);
  const r = run('wave.mjs', ['close'], dir);

  assert.equal(r.code, 0);
  const plan = readFileSync(planPath(dir), 'utf8');
  assert.match(plan, /Ticket pending — pending:/);
});

test('wave.mjs close: an audit for a ticket merged in an earlier wave doesn\'t count for this one', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  run('wave.mjs', ['start'], dir);
  run('wave.mjs', ['merged', '001', 'abc1234'], dir);
  run('wave.mjs', ['audit', '001', 'clean', 'first wave audit'], dir);
  run('wave.mjs', ['close'], dir);

  run('wave.mjs', ['start'], dir);
  run('wave.mjs', ['merged', '002', 'def5678'], dir);
  const r = run('wave.mjs', ['close'], dir);

  assert.equal(r.code, 0);
  const plan = readFileSync(planPath(dir), 'utf8');
  const secondClose = plan.slice(plan.lastIndexOf('# Wave 2 — close'));
  assert.match(secondClose, /Ticket pending — pending:/);
});
