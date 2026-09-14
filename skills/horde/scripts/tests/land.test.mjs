import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode, addAspect, yg, requireYg, MARKER_CHECK,
  writeEvidenceJudgement, NO_EVIDENCE_LAYER, A_TEST_SUITE,
} from './helpers.mjs';
import { raceOneLock, overlaps, describeRace } from './lock-race/harness.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// A commit made through this helper is signed by the sandbox's own commit-signing service
// (global git config: commit.gpgsign=true, gpg.ssh.program) — nothing to do with the code under
// test. Under heavy concurrent load that service intermittently answers 503, and git surfaces the
// failure as the signing program's own stderr followed by "failed to write commit object" (traced
// and reproduced locally by pointing gpg.ssh.program at a script that fails the same way: the
// phrase is git's own commit-object-writing step talking, the same for `commit`, `merge` and
// `revert` alike, whichever one asked for it). Retry ONLY that one signal, a small bounded number
// of times with a short backoff; anything else — a real conflict, a rejected commit-msg hook, a
// bad ref — throws on the first attempt, exactly as before this fix.
const COMMIT_WRITING_SUBCOMMANDS = new Set(['commit', 'merge', 'revert']);
const TRANSIENT_SIGNING_SIGNAL = /\b50[234]\b|service unavailable|bad gateway|gateway timeout/i;
const SIGNING_RETRY_ATTEMPTS = 3;
const SIGNING_RETRY_BACKOFF_SECONDS = 0.3;

function isTransientSigningFailure(stderr) {
  return /failed to write commit object/i.test(stderr) && TRANSIENT_SIGNING_SIGNAL.test(stderr);
}

function git(args, cwd) {
  if (!COMMIT_WRITING_SUBCOMMANDS.has(args[0])) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  for (let attempt = 1; attempt <= SIGNING_RETRY_ATTEMPTS; attempt += 1) {
    // Attempt 1 always runs the caller's own command. A `merge` or `revert` that failed at the
    // signing step has already updated the index and written git's own prepared commit message —
    // re-issuing the same subcommand fails outright ("already in progress" / "local changes would
    // be overwritten"); the correct way to finish it is a plain `git commit --no-edit`, which
    // reuses that prepared message (verified locally: it reproduces the exact commit `merge` or
    // `revert` would have made). A plain `commit` that failed at signing leaves the index
    // untouched, so re-issuing the exact same command is both correct and simpler — `--no-edit`
    // does NOT recover a `-m` message here (verified locally: it aborts on an empty commit
    // message), so it is only used to finish an already-staged `merge`/`revert`.
    const thisAttempt = (attempt === 1 || args[0] === 'commit') ? args : ['commit', '--no-edit'];
    try {
      return execFileSync('git', thisAttempt, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const transient = isTransientSigningFailure(stderr);
      if (!transient || attempt === SIGNING_RETRY_ATTEMPTS) {
        if (transient) {
          e.message += `\n[git commit-signing] gave up after ${attempt} attempts — stderr names a `
            + '50x/"Service Unavailable" signal alongside "failed to write commit object", which reads as '
            + 'the sandbox\'s signing service struggling under load, not a failure in the code under test.';
        }
        throw e;
      }
      execFileSync('sleep', [String(SIGNING_RETRY_BACKOFF_SECONDS * attempt)]);
    }
  }
  // Unreachable: SIGNING_RETRY_ATTEMPTS >= 1, and every iteration above either returns or throws.
  return undefined;
}

// The nine items, in the order `land` reports them. Asserted by name in the happy path below and
// referred to here so one list says what the gate is — three documents used to describe three
// different gates because no single place did.
const ITEMS = [
  'base freshness', 'judge', 'scope', 'revert test', 'gate', 'graph', 'mapping', 'journal', 'graph text',
];

// The graph rides on the branch. `yg check` reads the tree it is run in, and the gate runs it in a
// fresh tree at the branch's own tip — so a component has to be committed before a ticket branches
// off it, exactly as the architect files one on a real mission.
function commitGraph(dir) {
  git(['checkout', '-q', 'mission1/trunk'], dir);
  git(['add', '.yggdrasil'], dir);
  git(['commit', '-qm', 'graph: the components this mission touches'], dir);
}

function issueDir(dir, team, id) {
  return join(dir, '.horde', 'hordes', 'mission1', 'teams', team, 'issues', `${id}-sample-ticket`);
}

function writeIssue(dir, team, id, {
  node = 'feature', files = null, produces = null, evidence = null, kind = null,
} = {}) {
  const dst = issueDir(dir, team, id);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'issue.md'), [
    `# ${id} · Sample ticket`, '',
    '**Status:** landed',
    `**Node:** ${node} · **Class:** standard · **Severity:** medium · **Team:** ${team}${kind ? ` · **Kind:** ${kind}` : ''}`,
    `**Depends on:** none · **Branch:** mission1/t-${id}`,
    ...(files ? [`**Files:** ${files.join(', ')}`] : []),
    ...(produces ? [`**Consumes:** none · **Produces:** ${produces}`] : []),
    ...(evidence ? [`**Evidence:** ${evidence.join(', ')}`] : []),
    '',
    '## Acceptance — evidence', '', '- [ ] does the thing', '',
  ].join('\n'));
  return dst;
}

// A log entry newer than the branch's last commit — item 8's whole question. It used to be a
// "## Verdict ·" block, because a verifier wrote one as part of reaching this state; nothing
// writes a verdict any more, and the gate accepts no recorded result from anyone, so this is just
// an ordinary log line the way tk.mjs writes them.
function writeTicketLog(dst, { whenIso } = {}) {
  const at = whenIso || new Date().toISOString();
  writeFileSync(join(dst, 'log.md'), `- ${at} status: landed — ready to land\n`);
}

function seedQueueItem(dir, team, id, branch) {
  const queuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', team, 'queue.json');
  const doc = JSON.parse(readFileSync(queuePath, 'utf8'));
  doc.items.push({
    ticket: id, state: 'landed', class: 'standard', branch, dependsOn: [], agent: 'worker1', sha: null, notes: [], worktree: null,
  });
  writeFileSync(queuePath, JSON.stringify(doc, null, 2));
}

// A ticket branch off mission1/trunk that adds an implementation file and a new test file that
// only passes once the implementation exists — the shape checkRevertTest needs to see a real
// failure when the test is extracted onto the parent tree alone.
function makeTicketBranch(dir, id, { fromRef = 'mission1/trunk', extraFiles = {} } = {}) {
  git(['checkout', fromRef], dir);
  git(['checkout', '-b', `mission1/t-${id}`], dir);
  writeFileSync(join(dir, `feature-${id}.mjs`), 'export function add(a, b) { return a + b; }\n');
  writeFileSync(join(dir, `feature-${id}.test.mjs`), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { add } from './feature-${id}.mjs';`,
    "test('add', () => { assert.equal(add(1, 2), 3); });",
    '',
  ].join('\n'));
  const paths = [`feature-${id}.mjs`, `feature-${id}.test.mjs`];
  for (const [path, content] of Object.entries(extraFiles)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    paths.push(path);
  }
  // Add only this ticket's own files — the working tree also holds the untracked graph the
  // fixture wrote (outside any branch), which `git add -A` would sweep into the commit and make
  // the diff look like it left the ticket's node boundary.
  git(['add', '--', ...paths], dir);
  git(['commit', '-qm', `ticket ${id}`], dir);
  git(['checkout', 'mission1/trunk'], dir);
  return `mission1/t-${id}`;
}

// The whole of what a landable ticket needs: a graph with a script rule the tree satisfies, a
// green repository gate, a judge policy, a branch that really changes something and carries a new
// test, and a queue item naming it.
function setupLandable(dir, id, {
  marker = false, prose = false, reviewer = false, judge = 'one-shot', files = null, extraFiles = {}, mapping = null,
  evidence = null, kind = null, cutPrototypeBranch = false, fromRef = 'mission1/trunk',
} = {}) {
  initHorde(dir);
  if (reviewer) assert.equal(yg(dir, ['init', '--provider', 'claude-code', '--model', 'sonnet']).code, 0);
  if (prose) {
    addAspect(dir, 'reads-well', {
      description: 'Every exported name reads as a sentence a stranger understands.',
      content: '# Reads well\n\nAn exported name must read as something a stranger understands.\n',
    });
  }
  addAspect(dir, 'no-marker', {
    description: 'Source files must not carry an unfinished-work marker.',
    check: MARKER_CHECK,
  });
  addNode(dir, 'feature', {
    mapping: mapping || [`feature-${id}.mjs`, `feature-${id}.test.mjs`, ...Object.keys(extraFiles)],
    aspects: prose ? ['no-marker', 'reads-well'] : ['no-marker'],
  });
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  run('horde.mjs', ['config', 'set', 'judge', judge], dir);
  commitGraph(dir);
  if (cutPrototypeBranch) git(['branch', 'mission1/prototype', 'mission1/trunk'], dir);

  const branch = makeTicketBranch(dir, id, {
    fromRef,
    extraFiles: marker
      ? { [`feature-${id}.mjs`]: 'export function add(a, b) { return a + b; } // UNFINISHED\n', ...extraFiles }
      : extraFiles,
  });
  const dst = writeIssue(dir, 'trunk', id, { ...(files ? { files } : {}), ...(evidence ? { evidence } : {}), ...(kind ? { kind } : {}) });
  writeTicketLog(dst);
  seedQueueItem(dir, 'trunk', id, branch);
  return { branch, issueDir: dst };
}

function byName(result) {
  return Object.fromEntries((result.json ? result.json.checks : []).map((c) => [c.name, c]));
}

function scratchDirs(dir) {
  const root = join(dir, '.horde', 'scratch');
  if (!existsSync(root)) return [];
  return readdirSync(root);
}

// ---- the happy path -------------------------------------------------------------------

test('land.mjs: nine items green, and the gate merges the branch itself', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '001');
  const trunkBefore = git(['rev-parse', 'mission1/trunk'], dir);
  const tip = git(['rev-parse', branch], dir);

  const r = run('land.mjs', [branch], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);

  // The nine, by name, in this order — the one place that says what the gate is.
  const names = r.json.checks.map((c) => c.name);
  assert.deepEqual(names.slice(0, 9), ITEMS);
  for (const c of r.json.checks) assert.equal(c.ok, true, `${c.name}: ${c.note}`);

  // A real revert test ran (this whole run happens inside our own `node --test`, so a false pass
  // via NODE_TEST_CONTEXT leaking into the nested run would show up as "no new test files").
  const revert = r.json.checks.find((c) => c.name === 'revert test');
  assert.doesNotMatch(revert.note, /no new test files/);
  assert.match(revert.note, /feature-001\.test\.mjs: 1 fail/);

  // It landed: a --no-ff merge commit on trunk, with both parents.
  const trunkAfter = git(['rev-parse', 'mission1/trunk'], dir);
  assert.notEqual(trunkAfter, trunkBefore);
  assert.equal(r.json.landed.sha, trunkAfter);
  assert.equal(git(['rev-list', '--count', '--merges', `${trunkBefore}..mission1/trunk`], dir), '1');
  assert.deepEqual(git(['rev-list', '--parents', '-n', '1', trunkAfter], dir).split(' ').slice(1), [trunkBefore, tip]);

  // The branch and its worktree are gone, and the sha is written in both places that remember it.
  assert.equal(git(['branch', '--list', branch], dir), '');
  const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === '001');
  assert.equal(item.state, 'merged');
  assert.equal(item.sha, trunkAfter);
  assert.match(readFileSync(join(issueDir(dir, 'trunk', '001'), 'log.md'), 'utf8'), new RegExp(`landed 001 on mission1/trunk as ${trunkAfter}`));

  // And the wave journal carries the merge, the way a recorded merge always has.
  assert.match(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8'), /001/);

  // Nothing this run made is left behind.
  assert.deepEqual(scratchDirs(dir), []);
});

test('land.mjs: --no-gate reports the cheap items and never merges', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '002');
  const before = git(['rev-parse', 'mission1/trunk'], dir);

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 0, r.stderr);
  const items = byName(r);
  assert.deepEqual(r.json.checks.map((c) => c.name), ITEMS);
  for (const name of ['judge', 'gate', 'graph', 'mapping']) {
    assert.match(items[name].note, /skipped \(--no-gate\)/, `${name}: ${items[name].note}`);
  }
  assert.equal(r.json.landed, null);
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), before, 'trunk is untouched');
  assert.notEqual(git(['branch', '--list', branch], dir), '', 'the branch is still there');
});

// ---- the prototype ---------------------------------------------------------------------
//
// A prototype is built to be looked at and answered, never kept. Nothing verified it — that is
// what it is for — so the trunk, the line every later ticket is cut from, is the one place it may
// not reach. It is cut from the mission's prototype branch and merges back there, and nothing
// merges that onward.

test('land.mjs: a prototype rooted on the trunk is refused outright, and the trunk does not move', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '070', { kind: 'prototype' });
  const before = git(['rev-parse', 'mission1/trunk'], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is a prototype/);
  assert.match(r.stderr, /mission1\/prototype/);
  assert.match(r.stderr, /never merges into mission1\/trunk/);
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), before, 'the trunk is untouched');
  assert.notEqual(git(['branch', '--list', branch], dir), '', 'and the branch is still there');
});

test('land.mjs: a prototype cut from the prototype branch lands there, and only there', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '071', {
    kind: 'prototype', cutPrototypeBranch: true, fromRef: 'mission1/prototype',
  });
  const trunkBefore = git(['rev-parse', 'mission1/trunk'], dir);
  const protoBefore = git(['rev-parse', 'mission1/prototype'], dir);
  const tip = git(['rev-parse', branch], dir);

  const r = run('land.mjs', [branch], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);

  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), trunkBefore, 'the trunk never sees it');
  const protoAfter = git(['rev-parse', 'mission1/prototype'], dir);
  assert.notEqual(protoAfter, protoBefore);
  assert.equal(r.json.landed.sha, protoAfter);
  assert.deepEqual(git(['rev-list', '--parents', '-n', '1', protoAfter], dir).split(' ').slice(1), [protoBefore, tip]);
});

// ---- the judge ------------------------------------------------------------------------

test('land.mjs: config.judge one-shot hands back the pending pairs and the commands that judge them', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '003', { prose: true, reviewer: true, judge: 'one-shot' });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  const items = byName(r);
  assert.equal(items.judge.ok, false, items.judge.note);
  assert.match(items.judge.note, /one-shot/);
  assert.ok(r.json.pairs.length > 0, 'the pairs a judge still owes a verdict on');
  for (const pair of r.json.pairs) {
    assert.equal(pair.aspect, 'reads-well');
    assert.match(pair.commands.package, /verdict package --aspect reads-well/);
    assert.match(pair.commands.record, /verdict record --aspect reads-well/);
  }
  assert.match(r.json.brief, /cannot land until every prose rule below carries a judgement/);
  assert.match(r.json.brief, /verdict package --aspect reads-well/);
  assert.equal(r.json.landed, null);
});

test('land.mjs: config.judge tier says the reviewer left them unjudged, and goes green once they are', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '004', { prose: true, reviewer: true, judge: 'tier' });

  const red = run('land.mjs', [branch], dir);
  assert.equal(red.code, 1);
  assert.match(byName(red).judge.note, /config.judge is "tier".*came back unjudged/s);

  // The judge answers, through Yggdrasil's own external-judge channel, in a tree at the branch tip.
  // Attached to the branch, not detached: the judgement has to end up ON the branch, and a commit
  // in a detached tree moves nothing.
  const wt = join(dir, 'judge-tree');
  git(['worktree', 'add', wt, branch], dir);
  for (const pair of red.json.pairs) {
    const pkg = yg(wt, ['verdict', 'package', '--aspect', pair.aspect, `--${pair.unitKind}`, pair.unit]);
    assert.equal(pkg.code, 0, pkg.out);
    const hash = JSON.parse(pkg.out).hashes.pass;
    const rec = yg(wt, ['verdict', 'record', '--aspect', pair.aspect, `--${pair.unitKind}`, pair.unit, '--by', 'judge1', '--verdict', 'pass', '--hash', hash]);
    assert.equal(rec.code, 0, rec.out);
  }
  // The verdicts have to be COMMITTED to count. The gate reads a fresh tree at the branch's tip,
  // not whatever worktree someone happens to have open, so a judgement sitting uncommitted in
  // somebody's checkout is a judgement this branch does not carry — which is the whole reason the
  // gate stopped reading other people's trees.
  git(['add', '.yggdrasil'], wt);
  git(['commit', '-qm', 'graph: verdicts recorded'], wt);
  git(['worktree', 'remove', '--force', wt], dir);
  run('tk.mjs', ['log', '004', 'verdicts recorded on the branch'], dir);

  const green = run('land.mjs', [branch], dir);
  if (green.code !== 0) console.error(green.stdout, green.stderr);
  assert.equal(green.code, 0);
  assert.equal(byName(green).judge.ok, true);
  assert.deepEqual(green.json.pairs, []);
  assert.ok(green.json.landed, 'it landed');
});

test('land.mjs: config.judge unset refuses rather than guessing who judges', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '005');
  // Unset it the way a config written before the policy existed would read.
  const cfgPath = join(dir, '.horde', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  delete cfg.judge;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  const judge = byName(r).judge;
  assert.equal(judge.ok, false);
  assert.match(judge.note, /config.judge is unset/);
  assert.match(judge.note, /config set judge tier\|one-shot/);
  assert.equal(r.json.landed, null);
});

test('horde.mjs init works out the judge policy and says so', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', '--yg', requireYg()], dir, { json: false });
  assert.equal(r.code, 0, r.stderr);
  // A fresh `yg init` with no --provider leaves no reviewer, so there is no tier to judge with.
  assert.match(r.stdout, /judge: one-shot/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.horde', 'config.json'), 'utf8')).judge, 'one-shot');
});

test('horde.mjs init refuses a commit hook that needs a judge this repository has not got', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  assert.equal(yg(dir, ['init']).code, 0);
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nyg check\n');

  const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', '--yg', requireYg()], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /runs a full `yg check` on every commit, and this repository has no Yggdrasil reviewer/);
  assert.match(r.stderr, /--only-deterministic/);
  assert.match(r.stderr, /yg init --provider/);
  assert.doesNotMatch(r.stderr, /--no-verify is fine|use --no-verify/);
  assert.equal(existsSync(join(dir, '.horde', 'hordes')), false, 'nothing of the horde was created');
});

// ---- the items, one refusal each -------------------------------------------------------

test('land.mjs: base freshness fails — the branch is not rooted at the current parent tip', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '006');
  writeFileSync(join(dir, 'trunk-only.txt'), 'advance\n');
  git(['add', 'trunk-only.txt'], dir);
  git(['commit', '-qm', 'advance trunk'], dir);

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  const item = byName(r)['base freshness'];
  assert.equal(item.ok, false);
  assert.match(item.note, /STALE/);
});

test('land.mjs: scope fails — the diff touches a file outside the node boundary', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // Boundary deliberately excludes the extra file the branch also adds.
  const { branch } = setupLandable(dir, '007', {
    mapping: ['feature-007.mjs', 'feature-007.test.mjs'],
    extraFiles: { 'outside-file.txt': 'not in the node\n' },
  });

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const item = byName(r).scope;
  assert.equal(item.ok, false);
  assert.match(item.note, /outside boundary/);
});

test('land.mjs: a diff outside the files the ticket declared is refused, and declaring them passes', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '008', { files: ['feature-008.mjs'] });

  const refused = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(refused.code, 1);
  assert.match(byName(refused).scope.note, /declared 1 files, touched feature-008\.test\.mjs outside them/);
  assert.match(byName(refused).scope.note, /tk\.mjs edit --files, never in silence/);

  writeIssue(dir, 'trunk', '008', { files: ['feature-008.mjs', 'feature-008.test.mjs'] });
  writeTicketLog(issueDir(dir, 'trunk', '008'));
  const ok = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(byName(ok).scope.ok, true);
});

test('land.mjs: the revert test refuses when this repository\'s test convention is unknown', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '009');
  run('horde.mjs', ['config', 'set', 'testGlobs', ''], dir);

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, false);
  assert.match(item.note, /config.testGlobs is unset/);
  assert.match(item.note, /"not looked", not "none"/);
});

test('land.mjs: the revert test refuses a diff that carries no new or changed test and declares no exemption', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '010');
  // Drop the new test file from the branch so the diff carries only the implementation.
  git(['checkout', branch], dir);
  git(['rm', '-q', 'feature-010.test.mjs'], dir);
  git(['commit', '-qm', 'no test after all'], dir);
  git(['checkout', 'mission1/trunk'], dir);

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, false, item.note);
  assert.match(item.note, /no new or changed test files in diff \(looked for/);
  assert.match(item.note, /\*\*No new tests:\*\* <reason>/);
});

// Rewrites an already-written issue.md to add a header ahead of the acceptance section — the same
// insertion point addMutateField uses below, generalised to any "**Field:** value" line.
function addField(dst, line) {
  const path = join(dst, 'issue.md');
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace('## Acceptance', `${line}\n\n## Acceptance`));
}

test('land.mjs: a declared "**No new tests:**" reason passes the revert test when the diff adds or changes none', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, issueDir: dst } = setupLandable(dir, '074');
  git(['checkout', branch], dir);
  git(['rm', '-q', 'feature-074.test.mjs'], dir);
  git(['commit', '-qm', 'no test after all'], dir);
  git(['checkout', 'mission1/trunk'], dir);
  addField(dst, '**No new tests:** pure rename, behaviour covered by existing evidence rows');

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, true, item.note);
  assert.match(item.note, /declared no-new-tests: pure rename/);
});

test('land.mjs: a declared "**No new tests:**" header with no reason after it still refuses', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, issueDir: dst } = setupLandable(dir, '075');
  git(['checkout', branch], dir);
  git(['rm', '-q', 'feature-075.test.mjs'], dir);
  git(['commit', '-qm', 'no test after all'], dir);
  git(['checkout', 'mission1/trunk'], dir);
  addField(dst, '**No new tests:**');

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, false, item.note);
  assert.match(item.note, /no new or changed test files in diff/);
});

// A test file that already existed on the parent branch, modified (not added) on the ticket
// branch — the case the revert point used to wave through as "no new test files".
function makeModifiedTestFixture(dir, id) {
  git(['checkout', 'develop'], dir);
  writeFileSync(join(dir, `feature-${id}.mjs`), 'export function add(a, b) { return a + b; }\n');
  writeFileSync(join(dir, `feature-${id}.test.mjs`), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { add } from './feature-${id}.mjs';`,
    "test('add', () => { assert.equal(add(1, 2), 3); });",
    '',
  ].join('\n'));
  git(['add', `feature-${id}.mjs`, `feature-${id}.test.mjs`], dir);
  git(['commit', '-qm', 'existing feature and test'], dir);
  initHorde(dir); // mission1/trunk branches off this develop tip — inherits both files
  run('horde.mjs', ['config', 'set', 'judge', 'one-shot'], dir);
  addAspect(dir, 'no-marker', {
    description: 'Source files must not carry an unfinished-work marker.',
    check: MARKER_CHECK,
  });
  addNode(dir, 'feature', { mapping: [`feature-${id}.mjs`, `feature-${id}.test.mjs`], aspects: ['no-marker'] });
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  commitGraph(dir);

  git(['checkout', '-b', `mission1/t-${id}`], dir);
  writeFileSync(join(dir, `feature-${id}.mjs`), 'export function add(a, b, c = 0) { return a + b + c; }\n');
  writeFileSync(join(dir, `feature-${id}.test.mjs`), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { add } from './feature-${id}.mjs';`,
    "test('add', () => { assert.equal(add(1, 2), 3); });",
    "test('add three', () => { assert.equal(add(1, 2, 3), 6); });",
    '',
  ].join('\n'));
  git(['add', `feature-${id}.mjs`, `feature-${id}.test.mjs`], dir);
  git(['commit', '-qm', `ticket ${id}`], dir);
  git(['checkout', 'mission1/trunk'], dir);
  return `mission1/t-${id}`;
}

test('land.mjs: a modified existing test file is checked for red the same as a new one', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const branch = makeModifiedTestFixture(dir, '076');
  const dst = writeIssue(dir, 'trunk', '076', {});
  writeTicketLog(dst);
  seedQueueItem(dir, 'trunk', '076', branch);

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, true, item.note);
  assert.match(item.note, /feature-076\.test\.mjs: 1 fail/);
});

// A contract test that pins a surface already true on the parent branch by design — green there
// on purpose — with its intended failing base reachable only via a named ref, not the parent's tip.
function makeContractRevertFixture(dir, id) {
  git(['checkout', 'develop'], dir);
  writeFileSync(join(dir, `surface-${id}.mjs`), 'export function getValue() { return 0; }\n');
  git(['add', `surface-${id}.mjs`], dir);
  git(['commit', '-qm', 'old surface'], dir);
  initHorde(dir); // mission1/trunk branches off this develop tip — inherits getValue() === 0
  run('horde.mjs', ['config', 'set', 'judge', 'one-shot'], dir);
  addNode(dir, 'feature', { mapping: [`surface-${id}.mjs`, `surface-${id}.test.mjs`] });
  commitGraph(dir);

  git(['checkout', 'mission1/trunk'], dir);
  writeFileSync(join(dir, `surface-${id}.mjs`), 'export function getValue() { return 42; }\n');
  git(['add', `surface-${id}.mjs`], dir);
  git(['commit', '-qm', 'surface now pinned at 42'], dir);

  git(['checkout', '-b', `mission1/t-${id}`], dir);
  writeFileSync(join(dir, `surface-${id}.test.mjs`), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { getValue } from './surface-${id}.mjs';`,
    "test('pinned', () => { assert.equal(getValue(), 42); });",
    '',
  ].join('\n'));
  git(['add', `surface-${id}.test.mjs`], dir);
  git(['commit', '-qm', `ticket ${id}`], dir);
  git(['checkout', 'mission1/trunk'], dir);
  return `mission1/t-${id}`;
}

test('land.mjs: the revert test uses the ticket\'s "**Revert base:**" header instead of the parent tip', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const branch = makeContractRevertFixture(dir, '011');
  const dst = issueDir(dir, 'trunk', '011');
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'issue.md'), [
    '# 011 · Sample ticket', '',
    '**Status:** landed',
    '**Node:** feature · **Class:** standard · **Severity:** medium · **Team:** trunk',
    '**Depends on:** none · **Branch:** mission1/t-011',
    '**Revert base:** develop', '',
    '## Acceptance — evidence', '', '- [ ] pins the surface', '',
  ].join('\n'));
  writeTicketLog(dst);
  seedQueueItem(dir, 'trunk', '011', branch);

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, true, item.note);
  assert.match(item.note, /base develop/);
  assert.match(item.note, /1 fail/);
});

// Rewrites an already-written issue.md to add a "**Mutate:**" header, the way `tk.mjs new
// --mutate` would have rendered it — inserted ahead of the acceptance section, since neither
// mutateCommand nor revertBaseRef in land.mjs care about a header's position in the file.
function addMutateField(dst, command) {
  const path = join(dst, 'issue.md');
  const text = readFileSync(path, 'utf8');
  assert.doesNotMatch(text, /\*\*Mutate:\*\*/, 'fixture already carries a Mutate header');
  writeFileSync(path, text.replace('## Acceptance', `**Mutate:** ${command}\n\n## Acceptance`));
}

test('land.mjs: a ticket\'s "**Mutate:**" command runs against the branch\'s own tip and the new tests must go red on it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, issueDir: dst } = setupLandable(dir, '070');
  // feature-070.mjs exports add(a, b) { return a + b; } — corrupt it to a subtraction so the new
  // test (`assert.equal(add(1, 2), 3)`) goes red once the command has run.
  addMutateField(dst, "node -e \"const fs=require('fs');const p='feature-070.mjs';fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace('a + b','a - b'))\"");

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, true, item.note);
  assert.match(item.note, /^mutate `node -e/);
  assert.match(item.note, /feature-070\.test\.mjs: 1 fail/);

  // Nothing this run made is left behind, and the branch's own committed tree (measured by every
  // later item) was never touched by the mutation — it ran only in a scratch copy.
  assert.deepEqual(scratchDirs(dir), []);
  assert.match(git(['show', `${branch}:feature-070.mjs`], dir), /a \+ b/);
});

test('land.mjs: a "**Mutate:**" command that fails to run is reported by name, not read as a pass', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, issueDir: dst } = setupLandable(dir, '071');
  addMutateField(dst, 'exit 7');

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, false);
  assert.match(item.note, /mutate command failed to run: exit 7/);
});

test('land.mjs: a ticket without "**Mutate:**" and without "**Revert base:**" keeps the default revert-to-base variant', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '072');

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, true, item.note);
  assert.doesNotMatch(item.note, /mutate/);
  assert.match(item.note, /feature-072\.test\.mjs: 1 fail/);
});

test('land.mjs: a ticket naming both "**Mutate:**" and "**Revert base:**" is refused — only one variant ever runs', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, issueDir: dst } = setupLandable(dir, '073');
  const path = join(dst, 'issue.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('## Acceptance', '**Revert base:** develop\n**Mutate:** true\n\n## Acceptance'));

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, false);
  assert.match(item.note, /names both --mutate and a revert base \(develop\)/);
});

test('land.mjs: the journal item fails when no log entry is newer than the last commit', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, issueDir: dst } = setupLandable(dir, '012');
  writeTicketLog(dst, { whenIso: '2000-01-01T00:00:00.000Z' });

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  assert.match(byName(r).journal.note, /predates last commit/);
});

test('land.mjs: the graph text item refuses mission language in a charter the branch touches', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '013', {
    extraFiles: { '.yggdrasil/model/feature/charter.md': '# Feature\n\nThis wave adds the discount.\n' },
  });

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  assert.match(byName(r)['graph text'].note, /mission language in graph text/);
  assert.match(byName(r)['graph text'].note, /wave/);
});

test('land.mjs: the mapping item refuses a file the graph owns nowhere', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '014', {
    mapping: ['feature-014.mjs', 'feature-014.test.mjs'],
    files: ['feature-014.mjs', 'feature-014.test.mjs', 'stray.mjs'],
    extraFiles: { 'stray.mjs': 'export const stray = 1;\n' },
  });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  const item = byName(r).mapping;
  assert.equal(item.ok, false, item.note);
  assert.match(item.note, /stray\.mjs/);
  assert.match(item.note, /a mapping and its first file land together/);
});

// ---- the repository's own gate ----------------------------------------------------------

test('land.mjs: an unconfigured repository gate names the command that sets it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '015');
  run('horde.mjs', ['config', 'set', 'gates.team', ''], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  const item = byName(r).gate;
  assert.equal(item.ok, false);
  assert.match(item.note, /no config.gates.team configured/);
  assert.match(item.note, /horde\.mjs config set gates\.team/);
});

test('land.mjs: a repository gate that hangs is stopped and the limit is named, not the process', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '016');
  run('horde.mjs', ['config', 'set', 'gates.team', 'sleep 30'], dir);
  run('horde.mjs', ['config', 'set', 'gateTimeoutMs', '1500'], dir);

  const started = Date.now();
  const r = run('land.mjs', [branch], dir);
  const elapsed = Date.now() - started;
  assert.equal(r.code, 1);
  const item = byName(r).gate;
  assert.equal(item.ok, false);
  assert.match(item.note, /did not finish within 2s and was stopped/);
  assert.match(item.note, /gateTimeoutMs/);
  assert.ok(elapsed < 25000, `the gate was not waited on to the end (${elapsed}ms)`);
  assert.equal(r.json.landed, null);
});

test('land.mjs: --level trunk selects the trunk gate; --level team is not a value any more', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '017');
  run('horde.mjs', ['config', 'set', 'gates.trunk', 'true'], dir);

  const refused = run('land.mjs', [branch, '--level', 'team'], dir);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--level team no longer exists/);

  const r = run('land.mjs', [branch, '--level', 'trunk'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.level, 'trunk');
  assert.match(byName(r).gate.note, /green \(true\)/);
});

// A landing writes its own measurement to cache/last-gate.json (at the sha the merge actually
// produced, not the pre-merge ticket-branch tip — a `--no-ff` merge commit is never that sha), so
// `horde.mjs done` and `wave.mjs close`, run right after, read what this landing just measured
// instead of finding nothing recorded. The gate command counts its own calls to a file outside any
// worktree the landing cleans up, so "did `done` trust the cache" is a fact about how many times
// the command ran, not an inference from timing.
test('land.mjs: a green landing at --level trunk records the gate cache, so `done` accepts it without re-running the gate and `wave.mjs close` reports it recorded', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '020');
  const gateLog = join(dir, 'gate-calls.log');
  run('horde.mjs', ['config', 'set', 'gates.trunk', `echo run >> "${gateLog}"`], dir);
  assert.equal(run('wave.mjs', ['start'], dir).code, 0);

  const r = run('land.mjs', [branch, '--level', 'trunk'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(byName(r).gate.ok, true, byName(r).gate.note);
  const trunkSha = git(['rev-parse', 'mission1/trunk'], dir);
  assert.equal(r.json.landed.sha, trunkSha);

  const callCount = () => readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(callCount(), 1, 'the gate command ran exactly once, during the landing itself');

  const cachePath = join(dir, '.horde', 'hordes', 'mission1', 'cache', 'last-gate.json');
  const cacheAfterLand = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(cacheAfterLand.trunk.sha, trunkSha, 'recorded at the sha the merge produced, not the pre-merge ticket branch tip');
  assert.equal(cacheAfterLand.trunk.result, 'green');
  assert.match(cacheAfterLand.trunk.by, /^land /);

  // `done` is not otherwise satisfied here (no evidence, no retrospective on file), so this run
  // still refuses with exactly those two reasons — but its own trunk-gate check runs before any of
  // that, unconditionally, and what matters is only what it did about the gate: found a matching
  // cached green and accepted it, rather than re-running the whole command a second time over the
  // tree land.mjs just measured. A third reason (any of the three phrasings `done` itself uses for
  // "the gate was not accepted") would mean it was not accepted after all.
  const done = run('horde.mjs', ['done'], dir);
  assert.equal(done.code, 1);
  assert.match(done.stderr, /is not done — 2 reason\(s\):/, `a 3rd reason would mean the gate was not accepted from cache: ${done.stderr}`);
  assert.doesNotMatch(done.stderr, /trunk gate red|no config\.gates\.trunk configured|no such branch: mission1\/trunk/);
  assert.equal(callCount(), 1, 'still exactly one gate run after `done` — it trusted the cache instead of measuring again');
  assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')).trunk, cacheAfterLand.trunk, '`done` left the cache exactly as the landing wrote it, rather than overwriting it with a fresh run of its own');

  // `wave.mjs close`, run with none of its own --gate/--sha, reads that same recorded entry rather
  // than reporting the gate as unrecorded right after a landing that was green.
  const close = run('wave.mjs', ['close'], dir);
  assert.equal(close.code, 0, close.stderr);
  assert.equal(close.json.gate, 'green');
});

// ---- the graph item -----------------------------------------------------------------------

test('land.mjs: the graph item is red when the graph refuses the tree, even with a green repository gate', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '018', { marker: true });
  const before = git(['rev-parse', 'mission1/trunk'], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  assert.equal(byName(r).gate.ok, true, 'the repository\'s own gate is green');
  assert.equal(byName(r).graph.ok, false);
  assert.match(byName(r).graph.note, /the graph refuses this tree|unfinished-work/);
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), before, 'and nothing landed');
});

test('land.mjs: the Yggdrasil CLI missing is a refusal naming config.ygCommand, never a quiet pass', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '019', { files: ['feature-019.mjs', 'feature-019.test.mjs'] });
  run('horde.mjs', ['config', 'set', 'ygCommand', 'no-such-yg'], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /config\.ygCommand|no-such-yg/);
});

test('land.mjs: a Yggdrasil CLI answering an unknown document names the release to install', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // Declared files, so the scope item never asks the graph and the stub is first met by the guard.
  const { branch } = setupLandable(dir, '020', { files: ['feature-020.mjs', 'feature-020.test.mjs'] });
  const stub = join(dir, 'yg-stub.mjs');
  writeFileSync(stub, [
    'const args = process.argv.slice(2);',
    "if (args.includes('--version')) { console.log('4.0.0'); process.exit(0); }",
    'console.log(JSON.stringify({ schema: "yg-aspects/2", aspects: [] }));',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stub}`], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  const said = r.stdout + r.stderr;
  assert.match(said, /did not answer with the .* document/);
  assert.match(said, /@chrisdudek\/yg|newer build/);
  assert.equal(r.json, null, 'a refusal, not a green law guard');
});

// ---- broken states and races ------------------------------------------------------------

// A land.mjs run reaching the gate is a fact these races can read off disk — the gate lock file
// names the pid holding it — rather than a guess about how long everything before the gate
// (worktree setup, the cheap pre-gate checks, the law and conflict guards) takes on this machine
// under this load. Every race below that needs a land.mjs child to have gotten there and be
// mid-gate waits on this instead of a fixed sleep: guessed too low under load and whatever the
// test does next (spawn a second landing, mutate the tree the first is measuring) lands before
// the child ever reaches the point the test meant to catch it at — sometimes racing straight past
// it and landing cleanly, sometimes tripping a different, earlier check instead — either way not
// the collision or conflict the test exists to prove.
async function waitGateLockHeldBy(dir, pid, timeoutMs = 30000) {
  const lockFile = join(dir, '.horde', 'gate.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(lockFile)) {
      try {
        if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === pid) return;
      } catch { /* the write is still in flight; keep polling instead of calling it absent */ }
    }
    if (Date.now() >= deadline) throw new Error(`${lockFile} never showed pid ${pid} holding it`);
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

test('land.mjs: the gate lock serializes two landings on one repository', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '021');
  // A gate slow enough that the second run is certain to meet the lock held, and a wait short
  // enough that it gives up inside this test rather than queueing behind it.
  run('horde.mjs', ['config', 'set', 'gates.team', 'sleep 6'], dir);
  run('horde.mjs', ['config', 'set', 'gateLockWaitMs', '1000'], dir);

  function spawnLand() {
    const child = spawn('node', [join(SCRIPTS_DIR, 'land.mjs'), branch, '--json'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = new Promise((resolve) => { child.on('close', (code) => resolve({ code, out, err })); });
    return { pid: child.pid, done };
  }

  // The second run only proves anything if it meets the lock actually held — starting it after a
  // fixed wait was a guess about how long the first spawnLand takes to reach the lock on this
  // machine, and guessing low under load let the second start before the first ever got there,
  // leaving both free to land in turn with no collision for either to report. Wait for the fact
  // instead: the lock file naming the first run's own pid.
  const first = spawnLand();
  await waitGateLockHeldBy(dir, first.pid);
  const second = spawnLand();

  const both = await Promise.all([first.done, second.done]);
  const refused = both.filter((x) => /holds the gate lock/.test(x.out + x.err));
  assert.equal(refused.length, 1, `exactly one run met the lock:\n${both[0].out}${both[0].err}\n---\n${both[1].out}${both[1].err}`);
  assert.match(refused[0].out + refused[0].err, /Landings on one repository run one at a time/);
  assert.match(refused[0].out + refused[0].err, /pid \d+/);
});

test('land.mjs: a lock left by a dead process is taken over with a note, not waited on', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '022');
  // A pid nothing on this machine is using. The lock must not be waited on for its full timeout.
  const lock = join(dir, '.horde', 'gate.lock');
  writeFileSync(lock, JSON.stringify({
    pid: 0x7ffffffe, ticket: '999', branch: 'mission1/t-999', at: '2020-01-01T00:00:00.000Z',
  }, null, 2));

  const started = Date.now();
  const r = run('land.mjs', [branch], dir);
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(elapsed < 60000, `it did not wait out the lock timeout (${elapsed}ms)`);
  assert.ok(r.json.lock.some((n) => /took over the gate lock left by pid 2147483646/.test(n)), JSON.stringify(r.json.lock));
  assert.equal(existsSync(lock), false, 'and released it on the way out');
});

test('land.mjs: a half-written lock file names no process to wait on, so it is taken over too', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '023');
  writeFileSync(join(dir, '.horde', 'gate.lock'), '{"pid": 12');

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.lock.some((n) => /unreadable gate lock/.test(n)), JSON.stringify(r.json.lock));
});

test('land.mjs: a gate lock caught half-made is waited for, never taken for an abandoned one', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  // The one above is a lock file nobody is behind — taken over, correctly. This is the other
  // case: a lock file whose holder is alive and still writing it. Two real processes take the
  // shipped gate lock, one paused mid-creation and the other held at the door until that pause
  // begins, which puts the second process inside the window every run instead of once in
  // thousands. What comes back is the window each one held the gate for, and a lock that holds
  // keeps those apart.
  const race = await raceOneLock(dir, 'gate');
  assert.ok(race.paused, `nothing was ever paused, so this run proves nothing:\n${describeRace(race)}`);
  assert.equal(race.slow.code, 0, describeRace(race));
  assert.equal(race.other.code, 0, describeRace(race));

  const paused = race.slow.window;
  const other = race.other.window;
  assert.ok(paused && paused.ok && other && other.ok, describeRace(race));
  assert.notEqual(paused.pid, other.pid, 'two processes, not one');
  assert.equal(overlaps(paused, other), false,
    'both landings held the gate at the same time: the one paused mid-creation had its lock file '
    + `read as an abandoned one and taken.\n${describeRace(race)}`);
});

test('land.mjs: --background returns a result-file path at once, and the file has the run\'s shape', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '024');
  run('horde.mjs', ['config', 'set', 'gates.team', 'sleep 3'], dir);

  const started = Date.now();
  const r = run('land.mjs', [branch, '--background'], dir);
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(elapsed < 3000, `it did not wait for the gate (${elapsed}ms)`);
  assert.equal(r.json.ticket, '024');
  assert.match(r.json.resultFile, /\.horde\/hordes\/mission1\/land\/024\.json$/);
  assert.equal(existsSync(r.json.resultFile), false, 'nothing is written yet');

  const deadline = Date.now() + 90000;
  let doc = null;
  while (Date.now() < deadline) {
    try { doc = JSON.parse(readFileSync(r.json.resultFile, 'utf8')); break; } catch { /* not yet, or half-written */ }
    execFileSync('sleep', ['0.25']);
  }
  assert.ok(doc, 'the background run wrote its result');
  assert.equal(doc.ticket, '024');
  assert.equal(doc.branch, branch);
  assert.match(doc.sha, /^[0-9a-f]{40}$/);
  assert.equal(typeof doc.ok, 'boolean');
  assert.ok(typeof doc.at === 'string' && doc.at.length > 0);
  assert.deepEqual(doc.checks.map((c) => c.name).slice(0, 9), ITEMS);
  for (const c of doc.checks) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.ok, 'boolean');
    assert.equal(typeof c.note, 'string');
  }
});

test('land.mjs readLandResult: a truncated result file reads as no file at all', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '025');
  const resultFile = join(dir, '.horde', 'hordes', 'mission1', 'land', '025.json');

  // Half a document, exactly what a run killed mid-write leaves behind.
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, '{"ticket": "025", "checks": [{"name": "base fre');

  const { readLandResult } = await import('../land.mjs');
  const before = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(readLandResult('mission1', '025'), null, 'unparsable reads as absent');
  } finally {
    process.chdir(before);
  }

  // And the gate itself is unbothered: it never trusts a recorded result, its own or anyone's.
  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.landed);
});

test('land.mjs: every scratch tree is gone on every way out', async (t) => {
  // A repository each: two hordes of one name cannot exist side by side, and the point here is
  // what is left on disk afterwards, which a shared fixture would blur.
  await t.test('after a refused item', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = setupLandable(dir, '026', { marker: true });
    const r = run('land.mjs', [branch], dir);
    assert.equal(r.code, 1);
    assert.deepEqual(scratchDirs(dir), []);
    assert.doesNotMatch(git(['worktree', 'list', '--porcelain'], dir), /scratch/);
  });

  await t.test('after a green run that landed', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = setupLandable(dir, '027');
    const r = run('land.mjs', [branch], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json.landed);
    assert.deepEqual(scratchDirs(dir), []);
    assert.doesNotMatch(git(['worktree', 'list', '--porcelain'], dir), /scratch/);
  });

  await t.test('after an exception inside an item', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = setupLandable(dir, '028');
    // A gate command that kills this process outright, mid-item — the case a `finally` alone
    // never covers.
    run('horde.mjs', ['config', 'set', 'gates.team', 'kill -TERM $PPID'], dir);
    run('land.mjs', [branch], dir);
    assert.deepEqual(scratchDirs(dir), []);
    assert.doesNotMatch(git(['worktree', 'list', '--porcelain'], dir), /scratch/);
  });
});

test('land.mjs: a worktree removed from under the run refuses by name, and git is still told to forget it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '033');
  // The gate command removes the very tree it is running in — the way a tidy-up script or a
  // disappearing volume does it on a real machine.
  run('horde.mjs', ['config', 'set', 'gates.team', 'rm -rf "$PWD"'], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  assert.deepEqual(scratchDirs(dir), []);
  const worktrees = git(['worktree', 'list', '--porcelain'], dir);
  assert.doesNotMatch(worktrees, /scratch/, `git still knows a scratch tree:\n${worktrees}`);
});

// A merge conflict is only reachable one way. A branch rooted at the parent's current tip merges
// cleanly by construction — that is what base freshness proves — so the only branch that can
// conflict is one whose parent moved after the items were measured. That is the race, and this is
// it: a slow gate, and the parent gaining a conflicting commit while it runs.
test('land.mjs: a merge conflict is aborted, the parent is untouched, and the conflicting files are named', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '029');
  run('horde.mjs', ['config', 'set', 'gates.team', 'sleep 4'], dir);

  const child = spawn('node', [join(SCRIPTS_DIR, 'land.mjs'), branch, '--json'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  // Wait for the fact that the run is mid-gate (the lock file naming this child's own pid), not a
  // guess about how long its own pre-gate work takes on this machine — base freshness among it,
  // which reads trunk's live tip: mutate trunk before that runs instead of after and this becomes
  // an ordinary stale-base refusal, never reaching a merge attempt at all.
  await waitGateLockHeldBy(dir, child.pid);

  // Trunk gains a commit touching the very line the ticket touched, while the gate is measuring.
  writeFileSync(join(dir, 'feature-029.mjs'), 'export function add(a, b) { return a * b; } // trunk moved\n');
  git(['add', 'feature-029.mjs'], dir);
  git(['commit', '-qm', 'trunk changes the same line, mid-gate'], dir);
  const trunkAfterMove = git(['rev-parse', 'mission1/trunk'], dir);

  const code = await new Promise((r) => { child.on('close', r); });
  const doc = JSON.parse(out);
  assert.equal(code, 1, out + err);
  assert.equal(doc.landed, null);

  const merge = doc.checks.find((c) => c.name === 'merge');
  assert.ok(merge, `a merge item was reported:\n${out}`);
  assert.equal(merge.ok, false);
  assert.match(merge.note, /conflicts and was aborted/);
  assert.match(merge.note, /feature-029\.mjs/, 'the conflicting file is named');

  // Trunk is exactly where the mid-gate commit left it: no merge commit, nothing half-applied.
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), trunkAfterMove, 'the parent is untouched');
  assert.equal(git(['rev-list', '--count', '--merges', `${trunkAfterMove}~1..mission1/trunk`], dir), '0');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no'], dir), '', 'no conflict left in the tree');
  assert.notEqual(git(['branch', '--list', branch], dir), '', 'and the branch still exists');
  assert.deepEqual(scratchDirs(dir), []);
});

test('land.mjs: a branch tip that moved during the run refuses, naming both shas, without merging', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '030');
  const measured = git(['rev-parse', branch], dir);
  const trunkBefore = git(['rev-parse', 'mission1/trunk'], dir);
  // A gate command slow enough to move the branch under the run, and a commit made while it runs.
  run('horde.mjs', ['config', 'set', 'gates.team', 'sleep 4'], dir);

  const child = spawn('node', [join(SCRIPTS_DIR, 'land.mjs'), branch, '--json'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  // Wait for the fact that the run is mid-gate (the lock file naming this child's own pid), not a
  // guess about how long its own pre-gate work takes on this machine — the journal check among
  // it, which reads the branch's own live last-commit time: push the extra commit before that
  // runs instead of after and it reads as the ticket's log predating its own last commit, a
  // different refusal than the one this test means to prove.
  await waitGateLockHeldBy(dir, child.pid);
  // The worker pushes one more commit while the gate is still measuring the old tip.
  const wt = join(dir, 'late-tree');
  git(['worktree', 'add', wt, branch], dir);
  writeFileSync(join(wt, 'feature-030.mjs'), 'export function add(a, b) { return a + b; } // late\n');
  git(['add', 'feature-030.mjs'], wt);
  git(['commit', '-qm', 'one more commit, mid-gate'], wt);
  git(['worktree', 'remove', '--force', wt], dir);
  const moved = git(['rev-parse', branch], dir);

  const code = await new Promise((r) => { child.on('close', r); });
  const said = out + err;
  assert.equal(code, 1, said);
  assert.match(said, new RegExp(`${branch} moved while this landing ran`));
  assert.match(said, new RegExp(measured.slice(0, 7)));
  assert.match(said, new RegExp(moved.slice(0, 7)));
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), trunkBefore, 'nothing merged');
});

test('land.mjs: a missing base branch refuses by name, because the guards have nothing to compare against', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '031');
  git(['checkout', '--detach', branch], dir);
  git(['branch', '-D', 'mission1/trunk'], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no such branch: mission1\/trunk/);
  assert.match(r.stderr, /nothing to compare against|with no base/);
  // git's own reason rides along, not just this tool's guess — proves the refusal is not reading
  // a real git failure as a plain "missing", the way it would if this text were absent.
  assert.match(r.stderr, /Needed a single revision/);
});

test('land.mjs: the ticket\'s own branch missing refuses by name, carrying git\'s own reason too', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '033');
  // queue.json still names the branch — only the branch itself is gone, e.g. pruned out from
  // under a stale queue record. checkout something else first: this branch is HEAD right now.
  git(['checkout', '--detach', 'mission1/trunk'], dir);
  git(['branch', '-D', branch], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`no such branch: ${branch.replace('/', '\\/')}`));
  assert.match(r.stderr, /Needed a single revision/);
});

// A git diff that fails outright (a corrupted object, an unreadable ref, a disk error mid-diff)
// must not come back as [] — the same shape as a genuinely empty diff — or the scope and mapping
// items would pass on a change this landing never actually read. Both items, and the run as a
// whole, must refuse instead.
test('land.mjs: a diff git cannot answer (a corrupted tree) refuses rather than reading as an empty, passing diff', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '097');
  const trunkBefore = git(['rev-parse', 'mission1/trunk'], dir);

  // The branch's own tip still resolves fine — `rev-parse --verify` only opens the commit object,
  // which is exactly why base freshness and the branch-existence checks above stay green on this.
  // What breaks is the diff this landing takes next: it has to walk that tip's tree, and cannot,
  // the same shape a corrupted object or a disk error mid-diff leaves on a real repository.
  const treeSha = git(['rev-parse', `${branch}^{tree}`], dir);
  const objPath = join(dir, '.git', 'objects', treeSha.slice(0, 2), treeSha.slice(2));
  assert.ok(existsSync(objPath), `expected a loose object at ${objPath} to corrupt`);
  rmSync(objPath);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1);
  // Not scope or mapping reporting red on a checklist — the run refused outright, before either
  // item, or anything else that reads this diff, ever ran.
  assert.equal(r.json, null, `expected no checklist at all, got:\n${r.stdout}`);
  assert.match(r.stderr, /git diff --name-only .* failed/);
  assert.match(r.stderr, /nothing changed/);
  // git's own reason rides along too, the same convention the sibling refusals above rely on —
  // proves this reads a real git failure rather than quietly treating it as an empty diff.
  assert.match(r.stderr, new RegExp(treeSha));

  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), trunkBefore, 'nothing merged on a diff the gate never read');
  assert.deepEqual(scratchDirs(dir), []);
});

test('land.mjs: unicode and spaces in a touched path survive scope, mapping and graph text', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const odd = 'zażółć gęślą/jaźń ünïcode.mjs';
  const { branch } = setupLandable(dir, '032', {
    mapping: ['feature-032.mjs', 'feature-032.test.mjs', odd],
    extraFiles: { [odd]: 'export const jazn = 1;\n' },
  });

  const r = run('land.mjs', [branch], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  assert.equal(byName(r).scope.ok, true, byName(r).scope.note);
  assert.equal(byName(r).mapping.ok, true, byName(r).mapping.note);
  assert.equal(byName(r)['graph text'].ok, true);
  assert.ok(r.json.landed);
  assert.match(git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'mission1/trunk'], dir), /jaźń ünïcode\.mjs/);
});

// ---- a ticket started from an unmerged dependency's tip (a stack) --------------------------

const LIB_LINES = Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`);

function libWithLines(changes) {
  const lines = [...LIB_LINES];
  for (const [line, value] of Object.entries(changes)) lines[Number(line) - 1] = `export const v${line} = ${value};`;
  return `${lines.join('\n')}\n`;
}

// The issue directory tk.mjs new created for a ticket id — its slug isn't known to the caller,
// so this finds it by the id prefix the same way the fixture's own log-reading assertions do.
function findIssueDir(dir, team, id) {
  const base = join(dir, '.horde', 'hordes', 'mission1', 'teams', team, 'issues');
  const entry = readdirSync(base).find((d) => d.startsWith(`${id}-`));
  return join(base, entry);
}

// The parent ticket running on its own branch with one line of the file changed, and the child
// queued behind it — dependency recorded, so the stack can follow it. Neither changes a test file
// (only lib.mjs), so each declares "**No new tests:**" up front — this fixture is about the stack
// mechanics, not the revert test, and its evidence rows already cover the line each ticket changes.
function chainOfTwo(dir, { parentLine = 5, childLine = 30 } = {}) {
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  run('horde.mjs', ['config', 'set', 'judge', 'one-shot'], dir);
  git(['checkout', 'mission1/trunk'], dir);
  writeFileSync(join(dir, 'lib.mjs'), `${LIB_LINES.join('\n')}\n`);
  writeFileSync(join(dir, 'other.mjs'), 'export const other = 0;\n');
  git(['add', 'lib.mjs', 'other.mjs'], dir);
  git(['commit', '-qm', 'the files both tickets change'], dir);
  addNode(dir, 'feature', { mapping: ['lib.mjs', 'other.mjs'] });
  commitGraph(dir);

  const parentId = run('tk.mjs', ['new', 'the-first-link', '--title', 'First link', '--node', 'feature', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
  addField(findIssueDir(dir, 'trunk', parentId), '**No new tests:** a constant\'s value only, covered by the evidence row');
  run('queue.mjs', ['add', parentId], dir);
  const parent = run('queue.mjs', ['set', parentId, 'running', '--agent', 'worker1'], dir).json;
  writeFileSync(join(parent.worktree, 'lib.mjs'), libWithLines({ [parentLine]: 500 }));
  git(['add', 'lib.mjs'], parent.worktree);
  git(['commit', '-qm', `ticket ${parentId}`], parent.worktree);
  run('tk.mjs', ['log', parentId, 'ready to land'], dir);

  const childId = run('tk.mjs', ['new', 'the-second-link', '--title', 'Second link', '--node', 'feature', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
  addField(findIssueDir(dir, 'trunk', childId), '**No new tests:** a constant\'s value only, covered by the evidence row');
  run('queue.mjs', ['add', childId, '--depends', parentId], dir);
  const started = run('queue.mjs', ['set', childId, 'running', '--agent', 'worker2', '--on', parentId], dir);
  assert.equal(started.code, 0, started.stderr);
  const child = started.json;

  writeFileSync(join(child.worktree, 'lib.mjs'), libWithLines({ [parentLine]: 500, [childLine]: 3000 }));
  git(['add', 'lib.mjs'], child.worktree);
  git(['commit', '-qm', `ticket ${childId}`], child.worktree);
  run('tk.mjs', ['log', childId, 'ready to land'], dir);

  return { parentId, parent, childId, child };
}

test('land.mjs: a stacked ticket is measured against its parent, and lands on the team once that parent has', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const {
    parentId, parent, childId, child,
  } = chainOfTwo(dir);

  await t.test('while the parent is unmerged, every item reads against the parent\'s branch', () => {
    const r = run('land.mjs', [child.branch, '--no-gate'], dir);
    assert.equal(r.code, 0, JSON.stringify(r.json && r.json.checks));
    assert.equal(r.json.parent, parent.branch);
    assert.equal(r.json.stackedOn, parentId);
    const base = r.json.checks.find((c) => c.name === 'base freshness');
    assert.equal(base.ok, true, base.note);
    assert.match(base.note, new RegExp(`rooted at ${parent.branch} tip`));
  });

  await t.test('the parent lands itself, and the stack is cleared', () => {
    const r = run('land.mjs', [parentId], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json.landed, 'the parent merged');
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === childId);
    assert.equal(item.stackedOn, null);
    assert.equal(git(['branch', '--list', parent.branch], dir), '');
  });

  await t.test('the child catches the team branch up and lands on it in its turn', () => {
    git(['merge', 'mission1/trunk', '-m', 'catch up with mission1/trunk'], child.worktree);
    run('tk.mjs', ['log', childId, 'caught the team branch up'], dir);

    const r = run('land.mjs', [childId], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.parent, 'mission1/trunk');
    assert.equal(r.json.stackedOn, null);
    assert.ok(r.json.landed);
    assert.equal(run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === childId).state, 'merged');
  });
});

// ---- what a red gate records ------------------------------------------------------------

test('land.mjs: a red gate puts the ticket on "changes" with the gate\'s own words and ticks the round', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  run('horde.mjs', ['config', 'set', 'judge', 'one-shot'], dir);
  addAspect(dir, 'no-marker', { description: 'No unfinished-work markers.', check: MARKER_CHECK });
  addNode(dir, 'feature', { mapping: ['lib.mjs', 'lib.test.mjs'], aspects: ['no-marker'] });
  commitGraph(dir);

  const id = run('tk.mjs', ['new', 'a-ticket', '--title', 'A ticket', '--node', 'feature', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
  run('queue.mjs', ['add', id], dir);
  const item = run('queue.mjs', ['set', id, 'running', '--agent', 'worker1'], dir).json;
  writeFileSync(join(item.worktree, 'lib.mjs'), 'export const value = 1; // UNFINISHED\n');
  writeFileSync(join(item.worktree, 'lib.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from './lib.mjs';",
    "test('value', () => { assert.equal(value, 1); });",
    '',
  ].join('\n'));
  git(['add', 'lib.mjs', 'lib.test.mjs'], item.worktree);
  git(['commit', '-qm', `ticket ${id}`], item.worktree);
  run('tk.mjs', ['log', id, 'ready to land'], dir);

  const r = run('land.mjs', [id], dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.landed, null);

  assert.match(run('tk.mjs', ['show', id], dir).json.text, /\*\*Status:\*\* changes/);
  const log = readFileSync(join(readdirSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues'))
    .map((d) => join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', d))
    .find((d) => d.includes(`/${id}-`)), 'log.md'), 'utf8');
  assert.match(log, /land refused: /);
  assert.match(log, /round 1\/5 — resume same worker/);
});

// ---- trailers on the merge commit --------------------------------------------------------
//
// Who worked what, and when, belongs to git rather than to `.horde/`, which is uncommitted and
// gone the moment a checkout is thrown away. This is the only place a merge commit is made, so it
// is the only place the trailers are written.

function trailersOf(dir, sha) {
  const body = git(['show', '-s', '--format=%B', sha], dir);
  const out = {};
  for (const line of body.split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    if (!/^(Ticket|Evidence|Law)$/.test(key)) continue;
    (out[key] ||= []).push(line.slice(at + 1).trim());
  }
  return out;
}

test('land.mjs: the merge commit carries Ticket and Evidence, and Law when the branch touched a rule', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // A real rule, added by the branch — a script rule so the graph can answer for it for free, and
  // declared on the ticket so the diff stays inside what the ticket said it would touch.
  const { branch } = setupLandable(dir, '060', {
    evidence: ['E1', 'E2'],
    extraFiles: {
      '.yggdrasil/aspects/reads-plainly/yg-aspect.yaml': [
        'name: ReadsPlainly',
        'description: Source files must not carry a second unfinished-work marker.',
        'errs: under',
        'status: draft',
        'review_by: 2099-01-01',
        '',
      ].join('\n'),
      '.yggdrasil/aspects/reads-plainly/check.mjs': MARKER_CHECK.replace('UNFINISHED', 'SCRATCH'),
    },
    mapping: ['feature-060.mjs', 'feature-060.test.mjs'],
    files: [
      'feature-060.mjs', 'feature-060.test.mjs',
      '.yggdrasil/aspects/reads-plainly/yg-aspect.yaml',
      '.yggdrasil/aspects/reads-plainly/check.mjs',
    ],
  });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.json.ok, true);

  const trailers = trailersOf(dir, r.json.landed.sha);
  assert.deepEqual(trailers.Ticket, ['t-060']);
  assert.deepEqual(trailers.Evidence, ['E1, E2']);
  assert.deepEqual(trailers.Law, ['reads-plainly added']);

  // Ordinary git trailers, so the tool everyone already has reads them.
  const parsed = git(['show', '-s', '--format=%(trailers:key=Ticket,valueonly)', r.json.landed.sha], dir);
  assert.equal(parsed.trim(), 't-060');
});

test('land.mjs: a ticket that earned no evidence row gets no Evidence trailer at all', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '061');

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);

  const trailers = trailersOf(dir, r.json.landed.sha);
  assert.deepEqual(trailers.Ticket, ['t-061']);
  // Not an empty one: "Evidence:" with nothing after it reads as "this landed proving nothing",
  // which is a different and false claim from "this ticket earned no catalogue row".
  assert.equal(trailers.Evidence, undefined);
  assert.equal(trailers.Law, undefined);
  assert.doesNotMatch(git(['show', '-s', '--format=%B', r.json.landed.sha], dir), /^Evidence:\s*$/m);
});

test('land.mjs: a trailer value holding a colon or a non-ASCII character survives the round trip', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // Free text rather than a catalogue id — the field takes either, and an adopter writing a path
  // or a sentence is the case a parser splitting on the last colon would get wrong.
  const { branch } = setupLandable(dir, '062', {
    evidence: ['tests/płatności: kwota się zgadza', 'E7'],
  });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);

  const trailers = trailersOf(dir, r.json.landed.sha);
  assert.deepEqual(trailers.Ticket, ['t-062']);
  assert.deepEqual(trailers.Evidence, ['tests/płatności: kwota się zgadza, E7']);
  assert.equal(
    git(['show', '-s', '--format=%(trailers:key=Evidence,valueonly)', r.json.landed.sha], dir).trim(),
    'tests/płatności: kwota się zgadza, E7',
  );
});

test('land.mjs: an adopter hook that rejects the merge costs the commit none of its trailers', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '063', { evidence: ['E1'] });

  // A commit-msg hook that refuses once and then lets the same message through — an adopter's own
  // policy hook having a bad day, which is the case where a retry could quietly write a shorter
  // message than the one that was refused.
  const hookDir = join(dir, '.git', 'hooks');
  mkdirSync(hookDir, { recursive: true });
  const stamp = join(dir, '.git', 'hook-fired');
  writeFileSync(join(hookDir, 'commit-msg'), [
    '#!/bin/sh',
    `if [ ! -f "${stamp}" ]; then touch "${stamp}"; echo "policy: not today" >&2; exit 1; fi`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const refused = run('land.mjs', [branch], dir);
  assert.equal(refused.json.ok, false);
  const mergeItem = refused.json.checks.find((c) => c.name === 'merge');
  assert.ok(mergeItem && !mergeItem.ok, 'the merge item reports the refusal');
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), git(['rev-parse', 'mission1/trunk'], dir));

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  const trailers = trailersOf(dir, r.json.landed.sha);
  assert.deepEqual(trailers.Ticket, ['t-063']);
  assert.deepEqual(trailers.Evidence, ['E1'], 'the retry wrote the same trailers, not fewer');
});

// ---- what became of a ticket after it landed ----------------------------------------------
//
// A landing used to be the end of the record. These three tests are the other end of it: a merge
// that was undone, a ticket filed to earn back what another one had claimed, and the two places
// either of them is written — the ticket's own result file and the wave journal the close reads.

function landResultPath(dir, ticket, horde = 'mission1') {
  return join(dir, '.horde', 'hordes', horde, 'land', `${ticket}.json`);
}

function landResult(dir, ticket, horde = 'mission1') {
  return JSON.parse(readFileSync(landResultPath(dir, ticket, horde), 'utf8'));
}

function journal(dir, horde = 'mission1') {
  return readFileSync(join(dir, '.horde', 'hordes', horde, 'plan.md'), 'utf8');
}

// A background landing, waited on — the way `tick.mjs` lands, and the only way a result file is
// written at all, which is what makes this the case where a fate has a document to extend.
function landInBackground(dir, branch) {
  const started = run('land.mjs', [branch, '--background'], dir);
  assert.equal(started.code, 0, started.stderr);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(started.json.resultFile, 'utf8')); } catch { /* not yet */ }
    execFileSync('sleep', ['0.25']);
  }
  throw new Error(`the background landing of ${branch} wrote no result`);
}

test('land.mjs --fate reverted: the undone merge extends the run\'s own result file, and the journal, once', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '070');

  const result = landInBackground(dir, branch);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  const mergeSha = result.landed.sha;

  // A real revert of that real merge — the commit the record has to be able to point at.
  git(['checkout', '-q', '-B', 'undo-070', mergeSha], dir);
  git(['revert', '--no-edit', '-m', '1', mergeSha], dir);
  const revertSha = git(['rev-parse', 'HEAD'], dir);
  git(['checkout', '-q', 'mission1/trunk'], dir);

  const r = run('land.mjs', ['070', '--fate', 'reverted', '--by', revertSha], dir);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.json.ticket, '070');
  assert.equal(r.json.fate, 'reverted');
  assert.equal(r.json.by, revertSha);
  assert.equal(r.json.recorded, true);

  // The document the gate already wrote, extended — not a second file in a shape of its own.
  const doc = landResult(dir, '070');
  assert.deepEqual(doc.checks.map((c) => c.name).slice(0, 9), ITEMS, 'the run\'s own items are still there');
  assert.equal(doc.landed.sha, mergeSha, 'and so is what it landed');
  assert.equal(doc.fates.length, 1);
  assert.equal(doc.fates[0].fate, 'reverted');
  assert.equal(doc.fates[0].by, revertSha);
  assert.match(doc.fates[0].at, /^\d{4}-\d{2}-\d{2}T/);

  // And the journal, which is where the wave close reads from.
  assert.match(journal(dir), new RegExp(`^- \\S+ reverted: 070 ${revertSha}$`, 'm'));

  // One fate, carried by one commit, is one record however often it is reported.
  const again = run('land.mjs', ['070', '--fate', 'reverted', '--by', revertSha], dir);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.recorded, false);
  assert.equal(landResult(dir, '070').fates.length, 1);
  assert.equal(journal(dir).split(`reverted: 070 ${revertSha}`).length - 1, 1);

  // Nothing in the queue moved: the merge commit still stands, and a revert is a commit on top of
  // it rather than a ticket going backwards.
  const queue = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json'), 'utf8'));
  assert.equal(queue.items.find((i) => i.ticket === '070').state, 'merged');
});

test('land.mjs --fate reopened: the new ticket has to say so itself', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '071');
  assert.equal(run('land.mjs', [branch], dir).code, 0);
  // A foreground landing writes no result file, which is the other half of the shape: a fate on a
  // ticket whose merge was never written down still has somewhere to live.
  assert.equal(existsSync(landResultPath(dir, '071')), false);

  // One ticket that reopens nothing and one that reopens t-071, both filed the way an owner files
  // one — so the "**Reopens:**" line here is the ticket template's own rendering, not a fixture's.
  const unrelated = run('tk.mjs', ['new', 'unrelated', '--title', 'Something else', '--node', 'feature', '--class', 'standard'], dir);
  assert.equal(unrelated.code, 0, unrelated.stderr);
  const reopening = run('tk.mjs', ['new', 'second-attempt', '--title', 'Earn it back', '--node', 'feature', '--class', 'standard', '--reopens', '071'], dir);
  assert.equal(reopening.code, 0, reopening.stderr);
  assert.equal(reopening.json.reopens, 't-071');
  const issuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', `${reopening.json.id}-second-attempt`, 'issue.md');
  assert.match(readFileSync(issuePath, 'utf8'), /^\*\*Reopens:\*\* t-071$/m);

  await t.test('a number this horde never filed is refused where it is written, on the ticket', () => {
    const r = run('tk.mjs', ['new', 'nowhere', '--title', 'Nowhere', '--node', 'feature', '--class', 'standard', '--reopens', '999'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no ticket 999/);
  });

  await t.test('a fate naming a ticket that was never filed names the command that files one', () => {
    const r = run('land.mjs', ['071', '--fate', 'reopened', '--by', '999'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no ticket 999/);
    assert.match(r.stderr, /--reopens 071/);
  });

  await t.test('a ticket that does not claim the reopening is refused, never taken on the caller\'s word', () => {
    const r = run('land.mjs', ['071', '--fate', 'reopened', '--by', unrelated.json.id], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not say it reopens t-071/);
    assert.equal(existsSync(landResultPath(dir, '071')), false, 'nothing was written');
  });

  await t.test('the ticket that does claim it is recorded in both places', () => {
    const r = run('land.mjs', ['071', '--fate', 'reopened', '--by', reopening.json.id], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.fate, 'reopened');
    assert.equal(r.json.by, `t-${reopening.json.id}`);

    const doc = landResult(dir, '071');
    assert.equal(doc.ticket, '071');
    assert.equal(doc.fates.length, 1);
    assert.equal(doc.fates[0].fate, 'reopened');
    assert.equal(doc.fates[0].by, `t-${reopening.json.id}`);
    assert.match(journal(dir), new RegExp(`^- \\S+ reopened: 071 t-${reopening.json.id}$`, 'm'));
  });
});

test('land.mjs --fate: what it refuses, and why the gate\'s own flags are not its flags', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '072');

  await t.test('a ticket that has not landed has no fate yet', () => {
    const r = run('land.mjs', ['072', '--fate', 'reverted', '--by', 'HEAD'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is landed, not merged/);
  });

  assert.equal(run('land.mjs', [branch], dir).code, 0);

  await t.test('an unknown fate names the two there are', () => {
    const r = run('land.mjs', ['072', '--fate', 'forgotten', '--by', 'HEAD'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--fate must be one of: reverted, reopened/);
  });

  await t.test('a fate with nothing behind it is a claim, not a record', () => {
    const r = run('land.mjs', ['072', '--fate', 'reverted'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires --by <sha>/);
    const reopened = run('land.mjs', ['072', '--fate', 'reopened'], dir);
    assert.equal(reopened.code, 1);
    assert.match(reopened.stderr, /requires --by <ticket>/);
  });

  await t.test('a revert nobody can look at is refused, and nothing is written', () => {
    const r = run('land.mjs', ['072', '--fate', 'reverted', '--by', 'f'.repeat(40)], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such commit/);
    assert.equal(existsSync(landResultPath(dir, '072')), false);
  });

  await t.test('a ticket this horde never tracked has no fate here', () => {
    const r = run('land.mjs', ['404', '--fate', 'reverted', '--by', 'HEAD'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no queue item names 404/);
  });

  await t.test('--fate runs no gate, so a gate flag beside it is refused rather than ignored', () => {
    const r = run('land.mjs', ['072', '--fate', 'reverted', '--by', 'HEAD', '--no-gate'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--no-gate does not go with --fate/);
  });
});

// ---- a mission with no evidence layer says so on every landing --------------------------------
//
// The charter carries one judgement of what proof means in this repository, and one of its answers
// is that there is nothing here to point at: no suite, no promises, not a file named like a test.
// Every row a ticket earns then stands on what it names itself — a scenario, a film, a screenshot —
// and the only person who can tell whether it holds is whoever goes and looks. A landing that said
// nothing about that would leave that to be worked out from items talking about globs and commands,
// or from reading the charter. So it is said here, once, on every landing, however the items went.

test('land.mjs: a mission whose charter found no evidence layer says so on every landing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '080');
  await writeEvidenceJudgement(dir, NO_EVIDENCE_LAYER);

  await t.test('a landing whose items are all green still states it', () => {
    const r = run('land.mjs', [branch, '--no-gate'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.match(r.json.noEvidenceLayer, /^No evidence layer in this repository:/);
    assert.match(r.json.noEvidenceLayer, /stands on what it names itself/);
  });

  await t.test('and so does a refused one — it is a fact about the mission, not about this run', () => {
    // A no-evidence-layer mission exempts the revert test outright (issue 108) — it is never the
    // item that refuses here, even with testGlobs unset (the same emptiness the charter's own
    // judgement is made from). Refuse on something the exemption has nothing to do with instead —
    // a stale log entry — so this still proves the sentence is said on a refused run too, not only
    // a green one.
    run('horde.mjs', ['config', 'set', 'testGlobs', ''], dir);
    writeTicketLog(issueDir(dir, 'trunk', '080'), { whenIso: '2000-01-01T00:00:00.000Z' });
    const r = run('land.mjs', [branch, '--no-gate'], dir);
    assert.equal(r.code, 1);
    assert.equal(byName(r).journal.ok, false);
    assert.equal(byName(r)['revert test'].ok, true, byName(r)['revert test'].note);
    assert.match(r.json.noEvidenceLayer, /^No evidence layer in this repository:/);
  });

  await t.test('said out loud above the items, where whoever reads them will read it first', () => {
    const said = run('land.mjs', [branch, '--no-gate'], dir, { json: false });
    const sentence = said.stdout.indexOf('No evidence layer in this repository:');
    assert.notEqual(sentence, -1, said.stdout);
    const firstItem = said.stdout.search(/^[✓✗] base freshness/m);
    assert.notEqual(firstItem, -1, said.stdout);
    assert.ok(sentence < firstItem, 'the sentence stands above the items it frames');
  });

  await t.test('and it is in the result file the retrospective reads back', () => {
    const r = run('land.mjs', [branch, '--no-gate', '--result'], dir);
    assert.equal(r.code, 1);
    assert.match(landResult(dir, '080').noEvidenceLayer, /^No evidence layer in this repository:/);
  });
});

test('land.mjs: a mission that has an evidence layer says nothing about one', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '081');
  await writeEvidenceJudgement(dir, A_TEST_SUITE);

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.noEvidenceLayer, null);

  const said = run('land.mjs', [branch, '--no-gate'], dir, { json: false });
  assert.doesNotMatch(said.stdout, /No evidence layer in this repository/);
});

// The charter template quotes the phrase in the middle of a sentence, where it tells the architect
// when to write it. A mission whose cut has not run yet has judged nothing, and a landing must not
// read those instructions as a verdict.
test('land.mjs: a charter whose evidence judgement has not been made yet claims nothing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '082');

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.noEvidenceLayer, null);
});

// ---- the no-evidence-layer exemption on the revert-test item itself (issue 108) -----------------
//
// config.testGlobs is empty on a no-evidence-layer repository BY CONSTRUCTION — the same emptiness
// the charter's judgement is made from — so the testGlobs-unset refusal used to fire on every
// single ticket in exactly the repositories Horde tells to prove their catalogue rows some other
// way (a scenario, a screenshot, a recording), before a ticket's own "**No new tests:**" exemption
// was even read. The charter's judgement now reaches this item directly instead: exempted outright,
// first, citing that judgement, rather than refusing on empty testGlobs or asking for an excuse a
// mission with nothing to run a proof against cannot give.

test('land.mjs: a mission with no evidence layer exempts the revert test outright, even with testGlobs unset and a real new test file in the diff', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '116'); // adds feature-116.test.mjs; no "**No new tests:**" declared
  await writeEvidenceJudgement(dir, NO_EVIDENCE_LAYER);
  // The same emptiness the charter's judgement is made from — construction, not a separate mutation.
  run('horde.mjs', ['config', 'set', 'testGlobs', ''], dir);

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 0, r.stderr);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, true, item.note);
  assert.doesNotMatch(item.note, /testGlobs is unset/);
  assert.doesNotMatch(item.note, /no new or changed test files/);
  assert.match(item.note, /^No evidence layer in this repository:/);
  assert.match(item.note, /stands on what it names itself/);
});

test('land.mjs: the no-evidence-layer exemption is checked before even the ticket\'s own --mutate/--revert-base conflict guard', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, issueDir: dst } = setupLandable(dir, '117');
  await writeEvidenceJudgement(dir, NO_EVIDENCE_LAYER);
  // A ticket that would otherwise be refused outright for naming both fields (see the "names both
  // --mutate and a revert base" test above) — proof the exemption really runs first, ahead of every
  // other branch in the function, not only the two the ticket names by name.
  const path = join(dst, 'issue.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('## Acceptance', '**Revert base:** develop\n**Mutate:** true\n\n## Acceptance'));

  const r = run('land.mjs', [branch, '--no-gate'], dir);
  const item = byName(r)['revert test'];
  assert.equal(item.ok, true, item.note);
  assert.doesNotMatch(item.note, /names both --mutate and a revert base/);
  assert.match(item.note, /^No evidence layer in this repository:/);
});

test('land.mjs: a mission with an evidence layer keeps the old testGlobs-unset refusal and the old "**No new tests:**" exemption, unchanged', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, issueDir: dst } = setupLandable(dir, '118');
  await writeEvidenceJudgement(dir, A_TEST_SUITE);

  await t.test('testGlobs unset still refuses, exactly as before', () => {
    run('horde.mjs', ['config', 'set', 'testGlobs', ''], dir);
    const r = run('land.mjs', [branch, '--no-gate'], dir);
    assert.equal(r.code, 1);
    const item = byName(r)['revert test'];
    assert.equal(item.ok, false);
    assert.match(item.note, /config.testGlobs is unset/);
    assert.match(item.note, /"not looked", not "none"/);
  });

  await t.test('and a declared "**No new tests:**" reason still passes it when the diff adds or changes none, exactly as before', () => {
    run('horde.mjs', ['config', 'set', 'testGlobs', '**/*.test.*,**/*.spec.*'], dir);
    git(['checkout', branch], dir);
    git(['rm', '-q', 'feature-118.test.mjs'], dir);
    git(['commit', '-qm', 'no test after all'], dir);
    git(['checkout', 'mission1/trunk'], dir);
    addField(dst, '**No new tests:** pure rename, behaviour covered by existing evidence rows');

    const r = run('land.mjs', [branch, '--no-gate'], dir);
    const item = byName(r)['revert test'];
    assert.equal(item.ok, true, item.note);
    assert.match(item.note, /declared no-new-tests: pure rename/);
  });
});

// ---- the tree land.mjs itself runs in, with and without --horde written out (issue 109) --------
//
// The same shared contract every other tool here reads (node.mjs main()'s own comment above its
// resolveTree call, tree.test.mjs, and tick.test.mjs's own version of this test): an ordinary run
// with neither --tree nor --horde stays on cwd, whatever tree that happens to be — a resolvable
// horde is not by itself a second signal for "read trunk instead". --horde WRITTEN OUT is the one
// thing that does mean this horde's own trunk, exactly as queue.mjs plan/quality and tick.mjs
// already read it. Before this test existed, land.mjs's own resolveTree calls forwarded neither
// form of --horde at all, so the flag had no effect on the tree land ran in either way.
//
// Files are declared explicitly on both tickets so the scope check never depends on which tree's
// own graph state gets read — that would entangle this with a second question (which tree
// checkScope should read) this issue is not about. What is left to differ, and what this test
// actually proves, is whether land.mjs ever provisions this horde's own trunk WORKTREE — a
// resource only --horde written out reaches — while running from a shell sitting on neither the
// mission's own base branch nor mission1/trunk, matching the issue's own "wandered somewhere land
// was never told about" shape.
test('land.mjs: no --horde stays on cwd; --horde written out resolves to that horde\'s own trunk instead', async (t) => {
  await t.test('no --horde at all: cwd, wherever the main checkout is sitting — trunk\'s own separate worktree is never touched', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = setupLandable(dir, '109', { files: ['feature-109.mjs', 'feature-109.test.mjs'] });
    git(['checkout', 'develop'], dir);
    const trunkBefore = git(['rev-parse', 'mission1/trunk'], dir);
    const trunkWorktree = join(dir, '.horde', 'worktrees', 'mission1', 'trunk');

    const r = run('land.mjs', [branch], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.notEqual(git(['rev-parse', 'mission1/trunk'], dir), trunkBefore, 'the ticket still landed');
    assert.equal(existsSync(trunkWorktree), false, 'trunk\'s own separate worktree was never provisioned');
    // Resolving a tree is not a checkout: the shell this ran from stays exactly where it was.
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), 'develop');
  });

  await t.test('--horde mission1 written out: this horde\'s own trunk worktree gets provisioned, a different tree from cwd', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = setupLandable(dir, '110', { files: ['feature-110.mjs', 'feature-110.test.mjs'] });
    git(['checkout', 'develop'], dir);
    const trunkBefore = git(['rev-parse', 'mission1/trunk'], dir);
    const trunkWorktree = join(dir, '.horde', 'worktrees', 'mission1', 'trunk');
    assert.equal(existsSync(trunkWorktree), false, 'not provisioned yet — the point of this sub-test is that land.mjs is what provisions it');

    const r = run('land.mjs', [branch, '--horde', 'mission1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.notEqual(git(['rev-parse', 'mission1/trunk'], dir), trunkBefore, 'the ticket still landed');
    assert.equal(existsSync(trunkWorktree), true, '--horde written out: trunk\'s own separate worktree was provisioned');
    // Shared state, not part of either tree: the main checkout is left exactly where it was.
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), 'develop');
  });
});

// --fate draws the same tree distinction as the gate-run path above, for consistency — one script,
// one flag, one reading of it — even though the one thing --fate itself reads off the tree (a
// single, repo-wide "does this commit exist") could not care less which valid worktree answers it.
test('land.mjs --fate: --horde written out resolves to that horde\'s own trunk too, same as a gate run', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '111', { files: ['feature-111.mjs', 'feature-111.test.mjs'] });
  const landed = run('land.mjs', [branch], dir);
  assert.equal(landed.code, 0, landed.stderr);
  const revertSha = landed.json.landed.sha;
  git(['checkout', 'develop'], dir);
  const trunkWorktree = join(dir, '.horde', 'worktrees', 'mission1', 'trunk');
  assert.equal(existsSync(trunkWorktree), false);

  const r = run('land.mjs', ['111', '--fate', 'reverted', '--by', revertSha, '--horde', 'mission1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.recorded, true);
  assert.equal(existsSync(trunkWorktree), true, '--horde written out on --fate provisions trunk\'s own worktree too');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), 'develop');
});

// ---- batching (080): several ready tickets share one run of the expensive items ------------
//
// One node per ticket (never one shared node the way setupLandable's own callers do) — every id
// gets its own component, its own pair of files, its own mapping — so "non-overlapping" is the
// fixture's own construction rather than something asserted after the fact, and calling this
// helper for several ids in one test never has one id's addNode overwrite another's mapping the
// way a shared node would.
//
// Each node's own yg-node.yaml lands on ITS ticket's own branch, beside the first file it maps —
// never pre-committed to trunk ahead of the file it names. That is not a fixture nicety: Yggdrasil
// itself refuses a mapping whose path does not yet exist on the tree being checked
// ("mapping-path-missing"), so checking one ticket's own tree in isolation — exactly what land.mjs
// does for every ticket, batched or not — would refuse it outright if another ticket's not-yet-
// merged node sat on trunk already. Only the aspect goes on trunk before any ticket branches: it
// reaches nothing yet, so nothing about it depends on any one ticket's files existing. And because
// every node this way is genuinely new (none of them exist on trunk yet), every ticket declares its
// own "**Files:**" rather than leaning on the node-boundary fallback: that fallback reads the node
// off `root` (trunk, this land.mjs run's own tree), which a brand-new node introduced on the
// ticket's own branch is never going to be found on — a declared list is the only boundary a
// ticket that introduces its own component can give the scope check.
//
// .yggdrasil/model/.gitkeep, committed with the aspect, keeps model/ itself a real, git-tracked
// path: git tracks files, never empty directories, so a model/ directory `yg init` merely created
// on disk would vanish the moment any branch without a node in it is checked out — exactly what
// every ticket branch here is, on trunk, until its own node lands. Without it, Yggdrasil reads a
// directory that is not there as "no .yggdrasil/ project here at all", a confusing stand-in for
// the real answer ("no node by that name yet") that has nothing to do with land.mjs itself.
function setupBatchLandable(dir, ids, { judge = 'one-shot', perTicket = {} } = {}) {
  initHorde(dir);
  addAspect(dir, 'no-marker', {
    description: 'Source files must not carry an unfinished-work marker.',
    check: MARKER_CHECK,
  });
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  run('horde.mjs', ['config', 'set', 'judge', judge], dir);
  git(['checkout', '-q', 'mission1/trunk'], dir);
  mkdirSync(join(dir, '.yggdrasil', 'model'), { recursive: true });
  writeFileSync(join(dir, '.yggdrasil', 'model', '.gitkeep'), '');
  git(['add', '.yggdrasil'], dir);
  git(['commit', '-qm', 'graph: the rule this batch is judged by'], dir);

  const branches = {};
  for (const id of ids) {
    const own = perTicket[id] || {};
    const mapping = [`feature-${id}.mjs`, `feature-${id}.test.mjs`, ...(own.extraMapping || [])];
    const nodePath = `.yggdrasil/model/feature${id}/yg-node.yaml`;
    const nodeYaml = [
      `name: feature${id}`,
      'type: module',
      `description: Fixture component feature${id}.`,
      'aspects:',
      '  - no-marker',
      'mapping:',
      ...mapping.map((m) => `  - "${m}"`),
      'relations: []',
      '',
    ].join('\n');
    const extraFiles = { [nodePath]: nodeYaml, ...(own.extraFiles || {}) };
    const branch = makeTicketBranch(dir, id, { extraFiles });
    const files = [nodePath, `feature-${id}.mjs`, `feature-${id}.test.mjs`, ...Object.keys(own.extraFiles || {})];
    const dst = writeIssue(dir, 'trunk', id, { node: `feature${id}`, files });
    writeTicketLog(dst);
    seedQueueItem(dir, 'trunk', id, branch);
    branches[id] = branch;
  }
  return branches;
}

function gateCallCount(gateLog) {
  if (!existsSync(gateLog)) return 0;
  return readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).length;
}

function resultFor(r, id) {
  return (r.json.results || []).find((x) => x.ticket === id);
}

test('land.mjs batch: non-overlapping tickets ready to land share one gate run, and each still lands on its own', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ids = ['101', '102', '103'];
  setupBatchLandable(dir, ids);
  const gateLog = join(dir, 'gate-calls.log');
  run('horde.mjs', ['config', 'set', 'gates.team', `echo run >> "${gateLog}"`], dir);
  const trunkBefore = git(['rev-parse', 'mission1/trunk'], dir);

  const r = run('land.mjs', [ids.join(',')], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.tickets, ids);
  assert.equal(r.json.results.length, 3);

  assert.equal(gateCallCount(gateLog), 1, 'the repository\'s own gate command ran exactly once for the whole batch');

  // Three merge commits landed, each with two parents (its own branch and whatever trunk stood at
  // when it merged) — sequential, not folded into one.
  assert.equal(git(['rev-list', '--count', '--merges', `${trunkBefore}..mission1/trunk`], dir), '3');

  const shas = new Set();
  for (const id of ids) {
    const res = resultFor(r, id);
    assert.ok(res, `no result for ${id}`);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.landed && res.landed.sha, `${id} carries no merge sha`);
    shas.add(res.landed.sha);

    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === id);
    assert.equal(item.state, 'merged', `${id} is not merged in the queue`);
    assert.equal(item.sha, res.landed.sha, `${id}'s queue item does not carry the sha it actually landed as`);

    assert.match(
      readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8'),
      new RegExp(id),
      `${id} carries no journal bullet`,
    );
    assert.ok(res.full.size, `${id} carries no size figure`);
    assert.deepEqual(res.full.checks.map((c) => c.name).slice(0, 9), ITEMS, `${id}'s own checks are not the nine items in order`);
    for (const c of res.full.checks.slice(0, 9)) assert.equal(c.ok, true, `${id} ${c.name}: ${c.note}`);
  }
  assert.equal(shas.size, 3, 'three distinct merge commits — no ticket landed as another\'s sha');
});

test('land.mjs batch: an overlapping pair excludes the overlapping ticket from the batch, and the rest still batch', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ids = ['111', '112', '113'];
  // 112 also touches 111's own file, on top of its own two — declared, so its own scope check
  // still passes once it lands on its own. The batching precondition reads the actual diff, not
  // the declaration, so this is enough to collide 112 with 111 without touching 113 at all.
  setupBatchLandable(dir, ids, {
    perTicket: {
      112: {
        extraFiles: { 'feature-111.mjs': 'export function add(a, b) { return a + b; } // also touched by 112\n' },
        // 112's own node claims this file too — its own tree, checked alone once it falls back to
        // landing on its own, must not depend on 111's separate branch (never merged with it) to
        // say who owns it. (Declared "**Files:**" — including this one — is computed automatically
        // from extraFiles' own keys; nothing more to say here.)
        extraMapping: ['feature-111.mjs'],
      },
    },
  });
  const gateLog = join(dir, 'gate-calls.log');
  run('horde.mjs', ['config', 'set', 'gates.team', `echo run >> "${gateLog}"`], dir);

  const r = run('land.mjs', [ids.join(',')], dir);

  // One shared run for {111, 113}, one standalone run for 112 — landed on its own precisely
  // because it collides with 111, never because anything about it is otherwise wrong.
  assert.equal(gateCallCount(gateLog), 2, 'the overlapping ticket ran its own gate, separate from the shared one');

  // 111 and 113 batch together and both land.
  for (const id of ['111', '113']) {
    const res = resultFor(r, id);
    assert.ok(res, `no result for ${id}`);
    assert.equal(res.ok, true, JSON.stringify(res));
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === id);
    assert.equal(item.state, 'merged', `${id} did not land`);
  }

  // 112 is excluded from the batch and runs alone — AFTER 111 and 113 have already landed and
  // moved the parent it was cut from, exactly as it would if a worker had spawned three separate
  // `land.mjs` calls at once today and this one lost the race to merge: it goes stale rather than
  // landing over content its own branch never incorporated. That is not a batching bug — it is the
  // same base-freshness item every landing runs, correctly refusing a branch a sibling's landing
  // has since overtaken. What this test cares about is that 112 got there on its OWN gate call
  // (proven by the count above), and that this run reports it, honestly, for what it is.
  assert.equal(r.code, 1, 'the run as a whole is not all-green while 112 has not actually landed');
  const res112 = resultFor(r, '112');
  assert.ok(res112, 'no result for 112');
  assert.equal(res112.ok, false, 'excluded from the batch by construction, but for a stale base — not a fabricated pass');
  const check112 = res112.full.checks.find((c) => c.name === 'base freshness');
  assert.equal(check112.ok, false);
  assert.match(check112.note, /STALE/);
  const item112 = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === '112');
  assert.equal(item112.state, 'landed', '112 is exactly where it was — nothing landed for it, nothing else touched it');
});

test('land.mjs batch: a red shared gate falls back to landing every member on its own, in the same run, with correct attribution', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ids = ['121', '122', '123'];
  const branches = setupBatchLandable(dir, ids);
  const gateLog = join(dir, 'gate-calls.log');
  // Red on the first call (the shared one), green on every call after (each standalone fallback).
  const gateCmd = `n=$(cat "${gateLog}" 2>/dev/null | wc -l); echo run >> "${gateLog}"; [ "$n" -gt 0 ]`;
  run('horde.mjs', ['config', 'set', 'gates.team', gateCmd], dir);

  const r = run('land.mjs', [ids.join(',')], dir);

  assert.equal(
    gateCallCount(gateLog),
    4,
    '1 shared run (red, no bisection) + 3 standalone runs — the worst case costs exactly what it costs today',
  );

  // Three tickets that all shared one parent tip, none of them merged before this run started:
  // falling back to landing them one at a time, in sequence, is exactly what three separate
  // `land.mjs` calls racing for the same parent would do today — the first to actually merge wins,
  // and every one behind it finds its own branch no longer rooted at the parent's new tip (the same
  // base-freshness item every landing runs) and goes back to "changes" rather than landing over
  // content it never incorporated. Nothing here is a batching bug: it is "no bisection" costing
  // exactly what today's worst case already costs, and every result below is attributed to the
  // right ticket, never confused with a sibling's.
  const res121 = resultFor(r, '121');
  const res122 = resultFor(r, '122');
  const res123 = resultFor(r, '123');
  assert.ok(res121 && res122 && res123, 'a result for every ticket');

  assert.equal(res121.ok, true, JSON.stringify(res121));
  assert.ok(res121.landed && res121.landed.sha, '121 did not land');
  assert.equal(res121.full.branch, branches['121']);
  const item121 = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === '121');
  assert.equal(item121.state, 'merged');
  assert.equal(item121.sha, res121.landed.sha, '121\'s queue item does not carry the sha its own fallback run actually landed');

  for (const [id, res] of [['122', res122], ['123', res123]]) {
    assert.equal(res.ok, false, `${id} unexpectedly landed: ${JSON.stringify(res)}`);
    assert.equal(res.landed, null);
    assert.equal(res.full.branch, branches[id], `${id}'s own result names its own branch, not another ticket's`);
    const staleness = res.full.checks.find((c) => c.name === 'base freshness');
    assert.equal(staleness.ok, false);
    assert.match(staleness.note, /STALE/);
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === id);
    assert.equal(item.state, 'landed', `${id} is exactly where it was`);
  }
  assert.equal(r.code, 1, 'the run as a whole is not all-green while two of the three have not actually landed');
});

test('land.mjs batch: --no-gate on two or more tickets lands each on its own, never sharing a preview tree', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ids = ['124', '125'];
  setupBatchLandable(dir, ids);

  const r = run('land.mjs', [ids.join(','), '--no-gate'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  for (const id of ids) {
    const res = resultFor(r, id);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.landed, null, '--no-gate never merges');
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === id);
    assert.equal(item.state, 'landed', `${id} was not supposed to merge under --no-gate`);
  }
});

test('land.mjs batch: a batch naming exactly one ticket behaves exactly like the plain single-ticket call', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  setupLandable(dir, '130');

  const r = run('land.mjs', ['130'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.checks.map((c) => c.name).slice(0, 9), ITEMS);
  assert.equal(r.json.landed.sha, git(['rev-parse', 'mission1/trunk'], dir));
  // Today's single-ticket shape, never the batch envelope — no "tickets"/"results" fields at all.
  assert.equal(r.json.tickets, undefined);
  assert.equal(r.json.results, undefined);
  assert.equal(r.json.ticket, '130');
});

test('land.mjs --background with two or more tickets starts one worker for the whole batch', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ids = ['141', '142'];
  setupBatchLandable(dir, ids);
  run('horde.mjs', ['config', 'set', 'gates.team', 'sleep 2'], dir);

  const started = Date.now();
  const r = run('land.mjs', [ids.join(','), '--background'], dir);
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(elapsed < 2000, `it did not wait for the gate (${elapsed}ms)`);
  assert.deepEqual(r.json.tickets, ids);
  assert.equal(r.json.items.length, 2);
  for (const it of r.json.items) {
    assert.equal(it.started, true, JSON.stringify(it));
    assert.match(it.resultFile, /\.horde\/hordes\/mission1\/land\/1(41|42)\.json$/);
    assert.equal(existsSync(it.resultFile), false, 'nothing is written yet');
  }

  const deadline = Date.now() + 90000;
  const docs = {};
  while (Date.now() < deadline && Object.keys(docs).length < ids.length) {
    for (const it of r.json.items) {
      if (docs[it.ticket]) continue;
      try { docs[it.ticket] = JSON.parse(readFileSync(it.resultFile, 'utf8')); } catch { /* not yet, or half-written */ }
    }
    if (Object.keys(docs).length < ids.length) execFileSync('sleep', ['0.25']);
  }
  assert.equal(Object.keys(docs).length, ids.length, 'both background results were written');
  for (const id of ids) {
    assert.equal(docs[id].ok, true, JSON.stringify(docs[id]));
    assert.ok(docs[id].landed, `${id} did not land in the background`);
  }
});

test('land.mjs --background with a batch: a ticket with no queue item is refused inline and never holds up the rest', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ids = ['151', '152'];
  setupBatchLandable(dir, ids);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);

  const r = run('land.mjs', [[...ids, '999'].join(','), '--background'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.items.length, 3);
  const missing = r.json.items.find((it) => it.ticket === '999');
  assert.ok(missing);
  assert.equal(missing.started, false);
  assert.match(missing.note, /no queue item names 999/);
  for (const id of ids) {
    const it = r.json.items.find((x) => x.ticket === id);
    assert.equal(it.started, true, JSON.stringify(it));
  }

  const deadline = Date.now() + 90000;
  let bothLanded = false;
  while (Date.now() < deadline && !bothLanded) {
    const items = run('queue.mjs', ['list'], dir).json;
    bothLanded = ids.every((id) => items.find((i) => i.ticket === id)?.state === 'merged');
    if (!bothLanded) execFileSync('sleep', ['0.25']);
  }
  assert.ok(bothLanded, 'the two real tickets landed despite the third being unresolvable');
});
