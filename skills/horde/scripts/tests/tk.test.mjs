import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode,
} from './helpers.mjs';
import { charterMismatches } from '../tk.mjs';

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
  return run('tk.mjs', ['new', 'my-feature', '--title', 'Do the thing', '--node', 'core', '--class', 'standard', ...evidence, ...extra], dir);
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
    const r = run('tk.mjs', ['new', 'x', '--title', 't', '--class', 'standard'], dir);
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
    const r = run('tk.mjs', ['new', 'another', '--title', 'Another', '--node', 'core', '--class', 'light'], dir);
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
    assert.match(r.stderr, /allowed: proposed, queued, running, landed, changes, blocked, merged, dropped/);
  });

  // The seat cassation took verification and escalation out of the ticket's own ladder: the
  // landing gate verifies, and escalation goes to the client channel. Neither word is written by
  // this command any more, and neither falls through to a bare "unknown state" either — somebody
  // typing one from memory, or copying it off a pre-6.0.0 ticket, is told what replaced it.
  await t.test('status refuses each retired state by name, saying what replaced it', () => {
    const verified = run('tk.mjs', ['status', id, 'verified'], dir);
    assert.equal(verified.code, 1);
    assert.match(verified.stderr, /"verified" is no longer a state a ticket is moved to/);
    assert.match(verified.stderr, /landing gate/);

    const escalated = run('tk.mjs', ['status', id, 'escalated'], dir);
    assert.equal(escalated.code, 1);
    assert.match(escalated.stderr, /"escalated" is no longer a state a ticket is moved to/);
    assert.match(escalated.stderr, /ask\.mjs add/);
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
    const r = run('tk.mjs', ['new', 'no-id', '--title', 'No id', '--node', 'core', '--class', 'standard', '--evidence', 'a plain check, no id'], dir);
    assert.equal(r.code, 0, r.stderr);
    const show = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(show.json.text, /- \[ \] a plain check, no id/);
  });

  await t.test('an --evidence value citing a known catalogue id is accepted', () => {
    const r = run('tk.mjs', [
      'new', 'known-id', '--title', 'Known id', '--node', 'core', '--class', 'standard',
      '--evidence', 'covers E1', '--evidence', 'covers E2',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
    const show = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(show.json.text, /- \[ \] covers E1/);
    assert.match(show.json.text, /- \[ \] covers E2/);
  });

  await t.test('an --evidence value citing an unknown catalogue id is refused, listing it', () => {
    const r = run('tk.mjs', [
      'new', 'unknown-id', '--title', 'Unknown id', '--node', 'core', '--class', 'standard',
      '--evidence', 'covers E1', '--evidence', 'covers E9',
    ], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown evidence id\(s\).*E9/);
    assert.doesNotMatch(r.stderr, /E1/);
  });

  await t.test('a ticket refused for an unknown evidence id does not consume a ticket number', () => {
    const before = run('tk.mjs', ['list'], dir).json.length;
    run('tk.mjs', [
      'new', 'refused-again', '--title', 'Refused again', '--node', 'core', '--class', 'standard', '--evidence', 'covers E9',
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
    const r = run('tk.mjs', ['new', 'pinned-surface', '--title', 'Pin it', '--node', 'core', '--class', 'standard', '--revert-base', 'develop'], dir);
    assert.equal(r.code, 0);
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Revert base:\*\* develop/);
  });

  await t.test('without --revert-base, the header renders with nothing after it', () => {
    const r = run('tk.mjs', ['new', 'no-base', '--title', 'No base', '--node', 'core', '--class', 'standard'], dir);
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Revert base:\*\* *\n/);
  });
});

test('tk.mjs: new --mutate sets the header; omitted, it renders empty (default: revert to base)', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('with --mutate', () => {
    const r = run('tk.mjs', ['new', 'mutate-surface', '--title', 'Mutate it', '--node', 'core', '--class', 'standard', '--mutate', "sed -i '' 's/+/-/' surface.mjs"], dir);
    assert.equal(r.code, 0);
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Mutate:\*\* sed -i '' 's\/\+\/-\/' surface\.mjs/);
  });

  await t.test('without --mutate, the header renders with nothing after it', () => {
    const r = run('tk.mjs', ['new', 'no-mutate', '--title', 'No mutate', '--node', 'core', '--class', 'standard'], dir);
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Mutate:\*\* *\n/);
  });

  await t.test('--mutate together with --revert-base is refused — only one variant ever runs', () => {
    const before = run('tk.mjs', ['list'], dir).json.length;
    const r = run('tk.mjs', [
      'new', 'both-fields', '--title', 'Both fields', '--node', 'core', '--class', 'standard',
      '--revert-base', 'develop', '--mutate', 'true',
    ], dir);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /either --mutate or --revert-base, not both/);
    const after = run('tk.mjs', ['list'], dir).json.length;
    assert.equal(after, before, 'a refused ticket must not consume a ticket number');
  });
});

test('tk.mjs: new --kind defaults to "work"; "quality" and "prototype" are the other two values accepted', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedCharterEvidence(dir, 'mission1', [['E1', 'the shift board shows a week', 'core']]);

  await t.test('omitted, the ticket is "work"', () => {
    const r = run('tk.mjs', ['new', 'default-kind', '--title', 'Default kind', '--node', 'core', '--class', 'standard'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.kind, 'work');
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Kind:\*\* work/);
  });

  await t.test('--kind quality marks a self-filed improvement outside the ticket\'s own scope', () => {
    const r = run('tk.mjs', ['new', 'tidy-up', '--title', 'Tidy up', '--node', 'core', '--class', 'standard', '--kind', 'quality'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.kind, 'quality');
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Kind:\*\* quality/);
  });

  await t.test('--kind prototype marks something built to be looked at', () => {
    const r = run('tk.mjs', ['new', 'shift-board', '--title', 'Something to look at', '--node', 'core', '--class', 'standard', '--kind', 'prototype', '--evidence', 'E1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.kind, 'prototype');
    const shown = run('tk.mjs', ['show', r.json.id], dir);
    assert.match(shown.json.text, /\*\*Kind:\*\* prototype/);
  });

  await t.test('any other value is refused', () => {
    const r = run('tk.mjs', ['new', 'bad-kind', '--title', 'Bad kind', '--node', 'core', '--class', 'standard', '--kind', 'bogus'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--kind must be one of: work, quality, prototype/);
  });
});

// A prototype earns no verdict: the only thing that can say it worked is the person who asked for
// the thing, and their answer is written against the catalogue row the prototype was built to
// describe. Everything below is that answer's contract — it names one row, it carries a real
// fingerprint of what was shown, and it never turns the row itself green.
test('tk.mjs: a prototype frames one catalogue row, and only a recorded acceptance answers it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  seedCharterEvidence(dir, 'mission1', [
    ['E1', 'the shift board shows a week', 'core'],
    ['E2', 'a swap is confirmed in one tap', 'core'],
  ]);
  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  const newPrototype = (slug, evidence) => run('tk.mjs', [
    'new', slug, '--title', 'Something to look at', '--node', 'core', '--class', 'standard',
    '--kind', 'prototype', ...evidence.flatMap((e) => ['--evidence', e]),
  ], dir);

  await t.test('a prototype naming no row is refused — there is nothing for the answer to stand on', () => {
    const r = newPrototype('no-row', []);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /prototype names exactly one evidence row/);
  });

  await t.test('a prototype naming two rows is refused the same way', () => {
    const r = newPrototype('two-rows', ['E1, E2']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /prototype names exactly one evidence row/);
  });

  const proto = newPrototype('shift-board', ['E1']);
  await t.test('naming one row, it is filed, and its only acceptance line is the client\'s own answer', () => {
    assert.equal(proto.code, 0, proto.stderr);
    const shown = run('tk.mjs', ['show', proto.json.id], dir);
    assert.match(shown.json.text, /\*\*Evidence:\*\* E1/);
    assert.match(shown.json.text, /- \[ \] E1 — the client is shown this and their acceptance is recorded/);
  });

  await t.test('accept without a fingerprint of what was shown is refused', () => {
    const r = run('tk.mjs', ['accept', proto.json.id, '--by', 'Anna Kowalska'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /accept requires --sha256/);
  });

  await t.test('accept with something that is not a sha256 is refused, saying what one looks like', () => {
    const r = run('tk.mjs', ['accept', proto.json.id, '--by', 'Anna Kowalska', '--sha256', 'looked-fine-to-me'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /64 hex characters/);
  });

  await t.test('accept with nobody accepting it is refused', () => {
    const r = run('tk.mjs', ['accept', proto.json.id, '--sha256', 'a'.repeat(64)], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /accept requires --by/);
  });

  const sha = 'b'.repeat(64);
  await t.test('accepted, the answer stands on the charter against the row it frames', () => {
    const r = run('tk.mjs', ['accept', proto.json.id, '--by', 'Anna Kowalska', '--sha256', sha], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.evidence, 'E1');
    assert.equal(r.json.acceptedBy, 'Anna Kowalska');
    assert.equal(r.json.sha256, sha);

    const charter = readFileSync(charterPath, 'utf8');
    assert.match(charter, /^## Prototypes accepted$/m);
    assert.match(charter, new RegExp(`\\| E1 \\| ${proto.json.id} \\| ${sha} \\| Anna Kowalska \\| \\S+ \\|`));
    assert.match(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', `${proto.json.id}-shift-board`, 'log.md'), 'utf8'), /accepted by Anna Kowalska/);
  });

  await t.test('and the row itself is not green — seeing a thing is not having built it', () => {
    const charter = readFileSync(charterPath, 'utf8');
    assert.match(charter, /\| E1 \| the shift board shows a week \| core \|\s+\|/);
  });

  await t.test('accepted twice, the answer is replaced rather than repeated', () => {
    const again = 'c'.repeat(64);
    const r = run('tk.mjs', ['accept', proto.json.id, '--by', 'Bartek Nowak', '--sha256', again], dir);
    assert.equal(r.code, 0, r.stderr);
    const charter = readFileSync(charterPath, 'utf8');
    assert.equal([...charter.matchAll(/^## Prototypes accepted$/gm)].length, 1);
    assert.equal([...charter.matchAll(/^\| E1 \| \d/gm)].length, 1);
    assert.match(charter, new RegExp(`\\| E1 \\| ${proto.json.id} \\| ${again} \\| Bartek Nowak \\|`));
  });

  await t.test('a ticket that is not a prototype has nothing to accept', () => {
    const work = run('tk.mjs', ['new', 'build-it', '--title', 'Build it', '--node', 'core', '--class', 'standard', '--evidence', 'E2'], dir);
    assert.equal(work.code, 0, work.stderr);
    const r = run('tk.mjs', ['accept', work.json.id, '--by', 'Anna Kowalska', '--sha256', 'd'.repeat(64)], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not a prototype/);
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

  const two = run('tk.mjs', ['new', 'contract-ticket', '--title', 'A contract', '--node', 'a', '--node', 'b', '--class', 'standard'], dir);
  assert.equal(two.code, 0, two.stderr);

  const three = run('tk.mjs', ['new', 'sprawling', '--title', 'Too much', '--node', 'a', '--node', 'b', '--node', 'c', '--class', 'standard'], dir);
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
      '--class', 'standard', '--files', 'src/auth/policy.ts,src/auth/policy.test.ts',
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
      '--class', 'standard', '--files', 'src/api/guard.ts'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /outside the boundary of auth: src\/api\/guard\.ts/);
    assert.match(r.stderr, /the boundary is src\/auth\/\*\*/);
  });

  await t.test('a port that is not <node>/<port> is refused', () => {
    const r = run('tk.mjs', ['new', 'bad-port', '--title', 'Bad port', '--node', 'api',
      '--class', 'standard', '--consumes', 'auth-policy-2'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /takes <node>\/<port>/);
  });

  await t.test('the old "<node>/<port>@<version>" syntax is refused, naming the removal', () => {
    const r = run('tk.mjs', ['new', 'old-syntax', '--title', 'Old syntax', '--node', 'api',
      '--class', 'standard', '--consumes', 'auth/policy@2'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"@<version>" suffix was removed/);
  });

  await t.test('a consumed port nothing produces and the graph does not have is refused by name', () => {
    const r = run('tk.mjs', ['new', 'no-producer', '--title', 'No producer', '--node', 'api',
      '--class', 'standard', '--consumes', 'auth/sessions'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing produces auth\/sessions/);
    assert.match(r.stderr, /File the producing ticket first/);
  });

  let consumer;
  await t.test('a consumed port another ticket produces is accepted', () => {
    const r = run('tk.mjs', ['new', 'api-guard', '--title', 'Guard', '--node', 'api', '--class', 'standard',
      '--files', 'src/api/guard.ts', '--consumes', 'auth/policy', '--evidence', 'E2'], dir);
    assert.equal(r.code, 0, r.stderr);
    consumer = r.json.id;
  });

  await t.test('an evidence id the charter does not carry is refused', () => {
    const r = run('tk.mjs', ['new', 'invented', '--title', 'Invented', '--node', 'api',
      '--class', 'standard', '--evidence', 'E9'], dir);
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

  const created = run('tk.mjs', ['new', 'scoped', '--title', 'Scoped again', '--node', 'core', '--class', 'standard'], dir);
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

test('tk.mjs review-request --delta (bare) refuses without pointing the caller at a source that writes nothing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const created = run('tk.mjs', ['new', 'scoped2', '--title', 'Scoped bare', '--node', 'core', '--class', 'standard'], dir);
  const id = created.json.id;

  const bare = run('tk.mjs', ['review-request', id, '--delta'], dir);
  assert.equal(bare.code, 1);
  // The refusal must not send the caller looking for output "the merge checklist" never produces —
  // nothing in this tool set writes a rereview diff file. It must instead say the caller builds it.
  assert.doesNotMatch(bare.stderr, /merge checklist/);
  assert.match(bare.stderr, /generate yourself/);
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
  const second = run('tk.mjs', ['new', 'second', '--title', 'Second', '--node', 'core', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
  const third = run('tk.mjs', ['new', 'third', '--title', 'Third', '--node', 'core', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
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
    const loose = run('tk.mjs', ['new', 'loose', '--title', 'Loose', '--node', 'core', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
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

// ---- what the mission promised, against what the ticket says -----------------------------------
//
// The two halves of a mission card a ticket can contradict on its own: the territories the mission
// was cut into, and the evidence catalogue it promised. `charterMismatches` is that reading — pure,
// over a ticket's text and the two promises — and `queue.mjs add` is the door that applies it.

test('tk.mjs charterMismatches: a node outside every territory, and an evidence row the charter never had', async (t) => {
  const TERRITORIES = [
    { territory: 'the front door', nodes: ['auth', 'api'] },
    { territory: 'numbers', nodes: ['reporting'] },
  ];
  const ticketText = (node, evidence) => [
    '# 001 · A ticket', '',
    '**Status:** proposed',
    `**Node:** ${node} · **Class:** standard · **Severity:** medium · **Team:** trunk`,
    '**Depends on:** none · **Branch:** —',
    `**Evidence:** ${evidence}`, '',
    '## Acceptance — evidence', '', '- [ ] it works', '',
  ].join('\n');

  await t.test('a node inside a territory, earning a row the charter carries, matches nothing', () => {
    assert.deepEqual(charterMismatches(ticketText('auth', 'E1'), {
      territories: TERRITORIES, catalogue: new Set(['E1', 'E2']),
    }), []);
  });

  await t.test('a node outside every territory is a mismatch naming the node and the territories', () => {
    const out = charterMismatches(ticketText('billing', 'E1'), {
      territories: TERRITORIES, catalogue: new Set(['E1']),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].field, 'Node');
    assert.deepEqual(out[0].values, ['billing']);
    assert.match(out[0].has, /the front door \(auth, api\)/);
    assert.match(out[0].has, /numbers \(reporting\)/);
  });

  await t.test('a mission nobody has cut yet promises no area, so no node is outside one', () => {
    assert.deepEqual(charterMismatches(ticketText('billing', 'E1'), {
      territories: [], catalogue: new Set(['E1']),
    }), []);
  });

  await t.test('an evidence row the catalogue does not carry is a mismatch naming it', () => {
    const out = charterMismatches(ticketText('auth', 'E1, E7'), {
      territories: TERRITORIES, catalogue: new Set(['E1']),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].field, 'Evidence');
    assert.deepEqual(out[0].values, ['E7'], 'only the row the charter is missing, never the one it has');
    assert.match(out[0].has, /E1/);
  });

  await t.test('a ticket earning no row at all is ordinary work, not a mismatch', () => {
    assert.deepEqual(charterMismatches(ticketText('auth', 'none'), {
      territories: TERRITORIES, catalogue: new Set(['E1']),
    }), []);
  });

  await t.test('both wrong at once are reported together, neither hiding the other', () => {
    const out = charterMismatches(ticketText('billing', 'E7'), {
      territories: TERRITORIES, catalogue: new Set(['E1']),
    });
    assert.deepEqual(out.map((m) => m.field), ['Node', 'Evidence']);
  });
});
