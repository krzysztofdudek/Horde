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

test('verify.mjs record: --runs/--results — two disagreeing results record a flaky verdict, send the ticket to changes, and file an incident', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('--runs and --results are given together, or not at all', () => {
    const created = run('tk.mjs', ['new', 'flaky-a', '--title', 'Flaky A', '--node', 'core', '--class', 'sonnet'], dir);
    run('tk.mjs', ['key', created.json.id, 'author', '--by', 'worker-a'], dir);
    const r = run('verify.mjs', ['record', created.json.id, '--by', 'verifier-a', '--runs', '2'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--runs and --results are given together/);
  });

  await t.test('--results must list exactly --runs results', () => {
    const created = run('tk.mjs', ['new', 'flaky-b', '--title', 'Flaky B', '--node', 'core', '--class', 'sonnet'], dir);
    run('tk.mjs', ['key', created.json.id, 'author', '--by', 'worker-b'], dir);
    const r = run('verify.mjs', ['record', created.json.id, '--by', 'verifier-b', '--runs', '2', '--results', 'red,green,red'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /must list exactly --runs \(2\) result\(s\), got 3/);
  });

  await t.test('a disagreeing result requires --test to name what flaked', () => {
    const created = run('tk.mjs', ['new', 'flaky-c', '--title', 'Flaky C', '--node', 'core', '--class', 'sonnet'], dir);
    run('tk.mjs', ['key', created.json.id, 'author', '--by', 'worker-c'], dir);
    const r = run('verify.mjs', ['record', created.json.id, '--by', 'verifier-c', '--runs', '2', '--results', 'red,green'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires --test/);
  });

  await t.test('without a graph: two disagreeing runs record flaky, send the ticket to changes, and file a journal-note incident', () => {
    const created = run('tk.mjs', ['new', 'flaky-test', '--title', 'Has a flaky test', '--node', 'core', '--class', 'sonnet'], dir);
    const id = created.json.id;
    run('tk.mjs', ['key', id, 'author', '--by', 'worker-1'], dir);

    const r = run('verify.mjs', [
      'record', id, '--by', 'verifier-1', '--runs', '2', '--results', 'red,green', '--test', 'tests/flaky.test.mjs',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.verdict, 'flaky');
    assert.deepEqual(r.json.flake, { runs: 2, results: ['red', 'green'], test: 'tests/flaky.test.mjs' });
    assert.equal(r.json.incident.recorded, true);
    assert.match(r.json.incident.via, /journal note/);

    const ticket = run('tk.mjs', ['show', id], dir);
    assert.match(ticket.json.text, /\*\*Status:\*\* changes/);

    const log = run('tk.mjs', ['show', id, '--log'], dir);
    assert.match(log.json.log, /## Verdict · \d+/);
    assert.match(log.json.log, /\*\*Result:\*\* flaky/);
    assert.match(log.json.log, /\*\*Flake:\*\* tests\/flaky\.test\.mjs — runs: red, green \(2 runs\)/);
    assert.match(log.json.log, /status: changes — flaky: tests\/flaky\.test\.mjs \(round 1\/5/);

    const incidents = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'incidents.md'), 'utf8');
    assert.match(incidents, /flaky test on ticket \d+: tests\/flaky\.test\.mjs — runs: red, green/);

    // a flaky verdict never sets the verifier key — it did not reproduce anything
    assert.doesNotMatch(ticket.json.text, /verifier verifier-1/);
  });

  await t.test('agreeing results are not a flake — --verdict is still required and honoured', () => {
    const created = run('tk.mjs', ['new', 'not-flaky', '--title', 'Consistent', '--node', 'core', '--class', 'sonnet'], dir);
    const id = created.json.id;
    run('tk.mjs', ['key', id, 'author', '--by', 'worker-2'], dir);
    const r = run('verify.mjs', [
      'record', id, '--verdict', 'not-reproduced', '--by', 'verifier-2', '--runs', '2', '--results', 'red,red',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.verdict, 'not-reproduced');
  });

  await t.test('with a graph: the flake is filed through the installed Yggdrasil CLI, via a stub that records its own argv', () => {
    const stubPath = join(dir, 'stub-yg.mjs');
    writeFileSync(stubPath, [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync('stub-yg-calls.log', JSON.stringify(process.argv.slice(2)) + '\\n');",
    ].join('\n'));

    assert.equal(run('horde.mjs', ['config', 'set', 'nodeSource', 'yggdrasil'], dir).code, 0);
    assert.equal(run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stubPath}`], dir).code, 0);

    const created = run('tk.mjs', ['new', 'flaky-graph', '--title', 'Flaky under a graph', '--node', 'core', '--class', 'sonnet'], dir);
    const id = created.json.id;
    run('tk.mjs', ['key', id, 'author', '--by', 'worker-3'], dir);

    const r = run('verify.mjs', [
      'record', id, '--by', 'verifier-3', '--runs', '2', '--results', 'red,green', '--test', 'tests/graph-flaky.test.mjs',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.incident.recorded, true);
    assert.match(r.json.incident.via, /incident add/);

    const calls = readFileSync(join(dir, 'stub-yg-calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const call = calls[calls.length - 1];
    assert.deepEqual(call.slice(0, 3), ['incident', 'add', '--tag']);
    assert.equal(call[3], 'not-enforcement');
    assert.equal(call[4], '--reason');
    assert.match(call[5], new RegExp(`ticket ${id}: tests/graph-flaky\\.test\\.mjs`));
  });
});

test('verify.mjs record: a change that adds no test can still be verified', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('tk.mjs', ['new', 'rename-it', '--title', 'Rename the thing', '--node', 'auth', '--class', 'sonnet', '--evidence', 'the suite is still green'], dir);
  run('tk.mjs', ['key', '001', 'author', '--by', 'worker-1'], dir);

  // The refactor case: nothing new to run on the revert base, and until now that meant the ticket
  // could not be verified at all.
  const refused = run('verify.mjs', [
    'record', '001', '--verdict', 'reproduced', '--by', 'verifier-1',
    '--item', '1|npm test|green', '--gate', 'green', '--sha', 'abc1234', '--revert', 'not-run',
  ], dir);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--revert no-new-tests/);

  const ok = run('verify.mjs', [
    'record', '001', '--verdict', 'reproduced', '--by', 'verifier-1',
    '--item', '1|npm test|green', '--gate', 'green', '--sha', 'abc1234', '--revert', 'no-new-tests',
  ], dir);
  assert.equal(ok.code, 0, ok.stderr);

  const shown = run('verify.mjs', ['show', '001'], dir, { json: false });
  assert.match(shown.stdout, /this change adds no test/);

  const ticket = run('tk.mjs', ['show', '001'], dir);
  assert.match(ticket.json.text, /verifier verifier-1/);
});
