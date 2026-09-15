import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, rmRepo } from './helpers.mjs';
import { raceTrunk, overlaps, describeRace } from './tree-race/harness.mjs';

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
  // all go through fail(), which throws rather than exits and would be simple enough to catch
  // in-process — but what is actually under test there is the CLI's own contract on a refusal:
  // exit code 1 and a clean `error: ...` line with no stack trace, which only the real entrypoint
  // (main() via runMain) produces. Those stay CLI-level (child-process) tests in queue.test.mjs
  // for that reason. This one sticks to the resolving paths, which are safe to call directly.
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

// resolveTree's resolving paths only — every refusal is a CLI-level test in tree.test.mjs, for the
// same reason teamPath's refusals are above: fail() throws rather than exits, but the refusal path
// is tested for the CLI's own contract (exit code, a clean stack-trace-free line), which only the
// real entrypoint produces.
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

// 110: resolving a horde's trunk was a check-then-act with nothing serializing it. Two processes
// asking for one horde's trunk at the same moment — a director's watch loop and a hand-run
// command, or two sessions on one mission — both got the same answer to "is the tree there" and
// both acted on it, and git refused whichever arrived second: `fatal: '<path>' already exists` on
// a trunk neither knew the other was making, or `Unable to create '<gitdir>/index.lock'` on a
// trunk both were resyncing. Either way one caller got a raw git error where the honest answer was
// the tree the other had just finished with.
//
// Two real processes, both running the shipped resolve, both held open inside it on purpose (see
// tree-race/) so the second arrives inside the window every run rather than once in a thousand.
// The question is the same in both halves: were the two ever inside the resolve at the same time.
//
// That question, and not "did either one fail", is what these assert on, because it is the one
// with a deterministic answer. Which of the two failures a real collision produces — the raw git
// refusal, or the quieter one where the second caller is handed a tree the first has only started
// filling — turns on where in the first caller's git commands the second one lands, and no
// injection pins that down. Two callers inside at once is the fault behind both, and it is
// answered the same way every run. What each caller came back with is asserted beside it.
test('_lib.mjs resolveTree: two processes resolving one horde\'s trunk at once take turns, and both get the tree', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const g = (args, cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['branch', 'h1/trunk']);
  mkdirSync(join(dir, '.horde'), { recursive: true });
  writeFileSync(join(dir, '.horde', '.gitignore'), '*\n');

  const bothTookTurns = (race) => {
    assert.ok(race.marked, `nothing was ever paused, so this run proves nothing:\n${describeRace(race)}`);
    const a = race.first.answer;
    const b = race.second.answer;
    assert.ok(a && b, `both processes must print an answer:\n${describeRace(race)}`);
    assert.ok(
      a.pause && b.pause,
      `both processes must have been held inside the resolve, or the race was never run:\n${describeRace(race)}`,
    );
    assert.equal(
      overlaps(a.pause, b.pause),
      false,
      'both processes were inside the trunk resolve at the same moment — one of them is making or '
      + `resyncing a tree the other is already making or resyncing.\n${describeRace(race)}`,
    );
  };

  await t.test('a trunk no command has ever read: both processes come back with the same tree, neither is refused', async () => {
    const race = await raceTrunk(dir, 'h1');
    assert.equal(race.first.code, 0, describeRace(race));
    assert.equal(race.second.code, 0, describeRace(race));
    const a = race.first.answer;
    const b = race.second.answer;
    assert.ok(a.ok && b.ok, describeRace(race));
    assert.equal(a.path, b.path, `one tree, asked for twice:\n${describeRace(race)}`);
    assert.equal(a.sha, b.sha, `one tip, read twice:\n${describeRace(race)}`);
    assert.equal(a.branch, 'h1/trunk');
    assert.equal(b.branch, 'h1/trunk');
    assert.equal(a.kind, 'trunk');
    assert.equal(existsSync(a.path), true);
    // taking turns is only worth anything if the turn is given back
    assert.equal(existsSync(`${a.path}.lock`), false, 'nothing is left holding the tree afterwards');
    bothTookTurns(race);
  });

  // The second window, one step further on: the tree is there now, so both processes take the
  // other branch and resync it with `git reset --hard`, which git will not run twice at once on
  // one worktree. A dirty tree so the reset has real work to do.
  await t.test('a trunk that already exists: the two resyncs take turns too', async () => {
    const trunkPath = join(dir, '.horde', 'worktrees', 'h1', 'trunk');
    assert.equal(existsSync(trunkPath), true, 'the first half of this test provisions the tree');
    writeFileSync(join(trunkPath, 'README.md'), 'edited by hand, never committed\n');

    const race = await raceTrunk(dir, 'h1');
    assert.equal(race.first.code, 0, describeRace(race));
    assert.equal(race.second.code, 0, describeRace(race));
    const a = race.first.answer;
    const b = race.second.answer;
    assert.ok(a.ok && b.ok, describeRace(race));
    assert.equal(a.path, b.path, `one tree, asked for twice:\n${describeRace(race)}`);
    assert.equal(a.sha, b.sha, `one tip, read twice:\n${describeRace(race)}`);
    // the resync really happened: the hand edit is gone, back to what the branch committed
    assert.equal(readFileSync(join(trunkPath, 'README.md'), 'utf8'), 'hi\n');
    bothTookTurns(race);
  });
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
// every refusal goes through fail(), which throws rather than exits, but what those paths are
// tested for is the CLI's own contract on a refusal (exit code, a clean stderr line), which only
// the real entrypoint produces — so those are CLI-level tests in refine.test.mjs (same reason as
// teamPath's above).
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

// EVIDENCE_CLASSES (issue 120, off issue 024's own fixed vocabulary) is a hand-kept mirror of
// packages/promises/doc-shape/check.mjs's own CLASSES export — this skill never imports that
// package (CLAUDE.md's self-containment rule: "all behavior must be self-contained in
// skills/horde/"), so the two lists are kept in step by hand, and this is the test that would
// catch them drifting apart. It is also, deliberately, a completely different list from
// DEFAULT_CLASSES above: one names a kind of proof, the other names how heavy a ticket runs.
test('_lib.mjs: EVIDENCE_CLASSES mirrors the promises package\'s CLASSES exactly, and shares no word with DEFAULT_CLASSES', async (t) => {
  const { EVIDENCE_CLASSES, DEFAULT_CLASSES } = await import('../_lib.mjs');
  // tests/ -> scripts/ -> horde/ -> skills/ -> repo root -> packages/promises/doc-shape/check.mjs
  const PACKAGE_CHECK = join(
    dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))),
    'packages', 'promises', 'doc-shape', 'check.mjs',
  );

  await t.test('the same six words, in the same order, as packages/promises/doc-shape/check.mjs\'s own CLASSES', async () => {
    const { CLASSES } = await import(PACKAGE_CHECK);
    assert.deepEqual(EVIDENCE_CLASSES, CLASSES);
  });

  await t.test('none of the six words is a key DEFAULT_CLASSES uses, and none of DEFAULT_CLASSES\' own keys is one of the six', () => {
    for (const word of EVIDENCE_CLASSES) {
      assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_CLASSES, word), false, `DEFAULT_CLASSES should not key on "${word}"`);
    }
    for (const key of Object.keys(DEFAULT_CLASSES)) {
      assert.equal(EVIDENCE_CLASSES.includes(key), false, `EVIDENCE_CLASSES should not carry the cost-class word "${key}"`);
    }
  });
});

// classUp is the fresh, one-class-heavier worker's own class — never a plain default, and never
// something it invents when handed a class it does not recognise.
test('_lib.mjs: classUp walks the ladder one rung, and refuses to invent one', async (t) => {
  const { DEFAULT_CLASSES, classUp } = await import('../_lib.mjs');

  await t.test('one rung up DEFAULT_CLASSES\' own order with no config.classes at all', () => {
    assert.equal(classUp(null, 'light'), 'standard');
    assert.equal(classUp({}, 'standard'), 'heavy');
    assert.equal(classUp({ classes: {} }, 'heavy'), 'max');
  });

  await t.test('one rung up the mission\'s own configured order and names, whatever they are', () => {
    const cfg = { classes: { mini: 1, mid: 3, big: 10 } };
    assert.equal(classUp(cfg, 'mini'), 'mid');
    assert.equal(classUp(cfg, 'mid'), 'big');
  });

  await t.test('already the heaviest rung: comes back unchanged, not wrapped or invented', () => {
    assert.equal(classUp(null, Object.keys(DEFAULT_CLASSES).at(-1)), Object.keys(DEFAULT_CLASSES).at(-1));
    assert.equal(classUp({ classes: { only: 1 } }, 'only'), 'only');
  });

  await t.test('a class not on the ladder at all comes back unchanged — never throws', () => {
    assert.equal(classUp(null, 'made-up'), 'made-up');
    assert.equal(classUp(null, null), null);
    assert.equal(classUp({ classes: { mini: 1 } }, 'heavy'), 'heavy');
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
        id: 'E1', evidence: 'the page renders', node: 'web', reproducedBy: 'scout', evidenceClass: '',
      },
      {
        id: 'E2', evidence: 'the audit event lands', node: 'audit', reproducedBy: '', evidenceClass: '',
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

  // issue 120: a fifth cell names the kind of proof the row rests on — optional, and a row written
  // before the column existed (four cells, exactly the shape above) reads exactly as though the
  // cell were left blank: 'unstated', never a parse error and never refused.
  await t.test('a fifth cell names the kind of proof; a charter with none of that column is unaffected', () => {
    const withClass = [
      '# Mission',
      '',
      '## Acceptance — the evidence catalogue',
      '',
      '| id | evidence | node | reproduced by | evidence class |',
      '|---|---|---|---|---|',
      '| E1 | the checkout completes | web | scout | e2e scenario |',
      '| E2 | the audit event lands | audit | | hermetic test |',
      '| E3 | old row, no fifth cell at all | audit | keeper |',
      '| E4 | fifth cell present but left blank | audit | | |',
    ].join('\n');
    assert.deepEqual(parseEvidenceRows(withClass), [
      {
        id: 'E1', evidence: 'the checkout completes', node: 'web', reproducedBy: 'scout', evidenceClass: 'e2e scenario',
      },
      {
        id: 'E2', evidence: 'the audit event lands', node: 'audit', reproducedBy: '', evidenceClass: 'hermetic test',
      },
      {
        id: 'E3', evidence: 'old row, no fifth cell at all', node: 'audit', reproducedBy: 'keeper', evidenceClass: '',
      },
      {
        id: 'E4', evidence: 'fifth cell present but left blank', node: 'audit', reproducedBy: '', evidenceClass: '',
      },
    ]);
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

// qualityPolicy()'s resolving paths (no charter, no Quality section, or a recognized value) are
// safe to call in-process; its refusal is tested differently — not because fail() would take this
// run with it (it throws, not exits) but because the refusal path is tested for the CLI's own
// contract (exit code, a clean stderr line), which only the real entrypoint produces — same
// reason resolveTree's, teamPath's and the lease claims' refusals above are child-process tests
// rather than direct calls.
test('_lib.mjs qualityPolicy: reads a recognized value or the ruling\'s own default, refuses anything else', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    const mod = await import('../_lib.mjs');
    const horde = 'pilot';
    const charterPath = mod.hordePath(horde, 'charter.md');
    mkdirSync(dirname(charterPath), { recursive: true });

    await t.test('no charter file at all, and a charter with no Quality section, both read as autonomous', () => {
      assert.equal(mod.qualityPolicy(horde), 'autonomous'); // charter.md does not exist yet
      writeFileSync(charterPath, '# Mission · pilot\n\nno quality section in this one\n');
      assert.equal(mod.qualityPolicy(horde), 'autonomous');
    });

    await t.test('a recognized value round-trips', () => {
      writeFileSync(charterPath, '# Mission · pilot\n\n## Quality\n\n**Policy:** only-the-work\n');
      assert.equal(mod.qualityPolicy(horde), 'only-the-work');
    });

    await t.test('a value nothing recognises is refused, naming both valid policies — never silently read as the more permissive default', () => {
      writeFileSync(charterPath, '# Mission · pilot\n\n## Quality\n\n**Policy:** sometimes\n');
      const libPath = fileURLToPath(new URL('../_lib.mjs', import.meta.url));
      const script = join(dir, 'check-quality-policy.mjs');
      writeFileSync(script, [
        `import { qualityPolicy } from ${JSON.stringify(libPath)};`,
        `qualityPolicy(${JSON.stringify(horde)});`,
        '',
      ].join('\n'));
      assert.throws(() => {
        execFileSync('node', [script], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      }, (e) => {
        assert.equal(e.status, 1);
        const stderr = e.stderr.toString();
        assert.match(stderr, /sometimes/);
        assert.match(stderr, /not a setting this horde has/);
        // Names both valid policies — reused from QUALITY_POLICIES, not retyped here.
        for (const p of mod.QUALITY_POLICIES) {
          assert.ok(stderr.includes(p), `refusal should name valid policy "${p}" — got: ${stderr}`);
        }
        return true;
      });
    });
  } finally {
    process.chdir(origCwd);
  }
});
