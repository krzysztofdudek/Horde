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

test('brief.mjs: every role held to a discipline carries it under "## Law"', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('node.mjs', ['new', 'nodeA', '--boundary', 'src/a/**'], dir);
  writeRoster(dir, 'mission1', [
    { name: 'mission1-steward-trunk-1', role: 'steward', team: 'trunk', parent: null },
  ]);
  seedTicket(dir, 'mission1', 'trunk', '003', {
    branch: 'mission1/t-003', worktree: '.horde/worktrees/mission1/t-003',
  });

  await t.test('worker — the tdd and debugging law, with their tables', () => {
    const r = run('brief.mjs', ['worker', '003', '--name', 'mission1-worker-trunk-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, /\n## Law\n/);
    assert.match(r.json.brief, /### Tests that can fail/);
    assert.match(r.json.brief, /### Finding the cause before the fix/);
    assert.match(r.json.brief, /\| What you will think \| What is true \|/);
    assert.match(r.json.brief, /#### Red flags — stop/);
    // the role file names its disciplines instead of repeating them
    assert.match(r.json.brief, /held to two disciplines — \*\*tdd\*\* and \*\*debugging\*\*/);
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('verifier — the verification and review law', () => {
    const r = run('brief.mjs', ['verifier', '003', '--name', 'mission1-verifier-trunk-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, /### Evidence before the claim/);
    assert.match(r.json.brief, /### Findings with a severity/);
    assert.match(r.json.brief, /no key without the output of the command that proves it/);
  });

  await t.test('owner — the review law and nothing else', () => {
    const r = run('brief.mjs', ['owner', 'nodeA', '--name', 'mission1-owner-nodeA-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, /### Findings with a severity/);
    assert.doesNotMatch(r.json.brief, /### Tests that can fail/);
  });

  await t.test("architect — framing's checklist, not the whole of framing", () => {
    const r = run('brief.mjs', ['architect', '--name', 'mission1-architect-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, /### Framing before anything runs — Checklist/);
    assert.match(r.json.brief, /Approve unless a gap would produce the wrong plan\./);
    assert.doesNotMatch(r.json.brief, /One question per message/);
  });

  await t.test('steward — no discipline of its own, so no Law section', () => {
    const r = run('brief.mjs', ['steward', 'trunk', '--name', 'mission1-steward-trunk-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.json.brief, /\n## Law\n/);
  });
});
