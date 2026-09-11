import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { makeRepo, rmRepo } from './helpers.mjs';

test('_lib.mjs: hordeRoot, parseArgs, renderTemplate, appendText', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  await t.test('hordeRoot is not created until asked to, and is gitignored once it is', async () => {
    const mod = await import('../_lib.mjs');
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const hr = mod.hordeRoot();
      assert.equal(existsSync(hr), false);
      const created = mod.hordeRoot({ create: true });
      assert.equal(existsSync(created), true);
      assert.equal(readFileSync(join(created, '.gitignore'), 'utf8'), '*\n');
      // idempotent: calling again with create:true does not error or duplicate the .gitignore
      const again = mod.hordeRoot({ create: true });
      assert.equal(again, created);
    } finally {
      process.chdir(origCwd);
    }
  });

  await t.test('parseArgs: --k v, --k=v, booleans, repeats, positionals', async () => {
    const { parseArgs } = await import('../_lib.mjs');
    const { positional, flags } = parseArgs(
      ['add', 'slug', '--ticket', '007', '--node=auth', '--open', '--evidence', 'a', '--evidence', 'b'],
      { flags: ['open'] },
    );
    assert.deepEqual(positional, ['add', 'slug']);
    assert.equal(flags.ticket, '007');
    assert.equal(flags.node, 'auth');
    assert.equal(flags.open, true);
    assert.deepEqual(flags.evidence, ['a', 'b']);
  });

  await t.test('appendText never duplicates existing content', async () => {
    const { appendText } = await import('../_lib.mjs');
    const file = join(dir, 'j.md');
    appendText(file, 'line1\n');
    appendText(file, 'line2\n');
    assert.equal(readFileSync(file, 'utf8'), 'line1\nline2\n');
  });

  await t.test('renderTemplate fills placeholders and defaults', async () => {
    const { renderTemplate } = await import('../_lib.mjs');
    const out = renderTemplate('charter', { title: 'T', horde: 'h', base: 'develop', date: '2026-01-01', user: 'U' });
    assert.match(out, /# Mission · T/);
    assert.match(out, /Limit: none runs-weighted/);
  });

  // teamPath()'s refusal paths (unknown team, a literal "teams" segment, a mismatched full path)
  // all go through fail() -> process.exit(), which would kill this whole in-process test run if
  // called directly here — those are covered instead as CLI-level (child-process) tests in
  // queue.test.mjs. This one sticks to the resolving paths, which are safe to call directly.
  await t.test('teamPath resolves a leaf name through roster.json\'s steward parent chain, and accepts a matching full path', async () => {
    const { teamPath, hordeRoot: hordeRootFn } = await import('../_lib.mjs');
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      hordeRootFn({ create: true });
      const rosterFile = join(hordeRootFn(), 'hordes', 'pilot', 'roster.json');
      mkdirSync(dirname(rosterFile), { recursive: true });
      writeFileSync(rosterFile, JSON.stringify({
        entries: [
          { name: 'pilot-steward-lark-1', role: 'steward', team: 'lark', parent: 'trunk' },
          { name: 'pilot-steward-wren-1', role: 'steward', team: 'wren', parent: 'lark' },
        ],
      }));

      const trunkPath = join(hordeRootFn(), 'hordes', 'pilot', 'teams', 'trunk', 'x');
      const larkPath = join(hordeRootFn(), 'hordes', 'pilot', 'teams', 'trunk', 'teams', 'lark', 'x');
      const wrenPath = join(hordeRootFn(), 'hordes', 'pilot', 'teams', 'trunk', 'teams', 'lark', 'teams', 'wren', 'x');

      assert.equal(teamPath('pilot', 'trunk', 'x'), trunkPath);
      assert.equal(teamPath('pilot', 'lark', 'x'), larkPath);
      assert.equal(teamPath('pilot', 'wren', 'x'), wrenPath);
      // a full slash path is accepted when it matches what the roster independently resolves
      assert.equal(teamPath('pilot', 'trunk/lark', 'x'), larkPath);
      assert.equal(teamPath('pilot', 'trunk/lark/wren', 'x'), wrenPath);
    } finally {
      process.chdir(origCwd);
    }
  });

  await t.test('renderTemplate throws listing every unfilled placeholder', async () => {
    const { renderTemplate } = await import('../_lib.mjs');
    assert.throws(
      () => renderTemplate('charter', { title: 'T' }),
      (err) => {
        assert.match(err.message, /unfilled placeholder/);
        assert.match(err.message, /horde/);
        assert.match(err.message, /base/);
        assert.match(err.message, /date/);
        assert.match(err.message, /user/);
        return true;
      },
    );
  });
});

// The measurement the whole key-transfer rests on, made a test: what a landing on the base does
// to the identity of a branch's diff, at the default sensitivity and at a lower one.
test('_lib.mjs patchIdOf: a landing outside the change\'s own context leaves its identity alone', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { patchIdOf } = await import('../_lib.mjs');
  const g = (args, cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const lines = Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
  const withLine = (n, value) => {
    const out = [...lines];
    out[n - 1] = `export const v${n} = ${value};`;
    return `${out.join('\n')}\n`;
  };

  g(['checkout', '-qb', 'base']);
  writeFileSync(join(dir, 'lib.mjs'), `${lines.join('\n')}\n`);
  g(['add', 'lib.mjs']);
  g(['commit', '-qm', 'the file']);
  g(['checkout', '-qb', 'ticket']);
  writeFileSync(join(dir, 'lib.mjs'), withLine(20, 2000));
  g(['commit', '-qam', 'the ticket changes line 20']);
  g(['checkout', '-q', 'base']);

  const original = patchIdOf('ticket', 'base', { cwd: dir });
  const originalTight = patchIdOf('ticket', 'base', { cwd: dir, context: 1 });
  assert.match(original, /^[0-9a-f]{40}$/);
  assert.match(originalTight, /^[0-9a-f]{40}$/);

  const land = (name, files) => {
    g(['checkout', '-q', 'base']);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    g(['add', '-A']);
    g(['commit', '-qm', name]);
    g(['checkout', '-q', 'ticket']);
    g(['merge', '-q', 'base', '-m', `catch up: ${name}`]);
    const id = patchIdOf('ticket', 'base', { cwd: dir });
    g(['checkout', '-q', 'base']);
    return id;
  };

  await t.test('another file entirely: unchanged', () => {
    assert.equal(land('another file', { 'other.mjs': 'export const other = 1;\n' }), original);
  });

  await t.test('the same file, fifteen lines away: unchanged', () => {
    assert.equal(land('line 35', { 'lib.mjs': withLine(35, 999) }), original);
  });

  await t.test('the same file, inside the change\'s own three lines of context: changed', () => {
    const moved = land('line 22', { 'lib.mjs': withLine(22, 999) });
    assert.match(moved, /^[0-9a-f]{40}$/);
    assert.notEqual(moved, original);
  });

  await t.test('keyContext is the knob: at one line of context, that same landing is nothing', () => {
    // Every landing so far left lines 19 and 21 alone, so a key taken with one line of context
    // still holds — the cost of that being a key that survives a change two lines away.
    assert.equal(patchIdOf('ticket', 'base', { cwd: dir, context: 1 }), originalTight);
    assert.notEqual(patchIdOf('ticket', 'base', { cwd: dir }), original);
    // Zero is not offered: it reads as the default, so it can never be set as a way of ignoring
    // a change on the very next line.
    assert.equal(patchIdOf('ticket', 'base', { cwd: dir, context: 0 }), patchIdOf('ticket', 'base', { cwd: dir }));
  });

  await t.test('nothing to identify: an unknown ref, or a branch with no diff of its own', () => {
    assert.equal(patchIdOf('no-such-branch', 'base', { cwd: dir }), null);
    assert.equal(patchIdOf('base', 'base', { cwd: dir }), null);
  });
});

// resolveTree's resolving paths only — every refusal is a CLI-level test in tree.test.mjs, for the
// same reason teamPath's refusals are above: fail() calls process.exit() and would kill this whole
// in-process run.
test('_lib.mjs resolveTree: narrowest scope wins, cwd and trunk defaults, scratch cleanup', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const realDir = realpathSync(dir);
  const g = (args, cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    const { resolveTree, hordeRoot: hordeRootFn } = await import('../_lib.mjs');
    hordeRootFn({ create: true });
    g(['branch', 'h1/trunk']);
    const ticketBranch = 'h1/t-001';
    g(['branch', ticketBranch]);
    const ticketPath = join(hordeRootFn(), 'worktrees', 'h1', 't-001');
    g(['worktree', 'add', ticketPath, ticketBranch]);

    await t.test('--tree beats --ticket beats --horde', () => {
      const viaTree = resolveTree({ tree: ticketPath, ticket: '001', horde: 'h1' });
      assert.equal(viaTree.kind, 'tree');
      assert.equal(viaTree.path, ticketPath);
      assert.equal(viaTree.branch, ticketBranch);

      const viaTicket = resolveTree({ ticket: '001', horde: 'h1' });
      assert.equal(viaTicket.kind, 'ticket');
      assert.equal(viaTicket.path, ticketPath);
      assert.equal(viaTicket.branch, ticketBranch);
    });

    await t.test('--horde alone gives the trunk tip, kind "trunk", cleanup is a no-op', () => {
      const viaHorde = resolveTree({ horde: 'h1' });
      assert.equal(viaHorde.kind, 'trunk');
      assert.equal(viaHorde.branch, 'h1/trunk');
      assert.equal(viaHorde.path, join(hordeRootFn(), 'worktrees', 'h1', 'trunk'));
      assert.equal(viaHorde.sha, g(['rev-parse', 'h1/trunk']));
      assert.equal(typeof viaHorde.cleanup, 'function');
      viaHorde.cleanup();
      assert.equal(existsSync(viaHorde.path), true); // still there — cleanup does nothing for trunk
    });

    await t.test('no flags at all: cwd, kind "cwd"', () => {
      const viaCwd = resolveTree({});
      assert.equal(viaCwd.kind, 'cwd');
      assert.equal(viaCwd.path, realDir);
      assert.equal(viaCwd.sha, g(['rev-parse', 'HEAD']));
    });

    await t.test('--scratch creates a detached worktree at the given sha, and cleanup() removes it', () => {
      const sha = g(['rev-parse', 'HEAD']);
      const viaScratch = resolveTree({ scratch: sha });
      assert.equal(viaScratch.kind, 'scratch');
      assert.equal(viaScratch.branch, null);
      assert.equal(viaScratch.sha, sha);
      assert.equal(existsSync(viaScratch.path), true);
      viaScratch.cleanup();
      assert.equal(existsSync(viaScratch.path), false);
      const known = g(['worktree', 'list', '--porcelain']);
      assert.equal(known.includes(viaScratch.path), false);
    });
  } finally {
    process.chdir(origCwd);
  }
});
