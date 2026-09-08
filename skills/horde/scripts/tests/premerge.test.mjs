import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, addNode, addAspect, yg, requireYg, MARKER_CHECK,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The graph rides on the branch. `yg check` reads the tree it is run in, and the merge checklist
// runs it in the branch's own worktree — so a component has to be committed before a ticket
// branches off it, exactly as the architect files one on a real mission.
function commitGraph(dir) {
  git(['checkout', '-q', 'mission1/trunk'], dir);
  git(['add', '.yggdrasil'], dir);
  git(['commit', '-qm', 'graph: the components this mission touches'], dir);
}

function issueDir(dir, team, id) {
  return join(dir, '.horde', 'hordes', 'mission1', 'teams', team, 'issues', `${id}-sample-ticket`);
}

function writeIssue(dir, team, id, {
  node = 'feature', keysLine = '**Keys:** author worker1 · verifier verifier1 · feature owner1',
  files = null, produces = null,
} = {}) {
  const dst = issueDir(dir, team, id);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'issue.md'), [
    `# ${id} · Sample ticket`, '',
    `**Status:** landed`,
    `**Node:** ${node} · **Class:** sonnet · **Severity:** medium · **Team:** ${team}`,
    `**Depends on:** none · **Branch:** mission1/t-${id}`,
    ...(files ? [`**Files:** ${files.join(', ')}`] : []),
    ...(produces ? [`**Consumes:** none · **Produces:** ${produces}`] : []),
    keysLine, '',
    '## Acceptance — evidence', '', '- [ ] does the thing', '',
  ].join('\n'));
  return dst;
}

function writeVerdictLog(dst, { result = 'reproduced', gateLine, whenIso } = {}) {
  const at = whenIso || new Date().toISOString();
  writeFileSync(join(dst, 'log.md'), [
    `## Verdict · ${dst.split('/').pop().split('-')[0]} · ${at.slice(0, 10)} · by verifier1 (sonnet)`, '',
    `**Result:** ${result}`, '',
    '**Base check:** rooted at `mission1/trunk` tip — yes', '',
    gateLine || '**Gate:** `true` — green', '',
    `<!-- recorded ${at} -->`, '',
  ].join('\n'));
}

function seedQueueItem(dir, team, id, branch) {
  const queuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', team, 'queue.json');
  const doc = JSON.parse(readFileSync(queuePath, 'utf8'));
  doc.items.push({
    ticket: id, state: 'landed', class: 'sonnet', branch, dependsOn: [], agent: 'worker1', sha: null, notes: [], worktree: null,
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
  for (const [path, content] of Object.entries(extraFiles)) { writeFileSync(join(dir, path), content); paths.push(path); }
  // Add only this ticket's own files — the working tree also holds the untracked graph the
  // fixture wrote (outside any branch), which `git add -A` would sweep into the commit and make
  // the diff look like it left the ticket's node boundary.
  git(['add', ...paths], dir);
  git(['commit', '-qm', `ticket ${id}`], dir);
  git(['checkout', 'mission1/trunk'], dir);
  return `mission1/t-${id}`;
}

test('premerge.mjs: all six checks pass', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-001.mjs', 'feature-001.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '001');
  const dst = writeIssue(dir, 'trunk', '001');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '001', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  for (const c of r.json.checks) assert.equal(c.ok, true, `${c.name}: ${c.note}`);
  const names = r.json.checks.map((c) => c.name);
  assert.deepEqual(names, ['base freshness', 'keys', 'scope', 'revert test', 'gate', 'graph', 'mapping', 'journal', 'graph text']);

  // A real revert test ran (this whole run happens inside our own `node --test`, so a false pass
  // via NODE_TEST_CONTEXT leaking into the nested run would show up as "no new test files").
  const revert = r.json.checks.find((c) => c.name === 'revert test');
  assert.doesNotMatch(revert.note, /no new test files/);
  assert.match(revert.note, /feature-001\.test\.mjs: 1 fail/);
});

test('premerge.mjs: item 1 fails — branch not rooted at the current team tip', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-002.mjs', 'feature-002.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '002');
  // Advance trunk after the ticket branched off it, so the ticket's merge-base is now stale.
  writeFileSync(join(dir, 'trunk-only.txt'), 'advance\n');
  git(['add', 'trunk-only.txt'], dir);
  git(['commit', '-qm', 'advance trunk'], dir);

  const dst = writeIssue(dir, 'trunk', '002');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '002', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  const item1 = r.json.checks.find((c) => c.name === 'base freshness');
  assert.equal(item1.ok, false);
  assert.match(item1.note, /STALE/);
});

test('premerge.mjs: item 2 fails — keys missing (no verifier, no node approval)', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-003.mjs', 'feature-003.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '003');
  const dst = writeIssue(dir, 'trunk', '003', { keysLine: '**Keys:** author worker1 · verifier —' });
  writeVerdictLog(dst, { result: 'not-reproduced' });
  seedQueueItem(dir, 'trunk', '003', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const item2 = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(item2.ok, false);
  assert.match(item2.note, /verifier=unset/);
});

test('premerge.mjs: item 2 fails — a node approval\'s sha (tk.mjs review\'s "name@sha" encoding) predates the branch\'s current tip', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-009.mjs', 'feature-009.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '009');
  const dst = writeIssue(dir, 'trunk', '009', {
    keysLine: '**Keys:** author worker1 · verifier verifier1 · feature owner1@deadbee',
  });
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '009', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, false);
  assert.match(keys.note, /approval\/verdict predates .+ — re-review/);
});

test('premerge.mjs: item 2 — a real tk.mjs review approval records the tip and the diff it was given, and a further commit that changes the diff sends it back', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-010.mjs', 'feature-010.test.mjs'] });
  commitGraph(dir);

  const ticket = run('tk.mjs', ['new', 'sha-bound', '--title', 'Sha bound', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir);
  const id = ticket.json.id;
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker1'], dir);
  const branch = running.json.branch;
  const worktree = running.json.worktree;
  writeFileSync(join(worktree, 'feature-010.mjs'), 'export function add(a, b) { return a + b; }\n');
  git(['add', '-A'], worktree);
  git(['commit', '-qm', 'ticket 010'], worktree);

  run('tk.mjs', ['key', id, 'author', '--by', 'worker1'], dir);
  const review = run('tk.mjs', ['review', id, 'approve', '--by', 'owner1'], dir);
  assert.equal(review.code, 0, review.stderr);
  const show = run('tk.mjs', ['show', id], dir);
  const tip = git(['rev-parse', '--short', branch], dir);
  assert.match(show.json.text, new RegExp(`feature owner1@${tip}\\+[0-9a-f]{40}`));

  const verdict = run('verify.mjs', ['record', id, '--verdict', 'reproduced', '--revert', 'failed', '--by', 'verifier1', '--gate', 'green', '--sha', tip, '--item', '1|npm test|green'], dir);
  assert.equal(verdict.code, 0, verdict.stderr);

  const r1 = run('premerge.mjs', [branch, '--no-gate'], dir);
  const keys1 = r1.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys1.ok, true, keys1.note);

  assert.match(keys1.note, /keys bound to diff [0-9a-f]{7}/);

  // A further commit adds a file to the ticket's own change — this is not a catch-up, it is a
  // different diff, and neither the approval nor the verdict covers it.
  writeFileSync(join(worktree, 'feature-010-extra.mjs'), 'export const extra = true;\n');
  git(['add', '-A'], worktree);
  git(['commit', '-qm', 'a further commit'], worktree);

  const r2 = run('premerge.mjs', [branch, '--no-gate'], dir);
  const keys2 = r2.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys2.ok, false);
  assert.match(keys2.note, /diff changed since review at [0-9a-f]{7} — scoped re-review: \S+/);
});

test('premerge.mjs: item 3 fails — diff touches a file outside the node boundary', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  // Boundary deliberately excludes the test file the branch also adds.
  addNode(dir, 'feature', { mapping: ['feature-004.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '004', { extraFiles: { 'outside-file.txt': 'not in the node\n' } });
  const dst = writeIssue(dir, 'trunk', '004');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '004', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const item3 = r.json.checks.find((c) => c.name === 'scope');
  assert.equal(item3.ok, false);
  assert.match(item3.note, /outside boundary/);
});

// A contract test that pins a surface already true on the parent branch by design — green there
// on purpose — with its intended failing base (an older state of the surface) reachable only via
// a named ref, not the parent's tip. Returns the ticket branch name.
function makeContractRevertFixture(dir, id) {
  git(['checkout', 'develop'], dir);
  writeFileSync(join(dir, `surface-${id}.mjs`), 'export function getValue() { return 0; }\n');
  git(['add', `surface-${id}.mjs`], dir);
  git(['commit', '-qm', 'old surface'], dir);
  initHorde(dir); // mission1/trunk branches off this develop tip — inherits getValue() === 0
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

test('premerge.mjs: item 4 uses the ticket\'s "**Revert base:**" header instead of the parent tip', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const branch = makeContractRevertFixture(dir, '020');

  // Without a revert base the parent tip is used, where the pinned test is green by design —
  // proving this is a real regression check, not a fixture that always passes.
  const dstNoBase = writeIssue(dir, 'trunk', '020', { node: 'feature' });
  writeVerdictLog(dstNoBase);
  seedQueueItem(dir, 'trunk', '020', branch);
  const withoutBase = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(withoutBase.code, 1);
  const revertWithoutBase = withoutBase.json.checks.find((c) => c.name === 'revert test');
  assert.equal(revertWithoutBase.ok, false);
  assert.match(revertWithoutBase.note, /0 fail/);

  // Re-seed the same ticket with a "**Revert base:**" header naming the ref where it's red.
  const issuePath = join(issueDir(dir, 'trunk', '020'), 'issue.md');
  writeFileSync(issuePath, readFileSync(issuePath, 'utf8').replace('**Depends on:**', '**Revert base:** develop\n**Depends on:**'));

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  const revert = r.json.checks.find((c) => c.name === 'revert test');
  assert.equal(revert.ok, true);
  assert.match(revert.note, /base develop/);
  assert.match(revert.note, /1 fail/);
});

test('premerge.mjs: item 4 falls back to a "red on <ref>" phrase in the acceptance lines', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const branch = makeContractRevertFixture(dir, '021');

  const dst = writeIssue(dir, 'trunk', '021', { node: 'feature' });
  const issueText = readFileSync(join(dst, 'issue.md'), 'utf8')
    .replace('- [ ] does the thing', '- [ ] pinned at 42 — red on develop, green after');
  writeFileSync(join(dst, 'issue.md'), issueText);
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '021', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  const revert = r.json.checks.find((c) => c.name === 'revert test');
  assert.equal(revert.ok, true);
  assert.match(revert.note, /base develop/);
});

test('premerge.mjs: item 6 fails — no log entry newer than the last commit', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-005.mjs', 'feature-005.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '005');
  const dst = writeIssue(dir, 'trunk', '005');
  // Verdict recorded, but dated well before the commit that will land just after.
  writeVerdictLog(dst, { whenIso: '2020-01-01T00:00:00.000Z' });
  seedQueueItem(dir, 'trunk', '005', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const item6 = r.json.checks.find((c) => c.name === 'journal');
  assert.equal(item6.ok, false);
  assert.match(item6.note, /predates/);
});

test('premerge.mjs: --no-gate skips item 5; a stubbed gates.team runs and caches when --no-gate is omitted', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  addNode(dir, 'feature', { mapping: ['feature-006.mjs', 'feature-006.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '006');
  const dst = writeIssue(dir, 'trunk', '006');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '006', branch);

  const wt = join(dir, '.horde', 'worktrees', 'mission1', 't-006');
  git(['worktree', 'add', wt, branch], dir);

  const r = run('premerge.mjs', [branch], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  const item5 = r.json.checks.find((c) => c.name === 'gate');
  assert.equal(item5.ok, true);

  const cache = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'cache', 'last-gate.json'), 'utf8'));
  assert.equal(cache.team.result, 'green');
});

test('premerge.mjs: item 5 accepts a verifier\'s green gate only when its sha matches the branch tip', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  // A gate that would fail if actually run, so "accepted without running" is unambiguous.
  run('horde.mjs', ['config', 'set', 'gates.team', 'false'], dir);
  addNode(dir, 'feature', { mapping: ['feature-007.mjs', 'feature-007.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '007');
  const branchSha = git(['rev-parse', branch], dir);
  const dst = writeIssue(dir, 'trunk', '007');
  writeVerdictLog(dst, { gateLine: `**Gate:** \`true\` — green at sha ${branchSha}` });
  seedQueueItem(dir, 'trunk', '007', branch);
  git(['worktree', 'add', join(dir, '.horde', 'worktrees', 'mission1', 't-007'), branch], dir);

  const r = run('premerge.mjs', [branch], dir); // no --no-gate: must not need to run gates.team="false"
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  const gate = r.json.checks.find((c) => c.name === 'gate');
  assert.match(gate.note, /accepted the verifier's recorded green gate/);
});

test('premerge.mjs: item 5 re-runs the gate when the verifier\'s recorded sha does not match the branch tip', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  addNode(dir, 'feature', { mapping: ['feature-008.mjs', 'feature-008.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '008');
  const dst = writeIssue(dir, 'trunk', '008');
  writeVerdictLog(dst, { gateLine: '**Gate:** `true` — green at sha 0000000stale' });
  seedQueueItem(dir, 'trunk', '008', branch);

  const wt = join(dir, '.horde', 'worktrees', 'mission1', 't-008');
  git(['worktree', 'add', wt, branch], dir);

  const r = run('premerge.mjs', [branch], dir);
  const gate = r.json.checks.find((c) => c.name === 'gate');
  assert.doesNotMatch(gate.note, /accepted the verifier's recorded/);
  assert.match(gate.note, /green \(true\)/);
  assert.equal(gate.ok, true);
  // A verdict's own recorded gate sha not matching the branch tip is exactly the same staleness
  // item 2 (keys) now refuses — a reproduced verdict for a commit that's no longer this branch's
  // tip is not a reproduction of what's on it now, whether or not the gate happens to re-run
  // green.
  assert.equal(r.code, 1);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, false);
  assert.match(keys.note, /approval\/verdict predates .+ — re-review/);
});

test('premerge.mjs: item 3 scope — a component\'s own graph files are inside its boundary, but the rest of the graph is not', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['src/feature/**'] });
  commitGraph(dir);

  git(['checkout', 'mission1/trunk'], dir);
  git(['checkout', '-b', 'mission1/t-010'], dir);
  mkdirSync(join(dir, 'src', 'feature'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.yggdrasil', 'model', 'feature', 'charter.md'), '# feature\n\nwhy it exists\n');
  git(['add', join('src', 'feature', 'a.mjs'), join('.yggdrasil', 'model', 'feature', 'charter.md')], dir);
  git(['commit', '-qm', 'ticket 010'], dir);
  git(['checkout', 'mission1/trunk'], dir);

  const dst = writeIssue(dir, 'trunk', '010');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '010', 'mission1/t-010');

  const ok = run('premerge.mjs', ['mission1/t-010', '--no-gate'], dir);
  if (ok.code !== 0) console.error(ok.stdout, ok.stderr);
  const okScope = ok.json.checks.find((c) => c.name === 'scope');
  assert.equal(okScope.ok, true, okScope.note);

  // A second ticket branch that also edits yg-architecture.yaml — not any component's own files —
  // must stay out of scope.
  git(['checkout', 'mission1/trunk'], dir);
  git(['checkout', '-b', 'mission1/t-011'], dir);
  mkdirSync(join(dir, 'src', 'feature'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature', 'b.mjs'), 'export const b = 2;\n');
  writeFileSync(join(dir, '.yggdrasil', 'yg-architecture.yaml'), 'node_types: {}\n# widened\n');
  git(['add', join('src', 'feature', 'b.mjs'), join('.yggdrasil', 'yg-architecture.yaml')], dir);
  git(['commit', '-qm', 'ticket 011'], dir);
  git(['checkout', 'mission1/trunk'], dir);

  const dst2 = writeIssue(dir, 'trunk', '011');
  writeVerdictLog(dst2);
  seedQueueItem(dir, 'trunk', '011', 'mission1/t-011');

  const bad = run('premerge.mjs', ['mission1/t-011', '--no-gate'], dir);
  assert.equal(bad.code, 1);
  const badScope = bad.json.checks.find((c) => c.name === 'scope');
  assert.equal(badScope.ok, false);
  assert.match(badScope.note, /yg-architecture\.yaml/);
});

test('premerge.mjs: item 3 scope — yg\'s committed lock files are derived, not out of scope', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['src/feature/**'] });
  commitGraph(dir);

  git(['checkout', 'mission1/trunk'], dir);
  git(['checkout', '-b', 'mission1/t-012'], dir);
  mkdirSync(join(dir, 'src', 'feature'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature', 'c.mjs'), 'export const c = 3;\n');
  writeFileSync(join(dir, '.yggdrasil', 'model', 'feature', 'log.md'), '# log\n\n- entry\n');
  writeFileSync(join(dir, '.yggdrasil', 'yg-lock.logs.json'), '{"version":1,"nodes":{"feature":{}}}\n');
  git(['add', join('src', 'feature', 'c.mjs'), join('.yggdrasil', 'model', 'feature', 'log.md'), join('.yggdrasil', 'yg-lock.logs.json')], dir);
  git(['commit', '-qm', 'ticket 012'], dir);
  git(['checkout', 'mission1/trunk'], dir);

  const dst = writeIssue(dir, 'trunk', '012');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '012', 'mission1/t-012');

  const r = run('premerge.mjs', ['mission1/t-012', '--no-gate'], dir);
  const scope = r.json.checks.find((c) => c.name === 'scope');
  assert.equal(scope.ok, true, scope.note);
  assert.match(scope.note, /derived lock files left to yg check: \.yggdrasil\/yg-lock\.logs\.json/);
});

// A sub-team ("goblins") merging up into trunk: represented in trunk's own queue.json as an item
// named "team:goblins" whose branch is the child team's own mission1/goblins — the shape
// queue.mjs and roster.mjs's steward spawn are contracted to produce.
function writeIssueAt(teamDir, id, {
  node = 'feature', keysLine = '**Keys:** author worker1 · verifier verifier1 · feature owner1',
} = {}) {
  const dst = join(teamDir, 'issues', `${id}-sample-ticket`);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'issue.md'), [
    `# ${id} · Sample ticket`, '',
    '**Status:** merged',
    `**Node:** ${node} · **Class:** sonnet · **Severity:** medium · **Team:** goblins`,
    `**Depends on:** none · **Branch:** mission1/t-${id}`,
    keysLine, '',
    '## Acceptance — evidence', '', '- [ ] does the thing', '',
  ].join('\n'));
  writeVerdictLog(dst);
  return dst;
}

function setupTeamMergeUp(dir, { ticketMerged = true, ticketState } = {}) {
  const resolvedState = ticketState || (ticketMerged ? 'merged' : 'running');
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-101.mjs'] });
  commitGraph(dir);

  const childTeamDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'teams', 'goblins');
  mkdirSync(join(childTeamDir, 'issues'), { recursive: true });

  git(['checkout', '-b', 'mission1/goblins', 'mission1/trunk'], dir);
  git(['checkout', '-b', 'mission1/t-101', 'mission1/goblins'], dir);
  writeFileSync(join(dir, 'feature-101.mjs'), 'export const flag = true;\n');
  // Also touches the node's own graph file — proves the team-mode scope union (over the team's
  // tickets' nodes) counts a node's graph files as in scope too, the same as ticket mode.
  writeFileSync(join(dir, '.yggdrasil', 'model', 'feature', 'charter.md'), '# Node · feature\n\nrefreshed\n');
  git(['add', 'feature-101.mjs', join('.yggdrasil', 'model', 'feature', 'charter.md')], dir);
  git(['commit', '-qm', 'ticket 101'], dir);
  git(['checkout', 'mission1/goblins'], dir);
  git(['merge', '--no-ff', 'mission1/t-101', '-m', 'merge ticket 101'], dir);
  git(['checkout', 'mission1/trunk'], dir);

  writeIssueAt(childTeamDir, '101');
  writeFileSync(join(childTeamDir, 'queue.json'), JSON.stringify({
    items: [{
      ticket: '101', state: resolvedState, class: 'sonnet', branch: 'mission1/t-101', dependsOn: [], agent: 'worker1', sha: null, notes: [], worktree: null,
    }],
  }, null, 2));
  writeFileSync(join(childTeamDir, 'plan.md'), `# Wave 1 — close ${new Date().toISOString().slice(0, 10)}\n\n**Merged:** 1 tickets\n`);

  const trunkQueuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json');
  const trunkQueue = JSON.parse(readFileSync(trunkQueuePath, 'utf8'));
  trunkQueue.items.push({
    ticket: 'team:goblins', state: 'landed', class: null, branch: 'mission1/goblins', dependsOn: [], agent: null, sha: null, notes: [], worktree: null,
  });
  writeFileSync(trunkQueuePath, JSON.stringify(trunkQueue, null, 2));
}

test('premerge.mjs: team merge-up mode — every child ticket merged+keyed, revert test skipped', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  setupTeamMergeUp(dir);

  const r = run('premerge.mjs', ['mission1/goblins', '--no-gate'], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.match(keys.note, /1 ticket\(s\) merged, each with two keys/);
  const revert = r.json.checks.find((c) => c.name === 'revert test');
  assert.match(revert.note, /skipped/);
  const scope = r.json.checks.find((c) => c.name === 'scope');
  assert.equal(scope.ok, true);
});

test('premerge.mjs: team merge-up mode fails item 2 when one of the child\'s tickets is not merged', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  setupTeamMergeUp(dir, { ticketMerged: false });

  const r = run('premerge.mjs', ['mission1/goblins', '--no-gate'], dir);
  assert.equal(r.code, 1);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, false);
  assert.match(keys.note, /101: running/);
});

// A team lands only with an empty queue — every state but "merged" blocks, including a ticket
// that was never even started ("queued") or one waiting on class availability ("waiting"), not
// just one already running.
for (const state of ['queued', 'waiting']) {
  test(`premerge.mjs: team merge-up mode fails item 2 when one of the child's tickets is still "${state}"`, async (t) => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    setupTeamMergeUp(dir, { ticketState: state });

    const r = run('premerge.mjs', ['mission1/goblins', '--no-gate'], dir);
    assert.equal(r.code, 1);
    const keys = r.json.checks.find((c) => c.name === 'keys');
    assert.equal(keys.ok, false);
    assert.match(keys.note, new RegExp(`101: ${state}`));
  });
}

// ---- the graph gate ----------------------------------------------------------------
//
// The real Yggdrasil CLI on a real graph, in the branch's own worktree. Nothing is stood in for:
// the rule is a check.mjs the CLI runs, the refusal is one it produces, and the verdict that
// clears a prose rule is one the external-judge channel records. What is under test is that the
// merge checklist runs the free half itself, names what is left for a judge, and ticks only when
// a full `yg check` is green.
function setupGraphGateRepo(dir, id, { marker = false, prose = false, judge = true, files = null } = {}) {
  initHorde(dir);
  if (prose) {
    // A reviewer tier gives the graph an identity a verdict can bind to — no key, no judge.
    if (judge) assert.equal(yg(dir, ['init', '--provider', 'claude-code', '--model', 'sonnet']).code, 0);
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
    mapping: [`feature-${id}.mjs`, `feature-${id}.test.mjs`],
    aspects: prose ? ['no-marker', 'reads-well'] : ['no-marker'],
  });
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir); // the level's gate is green

  commitGraph(dir);

  const branch = makeTicketBranch(dir, id, marker
    ? { extraFiles: { [`feature-${id}.mjs`]: 'export function add(a, b) { return a + b; } // UNFINISHED\n' } }
    : {});
  const dst = writeIssue(dir, 'trunk', id, files ? { files } : {});
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', id, branch);
  const wt = join(dir, '.horde', 'worktrees', 'mission1', `t-${id}`);
  git(['worktree', 'add', wt, branch], dir);
  return { branch, worktree: wt };
}

test('premerge.mjs: horde.mjs init says the graph check is in the merge gate', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', '--yg', requireYg()], dir, { json: false });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /check` is part of every merge check/);
});

test('premerge.mjs: the graph gate is red when the graph refuses the tree, even with a green level gate', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = setupGraphGateRepo(dir, '020', { marker: true });

  const r = run('premerge.mjs', [branch], dir);
  assert.equal(r.code, 1);
  const gate = r.json.checks.find((c) => c.name === 'gate');
  assert.equal(gate.ok, true, 'the level gate is green — only the graph refuses');
  const graph = r.json.checks.find((c) => c.name === 'graph');
  assert.equal(graph.ok, false);
  assert.match(graph.note, /the graph refuses this tree/);
  assert.equal(r.json.ok, false);
});

test('premerge.mjs: the graph gate is green once the free deterministic verdicts are recorded', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, worktree } = setupGraphGateRepo(dir, '021');

  // Nothing has been recorded yet — the item runs the free half itself, which is the point.
  assert.equal(yg(worktree, ['check']).code, 1, 'a fresh worktree starts with every pair unverified');

  const r = run('premerge.mjs', [branch], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  const graph = r.json.checks.find((c) => c.name === 'graph');
  assert.equal(graph.ok, true);
  assert.match(graph.note, /green/);
});

test('premerge.mjs: the graph item names the prose rules a judge still owes a verdict on, and ticks once they are judged', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch, worktree } = setupGraphGateRepo(dir, '024', { prose: true });

  const pending = run('premerge.mjs', [branch], dir);
  assert.equal(pending.code, 1);
  const graph = pending.json.checks.find((c) => c.name === 'graph');
  assert.equal(graph.ok, false);
  assert.deepEqual(graph.pending.map((p) => `${p.aspect} ${p.unitKind}:${p.unit}`), ['reads-well node:feature']);
  assert.match(graph.note, /script rules are recorded/);
  assert.match(graph.note, /reads-well on node:feature/);
  assert.match(graph.note, /node\.mjs verdicts --at/);

  // The verifier judges it under its own name, through the channel the brief names.
  const pkg = JSON.parse(yg(worktree, ['verdict', 'package', '--aspect', 'reads-well', '--node', 'feature']).out);
  const recorded = yg(worktree, ['verdict', 'record', '--aspect', 'reads-well', '--node', 'feature',
    '--by', 'verifier1', '--verdict', 'pass', '--hash', pkg.hashes.pass]);
  assert.equal(recorded.code, 0, recorded.out);

  const after = run('premerge.mjs', [branch], dir);
  if (after.code !== 0) console.error(after.stdout, after.stderr);
  assert.equal(after.code, 0);
  assert.equal(after.json.checks.find((c) => c.name === 'graph').ok, true);
});

test('premerge.mjs: a graph whose free run will not even start hands over what it said, and names no pairs', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // A judgement rule with nowhere to judge from: the CLI refuses to record anything at all, so
  // not even the script rules get their free verdicts. Naming pairs here would send the verifier
  // off to read a rule a command answers for nothing.
  const { branch } = setupGraphGateRepo(dir, '025', { prose: true, judge: false });

  const r = run('premerge.mjs', [branch], dir);
  assert.equal(r.code, 1);
  const graph = r.json.checks.find((c) => c.name === 'graph');
  assert.equal(graph.ok, false);
  assert.equal(graph.pending, undefined, 'nothing is named as prose until the free half has run');
  assert.match(graph.note, /the free half did not take/);
  assert.match(graph.note, /has no judge/);
});

test('premerge.mjs: the graph gate refuses rather than passes when the Yggdrasil CLI cannot be run', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // The ticket declares its own files, so the scope item never asks the graph for a boundary —
  // which leaves the graph item as the one place a CLI that cannot start has to show up.
  const { branch } = setupGraphGateRepo(dir, '022', { files: ['feature-022.mjs', 'feature-022.test.mjs'] });
  run('horde.mjs', ['config', 'set', 'ygCommand', join(dir, 'no-such-yg-binary')], dir);

  const r = run('premerge.mjs', [branch], dir);
  assert.equal(r.code, 1);
  const graph = r.json.checks.find((c) => c.name === 'graph');
  assert.equal(graph.ok, false);
  assert.match(graph.note, /cannot run/);
  assert.match(graph.note, /config\.ygCommand/);
});

test('premerge.mjs: --no-gate says the graph was not judged, rather than ticking it quietly', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-023.mjs', 'feature-023.test.mjs'] });
  const branch = makeTicketBranch(dir, '023');
  const dst = writeIssue(dir, 'trunk', '023');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '023', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 0, r.stderr);
  const graph = r.json.checks.find((c) => c.name === 'graph');
  assert.ok(graph, 'the graph item is always on the checklist');
  assert.equal(graph.ok, true);
  assert.match(graph.note, /skipped \(--no-gate\)/);
});

test('premerge.mjs: item 4 refuses when this repository\'s test convention is unknown', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // No --test-globs, and a fixture repo with no build files: nothing tells the checklist what a
  // test file is called here.
  run('horde.mjs', ['init', 'mission1', '--base', 'develop', '--yg', requireYg()], dir);
  addNode(dir, 'feature', { mapping: ['feature-030.mjs', 'feature-030.test.mjs'] });

  const branch = makeTicketBranch(dir, '030');
  const dst = writeIssue(dir, 'trunk', '030');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '030', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const revert = r.json.checks.find((c) => c.name === 'revert test');
  assert.equal(revert.ok, false);
  assert.match(revert.note, /cannot recognise a test file in this repository/);
  assert.match(revert.note, /config set testGlobs/);
});

test('premerge.mjs: item 4 says what it looked for when a diff really carries no new tests', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1', ['--test-globs', '**/*Tests.java']);
  addNode(dir, 'feature', { mapping: ['feature-031.mjs', 'feature-031.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '031');
  const dst = writeIssue(dir, 'trunk', '031');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '031', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  const revert = r.json.checks.find((c) => c.name === 'revert test');
  assert.equal(revert.ok, true);
  // The Java patterns match nothing in this diff — and the note names them, so the ✓ cannot be
  // read as "there were no tests to find" when it means "none matching these".
  assert.match(revert.note, /no new test files in diff \(looked for \*\*\/\*Tests\.java\)/);
});

test('premerge.mjs: item 3 scope — a diff outside the files the ticket declared is refused', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  // The node's boundary is wide enough for all three files; the ticket declared only two of them.
  addNode(dir, 'feature', { mapping: ['feature-040.mjs', 'feature-040.test.mjs', 'extra-040.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '040', { extraFiles: { 'extra-040.mjs': 'export const x = 1;\n' } });
  const dst = writeIssue(dir, 'trunk', '040', { files: ['feature-040.mjs', 'feature-040.test.mjs'] });
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '040', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(r.code, 1);
  const scope = r.json.checks.find((c) => c.name === 'scope');
  assert.equal(scope.ok, false);
  assert.match(scope.note, /declared 2 files, touched extra-040\.mjs outside them/);
  assert.match(scope.note, /tk\.mjs edit --files/);
});

test('premerge.mjs: item 3 scope — declaring the file the diff touches makes it pass, and a ticket with no Files falls back to the node boundary', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-041.mjs', 'feature-041.test.mjs', 'extra-041.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '041', { extraFiles: { 'extra-041.mjs': 'export const x = 1;\n' } });
  const dst = writeIssue(dir, 'trunk', '041', {
    files: ['feature-041.mjs', 'feature-041.test.mjs', 'extra-041.mjs'],
  });
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '041', branch);

  const declared = run('premerge.mjs', [branch, '--no-gate'], dir);
  const declaredScope = declared.json.checks.find((c) => c.name === 'scope');
  assert.equal(declaredScope.ok, true, declaredScope.note);
  assert.match(declaredScope.note, /diff inside the 3 declared file\(s\)/);

  // The same branch on a ticket that declares nothing: the node's boundary is what holds, exactly
  // as it did before the field existed.
  writeIssue(dir, 'trunk', '041');
  writeVerdictLog(dst);
  const undeclared = run('premerge.mjs', [branch, '--no-gate'], dir);
  const undeclaredScope = undeclared.json.checks.find((c) => c.name === 'scope');
  assert.equal(undeclaredScope.ok, true, undeclaredScope.note);
  assert.match(undeclaredScope.note, /diff inside node boundary/);
});

test('premerge.mjs: item 2 keys — a ticket that raises a port\'s version owes an approval to every node that consumes it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-042.mjs', 'feature-042.test.mjs'] });
  commitGraph(dir);
  addNode(dir, 'downstream', {
    mapping: ['src/downstream/**'],
    relations: [{ target: 'feature', type: 'uses' }],
  });

  const branch = makeTicketBranch(dir, '042');
  const dst = writeIssue(dir, 'trunk', '042', { produces: 'feature/api@2' });
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '042', branch);

  const missing = run('premerge.mjs', [branch, '--no-gate'], dir);
  assert.equal(missing.code, 1);
  const keys = missing.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, false);
  assert.match(keys.note, /downstream=missing/);

  // Once the consuming node's owner has approved, the same checklist is satisfied.
  writeIssue(dir, 'trunk', '042', {
    produces: 'feature/api@2',
    keysLine: '**Keys:** author worker1 · verifier verifier1 · feature owner1 · downstream owner2',
  });
  writeVerdictLog(dst);
  const approved = run('premerge.mjs', [branch, '--no-gate'], dir);
  const keys2 = approved.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys2.ok, true, keys2.note);
  assert.match(keys2.note, /downstream=owner2/);
});

// ---- keys bound to the ticket's own diff -------------------------------------------------
//
// The whole point of item 2 binding to the diff rather than to the branch tip: a team branch that
// moves under a ticket costs it nothing, unless what moved reached into the ticket's own change.
// These four go through the real tools (queue, tk, verify) on a real file, because what is being
// tested is exactly the recorded shape of a key — a hand-written imitation would prove nothing.

const LIB_LINES = Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`);

function libWith(line, value) {
  const lines = [...LIB_LINES];
  lines[line - 1] = `export const v${line} = ${value};`;
  return `${lines.join('\n')}\n`;
}

// A ticket carried all the way to two live keys: a 40-line file on the team branch, one line of it
// changed on the ticket's own branch, the author key, the owner's approval and a reproduced
// verdict — each recorded by the tool that really records it.
function reviewedTicket(dir, slug) {
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  git(['checkout', 'mission1/trunk'], dir);
  writeFileSync(join(dir, 'lib.mjs'), `${LIB_LINES.join('\n')}\n`);
  writeFileSync(join(dir, 'other.mjs'), 'export const other = 0;\n');
  git(['add', 'lib.mjs', 'other.mjs'], dir);
  git(['commit', '-qm', 'the files the ticket will change'], dir);
  addNode(dir, 'feature', { mapping: ['lib.mjs', 'other.mjs'] });
  commitGraph(dir);

  const created = run('tk.mjs', ['new', slug, '--title', 'One line in the middle', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir);
  const id = created.json.id;
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'worker1'], dir);
  const { branch, worktree } = running.json;

  writeFileSync(join(worktree, 'lib.mjs'), libWith(20, 2000));
  git(['add', 'lib.mjs'], worktree);
  git(['commit', '-qm', `ticket ${id}`], worktree);

  run('tk.mjs', ['key', id, 'author', '--by', 'worker1'], dir);
  const approve = run('tk.mjs', ['review', id, 'approve', '--by', 'owner1'], dir);
  assert.equal(approve.code, 0, approve.stderr);
  const tip = git(['rev-parse', '--short', branch], dir);
  const verdict = run('verify.mjs', ['record', id, '--verdict', 'reproduced', '--revert', 'no-new-tests', '--by', 'verifier1', '--gate', 'green', '--sha', tip, '--item', '1|npm test|green'], dir);
  assert.equal(verdict.code, 0, verdict.stderr);
  return {
    id, branch, worktree, tip, approve, verdict,
  };
}

// A sibling ticket landing on the team branch — what makes every other branch in flight stale.
function landOnTeamBranch(dir, files, message = 'a sibling ticket lands') {
  git(['checkout', 'mission1/trunk'], dir);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  git(['add', ...Object.keys(files)], dir);
  git(['commit', '-qm', message], dir);
}

function tryMerge(worktree, ref) {
  try {
    return { ok: true, output: git(['merge', ref, '-m', `catch up with ${ref}`], worktree) };
  } catch (e) {
    return { ok: false, output: (e.stdout || '').toString() + (e.stderr || '').toString() };
  }
}

test('premerge.mjs: item 2 — a landing in another file moves the tip, not the diff, and both keys travel with it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ticket = reviewedTicket(dir, 'keys-travel');

  const before = run('premerge.mjs', [ticket.branch], dir);
  assert.equal(before.json.ok, true, JSON.stringify(before.json.checks));

  landOnTeamBranch(dir, { 'other.mjs': 'export const other = 1;\n' });
  const merge = tryMerge(ticket.worktree, 'mission1/trunk');
  assert.equal(merge.ok, true, merge.output);
  run('tk.mjs', ['log', ticket.id, 'caught the team branch up'], dir);

  const r = run('premerge.mjs', [ticket.branch], dir);
  assert.equal(r.code, 0, JSON.stringify(r.json && r.json.checks));
  const base = r.json.checks.find((c) => c.name === 'base freshness');
  assert.equal(base.ok, true, base.note);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, true, keys.note);
  assert.match(keys.note, /keys bound to diff [0-9a-f]{7}/);
  assert.doesNotMatch(keys.note, /re-review/);
  // The gate is tied to the tree, not to the diff: it runs again, for free, on the new tip.
  const gate = r.json.checks.find((c) => c.name === 'gate');
  assert.equal(gate.ok, true);
  assert.match(gate.note, /green \(true\)/);
  assert.doesNotMatch(gate.note, /accepted the verifier's recorded/);
});

test('premerge.mjs: item 2 — a transfer of keys is written into the wave journal, once', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ticket = reviewedTicket(dir, 'transfer-noted');
  const journal = join(dir, '.horde', 'hordes', 'mission1', 'plan.md');

  // Before any catch-up the keys were given at the tip they are still on: nothing travelled.
  run('premerge.mjs', [ticket.branch], dir);
  assert.doesNotMatch(readFileSync(journal, 'utf8'), /keys transferred/);

  landOnTeamBranch(dir, { 'other.mjs': 'export const other = 1;\n' });
  assert.equal(tryMerge(ticket.worktree, 'mission1/trunk').ok, true);
  run('tk.mjs', ['log', ticket.id, 'caught the team branch up'], dir);

  const r = run('premerge.mjs', [ticket.branch], dir);
  assert.equal(r.code, 0, JSON.stringify(r.json && r.json.checks));
  // Both keys — the owner's approval and the verifier's verdict — survived the catch-up.
  const bullet = new RegExp(`^- \\S+ keys transferred: ${ticket.id} 2 at diff [0-9a-f]{7}$`, 'm');
  assert.match(readFileSync(journal, 'utf8'), bullet);

  run('premerge.mjs', [ticket.branch], dir);
  const lines = readFileSync(journal, 'utf8').split('\n').filter((l) => l.includes('keys transferred'));
  assert.equal(lines.length, 1, 'a transfer is one event and costs one journal line');
});

test('premerge.mjs: item 2 — a landing inside the reviewed hunk\'s context changes the diff and asks for a scoped re-review', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ticket = reviewedTicket(dir, 'diff-changed');

  // Two lines below the ticket's own change: inside its context, so the merge is clean but what
  // the owner and the verifier read is no longer what is on the branch.
  landOnTeamBranch(dir, { 'lib.mjs': libWith(22, 999) });
  const merge = tryMerge(ticket.worktree, 'mission1/trunk');
  assert.equal(merge.ok, true, merge.output);
  run('tk.mjs', ['log', ticket.id, 'caught the team branch up'], dir);

  const r = run('premerge.mjs', [ticket.branch], dir);
  assert.equal(r.code, 1);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, false);
  assert.match(keys.note, /diff changed since review at [0-9a-f]{7} — scoped re-review: \S+/);
  assert.doesNotMatch(keys.note, /keys bound to diff/);

  const path = /scoped re-review: (\S+)/.exec(keys.note)[1];
  assert.match(path, /rereview-[0-9a-f]{7}\.\.[0-9a-f]{7}\.diff$/);
  // The file is the commit-by-commit comparison of what was approved against what is there now:
  // here the ticket's own commit is carried over unchanged, and what moved is the base under it.
  const delta = readFileSync(join(dir, path), 'utf8');
  assert.match(delta, new RegExp(`ticket ${ticket.id}`));
});

test('premerge.mjs: item 2 — an approval recorded with a sha alone stays bound to that commit, catch-up or not', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-040.mjs', 'feature-040.test.mjs', 'other-040.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '040');
  const tip = git(['rev-parse', '--short', branch], dir);
  const dst = writeIssue(dir, 'trunk', '040', {
    keysLine: `**Keys:** author worker1 · verifier verifier1 · feature owner1@${tip}`,
  });
  writeVerdictLog(dst, { gateLine: `**Gate:** \`true\` — green at sha ${tip}` });
  seedQueueItem(dir, 'trunk', '040', branch);

  const before = run('premerge.mjs', [branch, '--no-gate'], dir);
  const keysBefore = before.json.checks.find((c) => c.name === 'keys');
  assert.equal(keysBefore.ok, true, keysBefore.note);
  assert.doesNotMatch(keysBefore.note, /keys bound to diff/);

  // A landing elsewhere, then the same catch-up merge that costs a diff-bound key nothing.
  landOnTeamBranch(dir, { 'other-040.mjs': 'export const other = 1;\n' });
  git(['checkout', branch], dir);
  git(['merge', 'mission1/trunk', '-m', 'catch up'], dir);
  git(['checkout', 'mission1/trunk'], dir);

  const after = run('premerge.mjs', [branch, '--no-gate'], dir);
  const keys = after.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, false);
  assert.match(keys.note, /approval\/verdict predates [0-9a-f]{7} — re-review/);
  assert.doesNotMatch(keys.note, /scoped re-review/);
});

test('premerge.mjs: item 2 — a landing on the adjacent line conflicts, and the ticket goes back to its author untouched', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ticket = reviewedTicket(dir, 'adjacent');
  const tipBefore = git(['rev-parse', ticket.branch], dir);

  landOnTeamBranch(dir, { 'lib.mjs': libWith(21, 999) });
  const merge = tryMerge(ticket.worktree, 'mission1/trunk');
  assert.equal(merge.ok, false);
  assert.match(merge.output, /CONFLICT/);
  git(['merge', '--abort'], ticket.worktree);
  assert.equal(git(['rev-parse', ticket.branch], dir), tipBefore);

  // Nothing was asked of the reviewers: the branch is exactly where the author left it, the keys
  // still hold, and the only red item is the base the author must catch up with.
  const r = run('premerge.mjs', [ticket.branch], dir);
  assert.equal(r.code, 1);
  const base = r.json.checks.find((c) => c.name === 'base freshness');
  assert.equal(base.ok, false);
  assert.match(base.note, /STALE/);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, true, keys.note);
  assert.match(keys.note, /keys bound to diff [0-9a-f]{7}/);
});

test('premerge.mjs: item 2 — an approval given from the verifier seat is read like any other, and travels with the diff', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const ticket = reviewedTicket(dir, 'seat-travels');

  // The same recorded approval, given from the verifier's seat: the marker sits in the name, so
  // what item 2 holds it to is still the diff after it.
  const issueDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues');
  const dirName = readdirSync(issueDir).find((n) => n.startsWith(ticket.id));
  const issuePath = join(issueDir, dirName, 'issue.md');
  const seated = readFileSync(issuePath, 'utf8').replace(/(feature )([^\s@]+)@/, '$1$2(verifier-seat)@');
  writeFileSync(issuePath, seated);
  assert.match(seated, /feature \S+\(verifier-seat\)@[0-9a-f]+\+[0-9a-f]{40}/);

  landOnTeamBranch(dir, { 'other.mjs': 'export const other = 1;\n' });
  const merge = tryMerge(ticket.worktree, 'mission1/trunk');
  assert.equal(merge.ok, true, merge.output);
  run('tk.mjs', ['log', ticket.id, 'caught the team branch up'], dir);

  const r = run('premerge.mjs', [ticket.branch, '--no-gate'], dir);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, true, keys.note);
  assert.match(keys.note, /keys bound to diff [0-9a-f]{7}/);
  assert.match(keys.note, /\(verifier-seat\)/);
});

// ---- a ticket started from an unmerged dependency's tip (a stack) --------------------------
//
// The second ticket of a chain, written and reviewed while the first is still in flight. Every
// question with the word "parent" in it — where the base is, what the diff contains, what the
// keys are bound to, what a moved diff is compared against — has to be answered with the first
// ticket's branch until it merges, and with the team branch from the moment it does. If it is
// not, the keys die on the catch-up that follows the parent's merge, and the stack has bought
// nothing: the second ticket pays for a second review exactly as if it had waited a wave.

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
  git(['checkout', 'mission1/trunk'], dir);
  writeFileSync(join(dir, 'lib.mjs'), `${LIB_LINES.join('\n')}\n`);
  writeFileSync(join(dir, 'other.mjs'), 'export const other = 0;\n');
  git(['add', 'lib.mjs', 'other.mjs'], dir);
  git(['commit', '-qm', 'the files both tickets change'], dir);
  addNode(dir, 'feature', { mapping: ['lib.mjs', 'other.mjs'] });
  commitGraph(dir);

  const parentId = run('tk.mjs', ['new', 'the-first-link', '--title', 'First link', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  run('queue.mjs', ['add', parentId], dir);
  const parent = run('queue.mjs', ['set', parentId, 'running', '--agent', 'worker1'], dir).json;
  writeFileSync(join(parent.worktree, 'lib.mjs'), libWithLines({ [parentLine]: 500 }));
  git(['add', 'lib.mjs'], parent.worktree);
  git(['commit', '-qm', `ticket ${parentId}`], parent.worktree);

  const childId = run('tk.mjs', ['new', 'the-second-link', '--title', 'Second link', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  run('queue.mjs', ['add', childId, '--depends', parentId], dir);
  const started = run('queue.mjs', ['set', childId, 'running', '--agent', 'worker2', '--on', parentId], dir);
  assert.equal(started.code, 0, started.stderr);
  const child = started.json;

  // The child's own line, on top of what the parent already changed under it.
  writeFileSync(join(child.worktree, 'lib.mjs'), libWithLines({ [parentLine]: 500, [childLine]: 3000 }));
  git(['add', 'lib.mjs'], child.worktree);
  git(['commit', '-qm', `ticket ${childId}`], child.worktree);

  run('tk.mjs', ['key', childId, 'author', '--by', 'worker2'], dir);
  const approve = run('tk.mjs', ['review', childId, 'approve', '--by', 'owner1'], dir);
  assert.equal(approve.code, 0, approve.stderr);
  const childTip = git(['rev-parse', '--short', child.branch], dir);
  const verdict = run('verify.mjs', ['record', childId, '--verdict', 'reproduced', '--revert', 'no-new-tests', '--by', 'verifier1', '--gate', 'green', '--sha', childTip, '--item', '1|npm test|green'], dir);
  assert.equal(verdict.code, 0, verdict.stderr);

  return { parentId, parent, childId, child };
}

// The parent keyed, merged into the team branch and recorded as merged — the moment the stack ends.
function landTheParent(dir, parentId, parentBranch) {
  run('tk.mjs', ['key', parentId, 'author', '--by', 'worker1'], dir);
  run('tk.mjs', ['review', parentId, 'approve', '--by', 'owner1'], dir);
  const tip = git(['rev-parse', '--short', parentBranch], dir);
  run('verify.mjs', ['record', parentId, '--verdict', 'reproduced', '--revert', 'no-new-tests', '--by', 'verifier1', '--gate', 'green', '--sha', tip, '--item', '1|npm test|green'], dir);
  git(['checkout', 'mission1/trunk'], dir);
  git(['merge', '--no-ff', parentBranch, '-m', `merge ${parentId}`], dir);
  const sha = git(['rev-parse', '--short', 'mission1/trunk'], dir);
  const merged = run('queue.mjs', ['set', parentId, 'merged', '--sha', sha], dir);
  assert.equal(merged.code, 0, merged.stderr);
  return merged;
}

test('premerge.mjs: a stacked ticket is measured against its parent, and its keys survive the parent landing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const {
    parentId, parent, childId, child,
  } = chainOfTwo(dir);

  await t.test('while the parent is unmerged, every item reads against the parent\'s branch', () => {
    const r = run('premerge.mjs', [child.branch], dir);
    assert.equal(r.code, 0, JSON.stringify(r.json && r.json.checks));
    assert.equal(r.json.parent, parent.branch);
    assert.equal(r.json.stackedOn, parentId);
    const base = r.json.checks.find((c) => c.name === 'base freshness');
    assert.equal(base.ok, true, base.note);
    assert.match(base.note, new RegExp(`rooted at ${parent.branch} tip`));
    const keys = r.json.checks.find((c) => c.name === 'keys');
    assert.equal(keys.ok, true, keys.note);
    assert.match(keys.note, /keys bound to diff [0-9a-f]{7}/);
  });

  await t.test('the parent lands: the stack is cleared and the child catches up with the team', () => {
    landTheParent(dir, parentId, parent.branch);
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === childId);
    assert.equal(item.stackedOn, null);

    const merge = tryMerge(child.worktree, 'mission1/trunk');
    assert.equal(merge.ok, true, merge.output);
    run('tk.mjs', ['log', childId, 'caught the team branch up'], dir);
  });

  await t.test('and the keys hold: the parent is the team branch now, the diff is the same one', () => {
    const r = run('premerge.mjs', [child.branch], dir);
    assert.equal(r.code, 0, JSON.stringify(r.json && r.json.checks));
    assert.equal(r.json.parent, 'mission1/trunk');
    assert.equal(r.json.stackedOn, null);

    const base = r.json.checks.find((c) => c.name === 'base freshness');
    assert.equal(base.ok, true, base.note);
    assert.match(base.note, /rooted at mission1\/trunk tip/);
    const keys = r.json.checks.find((c) => c.name === 'keys');
    assert.equal(keys.ok, true, keys.note);
    assert.match(keys.note, /keys bound to diff [0-9a-f]{7}/);
    assert.doesNotMatch(keys.note, /re-review/);
    // The gate is tied to the tree, so it runs again on the merged one — nothing is carried over
    // but the human judgement.
    const gate = r.json.checks.find((c) => c.name === 'gate');
    assert.equal(gate.ok, true, gate.note);
    assert.match(gate.note, /green \(true\)/);
  });

  await t.test('the child then merges in its turn', () => {
    git(['checkout', 'mission1/trunk'], dir);
    git(['merge', '--no-ff', child.branch, '-m', `merge ${childId}`], dir);
    const sha = git(['rev-parse', '--short', 'mission1/trunk'], dir);
    const merged = run('queue.mjs', ['set', childId, 'merged', '--sha', sha], dir);
    assert.equal(merged.code, 0, merged.stderr);
  });
});

test('premerge.mjs: a parent amended inside the stacked ticket\'s own context sends its keys to a scoped re-review', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { parent, childId, child } = chainOfTwo(dir);

  // The parent changes a line two below the child's own, before landing: the merge is clean, but
  // what the owner and the verifier read on the child's branch is not what is on it any more.
  writeFileSync(join(parent.worktree, 'lib.mjs'), libWithLines({ 5: 500, 32: 999 }));
  git(['add', 'lib.mjs'], parent.worktree);
  git(['commit', '-qm', 'the parent takes another line'], parent.worktree);

  const merge = tryMerge(child.worktree, parent.branch);
  assert.equal(merge.ok, true, merge.output);
  run('tk.mjs', ['log', childId, 'caught the parent up'], dir);

  const r = run('premerge.mjs', [child.branch], dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.parent, parent.branch);
  const keys = r.json.checks.find((c) => c.name === 'keys');
  assert.equal(keys.ok, false);
  assert.match(keys.note, /diff changed since review at [0-9a-f]{7} — scoped re-review: \S+/);

  const path = /scoped re-review: (\S+)/.exec(keys.note)[1];
  assert.match(path, /rereview-[0-9a-f]{7}\.\.[0-9a-f]{7}\.diff$/);
  const delta = readFileSync(join(dir, path), 'utf8');
  assert.match(delta, new RegExp(`ticket ${childId}`));
});
