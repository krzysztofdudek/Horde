import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

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

// A component in the real graph. Node charters (charter.md, node.mjs's own "charter edit"
// command) are gone entirely as of task 014 — this used to also seed one via `node.mjs charter
// edit` so a worker's brief had something to embed; that placeholder is gone from the worker
// template too, so seedNode is now just addNode under the name every call site below already
// uses.
function seedNode(dir, node, mapping, ports) {
  addNode(dir, node, ports ? { mapping, ports } : { mapping });
}

test('brief.mjs: renders worker and architect from a seeded ticket, queue and roster', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  seedNode(dir, 'nodeA', ['src/a/**']);

  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  const charter = readFileSync(charterPath, 'utf8');
  writeFileSync(charterPath, charter.replace(
    '## Nodes\n',
    '## Nodes\n\nTouched: nodeA (sonnet, mission) — the widget layer.\n',
  ));

  // A pre-migration mission can still carry a roster.json with a steward entry (nothing writes
  // one any more, but old ones must not break reportsTo) — kept here only for the worker
  // reportsTo assertion below; steward and owner are no longer roles brief.mjs renders at all.
  writeRoster(dir, 'mission1', [
    { name: 'mission1-steward-trunk-1', role: 'steward', team: 'trunk', parent: null },
    { name: 'mission1-architect-1', role: 'architect' },
  ]);

  seedTicket(dir, 'mission1', 'trunk', '001', {
    branch: 'mission1/t-001', worktree: '.horde/worktrees/mission1/t-001', sha: 'abc1234def',
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
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('every role requires --name', () => {
    const r = run('brief.mjs', ['architect'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--name/);
  });

  await t.test('reportsTo carries the agent id, once a pre-migration roster.json still names the steward being reported to', () => {
    writeRoster(dir, 'mission1', [
      {
        name: 'mission1-steward-trunk-1', role: 'steward', team: 'trunk', parent: null, agentId: 'a-999',
      },
      { name: 'mission1-architect-1', role: 'architect' },
    ]);
    const worker = run('brief.mjs', ['worker', '001', '--name', 'mission1-worker-trunk-1'], dir);
    assert.equal(worker.code, 0, worker.stderr);
    assert.match(worker.json.brief, /report to the steward \*\*mission1-steward-trunk-1 \(agent id a-999\)\*\*/);
  });
});

test('brief.mjs: steward, owner, verifier, auditor and counsel are gone — unknown role, naming what remains', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedNode(dir, 'nodeA', ['src/a/**']);

  await t.test('each retired role is refused as "unknown role", listing only the roles that still exist', () => {
    for (const role of ['steward', 'owner', 'verifier', 'auditor', 'counsel']) {
      const r = run('brief.mjs', [role, 'x', '--name', 'someone'], dir);
      assert.equal(r.code, 1, `${role} should be refused`);
      assert.match(r.stderr, /unknown role: /);
      // The list is closed, and named in full: four roles and no fifth.
      assert.match(r.stderr, /roles: worker, architect, legislate, retro\)/);
    }
  });
});

test('brief.mjs worker --takeover: renders the prior worker\'s log and how many times it was attempted', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedNode(dir, 'nodeA', ['src/a/**']);

  const ticket = run('tk.mjs', ['new', 'takeover-thing', '--title', 'Needs a takeover', '--node', 'nodeA', '--class', 'sonnet', '--evidence', 'it works'], dir);
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
  seedNode(dir, 'nodeA', ['src/a/**']);

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
  seedNode(dir, 'nodeA', ['src/a/**']);
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

  await t.test("architect — framing's checklist, not the whole of framing", () => {
    const r = run('brief.mjs', ['architect', '--name', 'mission1-architect-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, /### Framing before anything runs — Checklist/);
    assert.match(r.json.brief, /Approve unless a gap would produce the wrong plan\./);
    assert.doesNotMatch(r.json.brief, /One question per message/);
  });
});

// A worker whose ticket was started from an unmerged dependency's tip is told to merge that
// dependency's branch, not the team's — merging the team branch would pull in what the parent has
// not landed and change the very diff the ticket's keys are bound to. The brief is rendered from
// real queue state, made by the real command, because what is being tested is that the first
// action a worker takes matches where the branch actually is.
test('brief.mjs: a stacked ticket\'s brief names the branch it was started from, and says so', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedNode(dir, 'feature', ['lib.mjs']);

  const first = run('tk.mjs', ['new', 'first-link', '--title', 'First link', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  const second = run('tk.mjs', ['new', 'second-link', '--title', 'Second link', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  run('queue.mjs', ['add', first], dir);
  run('queue.mjs', ['add', second, '--depends', first], dir);
  const parent = run('queue.mjs', ['set', first, 'running', '--agent', 'worker1'], dir).json;
  execFileSync('git', ['-C', parent.worktree, 'commit', '--allow-empty', '-qm', 'the first link'], { encoding: 'utf8' });
  const stacked = run('queue.mjs', ['set', second, 'running', '--agent', 'worker2', '--on', first], dir);
  assert.equal(stacked.code, 0, stacked.stderr);

  await t.test('the worker merges the parent ticket\'s branch and is told which ticket it belongs to', () => {
    const r = run('brief.mjs', ['worker', second, '--name', 'mission1-worker-trunk-2'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, new RegExp(`git merge mission1/t-${first}`));
    assert.doesNotMatch(r.json.brief, /git merge mission1\/trunk/);
    assert.match(r.json.brief, /\*\*This ticket is stacked\.\*\*/);
    assert.match(r.json.brief, new RegExp(`Ticket ${first} has not merged yet`));
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });

  await t.test('an unstacked ticket\'s brief is the team branch, with no note at all', () => {
    const r = run('brief.mjs', ['worker', first, '--name', 'mission1-worker-trunk-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, /git merge mission1\/trunk/);
    assert.doesNotMatch(r.json.brief, /This ticket is stacked/);
    assert.doesNotMatch(r.json.brief, /\{\{/);
  });
});

// the deleted roster tool (spawn/list) is deleted, and with it every way this used to build a multi-level
// lineage (a director spawning a sub-team's steward, that steward spawning a worker or lending
// out an owner). Sub-teams, stewards and owners are all gone along with it, so the only surviving,
// reconstructable piece of what this test covered is the architect's own fallback: it always
// reports to the director "main", with no roster at all involved.
test('brief.mjs: reportsTo — the architect always reports to the director "main"', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedNode(dir, 'nodeA', ['src/a/**']);

  const r = run('brief.mjs', ['architect', '--name', 'mission1-architect-1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.brief, /the director \*\*main\*\*/);
});

// resolveTree (010): the worker's brief carries the absolute path of their own worktree, and no
// longer any sentence telling them to enter the repository root first.
test('brief.mjs worker: carries the worktree\'s absolute path, never a sentence to enter the repository root', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedNode(dir, 'nodeA', ['src/a/**']);
  const absoluteWorktree = join(dir, '.horde', 'worktrees', 'mission1', 't-002');
  seedTicket(dir, 'mission1', 'trunk', '002', {
    branch: 'mission1/t-002', worktree: absoluteWorktree, sha: 'abc1234def',
  });

  const r = run('brief.mjs', ['worker', '002', '--name', 'mission1-worker-trunk-1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.brief.includes(absoluteWorktree), true);
  assert.doesNotMatch(r.json.brief, /enter the repository/i);
});

// ---- legislate: the fourth role, and the one that writes law -----------------------------------
//
// A pass over ONE territory. Everything in its brief is scoped to that territory: another area's
// refusals would propose another area's rules, which is the law-written-by-somebody-who-does-not-
// work-here this role exists to replace.

function seedTerritories(dir, horde, territories) {
  writeFileSync(join(dir, '.horde', 'hordes', horde, 'territories.json'), `${JSON.stringify(territories, null, 2)}\n`);
}

function seedLandResult(dir, horde, ticket, checks) {
  const landDir = join(dir, '.horde', 'hordes', horde, 'land');
  mkdirSync(landDir, { recursive: true });
  writeFileSync(join(landDir, `${ticket}.json`), `${JSON.stringify({ ticket, checks }, null, 2)}\n`);
}

test('brief.mjs legislate: one territory\'s own law, and nothing from anyone else\'s', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedNode(dir, 'nodeA', ['src/a/**']);
  seedNode(dir, 'nodeB', ['src/b/**']);
  seedTerritories(dir, 'mission1', {
    heart: { nodes: ['nodeA'], class: 'sonnet', why: 'the middle of it' },
    edge: { nodes: ['nodeB'], class: 'sonnet', why: 'the outside' },
  });
  seedTicket(dir, 'mission1', 'trunk', '001', { title: 'Inside the heart', node: 'nodeA', branch: 'mission1/t-001' });
  seedTicket(dir, 'mission1', 'trunk', '002', { title: 'Out on the edge', node: 'nodeB', branch: 'mission1/t-002' });
  seedLandResult(dir, 'mission1', '001', [
    { name: 'graph', ok: false, note: 'no-marker refused src/a/one.mjs' },
    { name: 'tests', ok: true, note: 'green' },
  ]);
  seedLandResult(dir, 'mission1', '002', [
    { name: 'graph', ok: false, note: 'tidy-exports refused src/b/two.mjs' },
  ]);

  let brief;
  await t.test('it renders, and never leaks an unfilled placeholder', () => {
    const r = run('brief.mjs', ['legislate', 'heart', '--name', 'mission1-legislate-heart-1'], dir);
    assert.equal(r.code, 0, r.stderr);
    brief = r.json.brief;
    assert.doesNotMatch(brief, /\{\{/, 'a brief is never printed with a placeholder left in it');
    assert.equal(r.json.territory, 'heart');
    assert.deepEqual(r.json.nodes, ['nodeA']);
    assert.deepEqual(r.json.tickets, ['001']);
  });

  await t.test('it carries this territory\'s gate refusals, and not the other\'s', () => {
    assert.match(brief, /ticket 001 · graph — no-marker refused src\/a\/one\.mjs/);
    assert.doesNotMatch(brief, /tidy-exports refused/, 'the edge territory\'s refusal is the edge territory\'s business');
    assert.doesNotMatch(brief, /tests — green/, 'a check that passed is not a refusal');
  });

  await t.test('it carries no ticket outside its territory', () => {
    assert.match(brief, /Inside the heart/);
    assert.doesNotMatch(brief, /002/, 'a ticket on another territory\'s component is not this pass\'s evidence');
    assert.doesNotMatch(brief, /Out on the edge/);
  });

  await t.test('it says which branch its edits land on, and that lowering is never its move', () => {
    assert.match(brief, /mission1\/legislate-heart/);
    assert.match(brief, /Taking a rule away, or making it\s+bite less, is the opposite direction and is never yours/);
    assert.match(brief, /node\.mjs promote <rule> --by heart/);
    assert.match(brief, /\*\*2\*\* closed waves reaching nothing/, 'config.law.retireAfterWaves, at its default');
  });

  await t.test('it carries the framing checklist under ## Law, like the architect', () => {
    assert.match(brief, /## Law/);
  });

  await t.test('without a territory it refuses, and an unknown one names the cut', () => {
    const none = run('brief.mjs', ['legislate', '--name', 'mission1-legislate-1'], dir);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /legislate requires <territory>/);

    const wrong = run('brief.mjs', ['legislate', 'nowhere', '--name', 'mission1-legislate-1'], dir);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /no such territory: nowhere/);
    assert.match(wrong.stderr, /edge, heart/);
  });
});

test('brief.mjs: a role whose template has a key nothing fills refuses, naming that key', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedNode(dir, 'nodeA', ['src/a/**']);
  seedTerritories(dir, 'mission1', { heart: { nodes: ['nodeA'], class: 'sonnet', why: 'the middle' } });

  // The real role file, with one placeholder nothing fills added to it — the refusal under test is
  // renderRole's, and it has to name the key rather than print "{{…}}" into an agent's prompt.
  const rolePath = join(SCRIPTS_DIR, '..', 'reference', 'roles', 'legislate.md');
  const original = readFileSync(rolePath, 'utf8');
  t.after(() => writeFileSync(rolePath, original));
  writeFileSync(rolePath, `${original}\nSomething nobody fills: {{aKeyNothingFills}}\n`);

  const r = run('brief.mjs', ['legislate', 'heart', '--name', 'mission1-legislate-heart-1'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /brief for "legislate" has unfilled placeholder\(s\): aKeyNothingFills/);
  assert.doesNotMatch(r.stdout, /\{\{/);
});
