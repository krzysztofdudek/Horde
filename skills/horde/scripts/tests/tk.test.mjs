import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Seeds the mission's charter.md evidence catalogue table with rows a test can then cite from
// --evidence — the same table format horde.mjs init renders from templates/charter.md.
function seedCharterEvidence(dir, horde, rows) {
  const path = join(dir, '.horde', 'hordes', horde, 'charter.md');
  const text = readFileSync(path, 'utf8');
  const body = rows.map(([id, evidence, node]) => `| ${id} | ${evidence} | ${node} |  |`).join('\n');
  writeFileSync(path, text.replace('| | | | |', body));
}

// Simulates a legacy roster.json steward entry — nothing writes these any more (the deleted roster tool is
// gone), but teamPath() still resolves a leaf name through them for backward compatibility, so a
// test that wants a real sub-team address (for tk.mjs move / --team) writes the fixture directly.
function seedTeamSteward(dir, horde, team, parent = 'trunk') {
  const path = join(dir, '.horde', 'hordes', horde, 'roster.json');
  writeFileSync(path, JSON.stringify({ entries: [{ name: `${horde}-steward-${team}-1`, role: 'steward', team, parent }] }));
}

function newTicket(dir, extra = []) {
  // A queued ticket needs an acceptance line; a caller that states its own evidence keeps it.
  const evidence = extra.includes('--evidence') ? [] : ['--evidence', 'it works'];
  return run('tk.mjs', ['new', 'my-feature', '--title', 'Do the thing', '--node', 'core', '--class', 'sonnet', ...evidence, ...extra], dir);
}

// tk.mjs edit reads its new body from stdin, which the run() helper (a plain argv exec) can't
// supply — invoke it directly, the same way lifecycle.test.mjs's charterEdit does for node.mjs.
function tkEdit(dir, id, body, args = []) {
  try {
    const out = execFileSync('node', [join(SCRIPTS_DIR, 'tk.mjs'), 'edit', id, ...args, '--json'], {
      cwd: dir, input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    return { code: e.status ?? 1, stderr: e.stderr ? e.stderr.toString() : '' };
  }
}

test('tk.mjs: new, list, show, status, log, grep, review-request, move', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('new requires --node', () => {
    const r = run('tk.mjs', ['new', 'x', '--title', 't', '--class', 'sonnet'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires --node/);
  });

  let id;
  await t.test('new creates a ticket rendered from the template, status proposed', () => {
    const r = newTicket(dir);
    assert.equal(r.code, 0);
    id = r.json.id;
    assert.equal(id, '001');
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, /\*\*Status:\*\* proposed/);
    assert.match(show.json.text, /\*\*Node:\*\* core/);
  });

  await t.test('a second ticket gets the next id', () => {
    const r = run('tk.mjs', ['new', 'another', '--title', 'Another', '--node', 'core', '--class', 'haiku'], dir);
    assert.equal(r.json.id, '002');
  });

  await t.test('list filters by state, node, --open', () => {
    const all = run('tk.mjs', ['list'], dir);
    assert.equal(all.json.length, 2);
    const byNode = run('tk.mjs', ['list', '--node', 'core'], dir);
    assert.equal(byNode.json.length, 2);
    const byState = run('tk.mjs', ['list', '--state', 'proposed'], dir);
    assert.equal(byState.json.length, 2);
    run('tk.mjs', ['status', '002', 'merged'], dir);
    const open = run('tk.mjs', ['list', '--open'], dir);
    assert.equal(open.json.length, 1);
    assert.equal(open.json[0].id, '001');
  });

  await t.test('status transitions and logs a note', () => {
    const r = run('tk.mjs', ['status', id, 'queued', 'ready to go'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.status, 'queued');
    const log = run('tk.mjs', ['show', id, '--log'], dir);
    assert.match(log.json.log, /status: queued — ready to go/);
  });

  await t.test('status refuses an unknown state', () => {
    const r = run('tk.mjs', ['status', id, 'bogus'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown state/);
  });

  await t.test('log appends a bullet', () => {
    const r = run('tk.mjs', ['log', id, 'a note for the record'], dir);
    assert.equal(r.code, 0);
    const log = run('tk.mjs', ['show', id, '--log'], dir);
    assert.match(log.json.log, /a note for the record/);
  });

  await t.test('grep finds a match across issue and log text', () => {
    const r = run('tk.mjs', ['grep', 'a note for the record'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].id, id);
  });

  await t.test('review-request timestamps the log', () => {
    const r = run('tk.mjs', ['review-request', id], dir);
    assert.equal(r.code, 0);
    const log = run('tk.mjs', ['show', id, '--log'], dir);
    assert.match(log.json.log, /review requested/);
  });

  await t.test('move relocates the issue folder and updates the Team field', () => {
    seedTeamSteward(dir, 'mission1', 'allies');
    const r = run('tk.mjs', ['move', id, '--team', 'trunk/allies'], dir);
    assert.equal(r.code, 0);
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, /\*\*Team:\*\* trunk\/allies/);
    const list = run('tk.mjs', ['list', '--team', 'trunk/allies'], dir);
    assert.equal(list.json.some((x) => x.id === id), true);
  });

  await t.test('move refuses when the destination equals the current team', () => {
    const r = run('tk.mjs', ['move', id, '--team', 'trunk/allies'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in team/);
  });

  await t.test('show refuses an unknown ticket', () => {
    const r = run('tk.mjs', ['show', '999'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such ticket/);
  });

  await t.test('--team refuses a leaf with no roster steward, the literal "teams" segment, and a mismatched full path', () => {
    const noSuchTeam = run('tk.mjs', ['list', '--team', 'ghost-team'], dir);
    assert.equal(noSuchTeam.code, 1);
    assert.match(noSuchTeam.stderr, /no such team/);

    const literalTeams = run('tk.mjs', ['list', '--team', 'trunk/teams/allies'], dir);
    assert.equal(literalTeams.code, 1);
    assert.match(literalTeams.stderr, /"teams" is inserted automatically/);

    const mismatched = run('tk.mjs', ['list', '--team', 'ghost-parent/allies'], dir);
    assert.equal(mismatched.code, 1);
    assert.match(mismatched.stderr, /does not match/);
  });

  await t.test('edit rewrites the body from stdin, leaves the header block untouched, and logs who edited it', () => {
    const before = run('tk.mjs', ['show', id], dir).json.text;
    const headerBefore = before.slice(0, before.indexOf('## What'));

    const r = tkEdit(dir, id, '## What\n\nA rewritten body.\n\n## Why\n\nBecause the owner said so.\n', ['--by', 'owner1']);
    assert.equal(r.code, 0, r.stderr);

    const after = run('tk.mjs', ['show', id], dir).json.text;
    assert.equal(after.slice(0, after.indexOf('## What')), headerBefore);
    assert.match(after, /A rewritten body\./);
    assert.match(after, /Because the owner said so\./);
    assert.doesNotMatch(after, /Non-obvious context the owner wants the worker to have/);

    const log = run('tk.mjs', ['show', id, '--log'], dir);
    assert.match(log.json.log, /body edited by owner1/);
  });

  await t.test('edit refuses without --by', () => {
    const r = tkEdit(dir, id, '## What\n\nx\n', []);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires --by/);
  });

  await t.test('edit refuses empty stdin', () => {
    const r = tkEdit(dir, id, '', ['--by', 'owner1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires the new body on stdin/);
  });

  await t.test('edit refuses an unknown ticket', () => {
    const r = tkEdit(dir, '999', '## What\n\nx\n', ['--by', 'owner1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such ticket/);
  });

});

test('tk.mjs: new --evidence writes checklist lines and checks catalogue ids against the charter', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedCharterEvidence(dir, 'mission1', [
    ['E1', 'the button renders', 'core'],
    ['E2', 'the button submits', 'core'],
  ]);

  await t.test('an --evidence value with no catalogue id is accepted, and writes a checklist line', () => {
    const r = run('tk.mjs', ['new', 'no-id', '--title', 'No id', '--node', 'core', '--class', 'sonnet', '--evidence', 'a plain check, no id'], dir);
    assert.equal(r.code, 0, r.stderr);
    const show = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(show.json.text, /- \[ \] a plain check, no id/);
  });

  await t.test('an --evidence value citing a known catalogue id is accepted', () => {
    const r = run('tk.mjs', [
      'new', 'known-id', '--title', 'Known id', '--node', 'core', '--class', 'sonnet',
      '--evidence', 'covers E1', '--evidence', 'covers E2',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
    const show = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(show.json.text, /- \[ \] covers E1/);
    assert.match(show.json.text, /- \[ \] covers E2/);
  });

  await t.test('an --evidence value citing an unknown catalogue id is refused, listing it', () => {
    const r = run('tk.mjs', [
      'new', 'unknown-id', '--title', 'Unknown id', '--node', 'core', '--class', 'sonnet',
      '--evidence', 'covers E1', '--evidence', 'covers E9',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown evidence id\(s\).*E9/);
    assert.doesNotMatch(r.stderr, /E1/);
  });

  await t.test('a ticket refused for an unknown evidence id does not consume a ticket number', () => {
    const before = run('tk.mjs', ['list'], dir).json.length;
    run('tk.mjs', [
      'new', 'refused-again', '--title', 'Refused again', '--node', 'core', '--class', 'sonnet', '--evidence', 'covers E9',
    ], dir);
    const after = run('tk.mjs', ['list'], dir).json.length;
    assert.equal(after, before);
  });
});

test('tk.mjs: new --revert-base sets the header; omitted, it renders empty (default: parent tip)', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('with --revert-base', () => {
    const r = run('tk.mjs', ['new', 'pinned-surface', '--title', 'Pin it', '--node', 'core', '--class', 'sonnet', '--revert-base', 'develop'], dir);
    assert.equal(r.code, 0);
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Revert base:\*\* develop/);
  });

  await t.test('without --revert-base, the header renders with nothing after it', () => {
    const r = run('tk.mjs', ['new', 'no-base', '--title', 'No base', '--node', 'core', '--class', 'sonnet'], dir);
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Revert base:\*\* *\n/);
  });
});

test('tk.mjs: new --mutate sets the header; omitted, it renders empty (default: revert to base)', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('with --mutate', () => {
    const r = run('tk.mjs', ['new', 'mutate-surface', '--title', 'Mutate it', '--node', 'core', '--class', 'sonnet', '--mutate', "sed -i '' 's/+/-/' surface.mjs"], dir);
    assert.equal(r.code, 0);
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Mutate:\*\* sed -i '' 's\/\+\/-\/' surface\.mjs/);
  });

  await t.test('without --mutate, the header renders with nothing after it', () => {
    const r = run('tk.mjs', ['new', 'no-mutate', '--title', 'No mutate', '--node', 'core', '--class', 'sonnet'], dir);
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Mutate:\*\* *\n/);
  });

  await t.test('--mutate together with --revert-base is refused — only one variant ever runs', () => {
    const before = run('tk.mjs', ['list'], dir).json.length;
    const r = run('tk.mjs', [
      'new', 'both-fields', '--title', 'Both fields', '--node', 'core', '--class', 'sonnet',
      '--revert-base', 'develop', '--mutate', 'true',
    ], dir);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /either --mutate or --revert-base, not both/);
    const after = run('tk.mjs', ['list'], dir).json.length;
    assert.equal(after, before, 'a refused ticket must not consume a ticket number');
  });
});

test('tk.mjs: new --kind defaults to "work"; "quality" is the only other value accepted', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('omitted, the ticket is "work"', () => {
    const r = run('tk.mjs', ['new', 'default-kind', '--title', 'Default kind', '--node', 'core', '--class', 'sonnet'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.kind, 'work');
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Kind:\*\* work/);
  });

  await t.test('--kind quality marks a self-filed improvement outside the ticket\'s own scope', () => {
    const r = run('tk.mjs', ['new', 'tidy-up', '--title', 'Tidy up', '--node', 'core', '--class', 'sonnet', '--kind', 'quality'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.kind, 'quality');
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Kind:\*\* quality/);
  });

  await t.test('any other value is refused', () => {
    const r = run('tk.mjs', ['new', 'bad-kind', '--title', 'Bad kind', '--node', 'core', '--class', 'sonnet', '--kind', 'bogus'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--kind must be one of: work, quality/);
  });
});

test('tk.mjs status changes: the fix-loop breaker counts rounds, then refuses past the cap', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const created = newTicket(dir);
  const id = created.json.id;
  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);

  await t.test('rounds 1-3 resume the same worker', () => {
    for (let i = 1; i <= 3; i++) {
      const r = run('tk.mjs', ['status', id, 'changes', `attempt ${i}`], dir);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.round, i);
      assert.equal(r.json.phase, 'resume same worker');
    }
  });

  await t.test('round 4 says "fresh worker, class up"', () => {
    const r = run('tk.mjs', ['status', id, 'changes', 'attempt 4'], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /fresh worker, class up/);
    assert.match(r.stdout, /round 4\/5/);
  });

  await t.test('round 5 is still a fresh round', () => {
    const r = run('tk.mjs', ['status', id, 'changes', 'attempt 5'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.round, 5);
    assert.equal(r.json.phase, 'fresh worker, class up');
  });

  await t.test('round 6 refuses, stating only that the round cap was exceeded — no next command is proposed', () => {
    const r = run('tk.mjs', ['status', id, 'changes', 'attempt 6'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /has already gone through 5 round\(s\) of changes/);
    assert.match(r.stderr, /another round is a stall, not a fix/);
    assert.doesNotMatch(r.stderr, /adjudicate/);
    assert.doesNotMatch(r.stderr, /escalate\.mjs/);
    assert.doesNotMatch(r.stderr, /queue\.mjs/);
  });

  await t.test('the ticket never actually advanced past round 5', () => {
    const show = run('tk.mjs', ['show', id, '--log'], dir);
    const rounds = [...show.json.log.matchAll(/round (\d+)\/5/g)].map((m) => Number(m[1]));
    assert.equal(Math.max(...rounds), 5);
  });
});

test('tk.mjs new: a ticket names one node, or two — never three', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const two = run('tk.mjs', ['new', 'contract-ticket', '--title', 'A contract', '--node', 'a', '--node', 'b', '--class', 'sonnet'], dir);
  assert.equal(two.code, 0, two.stderr);

  const three = run('tk.mjs', ['new', 'sprawling', '--title', 'Too much', '--node', 'a', '--node', 'b', '--node', 'c', '--class', 'sonnet'], dir);
  assert.equal(three.code, 1);
  assert.match(three.stderr, /names one node, or two/);
  assert.match(three.stderr, /Split it into one ticket per node/);
});

test('tk.mjs: Files, Consumes, Produces and Evidence on the ticket', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedCharterEvidence(dir, 'mission1', [['E1', 'the engine denies by default', 'auth'], ['E2', 'the guard asks the engine', 'api']]);
  addNode(dir, 'auth', { mapping: ['src/auth/**'] });
  addNode(dir, 'api', { mapping: ['src/api/**'], relations: [{ target: 'auth', type: 'uses' }] });

  let producer;
  await t.test('new writes the four fields into the header', () => {
    const r = run('tk.mjs', ['new', 'policy-engine', '--title', 'Policy engine', '--node', 'auth',
      '--class', 'sonnet', '--files', 'src/auth/policy.ts,src/auth/policy.test.ts',
      '--produces', 'auth/policy', '--evidence', 'E1'], dir);
    assert.equal(r.code, 0, r.stderr);
    producer = r.json.id;
    const text = run('tk.mjs', ['show', producer], dir).json.text;
    assert.match(text, /\*\*Files:\*\* src\/auth\/policy\.ts, src\/auth\/policy\.test\.ts/);
    assert.match(text, /\*\*Consumes:\*\* none · \*\*Produces:\*\* auth\/policy/);
    assert.match(text, /\*\*Evidence:\*\* E1/);
  });

  await t.test('a declared file outside the node boundary is refused, naming the boundary', () => {
    const r = run('tk.mjs', ['new', 'wrong-node', '--title', 'Wrong node', '--node', 'auth',
      '--class', 'sonnet', '--files', 'src/api/guard.ts'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /outside the boundary of auth: src\/api\/guard\.ts/);
    assert.match(r.stderr, /the boundary is src\/auth\/\*\*/);
  });

  await t.test('a port that is not <node>/<port> is refused', () => {
    const r = run('tk.mjs', ['new', 'bad-port', '--title', 'Bad port', '--node', 'api',
      '--class', 'sonnet', '--consumes', 'auth-policy-2'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /takes <node>\/<port>/);
  });

  await t.test('the old "<node>/<port>@<version>" syntax is refused, naming the removal', () => {
    const r = run('tk.mjs', ['new', 'old-syntax', '--title', 'Old syntax', '--node', 'api',
      '--class', 'sonnet', '--consumes', 'auth/policy@2'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"@<version>" suffix was removed/);
  });

  await t.test('a consumed port nothing produces and the graph does not have is refused by name', () => {
    const r = run('tk.mjs', ['new', 'no-producer', '--title', 'No producer', '--node', 'api',
      '--class', 'sonnet', '--consumes', 'auth/sessions'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing produces auth\/sessions/);
    assert.match(r.stderr, /File the producing ticket first/);
  });

  let consumer;
  await t.test('a consumed port another ticket produces is accepted', () => {
    const r = run('tk.mjs', ['new', 'api-guard', '--title', 'Guard', '--node', 'api', '--class', 'sonnet',
      '--files', 'src/api/guard.ts', '--consumes', 'auth/policy', '--evidence', 'E2'], dir);
    assert.equal(r.code, 0, r.stderr);
    consumer = r.json.id;
  });

  await t.test('an evidence id the charter does not carry is refused', () => {
    const r = run('tk.mjs', ['new', 'invented', '--title', 'Invented', '--node', 'api',
      '--class', 'sonnet', '--evidence', 'E9'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown evidence id/);
  });

  await t.test('edit --files widens the ticket and says in the log who did it', () => {
    const r = run('tk.mjs', ['edit', consumer, '--by', 'owner-api', '--files', 'src/api/guard.ts,src/api/guard.test.ts'], dir);
    assert.equal(r.code, 0, r.stderr);
    const text = run('tk.mjs', ['show', consumer], dir).json.text;
    assert.match(text, /\*\*Files:\*\* src\/api\/guard\.ts, src\/api\/guard\.test\.ts/);
    const log = run('tk.mjs', ['show', consumer, '--log'], dir).json.log;
    assert.match(log, /files: src\/api\/guard\.ts, src\/api\/guard\.test\.ts — changed by owner-api/);
  });

  await t.test('edit --files refuses a path outside the boundary, and changes nothing', () => {
    const r = run('tk.mjs', ['edit', consumer, '--by', 'owner-api', '--files', 'src/auth/policy.ts'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /outside the boundary of api/);
    assert.match(run('tk.mjs', ['show', consumer], dir).json.text, /\*\*Files:\*\* src\/api\/guard\.ts, src\/api\/guard\.test\.ts/);
  });

  await t.test('edit --consumes/--produces/--evidence change one field each, leaving the others', () => {
    const r = run('tk.mjs', ['edit', consumer, '--by', 'owner-api', '--produces', 'api/guard', '--evidence', 'E2'], dir);
    assert.equal(r.code, 0, r.stderr);
    const text = run('tk.mjs', ['show', consumer], dir).json.text;
    assert.match(text, /\*\*Consumes:\*\* auth\/policy · \*\*Produces:\*\* api\/guard/);
    assert.match(text, /\*\*Evidence:\*\* E2/);
    assert.match(text, /\*\*Files:\*\* src\/api\/guard\.ts, src\/api\/guard\.test\.ts/);
  });

  await t.test('edit with a field flag needs no body on stdin, and leaves the body alone', () => {
    const before = run('tk.mjs', ['show', producer], dir).json.text;
    run('tk.mjs', ['edit', producer, '--by', 'owner-auth', '--evidence', 'E1'], dir);
    const after = run('tk.mjs', ['show', producer], dir).json.text;
    assert.equal(after.slice(after.indexOf('## What')), before.slice(before.indexOf('## What')));
  });
});

test('tk.mjs review-request --delta logs the file the owner is asked to read', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const created = run('tk.mjs', ['new', 'scoped', '--title', 'Scoped again', '--node', 'core', '--class', 'sonnet'], dir);
  const id = created.json.id;

  const plain = run('tk.mjs', ['review-request', id], dir);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.json.delta, null);

  const scoped = run('tk.mjs', ['review-request', id, '--delta', '.horde/hordes/mission1/teams/trunk/issues/001-scoped/rereview-aaaaaaa..bbbbbbb.diff'], dir);
  assert.equal(scoped.code, 0, scoped.stderr);
  assert.match(scoped.json.delta, /rereview-aaaaaaa\.\.bbbbbbb\.diff$/);
  const log = run('tk.mjs', ['show', id, '--log'], dir);
  assert.match(log.json.log, /review requested$/m);
  assert.match(log.json.log, /review requested — scoped re-review: .*rereview-aaaaaaa\.\.bbbbbbb\.diff/);
});

// Backward compatibility: a ticket written before this task deleted the **Keys:** line (by an
// older version of tk.mjs, or by hand) may still carry one on disk. tk.mjs no longer parses or
// writes that line at all — `show` must just pass it through as inert body text, never throw.
test('tk.mjs show: a pre-migration **Keys:** line in issue.md is inert — show does not interpret or crash on it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const created = newTicket(dir);
  const id = created.json.id;
  const ticketDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', created.json.dirName);
  const issuePath = join(ticketDir, 'issue.md');
  const before = readFileSync(issuePath, 'utf8');
  // Splice in an old-format Keys line right after Status, the way a pre-migration ticket would
  // have carried it — nothing in the current template writes this line any more.
  const withKeys = before.replace(
    /^(\*\*Status:\*\*.*)$/m,
    '$1\n**Keys:** author worker1 · verifier — · core —',
  );
  writeFileSync(issuePath, withKeys);

  const show = run('tk.mjs', ['show', id], dir);
  assert.equal(show.code, 0, show.stderr);
  // The line is passed through as plain text, not interpreted into any structured field.
  assert.match(show.json.text, /\*\*Keys:\*\* author worker1/);

  const list = run('tk.mjs', ['list'], dir);
  assert.equal(list.code, 0, list.stderr);
});

test('tk.mjs edit --depends: the same path queue.mjs dep writes, so the circle is caught once', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const first = newTicket(dir).json.id;
  const second = run('tk.mjs', ['new', 'second', '--title', 'Second', '--node', 'core', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  const third = run('tk.mjs', ['new', 'third', '--title', 'Third', '--node', 'core', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  for (const id of [first, second, third]) assert.equal(run('queue.mjs', ['add', id], dir).code, 0);

  await t.test('it adds the edge to the queue item and logs who changed it', () => {
    const r = run('tk.mjs', ['edit', second, '--depends', first, '--by', 'consultant-a'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.changed, [`depends on: ${first}`]);
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === second);
    assert.deepEqual(item.dependsOn, [first]);
    assert.match(run('tk.mjs', ['show', second, '--log'], dir).json.log, new RegExp(`depends on: ${first} — changed by consultant-a`));
  });

  await t.test('a comma-separated list adds every one of them', () => {
    const r = run('tk.mjs', ['edit', third, '--depends', `${first},${second}`, '--by', 'consultant-a'], dir);
    assert.equal(r.code, 0, r.stderr);
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === third);
    assert.deepEqual(item.dependsOn.sort(), [first, second].sort());
  });

  await t.test('the plan is computed from it, exactly as it is from queue.mjs dep', () => {
    const plan = run('queue.mjs', ['plan'], dir).json;
    assert.deepEqual(plan.tickets.find((x) => x.id === third).dependsOn.sort(), [first, second].sort());
  });

  await t.test('a circle is refused here, by the one check that owns it', () => {
    const r = run('tk.mjs', ['edit', first, '--depends', third, '--by', 'consultant-a'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /would create a cycle/);
    assert.deepEqual(run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === first).dependsOn, []);
  });

  await t.test('a dependency that is not a ticket is refused by name', () => {
    const r = run('tk.mjs', ['edit', second, '--depends', '999', '--by', 'consultant-a'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such dependency: "999"/);
  });

  await t.test('a ticket that is not in the queue is told to join it first', () => {
    const loose = run('tk.mjs', ['new', 'loose', '--title', 'Loose', '--node', 'core', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
    const r = run('tk.mjs', ['edit', loose, '--depends', first, '--by', 'consultant-a'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /add it to the queue first/);
  });

  await t.test('with --depends alone, no body is read from stdin and none is required', () => {
    const r = run('tk.mjs', ['edit', second, '--depends', first, '--by', 'consultant-a'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.bytes, 0);
  });

  await t.test('and the refusal for none of them at all names it among the ways in', () => {
    const r = tkEdit(dir, second, '', ['--by', 'consultant-a']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--depends/);
  });
});
