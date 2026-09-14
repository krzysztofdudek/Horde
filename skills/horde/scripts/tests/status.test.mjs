import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

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

  await t.test('digest reflects trunk, queue and asks once a horde runs', () => {
    initHorde(dir, 'mission1');
    run('ask.mjs', ['add', 'q', '--kind', 'charter'], dir);

    const r = run('status.mjs', [], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.hordes.length, 1);
    const h = r.json.hordes[0];
    assert.equal(h.name, 'mission1');
    assert.equal(h.trunk.branch, 'mission1/trunk');
    assert.equal(h.trunk.sha.length > 0, true);
    assert.equal(h.asks.open, 1);
    assert.equal(h.cost, undefined);
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

  // --team used to narrow the digest to a sub-team. Nothing spawns one any more, so for any name
  // but "trunk" it printed a horde with no team in it at all — an empty answer that reads as
  // "nothing is happening here". A digest that answers with silence is the one failure it cannot
  // have, so the name is refused instead.
  await t.test('--team takes trunk, and refuses any other name rather than printing an empty horde', () => {
    const trunk = run('status.mjs', ['--horde', 'mission1', '--team', 'trunk'], dir);
    assert.equal(trunk.code, 0, trunk.stderr);
    assert.deepEqual(trunk.json.hordes[0].teams.map((t2) => t2.name), ['trunk']);

    const other = run('status.mjs', ['--horde', 'mission1', '--team', 'lark'], dir);
    assert.equal(other.code, 1);
    assert.match(other.stderr, /no such team "lark"/);
    assert.match(other.stderr, /every ticket is filed on "trunk"/);
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
    entries: [{ role: 'steward', team: 'goblins', parent: 'trunk', class: 'standard', name: 'steward-goblins-1' }],
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
  run('tk.mjs', ['new', 'use-shared', '--title', 'Use shared', '--node', 'shared', '--class', 'standard', '--horde', 'beta'], dir);

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

// 079 — a ticket branch whose queue.json entry is gone must still surface, as an orphan, not
// vanish. Liveness is judged by branches, not by silence in the queue.
test('status.mjs: a ticket branch with no queue entry shows up as orphaned', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1');

  // A branch under the ticket-branch pattern that queue.json never mentions (its entry was lost).
  execFileSync('git', ['branch', 'mission1/t-999', 'mission1/trunk'], { cwd: dir });

  const r = run('status.mjs', ['--horde', 'mission1'], dir);
  assert.equal(r.code, 0, r.stderr);
  const h = r.json.hordes[0];
  assert.deepEqual(h.orphanedBranches, ['mission1/t-999']);

  const human = run('status.mjs', ['--horde', 'mission1'], dir, { json: false });
  assert.match(human.stdout, /orphaned branches \(no queue entry\)/);
  assert.match(human.stdout, /mission1\/t-999/);
});

// 068 — branchCategory has to read the ticket's own issue Status (issue.md), not just the queue
// item's state (queue.json): the two vocabularies are disjoint (queue.json's `state` can never be
// "verified" or "changes" — those are issue.md Status values), so a ticket the gate has just sent
// back for changes must read as "unverified" even while the queue item itself still says "landed"
// (recordChanges in land.mjs, and the red-gate path in tick.mjs, both write the ticket's Status
// without necessarily moving the queue item off "landed" in the same beat).
test('status.mjs: a ticket whose issue Status is "changes" reads as unverified, even with a stale "landed" queue state', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const ticket = run('tk.mjs', [
    'new', 'widget-fix', '--title', 'Fix the widget', '--node', 'widget', '--class', 'standard',
    '--evidence', 'widget behaves correctly',
  ], dir);
  assert.equal(ticket.code, 0, ticket.stderr);
  const id = ticket.json.id;

  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  assert.equal(run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir).code, 0);
  const landed = run('queue.mjs', ['set', id, 'landed'], dir);
  assert.equal(landed.code, 0, landed.stderr);
  assert.equal(landed.json.state, 'landed');

  // The gate sends the ticket back for changes — exactly what land.mjs's recordChanges and
  // tick.mjs's red-gate path do to the ticket's own Status — without anything touching the queue
  // item's state, which stays "landed", stale.
  const changes = run('tk.mjs', ['status', id, 'changes', 'gate red: some check failed'], dir);
  assert.equal(changes.code, 0, changes.stderr);

  const r = run('status.mjs', ['--horde', 'mission1'], dir);
  assert.equal(r.code, 0, r.stderr);
  const tb = r.json.hordes[0].teams[0].ticketBranches.find((t2) => t2.ticket === id);
  assert.ok(tb, 'ticket branch present in the digest');
  assert.equal(tb.state, 'landed', "the queue item's own state never moved");
  assert.equal(tb.category, 'unverified', 'a ticket whose real Status is "changes" must not read as "landed"');
});

// E13 — status.mjs's evidence block: every charter row in one of six states, derived from
// tickets' own **Status:**, **Kind:** and acceptance checklists, never from a second, hand-kept
// count.
test('status.mjs: the evidence block shows all six coverage states', async (t) => {
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
      '| E6 | shown to the client, not yet answered | web | |',
      '| E7 | shown, but real work is also filed on it | web | |',
    ].join('\n'),
  );
  writeFileSync(charterPath, charter);

  function ticket(id, status, evidenceId, kind) {
    const dst = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', `${id}-slug`);
    mkdirSync(dst, { recursive: true });
    const kindLine = kind ? `\n**Kind:** ${kind}` : '';
    writeFileSync(join(dst, 'issue.md'), `# ${id} · slug\n\n**Status:** ${status}${kindLine}\n\n## Acceptance — evidence\n\n- [ ] covers ${evidenceId}\n`);
    // The log's contents are not what the evidence block reads — a row's state comes from the
    // ticket's own **Status:**, **Kind:** and its acceptance checklist, and "reproduced" comes
    // from the charter's own last column. The file exists here because a ticket directory has one.
    writeFileSync(join(dst, 'log.md'), `- 2026-01-01 status: ${status}\n`);
  }
  ticket('002', 'proposed', 'E2');
  ticket('003', 'running', 'E3');
  ticket('004', 'merged', 'E4');
  // 099 — a row only a prototype names must not read as ordinary "queued" work: it is a promise
  // being shown, not one being built, and a reader must be able to tell the two apart.
  ticket('005', 'proposed', 'E6', 'prototype');
  // Once a real ticket also claims the row (the shape after the client has answered and the real
  // work is filed alongside it), the real ticket's own progress wins — whatever the prototype's
  // own status is, even one as advanced-looking as "merged" (landed on the prototype branch, not
  // the trunk).
  ticket('006', 'merged', 'E7', 'prototype');
  ticket('007', 'running', 'E7');

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
  assert.equal(byId.E6.state, 'prototyping');
  assert.equal(byId.E6.ticket, '005');
  assert.equal(byId.E7.state, 'running', 'the real ticket wins the row over the prototype, whatever either one\'s own status');
  assert.equal(byId.E7.ticket, '007');
  assert.equal(r.json.hordes[0].evidence.total, 7);

  const human = run('status.mjs', ['--horde', 'mission1'], dir, { json: false });
  assert.match(human.stdout, /evidence: 1\/7 reproduced/);
  assert.match(human.stdout, /E4 \[merged\]/);
  assert.match(human.stdout, /E6 \[prototyping\]/);
});
