import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde,
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

function newTicket(dir, extra = []) {
  return run('tk.mjs', ['new', 'my-feature', '--title', 'Do the thing', '--node', 'core', '--class', 'sonnet', ...extra], dir);
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

test('tk.mjs: new, list, show, status, log, grep, key, move', async (t) => {
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
    assert.match(show.json.text, /\*\*Keys:\*\* author — · verifier — · core —/);
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

  await t.test('key sets the author, refuses a field other than "author"', () => {
    const bad = run('tk.mjs', ['key', id, 'verifier', '--by', 'x'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /only sets "author"/);
    const r = run('tk.mjs', ['key', id, 'author', '--by', 'worker1'], dir);
    assert.equal(r.code, 0);
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, /\*\*Keys:\*\* author worker1/);
  });

  await t.test('review-request timestamps the log', () => {
    const r = run('tk.mjs', ['review-request', id], dir);
    assert.equal(r.code, 0);
    const log = run('tk.mjs', ['show', id, '--log'], dir);
    assert.match(log.json.log, /review requested/);
  });

  await t.test('review refuses a reviewer equal to the author', () => {
    const r = run('tk.mjs', ['review', id, 'approve', '--by', 'worker1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be the ticket's author/);
  });

  await t.test('review approve by the node owner records the approval and verifies a single-node ticket', () => {
    const r = run('tk.mjs', ['review', id, 'approve', '--by', 'owner1'], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.nodes, ['core']);
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, /\*\*Status:\*\* verified/);
    assert.match(show.json.text, /core owner1/);
  });

  await t.test('review changes on a two-node ticket needs --node, and both owners in turn', () => {
    const two = run('tk.mjs', ['new', 'contract-ticket', '--title', 'Two nodes', '--node', 'core', '--node', 'billing', '--class', 'sonnet'], dir);
    const twoId = two.json.id;
    run('tk.mjs', ['key', twoId, 'author', '--by', 'workerX'], dir);

    const ambiguous = run('tk.mjs', ['review', twoId, 'approve', '--by', 'ownerCore'], dir);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /pass --node/);

    const badNode = run('tk.mjs', ['review', twoId, 'approve', '--by', 'ownerCore', '--node', 'nope'], dir);
    assert.equal(badNode.code, 1);
    assert.match(badNode.stderr, /does not name node/);

    const first = run('tk.mjs', ['review', twoId, 'approve', '--by', 'ownerCore', '--node', 'core'], dir);
    assert.equal(first.code, 0);
    let show = run('tk.mjs', ['show', twoId], dir);
    // only one of two nodes approved yet — status should not flip to verified
    assert.doesNotMatch(show.json.text, /\*\*Status:\*\* verified/);

    const second = run('tk.mjs', ['review', twoId, 'changes', 'needs work', '--by', 'ownerBilling', '--node', 'billing'], dir);
    assert.equal(second.code, 0);
    show = run('tk.mjs', ['show', twoId], dir);
    assert.match(show.json.text, /\*\*Status:\*\* changes/);
    assert.match(show.json.text, /billing changes:ownerBilling/);
  });

  await t.test('review as "architect" with no --node approves every node at once', () => {
    const two = run('tk.mjs', ['new', 'arch-ticket', '--title', 'Architect covers all', '--node', 'core', '--node', 'billing', '--class', 'sonnet'], dir);
    const twoId = two.json.id;
    run('tk.mjs', ['key', twoId, 'author', '--by', 'workerY'], dir);
    const r = run('tk.mjs', ['review', twoId, 'approve', '--by', 'architect'], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.nodes.sort(), ['billing', 'core']);
    const show = run('tk.mjs', ['show', twoId], dir);
    assert.match(show.json.text, /\*\*Status:\*\* verified/);
  });

  await t.test('move relocates the issue folder and updates the Team field', () => {
    run('roster.mjs', ['spawn', 'steward', '--team', 'allies', '--parent', 'trunk', '--class', 'sonnet'], dir);
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

  await t.test('review traces the reviewer in the roster when --by names a real roster entry', () => {
    const owner = run('roster.mjs', ['spawn', 'owner', '--node', 'core', '--class', 'sonnet'], dir);
    assert.equal(owner.code, 0, owner.stderr);
    const ownerName = owner.json.name;

    // trace only ever sets "now", so back-dating directly is the only deterministic way to get
    // a stale lastTrace to prove review moves it forward.
    const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
    const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
    const staleAt = new Date(Date.now() - 120 * 60000).toISOString();
    roster.entries.find((e) => e.name === ownerName).lastTrace = staleAt;
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

    const traced = run('tk.mjs', ['new', 'traced-thing', '--title', 'Traced', '--node', 'core', '--class', 'sonnet'], dir);
    run('tk.mjs', ['key', traced.json.id, 'author', '--by', 'someone-else'], dir);
    const review = run('tk.mjs', ['review', traced.json.id, 'approve', '--by', ownerName], dir);
    assert.equal(review.code, 0, review.stderr);

    const after = run('roster.mjs', ['list'], dir).json.find((e) => e.name === ownerName);
    assert.notEqual(after.lastTrace, staleAt);
  });

  await t.test('review does not fail when --by names nobody in the roster', () => {
    const traced = run('tk.mjs', ['new', 'untraced-thing', '--title', 'Untraced', '--node', 'core', '--class', 'sonnet'], dir);
    run('tk.mjs', ['key', traced.json.id, 'author', '--by', 'someone-else'], dir);
    const review = run('tk.mjs', ['review', traced.json.id, 'approve', '--by', 'not-a-roster-name'], dir);
    assert.equal(review.code, 0, review.stderr);
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

  await t.test('round 6 refuses, naming the escalate command as the next step', () => {
    const r = run('tk.mjs', ['status', id, 'changes', 'attempt 6'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /escalate\.mjs add/);
    assert.match(r.stderr, /--kind adjudicate/);
    assert.match(r.stderr, new RegExp(`--ticket ${id}`));
    assert.match(r.stderr, /queue\.mjs set/);
    assert.match(r.stderr, /escalated/);
  });

  await t.test('the ticket never actually advanced past round 5', () => {
    const show = run('tk.mjs', ['show', id, '--log'], dir);
    const rounds = [...show.json.log.matchAll(/round (\d+)\/5/g)].map((m) => Number(m[1]));
    assert.equal(Math.max(...rounds), 5);
  });

  await t.test('the named next step actually works: escalate add --kind adjudicate, then queue set escalated', () => {
    const esc = run('escalate.mjs', ['add', 'stuck in the fix loop', '--kind', 'adjudicate', '--ticket', id], dir);
    assert.equal(esc.code, 0, esc.stderr);
    assert.equal(esc.json.kind, 'adjudicate');
    const q = run('queue.mjs', ['set', id, 'escalated'], dir);
    assert.equal(q.code, 0, q.stderr);
    assert.equal(q.json.state, 'escalated');
  });
});

test("tk.mjs review: the approval seat — a ticket's own verifier may approve only when its author owns the node and no architect is live", async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const owner = run('roster.mjs', ['spawn', 'owner', '--node', 'core', '--class', 'sonnet'], dir);
  assert.equal(owner.code, 0, owner.stderr);
  const ownerName = owner.json.name;
  const verifier = run('roster.mjs', ['spawn', 'verifier', '--team', 'trunk', '--class', 'sonnet'], dir);
  assert.equal(verifier.code, 0, verifier.stderr);
  const verifierName = verifier.json.name;

  function selfAuthoredTicket(slug) {
    const created = run('tk.mjs', ['new', slug, '--title', 'Self authored', '--node', 'core', '--class', 'sonnet'], dir);
    const id = created.json.id;
    run('tk.mjs', ['key', id, 'author', '--by', ownerName], dir);
    const rec = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--by', verifierName,
      '--revert', 'no-new-tests', '--gate', 'green', '--sha', 'abc1234',
    ], dir);
    assert.equal(rec.code, 0, rec.stderr);
    return id;
  }

  await t.test('accepted: the author owns the node and no architect is live', () => {
    const id = selfAuthoredTicket('self-1');
    const r = run('tk.mjs', ['review', id, 'approve', '--by', verifierName], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.verifierSeat, true);
    const show = run('tk.mjs', ['show', id], dir);
    assert.match(show.json.text, new RegExp(`core ${verifierName}\\(verifier-seat\\)`));
    assert.match(show.json.text, /\*\*Status:\*\* verified/);
    const log = run('tk.mjs', ['show', id, '--log'], dir);
    assert.match(log.json.log, /\(verifier-seat\)/);
  });

  await t.test('refused: a live architect is on the roster', () => {
    const architect = run('roster.mjs', ['spawn', 'architect', '--class', 'opus'], dir);
    assert.equal(architect.code, 0, architect.stderr);
    const id = selfAuthoredTicket('self-2');
    const r = run('tk.mjs', ['review', id, 'approve', '--by', verifierName], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /live architect/);

    // stand the architect back down so later subtests see none live again
    run('roster.mjs', ['reclaim', architect.json.name, 'done', '--by', 'director'], dir);
  });

  await t.test("refused: the ticket's author does not own the node", () => {
    const other = run('tk.mjs', ['new', 'other-authored', '--title', 'Someone else wrote it', '--node', 'core', '--class', 'sonnet'], dir);
    const id = other.json.id;
    run('tk.mjs', ['key', id, 'author', '--by', 'someone-else'], dir);
    const rec = run('verify.mjs', [
      'record', id, '--verdict', 'reproduced', '--by', verifierName,
      '--revert', 'no-new-tests', '--gate', 'green', '--sha', 'abc1234',
    ], dir);
    assert.equal(rec.code, 0, rec.stderr);
    const r = run('tk.mjs', ['review', id, 'approve', '--by', verifierName], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not own/);
  });

  await t.test('a normal owner approval is never marked with the seat', () => {
    const id = selfAuthoredTicket('self-3');
    // the architect stands in for the self-authored case, ordinarily
    const r = run('tk.mjs', ['review', id, 'approve', '--by', 'architect'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.verifierSeat, false);
    const show = run('tk.mjs', ['show', id], dir);
    assert.doesNotMatch(show.json.text, /verifier-seat/);
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
