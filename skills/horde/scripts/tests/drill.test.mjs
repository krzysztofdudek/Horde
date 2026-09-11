import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode, requireYg,
} from './helpers.mjs';

const COMMITTED_CORPUS = join(dirname(fileURLToPath(import.meta.url)), 'drills');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { retry } from './retry.mjs';

test('retries a failing call until it succeeds', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('not yet');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});
`;

const IMPL_FILE = `export async function retry(fn) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
`;

// A real repository under a real horde, built only through the tools: the node map is committed
// onto the team branch (as an architect files it) so that every branch cut from that tip is judged
// against a boundary, and ticket 001 is running in the worktree the queue made for it.
function missionRepo(t, { files } = {}) {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1');
  addNode(dir, 'core', { mapping: ['src/**'] });
  git(['checkout', '-q', 'mission1/trunk'], dir);
  git(['add', '.yggdrasil'], dir);
  git(['commit', '-qm', 'graph: the core component and its boundary'], dir);

  const created = run('tk.mjs', ['new', 'retry', '--title', 'Retry a failed call three times',
    '--node', 'core', '--class', 'standard',
    ...(files ? ['--files', files] : []),
    '--evidence', 'node --test src/retry.test.mjs prints 1 pass'], dir);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(run('queue.mjs', ['add', '001'], dir).code, 0);
  const running = run('queue.mjs', ['set', '001', 'running', '--agent', 'worker1'], dir);
  assert.equal(running.code, 0, running.stderr);
  return { dir, worktree: running.json.worktree };
}

function commit(worktree, message, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), content);
  }
  git(['add', ...Object.keys(files)], worktree);
  git(['commit', '-qm', message], worktree);
  return git(['rev-parse', 'HEAD'], worktree);
}

function land(dir, worktree) {
  run('tk.mjs', ['log', '001', `landed ${git(['rev-parse', '--short', 'HEAD'], worktree)} — retry implemented`], dir);
  // tk.mjs key no longer exists; the author key it used to set here is not read by anything
  // drill.mjs checks — it was incidental plumbing, so the step is simply dropped.
}

// The verify tool no longer exists, and with it the only thing that ever wrote a "## Verdict" block
// to a ticket's log. drill.mjs's "verification" discipline still reads that block straight out of
// the log text, so these fixtures write the block by hand, in exactly the
// shape the verify tool used to render (templates/verdict.md, also deleted), instead of calling a
// tool that no longer exists.
function recordVerdict(dir, ticketId, {
  by, result = 'reproduced', rows, revert = 'failed', gateSha, node = 'core',
} = {}) {
  const revertLine = revert === 'failed' ? 'failed as expected'
    : revert === 'passed' ? 'passed (proves nothing)'
      : revert === 'no-new-tests' ? 'none — this change adds no test; its evidence is the items above'
        : 'not run';
  const rowsText = rows.map(([item, command, saw]) => `| ${item} | ${command} | ${saw} |`).join('\n');
  const gateLine = gateSha ? `green at sha ${gateSha}` : 'not run';
  const block = [
    `## Verdict · ${ticketId} · 2026-01-01 · by ${by} (standard)`,
    '',
    `**Result:** ${result}`,
    '',
    '**Flake:** not flaky',
    '',
    '**Base check:** rooted at `mission1/trunk` tip — yes',
    '',
    '**Evidence reproduced:**',
    '',
    '| item | command | saw |',
    '|---|---|---|',
    rowsText,
    '',
    `**Revert test:** new tests on the base — ${revertLine}`,
    '',
    `**Gate:** \`node --test\` — ${gateLine}`,
    '',
    '**Diff:** not recorded — this verdict is bound to its sha alone',
    '',
    `**Scope:** diff inside ${node} — yes · protected paths — untouched`,
    '',
    '**What failed, if anything** (what, not what to do):',
  ].join('\n');
  assert.equal(run('tk.mjs', ['log', ticketId, block], dir).code, 0);
}

// test first, then the code that makes it pass
function testFirstBranch(t) {
  const m = missionRepo(t);
  commit(m.worktree, 'a test for retrying a failed call', { 'src/retry.test.mjs': TEST_FILE });
  commit(m.worktree, 'retry a failed call three times', { 'src/retry.mjs': IMPL_FILE });
  land(m.dir, m.worktree);
  return m;
}

function tempCorpus(t) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-corpus-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('drill.mjs list: the five disciplines, the four drills, and the recorded cases', () => {
  const dir = makeRepo();
  try {
    const r = run('drill.mjs', ['list'], dir);
    assert.equal(r.code, 0, r.stderr);
    const names = r.json.disciplines.map((d) => d.discipline);
    assert.deepEqual(names, ['tdd', 'debugging', 'verification', 'review', 'framing']);
    for (const d of r.json.disciplines) assert.equal(d.present, true, `${d.discipline}.md is missing`);
    assert.equal(r.json.disciplines.find((d) => d.discipline === 'debugging').drill, null);
    assert.equal(r.json.disciplines.find((d) => d.discipline === 'framing').drill, 'scope');
    const tdd = r.json.disciplines.find((d) => d.discipline === 'tdd');
    assert.ok(tdd.cases.includes('satisfies-test-first'), 'the committed corpus carries a tdd case');
  } finally {
    rmRepo(dir);
  }
});

test('drill.mjs check tdd: green when the test could have failed where it arrived', async (t) => {
  const m = testFirstBranch(t);
  const r = run('drill.mjs', ['check', 'tdd', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.checks.map((c) => c.name), ['commits', 'new tests', 'red before', 'green after']);
});

test('drill.mjs check tdd: red when the test arrived after the code that satisfies it', async (t) => {
  const m = missionRepo(t);
  commit(m.worktree, 'retry a failed call three times', { 'src/retry.mjs': IMPL_FILE });
  commit(m.worktree, 'a test for retrying a failed call', { 'src/retry.test.mjs': TEST_FILE });
  land(m.dir, m.worktree);

  const r = run('drill.mjs', ['check', 'tdd', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  const redBefore = r.json.checks.find((c) => c.name === 'red before');
  assert.equal(redBefore.ok, false);
  assert.match(redBefore.note, /never showed they can fail/);
  // the tests do pass at the tip — the failure is only about where they arrived
  assert.equal(r.json.checks.find((c) => c.name === 'green after').ok, true);
});

test('drill.mjs check tdd: red when the branch adds no test at all', async (t) => {
  const m = missionRepo(t);
  commit(m.worktree, 'retry a failed call three times', { 'src/retry.mjs': IMPL_FILE });
  land(m.dir, m.worktree);

  const r = run('drill.mjs', ['check', 'tdd', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  const newTests = r.json.checks.find((c) => c.name === 'new tests');
  assert.equal(newTests.ok, false);
  assert.match(newTests.note, /no commit adds a test file/);
});

test('drill.mjs check verification: the verdict carries what was run, what was seen, and the tip', async (t) => {
  const m = testFirstBranch(t);
  const tip = git(['rev-parse', 'HEAD'], m.worktree);
  recordVerdict(m.dir, '001', {
    by: 'verifier1',
    gateSha: tip,
    rows: [['node --test src/retry.test.mjs prints 1 pass', 'node --test src/retry.test.mjs', '1 pass, 0 fail']],
  });

  const r = run('drill.mjs', ['check', 'verification', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
});

test('drill.mjs check verification: red when a row names a command and nothing seen', async (t) => {
  const m = testFirstBranch(t);
  const tip = git(['rev-parse', 'HEAD'], m.worktree);
  recordVerdict(m.dir, '001', {
    by: 'verifier1',
    gateSha: tip,
    rows: [['node --test src/retry.test.mjs prints 1 pass', 'node --test src/retry.test.mjs', '']],
  });

  const r = run('drill.mjs', ['check', 'verification', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  const rows = r.json.checks.find((c) => c.name === 'what was run and seen');
  assert.equal(rows.ok, false);
  assert.match(rows.note, /carry no command or nothing seen/);
});

test('drill.mjs check verification: red when a commit landed after the gate was run', async (t) => {
  const m = testFirstBranch(t);
  const tip = git(['rev-parse', 'HEAD'], m.worktree);
  recordVerdict(m.dir, '001', {
    by: 'verifier1',
    gateSha: tip,
    rows: [['node --test src/retry.test.mjs prints 1 pass', 'node --test src/retry.test.mjs', '1 pass, 0 fail']],
  });
  commit(m.worktree, 'one more thing after the verdict', { 'src/extra.mjs': 'export const extra = 1;\n' });

  const r = run('drill.mjs', ['check', 'verification', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  assert.match(r.json.checks.find((c) => c.name === 'gate at the tip').note, /the branch moved after the run/);
});

// tk.mjs review no longer exists — it used to append one "review: <node> approve|changes by
// <who>[…tail…][ — <why>]" log line per reviewed node. checkReview's own reviewLines() parses
// exactly that shape straight out of the log text, so these fixtures write
// the line by hand with tk.mjs log (still a live command) instead of calling a tool that no
// longer exists.
test('drill.mjs check review: green when findings are ranked and Minor stayed in the log', async (t) => {
  const m = testFirstBranch(t);
  assert.equal(run('tk.mjs', ['review-request', '001'], m.dir).code, 0);
  assert.equal(run('tk.mjs', ['log', '001',
    'review: core changes by owner-core — Important: a permanent failure still costs three calls'], m.dir).code, 0);
  assert.equal(run('tk.mjs', ['log', '001', 'Minor: "last" would read better as "lastError"'], m.dir).code, 0);

  const r = run('drill.mjs', ['check', 'review', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
});

test('drill.mjs check review: red when a Minor finding sent the ticket back', async (t) => {
  const m = testFirstBranch(t);
  assert.equal(run('tk.mjs', ['review-request', '001'], m.dir).code, 0);
  assert.equal(run('tk.mjs', ['log', '001',
    'review: core changes by owner-core — Minor: "last" would read better as "lastError"'], m.dir).code, 0);

  const r = run('drill.mjs', ['check', 'review', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  assert.match(r.json.checks.find((c) => c.name === 'Minor did not bounce the ticket').note, /Minor findings only/);
});

test('drill.mjs check review: red when a change request names no severity at all', async (t) => {
  const m = testFirstBranch(t);
  assert.equal(run('tk.mjs', ['log', '001', 'review: core changes by owner-core — please rework the loop'], m.dir).code, 0);

  const r = run('drill.mjs', ['check', 'review', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  assert.match(r.json.checks.find((c) => c.name === 'findings carry a severity').note, /name no severity/);
});

// An approval is recorded with whatever the key is bound to at the time — the sha, the diff, the
// seat. The drill reads past all of it, so a new note on the key never makes a review invisible.
test('drill.mjs check review: a review key carrying its sha and diff notes is still read', async (t) => {
  const m = testFirstBranch(t);
  assert.equal(run('tk.mjs', ['review-request', '001'], m.dir).code, 0);
  // tk.mjs review used to bind an approval to the sha and diff it was read at, appending a tail
  // like "at <sha> (diff <id>)" right after "by <who>" — written by hand here since that command
  // no longer exists, to prove checkReview still reads past whatever tail note rides there.
  assert.equal(run('tk.mjs', ['log', '001', 'review: core approve by owner-core at abc1234 (diff def5678)'], m.dir).code, 0);

  const r = run('drill.mjs', ['check', 'review', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.json.checks.find((c) => c.name === 'reviews recorded').note, /core approve by owner-core/);
});

test('drill.mjs check scope: green inside the node, red on a file no node maps', async (t) => {
  const inside = testFirstBranch(t);
  const green = run('drill.mjs', ['check', 'scope', '--repo', inside.dir, '--ticket', '001'], inside.dir);
  assert.equal(green.code, 0, green.stdout + green.stderr);

  const outside = testFirstBranch(t);
  commit(outside.worktree, 'and a note about the release while I was here',
    { 'docs/release-notes.md': 'retry now retries\n' });
  const red = run('drill.mjs', ['check', 'scope', '--repo', outside.dir, '--ticket', '001'], outside.dir);
  assert.equal(red.code, 1);
  assert.match(red.json.checks.find((c) => c.name === 'diff inside the boundary').note, /docs\/release-notes\.md/);
});

test('drill.mjs check scope: the files the ticket declared bound it, tighter than its node', async (t) => {
  const m = missionRepo(t, { files: 'src/retry.mjs,src/retry.test.mjs' });
  commit(m.worktree, 'a test for retrying a failed call', { 'src/retry.test.mjs': TEST_FILE });
  commit(m.worktree, 'retry a failed call three times', { 'src/retry.mjs': IMPL_FILE });
  land(m.dir, m.worktree);
  const green = run('drill.mjs', ['check', 'scope', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(green.code, 0, green.stdout + green.stderr);
  assert.match(green.json.checks.find((c) => c.name === 'scope declared').note, /2 file\(s\) declared/);

  // src/extra.mjs is inside the node's boundary and outside what the ticket said it would touch
  const red = missionRepo(t, { files: 'src/retry.mjs,src/retry.test.mjs' });
  commit(red.worktree, 'a test for retrying a failed call', { 'src/retry.test.mjs': TEST_FILE });
  commit(red.worktree, 'retry a failed call three times', { 'src/retry.mjs': IMPL_FILE });
  commit(red.worktree, 'one more file while I was in here', { 'src/extra.mjs': 'export const extra = 1;\n' });
  land(red.dir, red.worktree);
  const r = run('drill.mjs', ['check', 'scope', '--repo', red.dir, '--ticket', '001'], red.dir);
  assert.equal(r.code, 1);
  assert.match(r.json.checks.find((c) => c.name === 'diff inside the boundary').note, /src\/extra\.mjs/);
});

test('drill.mjs record: refuses a case whose state contradicts --expect', async (t) => {
  const m = testFirstBranch(t);
  const corpus = tempCorpus(t);
  const r = run('drill.mjs', ['record', 'test-first', '--discipline', 'tdd', '--expect', 'violates',
    '--ticket', '001', '--corpus', corpus], m.dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /satisfies the tdd drill, but --expect says violates/);
});

test('drill.mjs record then run: a recorded case is one "run" accepts', async (t) => {
  const corpus = tempCorpus(t);

  const good = testFirstBranch(t);
  const one = run('drill.mjs', ['record', 'test-first', '--discipline', 'tdd', '--expect', 'satisfies',
    '--ticket', '001', '--corpus', corpus], good.dir);
  assert.equal(one.code, 0, one.stderr);

  const bad = missionRepo(t);
  commit(bad.worktree, 'retry a failed call three times', { 'src/retry.mjs': IMPL_FILE });
  commit(bad.worktree, 'a test for retrying a failed call', { 'src/retry.test.mjs': TEST_FILE });
  land(bad.dir, bad.worktree);
  const two = run('drill.mjs', ['record', 'tests-after', '--discipline', 'tdd', '--expect', 'violates',
    '--ticket', '001', '--corpus', corpus], bad.dir);
  assert.equal(two.code, 0, two.stderr);

  const listed = run('drill.mjs', ['list', '--corpus', corpus], good.dir);
  assert.deepEqual(listed.json.disciplines.find((d) => d.discipline === 'tdd').cases,
    ['satisfies-test-first', 'violates-tests-after']);

  const r = run('drill.mjs', ['run', 'tdd', '--corpus', corpus], good.dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.cases.length, 2);
  assert.deepEqual(r.json.cases.map((c) => c.actual), ['satisfies', 'violates']);
  assert.ok(r.json.cases.every((c) => c.asExpected));

  // the case snapshot is the state, not a copy of this repository: the drill still reads it
  // after the repository it was recorded from is gone
  rmRepo(good.dir);
  const again = run('drill.mjs', ['run', 'tdd', '--corpus', corpus], bad.dir);
  assert.equal(again.code, 0, again.stdout + again.stderr);
});

test('drill.mjs run: non-zero when a case does not come out the way its name says', async (t) => {
  const corpus = tempCorpus(t);
  const m = testFirstBranch(t);
  assert.equal(run('drill.mjs', ['record', 'test-first', '--discipline', 'tdd', '--expect', 'satisfies',
    '--ticket', '001', '--corpus', corpus], m.dir).code, 0);
  // the same recorded state, now claimed to be a violation
  renameSync(join(corpus, 'tdd', 'satisfies-test-first'), join(corpus, 'tdd', 'violates-test-first'));

  const r = run('drill.mjs', ['run', 'tdd', '--corpus', corpus], m.dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.cases[0].asExpected, false);
  assert.equal(r.json.cases[0].actual, 'satisfies');
});

test('drill.mjs record: refuses a discipline that carries no drill', async (t) => {
  const m = testFirstBranch(t);
  const r = run('drill.mjs', ['record', 'anything', '--discipline', 'debugging', '--expect', 'violates',
    '--ticket', '001', '--corpus', tempCorpus(t)], m.dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /carries no drill/);
});

// E9: the committed corpus is the standing proof that each drill separates the two states.
test('drill.mjs run: every drill is red on its violates case and green on its satisfies case', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  // The corpus carries no way of invoking the Yggdrasil CLI — that is the machine's, not the
  // case's — so the drill is told how, exactly as an adopter's own config would tell it.
  for (const drill of ['tdd', 'verification', 'review', 'scope']) {
    const r = run('drill.mjs', ['run', drill, '--yg', requireYg()], dir);
    assert.equal(r.code, 0, `${drill}: ${r.stdout}${r.stderr}`);
    assert.ok(r.json.cases.length >= 2, `${drill} has fewer than two cases`);
    assert.ok(r.json.cases.some((c) => c.expect === 'violates' && c.actual === 'violates'), `${drill}: no case comes out red`);
    assert.ok(r.json.cases.some((c) => c.expect === 'satisfies' && c.actual === 'satisfies'), `${drill}: no case comes out green`);
  }
});

test('the committed corpus carries no file that would hide the rest of its case from git', () => {
  const cases = execFileSync('find', [COMMITTED_CORPUS, '-name', '.gitignore'], { encoding: 'utf8' }).trim();
  assert.equal(cases, '', `a .gitignore inside a case would ignore the case: ${cases}`);
  const meta = JSON.parse(readFileSync(join(COMMITTED_CORPUS, 'tdd', 'satisfies-test-first', 'case.json'), 'utf8'));
  assert.equal(meta.schema, 'horde-drill-case/1');
  assert.equal(meta.drill, 'tdd');
});
