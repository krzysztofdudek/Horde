import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, rmRepo, run, initHorde, writeCostRuns } from './helpers.mjs';

test('status.mjs: no horde, then a populated digest', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  await t.test('says "no horde" before any horde exists', () => {
    const human = run('status.mjs', [], dir, { json: false });
    assert.equal(human.code, 0);
    assert.match(human.stdout, /no horde/);
    const json = run('status.mjs', [], dir);
    assert.deepEqual(json.json, { hordes: [] });
  });

  await t.test('digest reflects trunk, queue, asks and cost once a horde runs', () => {
    initHorde(dir, 'mission1');
    run('ask.mjs', ['add', 'q', '--kind', 'charter'], dir);
    writeCostRuns(dir, 'mission1', [
      { name: 'mission1-worker-trunk-1', role: 'worker', class: 'haiku', ticket: '001', team: 'trunk', wave: '1', at: new Date().toISOString() },
    ]);

    const r = run('status.mjs', [], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.hordes.length, 1);
    const h = r.json.hordes[0];
    assert.equal(h.name, 'mission1');
    assert.equal(h.trunk.branch, 'mission1/trunk');
    assert.equal(h.trunk.sha.length > 0, true);
    assert.equal(h.asks.open, 1);
    assert.equal(h.cost.runs, 1);
    assert.equal(h.cost.limit, null);
    assert.equal(h.teams.length, 1);
    assert.equal(h.teams[0].name, 'trunk');
    // status.mjs no longer reads roster.json or dissents.json at all — both fields are gone.
    assert.equal(h.stewards, undefined);
    assert.equal(h.dissents, undefined);
  });

  await t.test('lastGate is keyed by level and prints one line per level present', () => {
    const cachePath = join(dir, '.horde', 'hordes', 'mission1', 'cache');
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, 'last-gate.json'), JSON.stringify({
      commit: { sha: 'abc1234', result: 'green', count: 3, at: new Date().toISOString() },
      trunk: { sha: 'def5678', result: 'red', count: 1, at: new Date().toISOString() },
    }));

    const json = run('status.mjs', ['--horde', 'mission1'], dir);
    const h = json.json.hordes[0];
    assert.equal(h.lastGate.commit.result, 'green');
    assert.equal(h.lastGate.trunk.result, 'red');
    assert.equal(h.lastGate.team, undefined);

    const human = run('status.mjs', ['--horde', 'mission1'], dir, { json: false });
    assert.match(human.stdout, /last gate \(commit\): green/);
    assert.match(human.stdout, /last gate \(trunk\): red/);
    assert.doesNotMatch(human.stdout, /last gate \(team\)/);
  });

  await t.test('--horde narrows to one horde and refuses an unknown one', () => {
    initHorde(dir, 'mission2');
    const scoped = run('status.mjs', ['--horde', 'mission2'], dir);
    assert.equal(scoped.json.hordes.length, 1);
    assert.equal(scoped.json.hordes[0].name, 'mission2');

    const bogus = run('status.mjs', ['--horde', 'nope'], dir);
    assert.equal(bogus.code, 1);
    assert.match(bogus.stderr, /no such horde/);
  });
});

// A mission that started before this migration still has roster.json, dissents.json and
// escalations.json on disk (the deleted roster tool, the deleted dissent tool, and the escalation
// channel folded into ask.mjs in 019). status.mjs no longer reads any of the three, so their
// presence must not crash it, and its output must carry no roster/dissent/escalation-derived
// field — asks.json, absent here, reads as an empty in-tray.
test('status.mjs: old-format roster.json/dissents.json/escalations.json on disk do not crash status and leave no stewards/dissents key or escalation count', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1');

  const hordeDir = join(dir, '.horde', 'hordes', 'mission1');
  writeFileSync(join(hordeDir, 'roster.json'), JSON.stringify({
    entries: [{ role: 'steward', team: 'goblins', parent: 'trunk', class: 'sonnet', name: 'steward-goblins-1' }],
  }));
  writeFileSync(join(hordeDir, 'dissents.json'), JSON.stringify({
    items: [{ id: 'D1', ticket: '001', by: 'owner', state: 'open', text: 'q' }],
  }));
  writeFileSync(join(hordeDir, 'escalations.json'), JSON.stringify({
    items: [{ id: 'ESC1', kind: 'structure', state: 'open', why: 'an old-format kind this migration dropped' }],
  }));

  const r = run('status.mjs', ['--horde', 'mission1'], dir);
  assert.equal(r.code, 0, r.stderr);
  const h = r.json.hordes[0];
  assert.equal(h.stewards, undefined);
  assert.equal(h.dissents, undefined);
  assert.deepEqual(h.teams.map((t) => t.name), ['trunk']);
  // The stray escalations.json is no longer read at all — asks.json does not exist here either,
  // so the digest's own ask count reads as the empty in-tray it is.
  assert.equal(h.asks.total, 0);
});

// ---- node-lease-across-hordes: leases block ---------------------------------------------------

test('status.mjs: leases held by other hordes on nodes this one touches', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'alpha');
  initHorde(dir, 'beta');

  // alpha leases "shared"; beta's own ticket names it too, without ever leasing it.
  run('node.mjs', ['bind', 'shared', '--horde', 'alpha'], dir);
  run('tk.mjs', ['new', 'use-shared', '--title', 'Use shared', '--node', 'shared', '--class', 'sonnet', '--horde', 'beta'], dir);

  await t.test('beta sees alpha\'s lease on the node its own ticket touches', () => {
    const r = run('status.mjs', ['--horde', 'beta'], dir);
    assert.equal(r.code, 0);
    const h = r.json.hordes[0];
    assert.equal(h.leases.foreign.length, 1);
    assert.equal(h.leases.foreign[0].node, 'shared');
    assert.equal(h.leases.foreign[0].horde, 'alpha');
    assert.ok(h.leases.foreign[0].since);

    const human = run('status.mjs', ['--horde', 'beta'], dir, { json: false });
    assert.match(human.stdout, /leases held by other hordes on nodes this one touches/);
    assert.match(human.stdout, /shared -> alpha/);
  });

  await t.test('alpha sees no foreign lease — it is the one holding it', () => {
    const r = run('status.mjs', ['--horde', 'alpha'], dir);
    assert.deepEqual(r.json.hordes[0].leases.foreign, []);
    const human = run('status.mjs', ['--horde', 'alpha'], dir, { json: false });
    assert.doesNotMatch(human.stdout, /leases held by other hordes/);
  });

  await t.test('once alpha archives, its lease is gone and beta sees no foreign lease either', () => {
    run('horde.mjs', ['archive', 'alpha'], dir);
    const r = run('status.mjs', ['--horde', 'beta'], dir);
    assert.deepEqual(r.json.hordes[0].leases.foreign, []);
  });
});

// E13 — status.mjs's evidence block: every charter row in one of five states, derived from
// tickets' own **Status:** and acceptance checklists, never from a second, hand-kept count.
test('status.mjs: the evidence block shows all five coverage states', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  const charter = readFileSync(charterPath, 'utf8').replace(
    '| | | | |',
    [
      '| E1 | no ticket names this | api | |',
      '| E2 | filed, not started | api | |',
      '| E3 | in flight | web | |',
      '| E4 | merged, not yet stamped | web | |',
      '| E5 | already stamped by hand | web | someone |',
    ].join('\n'),
  );
  writeFileSync(charterPath, charter);

  function ticket(id, status, evidenceId) {
    const dst = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', `${id}-slug`);
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'issue.md'), `# ${id} · slug\n\n**Status:** ${status}\n\n## Acceptance — evidence\n\n- [ ] covers ${evidenceId}\n`);
    // The log's contents are not what the evidence block reads — a row's state comes from the
    // ticket's own **Status:** and its acceptance checklist, and "reproduced" comes from the
    // charter's own last column. The file exists here because a ticket directory has one.
    writeFileSync(join(dst, 'log.md'), `- 2026-01-01 status: ${status}\n`);
  }
  ticket('002', 'proposed', 'E2');
  ticket('003', 'running', 'E3');
  ticket('004', 'merged', 'E4');

  const r = run('status.mjs', ['--horde', 'mission1'], dir);
  assert.equal(r.code, 0);
  const rows = r.json.hordes[0].evidence.rows;
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.E1.state, 'no-ticket');
  assert.equal(byId.E2.state, 'queued');
  assert.equal(byId.E2.ticket, '002');
  assert.equal(byId.E3.state, 'running');
  assert.equal(byId.E3.ticket, '003');
  assert.equal(byId.E4.state, 'merged');
  assert.equal(byId.E4.ticket, '004');
  assert.equal(byId.E5.state, 'reproduced');
  assert.equal(byId.E5.reproducedBy, 'someone');
  assert.equal(r.json.hordes[0].evidence.total, 5);

  const human = run('status.mjs', ['--horde', 'mission1'], dir, { json: false });
  assert.match(human.stdout, /evidence: 1\/5 reproduced/);
  assert.match(human.stdout, /E4 \[merged\]/);
});
