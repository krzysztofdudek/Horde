import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

function writeRoster(dir, horde, entries) {
  const path = join(dir, '.horde', 'hordes', horde, 'roster.json');
  writeFileSync(path, JSON.stringify({ entries }, null, 2));
}

function seedTicket(dir, horde, team, id, {
  title = 'Sample ticket', node = 'nodeA', body = 'What this does.\n\n## Acceptance — evidence\n\n- [ ] it works',
  branch, worktree, sha,
} = {}) {
  const issueDir = join(dir, '.horde', 'hordes', horde, 'teams', team, 'issues', `${id}-sample-ticket`);
  mkdirSync(issueDir, { recursive: true });
  const header = title === null ? '' : `# ${id} · ${title}\n\n`;
  writeFileSync(join(issueDir, 'issue.md'), `${header}**Node:** ${node} · **Class:** sonnet · **Severity:** medium · **Team:** ${team}\n\n${body}\n`);

  const queuePath = join(dir, '.horde', 'hordes', horde, 'teams', team, 'queue.json');
  const existing = JSON.parse(readFileSync(queuePath, 'utf8'));
  existing.items.push({
    ticket: id, state: 'running', class: 'sonnet', branch, worktree, dependsOn: [], agent: null, sha: sha || null, notes: [],
  });
  writeFileSync(queuePath, JSON.stringify(existing, null, 2));
}

test('brief.mjs: renders every role from a seeded charter/ticket/queue/roster', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  run('node.mjs', ['new', 'nodeA', '--boundary', 'src/a/**'], dir);

  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  const charter = readFileSync(charterPath, 'utf8');
  writeFileSync(charterPath, charter.replace(
    '## Nodes\n',
    '## Nodes\n\nTouched: nodeA (sonnet, mission) — the widget layer.\n',
  ));

  writeRoster(dir, 'mission1', [
    { name: 'mission1-steward-trunk-1', role: 'steward', team: 'trunk', parent: null },
    { name: 'mission1-owner-nodeA-1', role: 'owner', node: 'nodeA' },
    { name: 'mission1-architect-1', role: 'architect' },
  ]);

  seedTicket(dir, 'mission1', 'trunk', '001', {
    branch: 'mission1/t-001', worktree: '.horde/worktrees/mission1/t-001', sha: 'abc1234def',
  });

  await t.test('steward', () => {
    const r = run('brief.mjs', ['steward', 'trunk', '--name', 'mission1-steward-trunk-1'], dir);
    assert.equal(r.code, 0);
    assert.match(r.json.brief, /You are \*\*mission1-steward-trunk-1\*\*/);
    assert.match(r.json.brief, /Your branch is `mission1\/trunk`/);
    assert.match(r.json.brief, /report to \*\*main\*\*/);
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('owner — leaseScope reads the charter\'s Nodes line naming the node', () => {
    const r = run('brief.mjs', ['owner', 'nodeA', '--name', 'mission1-owner-nodeA-1'], dir);
    assert.equal(r.code, 0);
    assert.match(r.json.brief, /Touched: nodeA \(sonnet, mission\) — the widget layer\./);
    assert.match(r.json.brief, /report to the steward \*\*mission1-steward-trunk-1\*\*/);
  });

  await t.test('owner — leaseScope falls back to the default rule for a node the charter never names', () => {
    run('node.mjs', ['new', 'nodeB', '--boundary', 'src/b/**'], dir);
    const r = run('brief.mjs', ['owner', 'nodeB', '--name', 'mission1-owner-nodeA-1'], dir);
    assert.equal(r.code, 0);
    assert.match(r.json.brief, /mission when the node has three or more tickets, wave otherwise/);
  });

  await t.test('architect', () => {
    const r = run('brief.mjs', ['architect', '--name', 'mission1-architect-1'], dir);
    assert.equal(r.code, 0);
    assert.match(r.json.brief, /You are \*\*mission1-architect-1\*\*, the architect/);
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('worker', () => {
    const r = run('brief.mjs', ['worker', '001', '--name', 'mission1-worker-trunk-1'], dir);
    assert.equal(r.code, 0);
    assert.match(r.json.brief, /\*\*001 · Sample ticket\*\*, in node \*\*nodeA\*\*/);
    assert.match(r.json.brief, /worktree is `\.horde\/worktrees\/mission1\/t-001`/);
    assert.match(r.json.brief, /branch `mission1\/t-001`/);
    assert.match(r.json.brief, /unknown — report the count you get/);
    assert.match(r.json.brief, /# Node · nodeA/); // nodeCharter embedded
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('verifier', () => {
    const r = run('brief.mjs', ['verifier', '001', '--name', 'mission1-verifier-trunk-1'], dir);
    assert.equal(r.code, 0);
    assert.match(r.json.brief, /verifier of ticket \*\*001 · Sample ticket\*\*/);
    assert.match(r.json.brief, /it works/); // acceptance section
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('auditor — sha taken from the queue item', () => {
    const r = run('brief.mjs', ['auditor', '001', '--wave', '1', '--name', 'mission1-auditor-1'], dir);
    assert.equal(r.code, 0);
    assert.match(r.json.brief, /wave \*\*1\*\*/);
    assert.match(r.json.brief, /at the merge commit `abc1234def`/);
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('counsel — attaches a file\'s content', () => {
    writeFileSync(join(dir, 'notes.txt'), 'the trade-off in one line');
    const r = run('brief.mjs', ['counsel', '--question', 'should we split this node?', '--attach', 'notes.txt', '--name', 'mission1-counsel-1'], dir);
    assert.equal(r.code, 0);
    assert.match(r.json.brief, /should we split this node\?/);
    assert.match(r.json.brief, /the trade-off in one line/);
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('every role requires --name', () => {
    const r = run('brief.mjs', ['architect'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--name/);
  });

  await t.test('reportsTo carries the agent id, once roster.mjs has recorded one for the steward being reported to', () => {
    writeRoster(dir, 'mission1', [
      {
        name: 'mission1-steward-trunk-1', role: 'steward', team: 'trunk', parent: null, agentId: 'a-999',
      },
      { name: 'mission1-owner-nodeA-1', role: 'owner', node: 'nodeA' },
      { name: 'mission1-architect-1', role: 'architect' },
    ]);
    const worker = run('brief.mjs', ['worker', '001', '--name', 'mission1-worker-trunk-1'], dir);
    assert.equal(worker.code, 0, worker.stderr);
    assert.match(worker.json.brief, /report to the steward \*\*mission1-steward-trunk-1 \(agent id a-999\)\*\*/);

    const owner = run('brief.mjs', ['owner', 'nodeA', '--name', 'mission1-owner-nodeA-1'], dir);
    assert.equal(owner.code, 0, owner.stderr);
    assert.match(owner.json.brief, /report to the steward \*\*mission1-steward-trunk-1 \(agent id a-999\)\*\*/);
  });
});

test('brief.mjs worker --takeover: renders the prior worker\'s log and how many times it was attempted', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'nodeA', '--boundary', 'src/a/**'], dir);

  const ticket = run('tk.mjs', ['new', 'takeover-thing', '--title', 'Needs a takeover', '--node', 'nodeA', '--class', 'sonnet'], dir);
  const id = ticket.json.id;
  const queuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json');
  const q = JSON.parse(readFileSync(queuePath, 'utf8'));
  q.items.push({
    ticket: id, state: 'running', class: 'sonnet', branch: 'mission1/t-001', worktree: '.horde/worktrees/mission1/t-001', dependsOn: [], agent: null, sha: null, notes: [],
  });
  writeFileSync(queuePath, JSON.stringify(q, null, 2));

  for (let i = 1; i <= 4; i++) {
    assert.equal(run('tk.mjs', ['status', id, 'changes', `attempt ${i}`], dir).code, 0);
  }

  await t.test('without --takeover, no takeover section is rendered', () => {
    const r = run('brief.mjs', ['worker', id, '--name', 'mission1-worker-trunk-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.json.brief, /## Takeover/);
  });

  await t.test('with --takeover, the framing names the round count and reproduces the log', () => {
    const r = run('brief.mjs', ['worker', id, '--name', 'mission1-worker-trunk-2', '--takeover'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.takeover, true);
    assert.match(r.json.brief, /## Takeover/);
    assert.match(r.json.brief, /A prior worker attempted this ticket 3 times; the ticket is yours now/);
    assert.match(r.json.brief, /attempt 4/);
    assert.match(r.json.brief, /round 4\/5/);
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });
});

test('brief.mjs: refuses with the unfilled placeholder(s) rather than print "{{…}}"', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'nodeA', '--boundary', 'src/a/**'], dir);

  // A malformed ticket with no "# id · title" header — ticketTitle can't be read from it.
  seedTicket(dir, 'mission1', 'trunk', '002', {
    title: null, branch: 'mission1/t-002', worktree: '.horde/worktrees/mission1/t-002',
  });

  const r = run('brief.mjs', ['worker', '002', '--name', 'mission1-worker-trunk-1'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unfilled placeholder/);
  assert.match(r.stderr, /ticketTitle/);
});
