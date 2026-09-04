import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
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
