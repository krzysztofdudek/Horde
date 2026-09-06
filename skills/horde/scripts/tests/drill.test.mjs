import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

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
function missionRepo(t) {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1');
  assert.equal(run('node.mjs', ['new', 'core', '--boundary', 'src/**'], dir).code, 0);
  git(['checkout', '-q', 'mission1/trunk'], dir);
  git(['add', 'architecture'], dir);
  git(['commit', '-qm', 'graph: the core node and its boundary'], dir);

  const created = run('tk.mjs', ['new', 'retry', '--title', 'Retry a failed call three times',
    '--node', 'core', '--class', 'sonnet',
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
  assert.equal(run('tk.mjs', ['key', '001', 'author', '--by', 'worker1'], dir).code, 0);
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
  const recorded = run('verify.mjs', ['record', '001', '--verdict', 'reproduced', '--by', 'verifier1',
    '--item', '1|node --test src/retry.test.mjs|1 pass, 0 fail',
    '--gate', 'green', '--sha', tip, '--revert', 'failed'], m.dir);
  assert.equal(recorded.code, 0, recorded.stderr);

  const r = run('drill.mjs', ['check', 'verification', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
});

test('drill.mjs check verification: red when a row names a command and nothing seen', async (t) => {
  const m = testFirstBranch(t);
  const tip = git(['rev-parse', 'HEAD'], m.worktree);
  assert.equal(run('verify.mjs', ['record', '001', '--verdict', 'reproduced', '--by', 'verifier1',
    '--item', '1|node --test src/retry.test.mjs|',
    '--gate', 'green', '--sha', tip, '--revert', 'failed'], m.dir).code, 0);

  const r = run('drill.mjs', ['check', 'verification', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  const rows = r.json.checks.find((c) => c.name === 'what was run and seen');
  assert.equal(rows.ok, false);
  assert.match(rows.note, /carry no command or nothing seen/);
});

test('drill.mjs check verification: red when a commit landed after the gate was run', async (t) => {
  const m = testFirstBranch(t);
  const tip = git(['rev-parse', 'HEAD'], m.worktree);
  assert.equal(run('verify.mjs', ['record', '001', '--verdict', 'reproduced', '--by', 'verifier1',
    '--item', '1|node --test src/retry.test.mjs|1 pass, 0 fail',
    '--gate', 'green', '--sha', tip, '--revert', 'failed'], m.dir).code, 0);
  commit(m.worktree, 'one more thing after the verdict', { 'src/extra.mjs': 'export const extra = 1;\n' });

  const r = run('drill.mjs', ['check', 'verification', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  assert.match(r.json.checks.find((c) => c.name === 'gate at the tip').note, /the branch moved after the run/);
});

test('drill.mjs check review: green when findings are ranked and Minor stayed in the log', async (t) => {
  const m = testFirstBranch(t);
  assert.equal(run('tk.mjs', ['review-request', '001'], m.dir).code, 0);
  assert.equal(run('tk.mjs', ['review', '001', 'changes',
    'Important: a permanent failure still costs three calls', '--by', 'owner-core'], m.dir).code, 0);
  assert.equal(run('tk.mjs', ['log', '001', 'Minor: "last" would read better as "lastError"'], m.dir).code, 0);

  const r = run('drill.mjs', ['check', 'review', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
});

test('drill.mjs check review: red when a Minor finding sent the ticket back', async (t) => {
  const m = testFirstBranch(t);
  assert.equal(run('tk.mjs', ['review-request', '001'], m.dir).code, 0);
  assert.equal(run('tk.mjs', ['review', '001', 'changes',
    'Minor: "last" would read better as "lastError"', '--by', 'owner-core'], m.dir).code, 0);

  const r = run('drill.mjs', ['check', 'review', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  assert.match(r.json.checks.find((c) => c.name === 'Minor did not bounce the ticket').note, /Minor findings only/);
});

test('drill.mjs check review: red when a change request names no severity at all', async (t) => {
  const m = testFirstBranch(t);
  assert.equal(run('tk.mjs', ['review', '001', 'changes', 'please rework the loop', '--by', 'owner-core'], m.dir).code, 0);

  const r = run('drill.mjs', ['check', 'review', '--repo', m.dir, '--ticket', '001'], m.dir);
  assert.equal(r.code, 1);
  assert.match(r.json.checks.find((c) => c.name === 'findings carry a severity').note, /name no severity/);
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

  for (const drill of ['tdd', 'verification', 'review', 'scope']) {
    const r = run('drill.mjs', ['run', drill], dir);
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
