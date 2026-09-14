import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync,
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
    assert.match(out, /\*\*Policy:\*\* autonomous/);
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

    // 012: the resync used to run `git reset --hard` unconditionally, discarding a manual edit to
    // the trunk tree without a word. It still discards it — trunk is written only by the landing
    // script — but now it says so first, once, on stderr, with a count.
    await t.test('a dirty trunk tree: the resync warns once on stderr with a discard count, then still resets; an untracked file is not counted and survives; a clean read stays silent', () => {
      const trunkPath = join(hordeRootFn(), 'worktrees', 'h1', 'trunk');
      writeFileSync(join(trunkPath, 'README.md'), 'edited by hand, never committed\n');
      writeFileSync(join(trunkPath, 'untracked.txt'), 'never staged\n');

      const origWrite = process.stderr.write;
      const calls = [];
      process.stderr.write = (chunk) => { calls.push(String(chunk)); return true; };
      let resynced;
      try {
        resynced = resolveTree({ horde: 'h1' });
      } finally {
        process.stderr.write = origWrite;
      }

      assert.equal(resynced.kind, 'trunk');
      assert.equal(calls.length, 1, 'exactly one stderr write for the dirty resync');
      assert.equal(calls[0].split('\n').filter((l) => l.length).length, 1, 'a single line, not a dump');
      assert.match(calls[0], /discarded 1 uncommitted change\b/);
      assert.match(calls[0], /h1\/trunk/);

      // the hand edit to a tracked file really was discarded — back to what the branch committed
      assert.equal(readFileSync(join(trunkPath, 'README.md'), 'utf8'), 'hi\n');
      // `git reset --hard` never touches an untracked file, so it is not counted, and survives
      assert.equal(existsSync(join(trunkPath, 'untracked.txt')), true);

      rmSync(join(trunkPath, 'untracked.txt'));
      const calls2 = [];
      process.stderr.write = (chunk) => { calls2.push(String(chunk)); return true; };
      try {
        resolveTree({ horde: 'h1' });
      } finally {
        process.stderr.write = origWrite;
      }
      assert.equal(calls2.length, 0, 'a clean trunk tree resyncs without a word');
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

// git() swallows every git failure into null — a real error (git could not answer at all) and a
// clean "no" (a ref that simply does not exist, an existence check run with --quiet) come back
// identically. gitError() is how a caller tells them apart, so a refusal built on a null can carry
// git's own words instead of the wrapper's guess. Proven directly against git()/gitError(), then
// against a real caller (provisionTree) that puts the distinction to use.
test('_lib.mjs git()/gitError(): a real git failure is not swallowed silently', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { git, gitError, provisionTree } = await import('../_lib.mjs');

  await t.test('gitError() is null after success, holds git\'s stderr after a real failure, and is empty (not null) after a clean --quiet "no"', () => {
    assert.equal(git(['rev-parse', 'HEAD'], dir) !== null, true);
    assert.equal(gitError(), null);

    assert.equal(git(['not-a-real-git-command'], dir), null);
    assert.match(gitError(), /not a git command/);

    assert.equal(git(['show-ref', '--verify', '--quiet', 'refs/heads/no-such-branch'], dir), null);
    assert.equal(gitError(), '');

    // the next successful call clears it again
    assert.equal(git(['rev-parse', 'HEAD'], dir) !== null, true);
    assert.equal(gitError(), null);
  });

  await t.test('provisionTree: a worktree git could not create throws with git\'s own reason, not just the wrapper\'s guess', () => {
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const path = join(dir, 'nope');
      assert.throws(
        () => provisionTree(path, 'no-such-ref-at-all', {}),
        (err) => {
          assert.match(err.message, /could not create worktree/);
          // The point of the fix: the message carries git's OWN explanation. Before the fix this
          // is where the test goes red — the thrown message stopped at "for no-such-ref-at-all".
          assert.match(err.message, /invalid reference/i);
          return true;
        },
      );
      assert.equal(existsSync(path), false);
    } finally {
      process.chdir(origCwd);
    }
  });
});

// The lease file is keyed by a SUBJECT, not by a node: a node when `node.mjs bind` claims one, a
// territory when a refinement's cut does. Only the claiming paths are exercised in-process here —
// every refusal goes through fail() -> process.exit(), which would take this whole run with it, so
// those are CLI-level tests in refine.test.mjs (same reason as teamPath's above).
test('_lib.mjs leases: one mechanism, keyed by whatever is being held — a node or a territory', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const origCwd = process.cwd();
  process.chdir(realpathSync(dir));
  try {
    const {
      hordeRoot: hordeRootFn, claimLease, readLeases, releaseLeasesForHorde, leaseConflict,
    } = await import('../_lib.mjs');
    hordeRootFn({ create: true });
    mkdirSync(join(hordeRootFn(), 'hordes', 'h1'), { recursive: true });

    await t.test('a territory is claimed and then held, by the same call that claims a node', () => {
      const first = claimLease('h1', 'the front door', { kind: 'territory' });
      assert.equal(first.status, 'claimed');
      assert.equal(first.node, 'the front door');
      const again = claimLease('h1', 'the front door', { kind: 'territory' });
      assert.equal(again.status, 'held');
      assert.equal(again.since, readLeases().leases['the front door'].since, 'holding it again does not re-date it');
    });

    await t.test('two territories of one horde sit side by side, and so does a node', () => {
      claimLease('h1', 'numbers', { kind: 'territory' });
      claimLease('h1', 'auth');
      assert.deepEqual(Object.keys(readLeases().leases).sort(), ['auth', 'numbers', 'the front door']);
    });

    await t.test('the on-disk shape is unchanged — history keeps its "node" field, carrying the subject', () => {
      const { history } = readLeases();
      const entry = history.find((h) => h.node === 'the front door');
      assert.deepEqual(Object.keys(entry).sort(), ['at', 'ask', 'event', 'from', 'horde', 'node'].sort());
      assert.equal(entry.event, 'bind');
      assert.equal(entry.horde, 'h1');
    });

    await t.test('the holder is only a conflict while it is live — an unknown horde blocks nobody', () => {
      // "h1" has a directory under hordes/, so it is live; "ghost" never did.
      assert.equal(leaseConflict('h2', 'the front door').horde, 'h1');
      claimLease('ghost-holder-check', 'orphan');
      assert.equal(leaseConflict('h2', 'orphan'), null);
    });

    await t.test('archiving releases every subject at once, nodes and territories alike', () => {
      const released = releaseLeasesForHorde('h1');
      assert.deepEqual(released.sort(), ['auth', 'numbers', 'the front door']);
      assert.deepEqual(Object.keys(readLeases().leases), ['orphan']);
      assert.equal(readLeases().history.filter((h) => h.event === 'release').length, 3);
    });
  } finally {
    process.chdir(origCwd);
  }
});

// Class names are host-neutral, never a Claude model name, and the generic
// fallback (config.classes' own first key, DEFAULT_CLASSES' first key with no config yet) never
// falls back to a literal "sonnet".
test('_lib.mjs: DEFAULT_CLASSES and firstClass are host-neutral', async (t) => {
  const { DEFAULT_CLASSES, firstClass } = await import('../_lib.mjs');
  const CLAUDE_MODEL_NAMES = ['haiku', 'sonnet', 'opus', 'fable'];

  await t.test('DEFAULT_CLASSES carries none of the four Claude model names as a key', () => {
    for (const name of CLAUDE_MODEL_NAMES) {
      assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_CLASSES, name), false, `DEFAULT_CLASSES should not key on "${name}"`);
    }
  });

  await t.test('firstClass(cfg) returns the mission\'s own first configured class', () => {
    assert.equal(firstClass({ classes: { heavy: 10, light: 1 } }), 'heavy');
  });

  await t.test('firstClass(cfg) falls back to DEFAULT_CLASSES\' first key with no config yet, never "sonnet"', () => {
    assert.equal(firstClass(null), Object.keys(DEFAULT_CLASSES)[0]);
    assert.equal(firstClass({}), Object.keys(DEFAULT_CLASSES)[0]);
    assert.equal(firstClass({ classes: {} }), Object.keys(DEFAULT_CLASSES)[0]);
    assert.notEqual(firstClass(null), 'sonnet');
  });
});

// ---- one parser per document ------------------------------------------------------------------
//
// The same markdown documents used to be taken apart by a regex in each tool that read them: the
// ticket log's state lines in retro, brief and tk; its verdict blocks in drill, blame and wave;
// the ticket's acceptance checklist in tk, blame and wave; the charter's evidence catalogue in
// wave and tk; the mission's decisions in decide and land. A shape reworded in one of them left
// the others quietly measuring the wrong thing. Every one of those reads now goes through the
// parsers below, and the last test here is what keeps it that way.

test('_lib.mjs: the ticket log is parsed in one place', async (t) => {
  const { parseLogEntries, latestChangesRound } = await import('../_lib.mjs');

  const log = [
    '- 2026-01-01T00:00:00Z status: queued',
    '- 2026-01-02T00:00:00Z the worker asked about the status: line wording',
    '- 2026-01-03T00:00:00Z status: changes — gate red (round 2/5 — resume same worker)',
    '- 2026-01-04T00:00:00Z status: merged — landed',
    '- a remark with no stamp of its own',
    'not a log line at all',
  ].join('\n');

  await t.test('a state entry is told from a remark by its shape, never by its words', () => {
    const entries = parseLogEntries(log);
    assert.deepEqual(entries.map((e) => e.isStatus), [true, false, true, true, false]);
    // The remark talks about a status and stays a remark.
    assert.equal(entries[1].text, '2026-01-02T00:00:00Z the worker asked about the status: line wording');
    assert.equal(entries[4].text, 'a remark with no stamp of its own');
  });

  await t.test('an entry keeps the line it came from, so a caller can key on it', () => {
    assert.deepEqual(parseLogEntries(log).map((e) => e.index), [0, 1, 2, 3, 4]);
  });

  await t.test('a state entry carries its state, its note and its fix-loop round', () => {
    const changes = parseLogEntries(log)[2];
    assert.equal(changes.status, 'changes');
    assert.equal(changes.note, 'gate red');
    assert.deepEqual(
      { round: changes.round, cap: changes.cap, label: changes.label },
      { round: 2, cap: 5, label: 'resume same worker' },
    );
    const merged = parseLogEntries(log)[3];
    assert.equal(merged.status, 'merged');
    assert.equal(merged.note, 'landed');
    assert.equal(merged.round, null);
  });

  await t.test('latestChangesRound is the highest round the log records, 0 when it records none', () => {
    assert.equal(latestChangesRound(log), 2);
    assert.equal(latestChangesRound(`${log}\n- 2026-01-05T00:00:00Z status: changes — again (round 4/5 — fresh worker, class up)`), 4);
    assert.equal(latestChangesRound('- 2026-01-01T00:00:00Z status: queued'), 0);
    assert.equal(latestChangesRound(''), 0);
    assert.equal(latestChangesRound(null), 0);
  });
});

test('_lib.mjs: a verdict block is parsed in one place', async (t) => {
  const { parseVerdictBlocks } = await import('../_lib.mjs');

  const log = [
    '- 2026-01-01T00:00:00Z status: running',
    '',
    '## Verdict · 004 · 2026-01-02 · by scout (light)',
    '',
    '**Result:** not-reproduced',
    '',
    '| item | command | saw |',
    '|---|---|---|',
    '| the page renders | npm test | 1 failing |',
    '',
    '## Verdict · 004 · 2026-01-03 · by scout (light)',
    '',
    '**Result:** reproduced',
    '**Gate:** green at sha abc1234',
    '',
    '| item | command | saw |',
    '|---|---|---|',
    '| the page renders | npm test | 12 passing |',
    '| the pipe \\| inside a cell | grep -F pipe | one match |',
    '',
    '## Verdict · 007 · 2026-01-04 · by scout (heavy)',
    '',
    '**Result:** reproduced',
  ].join('\n');

  await t.test('every block on the log, in order, with its heading read out', () => {
    const blocks = parseVerdictBlocks(log);
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks.map((b) => b.ticket), ['004', '004', '007']);
    assert.deepEqual(blocks.map((b) => b.result), ['not-reproduced', 'reproduced', 'reproduced']);
    assert.deepEqual(blocks.map((b) => b.verifier), ['scout', 'scout', 'scout']);
    assert.deepEqual(blocks.map((b) => b.class), ['light', 'light', 'heavy']);
    assert.deepEqual(blocks.map((b) => b.date), ['2026-01-02', '2026-01-03', '2026-01-04']);
  });

  await t.test('the evidence table comes back as rows, an escaped pipe staying inside its cell', () => {
    const [, second] = parseVerdictBlocks(log);
    assert.deepEqual(second.rows, [
      { item: 'the page renders', command: 'npm test', saw: '12 passing' },
      { item: 'the pipe \\| inside a cell', command: 'grep -F pipe', saw: 'one match' },
    ]);
    assert.deepEqual(parseVerdictBlocks(log)[2].rows, []);
  });

  await t.test('the block keeps its own text, so a caller can read a field nobody parsed for it', () => {
    assert.match(parseVerdictBlocks(log)[1].block, /\*\*Gate:\*\* green at sha abc1234/);
  });

  await t.test('a verdict handed to the log as a remark carries the log\'s stamp, and reads the same', () => {
    const stamped = [
      '- 2026-01-01T00:00:00Z status: running',
      '- 2026-01-05T00:00:00Z ## Verdict · 004 · 2026-01-05 · by scout (standard)',
      '',
      '**Result:** reproduced',
      '',
      '| item | command | saw |',
      '|---|---|---|',
      '| the page renders | npm test | 12 passing |',
      '',
      '**Gate:** `node --test` — green at sha abc1234',
    ].join('\n');
    const [only] = parseVerdictBlocks(stamped);
    assert.equal(parseVerdictBlocks(stamped).length, 1);
    assert.deepEqual(
      {
        ticket: only.ticket, verifier: only.verifier, result: only.result, rows: only.rows.length,
      },
      {
        ticket: '004', verifier: 'scout', result: 'reproduced', rows: 1,
      },
    );
    assert.equal(only.block.startsWith('## Verdict · 004'), true, 'the stamp is not part of the block');
  });

  await t.test('a log with no verdict on it has no blocks', () => {
    assert.deepEqual(parseVerdictBlocks('- 2026-01-01T00:00:00Z status: queued'), []);
    assert.deepEqual(parseVerdictBlocks(''), []);
    assert.deepEqual(parseVerdictBlocks(null), []);
  });
});

test('_lib.mjs: a ticket\'s acceptance checklist is parsed in one place', async (t) => {
  const { parseAcceptanceLines } = await import('../_lib.mjs');

  const ticket = [
    '# 004 · a title',
    '',
    '## Acceptance — evidence',
    '',
    '- [ ] the page renders',
    '- [x] E3 the audit event lands',
    '- [X] E4 an upper-case tick is still a tick',
    '- [ ] …',
    '- [ ] ...',
    '- [ ]',
    '',
    '## Notes',
    '',
    '- [ ] a checkbox outside the section is not an acceptance line',
  ].join('\n');

  await t.test('only the real lines of the section, with their state and their text', () => {
    assert.deepEqual(parseAcceptanceLines(ticket), [
      { raw: '- [ ] the page renders', checked: false, text: 'the page renders' },
      { raw: '- [x] E3 the audit event lands', checked: true, text: 'E3 the audit event lands' },
      { raw: '- [X] E4 an upper-case tick is still a tick', checked: true, text: 'E4 an upper-case tick is still a tick' },
    ]);
  });

  await t.test('a ticket with no such section, and one with nothing but the placeholder', () => {
    assert.deepEqual(parseAcceptanceLines('no section at all'), []);
    assert.deepEqual(parseAcceptanceLines('## Acceptance — evidence\n\n- [ ] …\n'), []);
    assert.deepEqual(parseAcceptanceLines(null), []);
  });
});

test('_lib.mjs: the charter\'s evidence catalogue is parsed in one place', async (t) => {
  const { parseEvidenceRows, markdownSection, markdownTableCells } = await import('../_lib.mjs');

  const charter = [
    '# Mission',
    '',
    '## Acceptance — the evidence catalogue',
    '',
    '| id | evidence | node | reproduced by |',
    '|---|---|---|---|',
    '| E1 | the page renders | web | scout |',
    '| E2 | the audit event lands | audit | |',
    '| | | | |',
    '',
    '## Nodes',
    '',
    '| E9 | a row outside the section | x | |',
  ].join('\n');

  await t.test('the rows inside the section, the all-empty template row dropped', () => {
    assert.deepEqual(parseEvidenceRows(charter), [
      {
        id: 'E1', evidence: 'the page renders', node: 'web', reproducedBy: 'scout',
      },
      {
        id: 'E2', evidence: 'the audit event lands', node: 'audit', reproducedBy: '',
      },
    ]);
  });

  await t.test('a charter with no catalogue at all', () => {
    assert.deepEqual(parseEvidenceRows('# Mission\n'), []);
  });

  await t.test('markdownSection stops at the next heading; markdownTableCells trims and unwraps', () => {
    assert.equal(markdownSection(charter, '## Acceptance').includes('## Nodes'), false);
    assert.equal(markdownSection(charter, '## Nodes').includes('a row outside the section'), true);
    assert.equal(markdownSection(charter, '## Nowhere'), '');
    assert.deepEqual(markdownTableCells('|  a | b  |c|'), ['a', 'b', 'c']);
  });
});

test('_lib.mjs: the mission\'s decisions are parsed in one place', async (t) => {
  const { parseDecisionEntries, decisionField } = await import('../_lib.mjs');

  const decisions = [
    '# Decisions',
    '',
    'A banner nobody parses.',
    '',
    '## 2026-09-11 · ask-a-007 · ticket 004 · node auth',
    '',
    '**Kind:** lower · **Aspect:** no-marker · **Scope:** once',
    '**Question:** deleting this rule weakens what the mission is judged by.',
    '**Answer:** approved — superseded by the type-level check.',
    '**By:** client · **At:** 2026-09-11T09:00:00Z',
    '',
    '## 2026-09-12 · a-ruling',
    '',
    'The body of the ruling.',
    '',
  ].join('\n');

  await t.test('a heading in the entry shape comes back with its fields read out', () => {
    const entries = parseDecisionEntries(decisions);
    const ask = entries.find((e) => e.slug === 'ask-a-007');
    assert.deepEqual(
      {
        date: ask.date, slug: ask.slug, ticket: ask.ticket, node: ask.node,
      },
      {
        date: '2026-09-11', slug: 'ask-a-007', ticket: '004', node: 'auth',
      },
    );
    const ruling = entries.find((e) => e.slug === 'a-ruling');
    assert.equal(ruling.body, 'The body of the ruling.');
    assert.equal(ruling.ticket, null);
    assert.equal(ruling.node, null);
  });

  await t.test('a heading in any other shape still opens a block, with no fields read', () => {
    const banner = parseDecisionEntries('## not an entry heading\n\n**Kind:** lower\n');
    assert.equal(banner.length, 1);
    assert.equal(banner[0].slug, null);
    assert.equal(banner[0].date, null);
    assert.equal(decisionField(banner[0].block, 'Kind'), 'lower');
  });

  await t.test('an entry\'s block is the file\'s own text, so a caller can rewrite it in place', () => {
    const ask = parseDecisionEntries(decisions).find((e) => e.slug === 'ask-a-007');
    assert.equal(decisions.includes(ask.block), true, 'the block must be a literal slice of the document');
  });

  await t.test('decisionField reads one bold field out of a block, stopping at the next one', () => {
    const ask = parseDecisionEntries(decisions).find((e) => e.slug === 'ask-a-007');
    assert.equal(decisionField(ask.block, 'Kind'), 'lower');
    assert.equal(decisionField(ask.block, 'Aspect'), 'no-marker');
    assert.equal(decisionField(ask.block, 'Scope'), 'once');
    assert.equal(decisionField(ask.block, 'Answer'), 'approved — superseded by the type-level check.');
    assert.equal(decisionField(ask.block, 'Consumed'), '');
  });

  await t.test('an empty document has no entries', () => {
    assert.deepEqual(parseDecisionEntries(''), []);
    assert.deepEqual(parseDecisionEntries(null), []);
  });
});

// The invariant behind all of the above: the shapes of those documents are spelled out in
// _lib.mjs and nowhere else. Each marker below is a piece of one of them as it looks in code — if
// a tool starts reading a document its own way again, its own copy shows up here.
test('no tool but _lib.mjs spells out the shape of a document it reads', async () => {
  const { readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));

  const MARKERS = [
    ['the verdict block\'s heading', '## Verdict'],
    ['the verdict\'s result field', 'Result:\\*\\*'],
    ['the verdict\'s evidence table', 'command |'],
    ['the log\'s state line', 'status:\\s'],
    ['the log\'s fix-loop round', '(round (\\d+)'],
    ['the acceptance checkbox', '\\[[ x]\\]'],
    ['the acceptance checkbox', '\\[([ xX])\\]'],
    ['a table row taken apart by hand', 'split(\'|\').slice(1, -1)'],
    ['a table row taken apart by hand', 'split(\'|\')[1]'],
    ['a table row taken apart by hand', 'split(/(?<!\\\\)\\|/)'],
    ['the decisions entry heading', '· ticket ('],
    ['the decisions document split into blocks', 'split(/^## /m)'],
  ];

  const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs') && f !== '_lib.mjs');
  assert.ok(files.length > 10, `expected the whole tool set, found ${files.length} file(s)`);

  const offenders = [];
  for (const file of files) {
    // Full-line comments are prose about these documents and may name them; code may not.
    const code = readFileSync(join(scriptsDir, file), 'utf8').split('\n')
      .filter((l) => !l.trim().startsWith('//'));
    for (const [what, marker] of MARKERS) {
      const at = code.findIndex((l) => l.includes(marker));
      if (at !== -1) offenders.push(`${file}: ${what} — ${code[at].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `these documents are parsed in _lib.mjs; a second reading of one lives in:\n${offenders.join('\n')}`);
});
