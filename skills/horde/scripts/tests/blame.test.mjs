// blame.mjs: git blame -> commit -> the ticket whose recorded branch tip contains it -> keys,
// approvals, evidence and (when the repository has a graph) the rule verdicts standing against
// the file's owning node. Every scenario here is driven through the real tools against a real
// temporary git repository — no fixture is hand-typed into ticket/log files — and the merge
// itself is a real `git merge --no-ff`, exactly as a steward would do it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A real yg-node.yaml at .yggdrasil/model/<node>/yg-node.yaml, one node, one aspect declared on
// it directly — enough for horde.mjs init to auto-detect nodeSource "yggdrasil" and for
// node.mjs's graph-files fallback (no yg CLI needed) to resolve the aspect's status.
function writeGraph(dir, { node, mapping, aspectId }) {
  const nodeDir = join(dir, '.yggdrasil', 'model', node);
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, 'yg-node.yaml'), [
    `name: ${node}`, 'type: domain', `description: "node ${node}"`, '',
    'mapping:', ...mapping.map((m) => `  - ${m}`), '',
    'aspects:', `  - id: ${aspectId}`, '    status: enforced', '',
    'relations: []', '',
  ].join('\n'));
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

// One ticket, worked, reviewed, verified and merged into trunk by a real `git merge --no-ff` —
// the same sequence lifecycle.test.mjs drives, trimmed to only what blame.mjs's own fields read
// (no gate command, no revert test: verify.mjs's own --revert no-new-tests is the honest verdict
// for a fixture that adds no test file).
function landOneTicket(dir, horde) {
  const ticket = run('tk.mjs', [
    'new', 'extract-hook', '--title', 'Extract the hook', '--node', 'model', '--class', 'sonnet',
    '--evidence', 'the hook returns hooked',
  ], dir);
  assert.equal(ticket.code, 0, ticket.stderr);
  const id = ticket.json.id;

  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  assert.equal(run('wave.mjs', ['start'], dir).code, 0);

  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker-1'], dir);
  assert.equal(running.code, 0, running.stderr);
  const worktree = running.json.worktree;

  mkdirSync(join(worktree, 'src', 'model'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'model', 'hook.mjs'), "export function useHook() { return 'hooked'; }\n");
  git(['add', join('src', 'model', 'hook.mjs')], worktree);
  git(['commit', '-qm', 'extract the hook'], worktree);
  const landedSha = git(['rev-parse', '--short', `${horde}/t-${id}`], dir);

  assert.equal(run('tk.mjs', ['key', id, 'author', '--by', 'worker-1'], dir).code, 0);
  assert.equal(run('tk.mjs', ['review-request', id], dir).code, 0);
  const review = run('tk.mjs', ['review', id, 'approve', '--by', 'owner-1'], dir);
  assert.equal(review.code, 0, review.stderr);

  const verdict = run('verify.mjs', [
    'record', id, '--verdict', 'reproduced', '--revert', 'no-new-tests', '--by', 'verifier-1',
    '--item', '1|manual check|hooked', '--gate', 'green', '--sha', landedSha,
  ], dir);
  assert.equal(verdict.code, 0, verdict.stderr);

  git(['checkout', `${horde}/trunk`], dir);
  git(['merge', '--no-ff', `${horde}/t-${id}`, '-m', `merge ticket ${id}`], dir);
  const mergeSha = git(['rev-parse', '--short', 'HEAD'], dir);

  const merged = run('queue.mjs', ['set', id, 'merged', '--sha', mergeSha], dir);
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(run('tk.mjs', ['status', id, 'merged'], dir).code, 0);

  return { id, landedSha, mergeSha };
}

test('blame.mjs: E15 — full custody chain for a line a merged ticket introduced, and rule verdicts', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  writeGraph(dir, { node: 'model', mapping: ['src/model/**'], aspectId: 'house/no-console' });
  writeLockVerdict(dir, 'house/no-console', 'node:model', 'approved');

  initHorde(dir); // .yggdrasil/ exists -> nodeSource auto-detects "yggdrasil"
  run('horde.mjs', ['config', 'set', 'ygCommand', join(dir, 'no-such-yg')], dir); // force the graph-files fallback, no CLI needed

  const { id } = landOneTicket(dir, 'mission1');

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

test('blame.mjs: a pre-horde line reports plainly that no ticket owns it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir); // no .yggdrasil/ at all -> manual mode, no graph

  const blame = run('blame.mjs', ['README.md:1'], dir);
  assert.equal(blame.code, 0, blame.stderr);
  assert.equal(blame.json.ticket, null);
  assert.equal(blame.json.commit.summary, 'init');
  assert.equal(blame.json.rules.available, false);
  assert.match(blame.json.rules.reason, /manual/);

  const human = run('blame.mjs', ['README.md:1'], dir, { json: false });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /pre-horde: no ticket .* owns commit/);
});

test('blame.mjs: a repository with no graph at all says so plainly instead of guessing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const { id } = landOneTicket(dir, 'mission1');

  const blame = run('blame.mjs', ['src/model/hook.mjs:1'], dir);
  assert.equal(blame.code, 0, blame.stderr);
  assert.equal(blame.json.ticket.id, id);
  assert.equal(blame.json.rules.available, false);
  assert.match(blame.json.rules.reason, /nodeSource is manual/);
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
  run('horde.mjs', ['init', 'other', '--base', 'develop', '--test-globs', '**/*.test.*'], dir);

  const found = run('blame.mjs', ['src/model/hook.mjs:1', '--horde', 'mission1'], dir);
  assert.equal(found.code, 0, found.stderr);
  assert.equal(found.json.ticket.id, id);

  const notFound = run('blame.mjs', ['src/model/hook.mjs:1', '--horde', 'other'], dir);
  assert.equal(notFound.code, 0, notFound.stderr);
  assert.equal(notFound.json.ticket, null, '--horde other should not see mission1\'s ticket');
});
