import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

test('verify.mjs: record (one --item per acceptance line, a reproduced verdict needs a non-red gate, reproduced sets the verifier key, refuses the author, refuses missing flags), show', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const created = run('tk.mjs', [
    'new', 'thing', '--title', 'A thing', '--node', 'core', '--class', 'sonnet',
    '--evidence', 'the button renders', '--evidence', 'the button submits',
  ], dir);
  const id = created.json.id;
  run('tk.mjs', ['key', id, 'author', '--by', 'worker1'], dir);

  await t.test('record requires --verdict, --by, --gate (for a reproduced verdict), and one --item per acceptance line', () => {
    const noVerdict = run('verify.mjs', ['record', id, '--by', 'verifier1'], dir);
    assert.equal(noVerdict.code, 1);
    assert.match(noVerdict.stderr, /--verdict is required/);
    const noRevert = run('verify.mjs', ['record', id, '--verdict', 'reproduced', '--by', 'verifier1', '--gate', 'green', '--sha', 'abc123'], dir);
    assert.equal(noRevert.code, 1);
    assert.match(noRevert.stderr, /--revert failed/);
    const revertPassed = run('verify.mjs', ['record', id, '--verdict', 'reproduced', '--revert', 'passed', '--by', 'verifier1', '--gate', 'green', '--sha', 'abc123'], dir);
    assert.equal(revertPassed.code, 1);
    assert.match(revertPassed.stderr, /not a reproduction/);
    const noGate = run('verify.mjs', ['record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1'], dir);
    assert.equal(noGate.code, 1);
    assert.match(noGate.stderr, /--verdict reproduced requires --gate/);
    const noItems = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1', '--gate', 'green', '--sha', 'abc123',
    ], dir);
    assert.equal(noItems.code, 1);
    assert.match(noItems.stderr, /missing --item for acceptance line\(s\): 1, 2/);
  });

  await t.test('a reproduced verdict with a red gate is refused', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1',
      '--item', '1|x|y', '--item', '2|x|y', '--gate', 'red', '--sha', 'abc123',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /a red gate cannot be reproduced/);
  });

  await t.test('a not-reproduced verdict needs no --gate at all', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'not-reproduced', '--by', 'verifier1',
      '--item', '1|ran the button|nothing rendered', '--item', '2|clicked it|n/a',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
  });

  await t.test('record refuses an unknown verdict', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'bogus', '--by', 'verifier1',
      '--item', '1|x|y', '--item', '2|x|y',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--verdict is required/);
  });

  await t.test('record refuses one acceptance line missing an --item', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1',
      '--item', '1|ran the button|it rendered', '--gate', 'green', '--sha', 'abc123',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /missing --item for acceptance line\(s\): 2/);
  });

  await t.test('record refuses an --item index out of range', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1',
      '--item', '1|ran the button|it rendered', '--item', '2|clicked it|it submitted', '--item', '3|extra|nope',
      '--gate', 'green', '--sha', 'abc123',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--item index out of range \(ticket has 2 acceptance line\(s\)\): 3/);
  });

  await t.test('record refuses a verifier equal to the ticket\'s author', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'worker1',
      '--item', '1|x|y', '--item', '2|x|y', '--gate', 'green', '--sha', 'abc123',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be the ticket's author/);
  });

  await t.test('a not-reproduced verdict is recorded but does not set the verifier key', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'not-reproduced', '--by', 'verifier1',
      '--item', '1|ran the button|nothing rendered', '--item', '2|clicked it|n/a',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, /verifier —/);
  });

  await t.test('--gate requires --sha', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1',
      '--item', '1|x|y', '--item', '2|x|y', '--gate', 'green',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--gate requires --sha/);
  });

  await t.test('--ran and --saw are given together, or not at all', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1',
      '--item', '1|x|y', '--item', '2|x|y', '--gate', 'green', '--sha', 'abc123', '--ran', 'npm test',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--ran and --saw are given together, or not at all/);
  });

  await t.test('a reproduced verdict with --ran/--saw appends one row per acceptance line plus an "other" row, in order, and sets the verifier key; the gate sha is recorded on a green result too', () => {
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1',
      '--item', '1|npm test button.render.test.mjs|1 passed',
      '--item', '2|npm test button.submit.test.mjs|1 passed',
      '--ran', 'npm test', '--saw', 'green',
      '--gate', 'green', '--sha', 'abc123',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, /verifier verifier1/);
    const log = run('tk.mjs', ['show', id, '--log'], dir);
    assert.match(log.json.log, /## Verdict · 001/);
    assert.match(log.json.log, /\*\*Result:\*\* reproduced/);
    assert.match(log.json.log, /\| the button renders \| npm test button\.render\.test\.mjs \| 1 passed \|/);
    assert.match(log.json.log, /\| the button submits \| npm test button\.submit\.test\.mjs \| 1 passed \|/);
    assert.match(log.json.log, /\| other \| npm test \| green \|/);
    assert.match(log.json.log, /\*\*Gate:\*\* `.*` — green at sha abc123/);
  });

  await t.test('show lists all recorded verdicts, in order', () => {
    const r = run('verify.mjs', ['show', id], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.verdicts.length, 3);
    assert.match(r.json.verdicts[0], /not-reproduced/);
    assert.match(r.json.verdicts[1], /not-reproduced/);
    assert.match(r.json.verdicts[2], /reproduced/);
  });

  await t.test('record refuses an unknown ticket', () => {
    const r = run('verify.mjs', [
      'record', '999', '--verdict', 'reproduced', '--revert', 'failed', '--by', 'v', '--item', '1|x|y', '--gate', 'green', '--sha', 'abc123',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such ticket/);
  });

  await t.test('show refuses an unknown ticket', () => {
    const r = run('verify.mjs', ['show', '999'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such ticket/);
  });

  await t.test('a ticket with no real acceptance line (the template placeholder only) needs no --item, but still needs a gate for a reproduced verdict', () => {
    const bare = run('tk.mjs', ['new', 'bare-thing', '--title', 'Bare', '--node', 'core', '--class', 'sonnet'], dir);
    const bareId = bare.json.id;
    run('tk.mjs', ['key', bareId, 'author', '--by', 'worker2'], dir);
    const r = run('verify.mjs', [
      'record', bareId, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier2', '--gate', 'green', '--sha', 'abc123',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
  });

  await t.test('record traces the verifier in the roster when --by names a real roster entry', () => {
    const verifier = run('roster.mjs', ['spawn', 'verifier', '--team', 'trunk', '--class', 'sonnet'], dir);
    assert.equal(verifier.code, 0, verifier.stderr);
    const verifierName = verifier.json.name;

    const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
    const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
    const staleAt = new Date(Date.now() - 120 * 60000).toISOString();
    roster.entries.find((e) => e.name === verifierName).lastTrace = staleAt;
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

    const ticket = run('tk.mjs', ['new', 'traced-thing', '--title', 'Traced', '--node', 'core', '--class', 'sonnet'], dir);
    run('tk.mjs', ['key', ticket.json.id, 'author', '--by', 'worker3'], dir);
    const record = run('verify.mjs', ['record', ticket.json.id, '--verdict', 'not-reproduced', '--by', verifierName], dir);
    assert.equal(record.code, 0, record.stderr);

    const after = run('roster.mjs', ['list'], dir).json.find((e) => e.name === verifierName);
    assert.notEqual(after.lastTrace, staleAt);
  });

  await t.test('the verdict names the class the verifier was staffed at, not the ticket\'s', () => {
    const verifier = run('roster.mjs', ['spawn', 'verifier', '--team', 'trunk', '--class', 'opus'], dir);
    assert.equal(verifier.code, 0, verifier.stderr);
    const ticket = run('tk.mjs', ['new', 'labelled-thing', '--title', 'Labelled', '--node', 'core', '--class', 'sonnet'], dir);
    run('tk.mjs', ['key', ticket.json.id, 'author', '--by', 'worker4'], dir);
    const record = run('verify.mjs', ['record', ticket.json.id, '--verdict', 'not-reproduced', '--by', verifier.json.name], dir);
    assert.equal(record.code, 0, record.stderr);
    const log = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', `${ticket.json.id}-labelled-thing`, 'log.md'), 'utf8');
    assert.match(log, new RegExp(`by ${verifier.json.name} \\(opus\\)`));
  });
});
