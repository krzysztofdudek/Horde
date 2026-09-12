// resolveTree's CLI-visible contract: every refusal (fail() calls process.exit(), so none of these
// can be tested in-process — see lib.test.mjs's own note by teamPath()), and the provenance line
// every command that resolves a tree carries. The resolving paths themselves (precedence, cwd and
// trunk defaults, scratch's cleanup) are in lib.test.mjs, in-process.
//
// node.mjs's read commands take `--tree`/`--ticket`/`--scratch` (see node.mjs main()); `bind` with
// no positional is used as the plain vehicle below since it needs nothing else to exist first.
// queue.mjs's commands take `--horde` too, and that is the one place `--horde` alone means trunk —
// everywhere else here it stays the ordinary multi-horde disambiguator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, rmSync, realpathSync,
} from 'node:fs';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function newTicket(dir, slug) {
  const r = run('tk.mjs', ['new', slug, '--title', slug, '--node', 'core', '--class', 'standard', '--evidence', 'it works'], dir);
  if (r.code !== 0) throw new Error(`tk new (${slug}) failed: ${r.stderr}`);
  return r.json.id;
}

test('queue.mjs plan: reads the tree it was told, not wherever the main checkout happens to sit', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  git(['checkout', 'develop'], dir);
  newTicket(dir, 'a-ticket');

  await t.test('no --tree, no --horde: cwd — develop, in the main checkout', () => {
    const r = run('queue.mjs', ['plan'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.branch, 'develop');
    assert.equal(r.json.tree, realpathSync(dir));
  });

  await t.test('--horde mission1, no --tree: the tip of trunk — a different tree, a different branch, same tickets', () => {
    const cwdPlan = run('queue.mjs', ['plan'], dir).json;
    const trunkPlan = run('queue.mjs', ['plan', '--horde', 'mission1'], dir).json;
    assert.equal(trunkPlan.branch, 'mission1/trunk');
    assert.notEqual(trunkPlan.tree, cwdPlan.tree);
    assert.match(trunkPlan.tree, /worktrees[\\/]mission1[\\/]trunk$/);
    // The queue itself is shared state (.horde/), not part of either tree, so the same tickets show
    // up in both plans — what actually moved is the tree the graph is read from, per its own
    // provenance line, not which tickets are known to the horde.
    assert.deepEqual(trunkPlan.tickets.map((x) => x.id), cwdPlan.tickets.map((x) => x.id));
  });
});

test('node.mjs log --run: refuses a graph write from wherever it was not explicitly told to write', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  git(['checkout', 'develop'], dir);

  await t.test('cwd sitting on the mission\'s own base branch, no --tree: refused, naming the branch and trunk\'s tree', () => {
    const r = run('node.mjs', ['log', 'core', 'a reason', '--run'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"develop"/);
    assert.match(r.stderr, /worktrees[\\/]mission1[\\/]trunk/);
    assert.doesNotMatch(r.stderr, /at Object|at Module|node:internal/); // a refusal, not a stack trace
  });

  await t.test('--horde alone: trunk itself, refused — only the landing script writes there', () => {
    const r = run('node.mjs', ['log', 'core', 'a reason', '--run', '--horde', 'mission1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /landing script/);
    assert.match(r.stderr, /worktrees[\\/]mission1[\\/]trunk/);
  });

  await t.test('the same write, --tree naming that exact tree explicitly: goes through', () => {
    const trunkPath = run('queue.mjs', ['plan', '--horde', 'mission1'], dir).json.tree;
    const r = run('node.mjs', ['log', 'core', 'a reason', '--run', '--tree', trunkPath], dir);
    // core is not a real component in this fixture's bare graph, so the CLI itself still refuses —
    // but on "no such node", never on the tree: the tree guard is the thing under test here.
    assert.doesNotMatch(r.stderr, /landing script/);
    assert.doesNotMatch(r.stderr, /is on "develop"/);
  });
});

test('node.mjs --ticket: a worker\'s own tree, and every way it can be wrong', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('no such ticket worktree yet: refusal carries the command that creates it', () => {
    const r = run('node.mjs', ['bind', '--ticket', '013', '--horde', 'mission1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /queue\.mjs set 013 running --horde mission1/);
    assert.match(r.stderr, /worktrees[\\/]mission1[\\/]t-013/);
  });

  await t.test('the path exists, but as a plain directory — not a worktree of this repository', () => {
    const path013 = `${dir}/.horde/worktrees/mission1/t-013`;
    mkdirSync(path013, { recursive: true });
    t.after(() => rmSync(path013, { recursive: true, force: true }));
    const r = run('node.mjs', ['bind', '--ticket', '013', '--horde', 'mission1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a worktree of this repository/);
    assert.match(r.stderr, /git worktree list --porcelain/);
  });

  await t.test('a worktree that vanished from disk without "git worktree remove": prunable, not a stack trace', () => {
    const id = newTicket(dir, 'vanishing');
    run('queue.mjs', ['add', id], dir);
    const set = run('queue.mjs', ['set', id, 'running'], dir);
    assert.equal(set.code, 0, set.stderr);
    rmSync(set.json.worktree, { recursive: true, force: true });

    const r = run('node.mjs', ['bind', '--ticket', id, '--horde', 'mission1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /git worktree prune/);
    assert.match(r.stderr, new RegExp(set.json.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(r.stderr, /at Object|at Module|node:internal/);
  });
});

test('node.mjs --tree: another repository\'s worktree is refused, unicode and spaces resolve byte-for-byte', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('--tree pointing at a second, unrelated repository\'s worktree', () => {
    const other = makeRepo();
    t.after(() => rmRepo(other));
    const r = run('node.mjs', ['bind', '--tree', other], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a worktree of this repository/);
  });

  await t.test('a worktree path with unicode and a space resolves, and provenance reproduces it exactly', () => {
    const odd = `${dir}-wórk trée`;
    git(['worktree', 'add', '--detach', odd, 'HEAD'], dir);
    t.after(() => { try { git(['worktree', 'remove', '--force', odd], dir); } catch { /* already gone */ } });
    const r = run('queue.mjs', ['plan', '--tree', odd], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.tree, odd);
    assert.equal(r.json.branch, null);
  });
});

test('node.mjs --scratch: a throwaway detached tree, refused for an unknown sha, cleaned up when provisioning fails', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('a sha this repository has never seen', () => {
    const r = run('node.mjs', ['bind', '--scratch', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/);
  });

  await t.test('git worktree add succeeds, worktree.copy then refuses on a missing source: the tree is removed anyway', () => {
    run('horde.mjs', ['config', 'set', 'worktree.copy', 'never-existed.txt'], dir);
    const sha = git(['rev-parse', 'HEAD'], dir);
    const before = git(['worktree', 'list', '--porcelain'], dir);
    const r = run('node.mjs', ['bind', '--scratch', sha], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /never-existed\.txt/);
    const after = git(['worktree', 'list', '--porcelain'], dir);
    assert.equal(after, before); // nothing new left registered
  });
});

test('provenance: every command that resolves a tree carries tree, branch and sha in --json', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('an ordinary branch: both fields set', () => {
    const id = newTicket(dir, 'prov');
    run('queue.mjs', ['add', id], dir);
    const set = run('queue.mjs', ['set', id, 'running'], dir);
    assert.equal(set.code, 0, set.stderr);
    assert.equal(set.json.branch, `mission1/t-${id}`);
    // set's own "sha" field is the ticket's LANDED commit (null until merged) — a different fact
    // than the tree's provenance, so the sha check below reads it off a resolver-carrying command
    // instead of overloading that field's existing meaning here.

    const shown = run('node.mjs', ['bind', '--ticket', id, '--horde', 'mission1'], dir);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.json.branch, `mission1/t-${id}`);
    assert.match(shown.json.sha, /^[0-9a-f]{40}$/);
    assert.equal(shown.json.tree, set.json.worktree);
  });

  await t.test('a detached tree: branch is null, sha is set — both asserted, not just present', () => {
    const sha = git(['rev-parse', 'HEAD'], dir);
    const r = run('node.mjs', ['bind', '--scratch', sha], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.branch, null);
    assert.equal(r.json.sha, sha);
    assert.equal('branch' in r.json, true);
    assert.equal('sha' in r.json, true);
  });
});
