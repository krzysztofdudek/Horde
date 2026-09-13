import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode, addAspect, yg, requireYg, MARKER_CHECK,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  node = 'feature', files = null, produces = null, evidence = null,
} = {}) {
  const dst = issueDir(dir, team, id);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'issue.md'), [
    `# ${id} · Sample ticket`, '',
    '**Status:** landed',
    `**Node:** ${node} · **Class:** standard · **Severity:** medium · **Team:** ${team}`,
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
  evidence = null,
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

  const branch = makeTicketBranch(dir, id, {
    extraFiles: marker
      ? { [`feature-${id}.mjs`]: 'export function add(a, b) { return a + b; } // UNFINISHED\n', ...extraFiles }
      : extraFiles,
  });
  const dst = writeIssue(dir, 'trunk', id, { ...(files ? { files } : {}), ...(evidence ? { evidence } : {}) });
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

test('land.mjs: the revert test says what it looked for when a diff really carries no new tests', async (t) => {
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
  assert.equal(item.ok, true, item.note);
  assert.match(item.note, /no new test files in diff \(looked for/);
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

test('land.mjs: the gate lock serializes two landings on one repository', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupLandable(dir, '021');
  // A gate slow enough that the second run is certain to meet the lock held, and a wait short
  // enough that it gives up inside this test rather than queueing behind it.
  run('horde.mjs', ['config', 'set', 'gates.team', 'sleep 6'], dir);
  run('horde.mjs', ['config', 'set', 'gateLockWaitMs', '1000'], dir);

  const spawnLand = () => new Promise((resolve) => {
    const child = spawn('node', [join(SCRIPTS_DIR, 'land.mjs'), branch, '--json'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });

  const [a, b] = await Promise.all([spawnLand(), (async () => { await new Promise((r) => { setTimeout(r, 1200); }); return spawnLand(); })()]);
  const both = [a, b];
  const refused = both.filter((x) => /holds the gate lock/.test(x.out + x.err));
  assert.equal(refused.length, 1, `exactly one run met the lock:\n${a.out}${a.err}\n---\n${b.out}${b.err}`);
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
  await new Promise((r) => { setTimeout(r, 1500); });

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
  await new Promise((r) => { setTimeout(r, 1500); });
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

// The parent ticket running on its own branch with one line of the file changed, and the child
// queued behind it — dependency recorded, so the stack can follow it.
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
  run('queue.mjs', ['add', parentId], dir);
  const parent = run('queue.mjs', ['set', parentId, 'running', '--agent', 'worker1'], dir).json;
  writeFileSync(join(parent.worktree, 'lib.mjs'), libWithLines({ [parentLine]: 500 }));
  git(['add', 'lib.mjs'], parent.worktree);
  git(['commit', '-qm', `ticket ${parentId}`], parent.worktree);
  run('tk.mjs', ['log', parentId, 'ready to land'], dir);

  const childId = run('tk.mjs', ['new', 'the-second-link', '--title', 'Second link', '--node', 'feature', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
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
