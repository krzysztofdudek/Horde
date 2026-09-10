import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(names, ['base freshness', 'scope', 'revert test', 'gate', 'graph', 'mapping', 'journal', 'graph text']);

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

test('premerge.mjs: --level team is refused — the value no longer exists', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-003.mjs', 'feature-003.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '003');
  const dst = writeIssue(dir, 'trunk', '003');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '003', branch);

  const r = run('premerge.mjs', [branch, '--level', 'team', '--no-gate'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--level team no longer exists/);
});

test('premerge.mjs: --level trunk still selects the trunk gate, for a branch landing directly on trunk', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.trunk', 'true'], dir);
  addNode(dir, 'feature', { mapping: ['feature-009.mjs', 'feature-009.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '009');
  const dst = writeIssue(dir, 'trunk', '009');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '009', branch);
  git(['worktree', 'add', join(dir, '.horde', 'worktrees', 'mission1', 't-009'), branch], dir);

  const r = run('premerge.mjs', [branch, '--level', 'trunk'], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.json.level, 'trunk');
  const gate = r.json.checks.find((c) => c.name === 'gate');
  assert.match(gate.note, /green \(true\)/);
});

test('premerge.mjs: omitting --level still passes — it defaults internally to the team-level gate', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'feature', { mapping: ['feature-010.mjs', 'feature-010.test.mjs'] });
  commitGraph(dir);

  const branch = makeTicketBranch(dir, '010');
  const dst = writeIssue(dir, 'trunk', '010');
  writeVerdictLog(dst);
  seedQueueItem(dir, 'trunk', '010', branch);

  const r = run('premerge.mjs', [branch, '--no-gate'], dir);
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.json.level, 'team');
});

test('premerge.mjs: item 2 fails — diff touches a file outside the node boundary', async (t) => {
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

test('premerge.mjs: item 3 uses the ticket\'s "**Revert base:**" header instead of the parent tip', async (t) => {
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

test('premerge.mjs: item 3 falls back to a "red on <ref>" phrase in the acceptance lines', async (t) => {
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

test('premerge.mjs: item 7 fails — no log entry newer than the last commit', async (t) => {
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

test('premerge.mjs: --no-gate skips item 4; a stubbed gates.team runs and caches when --no-gate is omitted', async (t) => {
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

test('premerge.mjs: item 4 accepts a pre-migration ticket\'s recorded green gate only when its sha matches the branch tip', async (t) => {
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
  assert.match(gate.note, /accepted the pre-migration verdict's recorded green gate/);
});

test('premerge.mjs: item 4 re-runs the gate when the pre-migration verdict\'s recorded sha does not match the branch tip', async (t) => {
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
  if (r.code !== 0) console.error(r.stdout, r.stderr);
  const gate = r.json.checks.find((c) => c.name === 'gate');
  assert.doesNotMatch(gate.note, /accepted the pre-migration verdict's recorded/);
  assert.match(gate.note, /green \(true\)/);
  assert.equal(gate.ok, true);
  // A verdict's own recorded gate sha not matching the branch tip no longer costs anything else on
  // the checklist — nothing depends on that sha except the gate item itself.
  assert.equal(r.code, 0);
});

test('premerge.mjs: item 2 scope — a component\'s own graph files are inside its boundary, but the rest of the graph is not', async (t) => {
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

test('premerge.mjs: item 2 scope — yg\'s committed lock files are derived, not out of scope', async (t) => {
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

test('premerge.mjs: item 3 refuses when this repository\'s test convention is unknown', async (t) => {
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

test('premerge.mjs: item 3 says what it looked for when a diff really carries no new tests', async (t) => {
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

test('premerge.mjs: item 2 scope — a diff outside the files the ticket declared is refused', async (t) => {
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

test('premerge.mjs: item 2 scope — declaring the file the diff touches makes it pass, and a ticket with no Files falls back to the node boundary', async (t) => {
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

const LIB_LINES = Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`);

// A landing on the team branch after a ticket branched off it — what makes every other branch in
// flight stale until it catches up.
function tryMerge(worktree, ref) {
  try {
    return { ok: true, output: git(['merge', ref, '-m', `catch up with ${ref}`], worktree) };
  } catch (e) {
    return { ok: false, output: (e.stdout || '').toString() + (e.stderr || '').toString() };
  }
}

// ---- a ticket started from an unmerged dependency's tip (a stack) --------------------------
//
// The second ticket of a chain, written while the first is still in flight. Every question with
// the word "parent" in it — where the base is, what the diff contains, what a moved diff is
// compared against — has to be answered with the first ticket's branch until it merges, and with
// the team branch from the moment it does.

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
  // A log entry after the code commit — nothing else keeps the journal item fresh now that no
  // review/verdict command runs as part of reaching this state.
  run('tk.mjs', ['log', childId, 'ready for review'], dir);

  return { parentId, parent, childId, child };
}

// The parent merged into the team branch and recorded as merged — the moment the stack ends.
function landTheParent(dir, parentId, parentBranch) {
  git(['checkout', 'mission1/trunk'], dir);
  git(['merge', '--no-ff', parentBranch, '-m', `merge ${parentId}`], dir);
  const sha = git(['rev-parse', '--short', 'mission1/trunk'], dir);
  const merged = run('queue.mjs', ['set', parentId, 'merged', '--sha', sha], dir);
  assert.equal(merged.code, 0, merged.stderr);
  return merged;
}

test('premerge.mjs: a stacked ticket is measured against its parent, and against the team once it lands', async (t) => {
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
  });

  await t.test('the parent lands: the stack is cleared and the child catches up with the team', () => {
    landTheParent(dir, parentId, parent.branch);
    const item = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === childId);
    assert.equal(item.stackedOn, null);

    const merge = tryMerge(child.worktree, 'mission1/trunk');
    assert.equal(merge.ok, true, merge.output);
    run('tk.mjs', ['log', childId, 'caught the team branch up'], dir);
  });

  await t.test('and the branch reads clean: the parent is the team branch now, the diff is the same one', () => {
    const r = run('premerge.mjs', [child.branch], dir);
    assert.equal(r.code, 0, JSON.stringify(r.json && r.json.checks));
    assert.equal(r.json.parent, 'mission1/trunk');
    assert.equal(r.json.stackedOn, null);

    const base = r.json.checks.find((c) => c.name === 'base freshness');
    assert.equal(base.ok, true, base.note);
    assert.match(base.note, /rooted at mission1\/trunk tip/);
    // The gate is tied to the tree, so it runs again on the merged one.
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
