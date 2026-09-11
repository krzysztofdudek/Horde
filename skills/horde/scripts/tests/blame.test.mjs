// blame.mjs: git blame -> commit -> the ticket whose recorded branch tip contains it -> keys,
// approvals, evidence and the rule verdicts standing against the component the graph says owns
// the file. Every scenario here is driven through the real tools against a real
// temporary git repository — no fixture is hand-typed into ticket/log files — and the merge
// itself is a real `git merge --no-ff`, exactly as a steward would do it.
//
// tk.mjs's `key`/`review` and the deleted verify tool itself are gone (task 014 — seat cassation): a new-format
// ticket carries neither a **Keys:** line nor a ## Verdict block any more. blame.mjs keeps its own
// read-only copy of the old key-parsing logic so it can still walk a PRE-migration ticket's custody
// chain, so the fixtures below that need one write it directly to disk — the only way left to
// construct that shape at all, and exactly the scenario blame.mjs's backward-compat reading exists
// for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, addNode, addAspect, requireYg, MARKER_CHECK,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// One real component with one real rule attached to it. Which component owns a file, and which
// rules reach it, is the graph's own answer (`yg context --file … --json`); what verdict stands
// against each is the lock's.
function writeGraph(dir, { node, mapping, aspectId }) {
  addAspect(dir, aspectId, { status: 'enforced', description: 'No console in shipped code.', check: MARKER_CHECK });
  addNode(dir, node, { mapping, aspects: [aspectId] });
}

// The lock's own entries (yg-lock.nondeterministic.json), written directly — this is what
// blame.mjs reads for a rule verdict, since `yg check` has neither --json nor a per-file scope.
function writeLockVerdict(dir, aspectId, unitKey, verdict) {
  mkdirSync(join(dir, '.yggdrasil'), { recursive: true });
  writeFileSync(join(dir, '.yggdrasil', 'yg-lock.nondeterministic.json'), JSON.stringify({
    version: 1,
    verdicts: { [aspectId]: { [unitKey]: { hash: 'deadbeef', verdict } } },
  }, null, 2) + '\n');
}

function issuePathOf(dir, horde, team, dirName) {
  return join(dir, '.horde', 'hordes', horde, 'teams', team, 'issues', dirName, 'issue.md');
}

function logPathOf(dir, horde, team, dirName) {
  return join(dir, '.horde', 'hordes', horde, 'teams', team, 'issues', dirName, 'log.md');
}

// A pre-migration "## Verdict" block, in the exact shape the deleted verify tool's own templates/verdict.md
// used to render — heading, Result line, and the evidence table blame.mjs's parseVerdictBlock
// reads back.
function renderVerdictBlock({
  ticketId, verifier, cls, result, rows,
}) {
  const lines = [
    `## Verdict · ${ticketId} · 2024-01-01 · by ${verifier} (${cls})`,
    '',
    `**Result:** ${result}`,
    '',
    '| item | command | saw |',
    '|---|---|---|',
    ...rows.map(({ text, command, saw }) => `| ${text} | ${command} | ${saw} |`),
    '',
  ];
  return lines.join('\n');
}

// One ticket, worked and merged into trunk by a real `git merge --no-ff` — the same sequence
// lifecycle.test.mjs drives, trimmed to only what blame.mjs's own fields read. tk.mjs's key/review
// and the deleted verify tool record are gone, so the pre-migration **Keys:** line and ## Verdict block this
// scenario needs are written straight to the ticket's own files afterwards, simulating a ticket
// that predates the migration — exactly the shape blame.mjs's backward-compat reading exists for.
function landOneTicket(dir, horde) {
  const ticket = run('tk.mjs', [
    'new', 'extract-hook', '--title', 'Extract the hook', '--node', 'model', '--class', 'sonnet',
    '--evidence', 'the hook returns hooked',
  ], dir);
  assert.equal(ticket.code, 0, ticket.stderr);
  const { id, dirName, team } = ticket.json;

  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);

  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker-1'], dir);
  assert.equal(running.code, 0, running.stderr);
  const worktree = running.json.worktree;

  mkdirSync(join(worktree, 'src', 'model'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'model', 'hook.mjs'), "export function useHook() { return 'hooked'; }\n");
  git(['add', join('src', 'model', 'hook.mjs')], worktree);
  git(['commit', '-qm', 'extract the hook'], worktree);
  const landedSha = git(['rev-parse', '--short', `${horde}/t-${id}`], dir);

  // Pre-migration Keys line: author, verifier, and one owner approval per node, exactly the shape
  // tk.mjs's own writeKeys() used to produce.
  const issuePath = issuePathOf(dir, horde, team, dirName);
  const issueText = readFileSync(issuePath, 'utf8');
  writeFileSync(
    issuePath,
    `${issueText.trimEnd()}\n\n**Keys:** author worker-1 · verifier verifier-1 · model owner-1@${landedSha}\n`,
  );

  // Pre-migration verdict block, appended to the ticket's own log the way the deleted verify tool record used
  // to append it.
  const logPath = logPathOf(dir, horde, team, dirName);
  const block = renderVerdictBlock({
    ticketId: id,
    verifier: 'verifier-1',
    cls: 'sonnet',
    result: 'reproduced',
    rows: [{ text: 'the hook returns hooked', command: 'manual check', saw: 'hooked' }],
  });
  const existingLog = readFileSync(logPath, 'utf8');
  writeFileSync(logPath, `${existingLog.trimEnd()}\n\n${block}`.trimStart());

  git(['checkout', `${horde}/trunk`], dir);
  git(['merge', '--no-ff', `${horde}/t-${id}`, '-m', `merge ticket ${id}`], dir);
  const mergeSha = git(['rev-parse', '--short', 'HEAD'], dir);

  const merged = run('queue.mjs', ['set', id, 'merged', '--sha', mergeSha], dir);
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(run('tk.mjs', ['status', id, 'merged'], dir).code, 0);

  return {
    id, dirName, team, landedSha, mergeSha,
  };
}

test('blame.mjs: E15 — full custody chain for a line a merged ticket introduced, and rule verdicts', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  initHorde(dir);
  writeGraph(dir, { node: 'model', mapping: ['src/model/**'], aspectId: 'house/no-console' });

  const { id } = landOneTicket(dir, 'mission1');
  // The verdict blame reports is the one the lock holds against the code that was judged.
  writeLockVerdict(dir, 'house/no-console', 'node:model', 'approved');

  const blame = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(blame.code, 0, blame.stderr);
  const r = blame.json;

  assert.equal(r.file, 'src/model/hook.mjs');
  assert.equal(r.line, 1);
  assert.match(r.commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(r.commit.summary, 'extract the hook');

  assert.ok(r.ticket, 'a ticket should own this line');
  assert.equal(r.ticket.id, id);
  assert.equal(r.ticket.title, 'Extract the hook');
  assert.equal(r.ticket.status, 'merged');
  assert.deepEqual(r.ticket.nodes, ['model']);
  assert.equal(r.ticket.author, 'worker-1');
  assert.equal(r.ticket.verifier.name, 'verifier-1');
  assert.equal(r.ticket.verifier.class, 'sonnet');
  assert.match(r.ticket.ownerApprovals.model, /^owner-1@/);
  assert.equal(r.ticket.evidence.length, 1);
  assert.equal(r.ticket.evidence[0].text, 'the hook returns hooked');
  assert.equal(r.ticket.evidence[0].checked, false);
  assert.equal(r.ticket.evidence[0].saw, 'hooked');
  assert.equal(r.ticket.evidence[0].state, 'reproduced');

  assert.equal(r.rules.available, true);
  assert.equal(r.rules.node, 'model');
  assert.equal(r.rules.rows.length, 1);
  assert.equal(r.rules.rows[0].aspect, 'house/no-console');
  assert.equal(r.rules.rows[0].status, 'enforced');
  assert.equal(r.rules.rows[0].verdict, 'approved');

  // The human-rendered form the E15 report is captured from — every field above, in one screen.
  const human = run('blame.mjs', ['src/model/hook.mjs:1'], dir, { json: false });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /extract the hook/);
  assert.match(human.stdout, new RegExp(`${id} · Extract the hook`));
  assert.match(human.stdout, /author:\s+worker-1/);
  assert.match(human.stdout, /verifier: verifier-1 \(sonnet\)/);
  assert.match(human.stdout, /owner-1@/);
  assert.match(human.stdout, /the hook returns hooked — reproduced — saw: hooked/);
  assert.match(human.stdout, /house\/no-console \[enforced\] — approved/);
});

test('blame.mjs: a ticket with an old ## Verdict block but no **Keys:** line at all — the new-ticket shape — falls back to the last verdict instead of throwing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const horde = 'mission1';
  const ticket = run('tk.mjs', [
    'new', 'extract-hook', '--title', 'Extract the hook', '--node', 'model', '--class', 'sonnet',
    '--evidence', 'the hook returns hooked',
  ], dir);
  assert.equal(ticket.code, 0, ticket.stderr);
  const { id, dirName, team } = ticket.json;

  // A genuinely new-format ticket never gets a **Keys:** line written to it any more — confirm
  // the fixture really has none before leaning on that shape below.
  const issueText = readFileSync(issuePathOf(dir, horde, team, dirName), 'utf8');
  assert.doesNotMatch(issueText, /\*\*Keys:\*\*/);

  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker-1'], dir);
  assert.equal(running.code, 0, running.stderr);
  const worktree = running.json.worktree;

  mkdirSync(join(worktree, 'src', 'model'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'model', 'hook.mjs'), "export function useHook() { return 'hooked'; }\n");
  git(['add', join('src', 'model', 'hook.mjs')], worktree);
  git(['commit', '-qm', 'extract the hook'], worktree);

  // A pre-migration verdict block, sitting in this new-format ticket's log with no Keys line to
  // match it against — the shape a verdict left over from before the migration would have.
  const logPath = logPathOf(dir, horde, team, dirName);
  const block = renderVerdictBlock({
    ticketId: id,
    verifier: 'verifier-1',
    cls: 'sonnet',
    result: 'reproduced',
    rows: [{ text: 'the hook returns hooked', command: 'manual check', saw: 'hooked' }],
  });
  const existingLog = readFileSync(logPath, 'utf8');
  writeFileSync(logPath, `${existingLog.trimEnd()}\n\n${block}`.trimStart());

  git(['checkout', `${horde}/trunk`], dir);
  git(['merge', '--no-ff', `${horde}/t-${id}`, '-m', `merge ticket ${id}`], dir);
  const mergeSha = git(['rev-parse', '--short', 'HEAD'], dir);
  const merged = run('queue.mjs', ['set', id, 'merged', '--sha', mergeSha], dir);
  assert.equal(merged.code, 0, merged.stderr);

  const blame = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(blame.code, 0, blame.stderr);
  const r = blame.json;

  assert.ok(r.ticket, 'a ticket should own this line');
  assert.equal(r.ticket.id, id);
  // No Keys line at all means author/verifier read back as the unset marker …
  assert.equal(r.ticket.author, '—');
  assert.equal(r.ticket.verifier.name, '—');
  // … but verifierVerdict() falls back to the last verdict block in the log rather than finding
  // nothing, so its class and result still come through.
  assert.equal(r.ticket.verifier.class, 'sonnet');
  assert.equal(r.ticket.evidence.length, 1);
  assert.equal(r.ticket.evidence[0].state, 'reproduced');
  assert.equal(r.ticket.evidence[0].saw, 'hooked');

  const human = run('blame.mjs', ['src/model/hook.mjs:1'], dir, { json: false });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /the hook returns hooked — reproduced — saw: hooked/);
});

test('blame.mjs: a pre-horde line reports plainly that no ticket owns it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const blame = run('blame.mjs', ['README.md:1'], dir);
  assert.equal(blame.code, 0, blame.stderr);
  assert.equal(blame.json.ticket, null);
  assert.equal(blame.json.commit.summary, 'init');

  const human = run('blame.mjs', ['README.md:1'], dir, { json: false });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /pre-horde: no ticket .* owns commit/);
});

test('blame.mjs: a file no component owns says so plainly instead of guessing at rules', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const { id } = landOneTicket(dir, 'mission1');

  // The graph is real and empty of components, so the file the ticket wrote belongs to none.
  const blame = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(blame.code, 0, blame.stderr);
  assert.equal(blame.json.ticket.id, id);
  assert.equal(blame.json.rules.available, false);
  assert.match(blame.json.rules.reason, /not mapped to any component/);
});

test('blame.mjs: an archived horde is still searched — its branches and tickets outlive the archive move', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const { id } = landOneTicket(dir, 'mission1');

  const archived = run('horde.mjs', ['archive', 'mission1'], dir);
  assert.equal(archived.code, 0, archived.stderr);

  const blame = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(blame.code, 0, blame.stderr);
  assert.ok(blame.json.ticket, 'the archived horde\'s ticket should still be found');
  assert.equal(blame.json.ticket.id, id);
  assert.match(blame.json.ticket.horde, /^_archive\/mission1-/);
});

test('blame.mjs: --horde narrows the search to one horde', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir); // the sole horde "mission1" while this ticket lands
  const { id } = landOneTicket(dir, 'mission1');

  // A second, unrelated horde on the same repository — once it exists, --horde is the only way
  // to say which one's tickets should be searched.
  run('horde.mjs', ['init', 'other', '--base', 'develop', '--yg', requireYg(), '--test-globs', '**/*.test.*'], dir);

  const found = run('blame.mjs', ['src/model/hook.mjs:1', '--horde', 'mission1'], dir);
  assert.equal(found.code, 0, found.stderr);
  assert.equal(found.json.ticket.id, id);

  const notFound = run('blame.mjs', ['src/model/hook.mjs:1', '--horde', 'other'], dir);
  assert.equal(notFound.code, 0, notFound.stderr);
  assert.equal(notFound.json.ticket, null, '--horde other should not see mission1\'s ticket');
});

// ---- the direct path: trailers on the merge commit -------------------------------------------
//
// From 6.0.0 land.mjs writes `Ticket:`, `Evidence:` and `Law:` onto the merge commit it makes, so
// the edge commit → ticket is a fact in git rather than something reconstructed from three places
// in an uncommitted directory. The indirect reconstruction stays exactly as it was: no horde
// archived before 6.0.0 has a trailer anywhere, and that history is the whole reason for it.
//
// The trailers themselves are written and asserted in land.test.mjs. What is measured here is the
// reading — including the case where the trailer is the ONLY thing that could answer.

// A ticket worked and merged with the trailers land.mjs writes, and with every indirect source
// deliberately absent: no **Keys:** line, no verdict block, and no "merged:" line in the wave
// journal. Nothing but the commit itself can say which ticket owns this line.
function landWithTrailersOnly(dir, horde, { evidence = null, law = null } = {}) {
  const ticket = run('tk.mjs', [
    'new', 'extract-hook', '--title', 'Extract the hook', '--node', 'model', '--class', 'sonnet',
    '--evidence', 'the hook returns hooked',
  ], dir);
  assert.equal(ticket.code, 0, ticket.stderr);
  const { id, dirName, team } = ticket.json;

  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker-1'], dir);
  assert.equal(running.code, 0, running.stderr);
  const { worktree } = running.json;

  mkdirSync(join(worktree, 'src', 'model'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'model', 'hook.mjs'), "export function useHook() { return 'hooked'; }\n");
  git(['add', join('src', 'model', 'hook.mjs')], worktree);
  git(['commit', '-qm', 'extract the hook'], worktree);

  const message = [
    `merge ${id}: ${horde}/t-${id}`,
    '',
    `Ticket: t-${id}`,
    ...(evidence ? [`Evidence: ${evidence}`] : []),
    ...(law ? [`Law: ${law}`] : []),
    '',
  ].join('\n');

  git(['checkout', `${horde}/trunk`], dir);
  git(['merge', '--no-ff', `${horde}/t-${id}`, '-m', message], dir);

  return { id, dirName, team, mergeSha: git(['rev-parse', 'HEAD'], dir) };
}

test('blame.mjs: a line landed after 6.0.0 is read off the merge commit\'s own trailer, in one step', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  initHorde(dir);
  writeGraph(dir, { node: 'model', mapping: ['src/model/**'], aspectId: 'house/no-console' });

  const { id } = landWithTrailersOnly(dir, 'mission1', {
    evidence: 'E1, tests/hook: returns hooked',
    law: 'house/no-console raised',
  });

  const r = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.ticket, 'the trailer names the ticket');
  assert.equal(r.json.ticket.id, id);
  assert.equal(r.json.ticket.title, 'Extract the hook');
  assert.equal(r.json.custody.source, 'trailer', 'and it was read directly, not reconstructed');
});

test('blame.mjs: without the trailer, the same history answers nothing — which is what the trailer replaces', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  initHorde(dir);
  writeGraph(dir, { node: 'model', mapping: ['src/model/**'], aspectId: 'house/no-console' });

  // The identical sequence with the trailer left off the merge message. Every indirect source is
  // absent here too, so this is the measure of exactly how much the trailer is carrying.
  const ticket = run('tk.mjs', [
    'new', 'extract-hook', '--title', 'Extract the hook', '--node', 'model', '--class', 'sonnet',
    '--evidence', 'the hook returns hooked',
  ], dir);
  const { id } = ticket.json;
  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  const { worktree } = run('queue.mjs', ['set', id, 'running', '--agent', 'worker-1'], dir).json;
  mkdirSync(join(worktree, 'src', 'model'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'model', 'hook.mjs'), "export function useHook() { return 'hooked'; }\n");
  git(['add', join('src', 'model', 'hook.mjs')], worktree);
  git(['commit', '-qm', 'extract the hook'], worktree);
  git(['checkout', 'mission1/trunk'], dir);
  git(['merge', '--no-ff', `mission1/t-${id}`, '-m', `merge ticket ${id}`], dir);

  const r = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ticket, null);
  assert.equal(r.json.custody, null);
  assert.match(run('blame.mjs', ['src/model/hook.mjs:1'], dir, { json: false }).stdout, /pre-horde: no ticket/);
});

test('blame.mjs: a line landed BEFORE 6.0.0 still answers by the old road', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  initHorde(dir);
  writeGraph(dir, { node: 'model', mapping: ['src/model/**'], aspectId: 'house/no-console' });

  // landOneTicket merges by hand with a plain "-m" message, exactly as a steward did before this
  // tool made the merge commit at all — no trailer anywhere — and records the sha in the wave
  // journal through queue.mjs, which is one of the three places the reconstruction reads.
  const { id } = landOneTicket(dir, 'mission1');

  const r = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.ticket, 'the old road still finds it');
  assert.equal(r.json.ticket.id, id);
  assert.notEqual(r.json.custody.source, 'trailer');
  assert.ok(['keys', 'verdict', 'journal'].includes(r.json.custody.source), r.json.custody.source);
});

test('blame.mjs: a trailer value holding a colon or a non-ASCII character does not break the read', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  initHorde(dir);
  writeGraph(dir, { node: 'model', mapping: ['src/model/**'], aspectId: 'house/no-console' });

  const { id, mergeSha } = landWithTrailersOnly(dir, 'mission1', {
    evidence: 'tests/płatności: kwota się zgadza',
    law: 'house/no-console: raised — na podstawie dowodu',
  });

  const r = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ticket.id, id, 'the Ticket trailer is still read past the ones with colons in them');
  assert.equal(r.json.custody.source, 'trailer');
  assert.equal(r.json.custody.sha, mergeSha);
});

test('blame.mjs: an archived horde answers exactly as a live one does, trailer or not', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  initHorde(dir);
  writeGraph(dir, { node: 'model', mapping: ['src/model/**'], aspectId: 'house/no-console' });
  const { id } = landWithTrailersOnly(dir, 'mission1', { evidence: 'E1' });

  const live = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(live.json.ticket.id, id);

  const archived = run('horde.mjs', ['archive', 'mission1'], dir);
  assert.equal(archived.code, 0, archived.stderr);
  assert.match(readFileSync(join(archived.json.to, 'archived'), 'utf8'), /^\d{4}-\d{2}-\d{2} /);

  const after = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(after.code, 0, after.stderr);
  assert.equal(after.json.ticket.id, id, 'the mission being over does not lose the line its custody');
  assert.equal(after.json.custody.source, 'trailer');
});
