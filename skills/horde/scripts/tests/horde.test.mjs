import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

test('horde.mjs: init, list, config, archive', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  await t.test('init creates .horde/, the charter, empty state, and the trunk branch', () => {
    const r = initHorde(dir, 'mission1', ['--title', 'The Mission']);
    assert.equal(r.horde, 'mission1');
    assert.equal(r.branch, 'mission1/trunk');
    assert.equal(existsSync(join(dir, '.horde', '.gitignore')), true);
    const charter = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'charter.md'), 'utf8');
    assert.match(charter, /# Mission · The Mission/);
    assert.match(charter, /`mission1\/trunk` off `develop`/);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission1', 'counter.json')), true);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json')), true);
    const branches = execFileSync('git', ['branch'], { cwd: dir, encoding: 'utf8' });
    assert.match(branches, /mission1\/trunk/);
  });

  await t.test('init refuses a duplicate horde name', () => {
    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists/);
  });

  await t.test('config get/set round-trips through dotted paths with type coercion', () => {
    const before = run('horde.mjs', ['config', 'get', 'liveness.stewardMinutes'], dir);
    assert.equal(before.json.value, 60);

    const setResult = run('horde.mjs', ['config', 'set', 'liveness.stewardMinutes', '90'], dir);
    assert.equal(setResult.code, 0);
    const after = run('horde.mjs', ['config', 'get', 'liveness.stewardMinutes'], dir);
    assert.equal(after.json.value, 90);

    run('horde.mjs', ['config', 'set', 'protectedPaths', 'a/b,c/d'], dir);
    const paths = run('horde.mjs', ['config', 'get', 'protectedPaths'], dir);
    assert.deepEqual(paths.json.value, ['a/b', 'c/d']);
  });

  await t.test('list shows the horde with trunk sha, base and open ticket count', () => {
    const r = run('horde.mjs', ['list'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].name, 'mission1');
    assert.equal(r.json[0].base, 'develop');
    assert.equal(r.json[0].openTickets, 0);
  });

  await t.test('a second horde makes the CLI ambiguous without --horde', () => {
    initHorde(dir, 'mission2');
    const ambiguous = run('decide.mjs', ['list'], dir);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /multiple hordes exist/);
    const scoped = run('decide.mjs', ['list', '--horde', 'mission2'], dir);
    assert.equal(scoped.code, 0);
  });

  await t.test('archive moves the horde and leaves branches untouched; re-archiving refuses', () => {
    const r = run('horde.mjs', ['archive', 'mission2'], dir);
    assert.equal(r.code, 0);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission2')), false);
    assert.match(r.json.to, /_archive\/mission2-/);
    const branches = execFileSync('git', ['branch'], { cwd: dir, encoding: 'utf8' });
    assert.match(branches, /mission2\/trunk/);

    const again = run('horde.mjs', ['archive', 'mission2'], dir);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /no such horde/);
  });
});

test('horde.mjs: unknown horde is refused by any tool, not just horde.mjs', () => {
  const dir = makeRepo();
  try {
    initHorde(dir, 'mission1');
    const r = run('decide.mjs', ['list', '--horde', 'nope'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such horde: nope/);
  } finally {
    rmRepo(dir);
  }
});

// ---- what init works out from the repository, and what it says it could not -----------

function ecoRepo(files) {
  const dir = makeRepo();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const ECOSYSTEMS = [
  ['Maven with a wrapper', { 'pom.xml': '<project/>\n', mvnw: '#!/bin/sh\n' }, './mvnw -B test', '**/*Tests.java'],
  ['Maven without a wrapper', { 'pom.xml': '<project/>\n' }, 'mvn -B test', '**/*Test.java'],
  ['Gradle with a wrapper', { 'build.gradle': 'plugins {}\n', gradlew: '#!/bin/sh\n' }, './gradlew test', '**/*Tests.kt'],
  ['Cargo', { 'Cargo.toml': '[package]\n' }, 'cargo test', '**/tests/**/*.rs'],
  ['Go', { 'go.mod': 'module x\n' }, 'go test ./...', '**/*_test.go'],
  ['Python', { 'pyproject.toml': '[project]\n' }, 'pytest', '**/test_*.py'],
  ['Make', { Makefile: 'test:\n\techo hi\n' }, 'make test', null],
  ['npm', { 'package.json': '{"scripts":{"test":"node --test"}}\n' }, 'npm run test', '**/*.test.*'],
];

for (const [label, files, gate, glob] of ECOSYSTEMS) {
  test(`horde.mjs init: works the gate out of a ${label} repository`, async (t) => {
    const dir = ecoRepo(files);
    t.after(() => rmRepo(dir));
    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.gates.team, gate);
    assert.equal(r.json.gates.trunk, gate);
    if (glob) assert.ok(r.json.testGlobs.includes(glob), `${glob} not in ${JSON.stringify(r.json.testGlobs)}`);
  });
}

test('horde.mjs init: an unrecognised repository is told so, and asked, rather than left with an empty gate', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop'], dir, { json: false });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no gate command could be worked out/);
  assert.match(r.stdout, /What proves this repository still works\?/);
  assert.match(r.stdout, /no test convention could be worked out/);
  assert.match(r.stdout, /config set testGlobs/);
});

test('horde.mjs init: --test-globs names the test patterns outright', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', '--test-globs', '**/*Tests.java,**/*Test.java'], dir);
  assert.deepEqual(r.json.testGlobs, ['**/*Tests.java', '**/*Test.java']);
});

test('horde.mjs config set: a list-valued key takes a list, in either notation', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const json = run('horde.mjs', ['config', 'set', 'testGlobs', '["**/*Tests.java","**/*Test.java"]'], dir);
  assert.equal(json.code, 0);
  assert.deepEqual(json.json.value, ['**/*Tests.java', '**/*Test.java']);

  const commas = run('horde.mjs', ['config', 'set', 'testGlobs', '**/*_test.go,**/*_bench.go'], dir);
  assert.deepEqual(commas.json.value, ['**/*_test.go', '**/*_bench.go']);

  // …and it is a list on disk, not the text of one: the whole point is that every reader of the
  // key gets an array back.
  const onDisk = JSON.parse(readFileSync(join(dir, '.horde', 'config.json'), 'utf8'));
  assert.ok(Array.isArray(onDisk.testGlobs));

  const broken = run('horde.mjs', ['config', 'set', 'testGlobs', '["unclosed"'], dir);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /not a readable list/);
});

test('horde.mjs charter: show prints it, edit replaces it from stdin', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1', ['--title', 'The Mission']);

  const shown = run('horde.mjs', ['charter', 'show'], dir, { json: false });
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /# Mission · The Mission/);

  const body = [
    '# Mission · The Mission', '',
    '## Goal', '', 'Ship the thing.', '',
    '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |',
    '|---|---|---|---|',
    '| E1 | the suite is green | api | |',
    '| E2 | the page renders | web | |', '',
  ].join('\n');
  const written = execFileSync('node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit', '--json'], {
    cwd: dir, input: body, encoding: 'utf8',
  });
  const result = JSON.parse(written);
  assert.equal(result.evidenceRows, 2);
  assert.equal(result.evidenceReproduced, 0);
  assert.deepEqual(result.droppedEvidence, []);
  assert.equal(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'charter.md'), 'utf8'), body);

  const refused = run('horde.mjs', ['charter', 'edit'], dir);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /requires content on stdin/);
});

test('horde.mjs charter edit: a rewrite that drops a recorded verifier says so', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const withRow = [
    '# Mission · m', '', '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |', '|---|---|---|---|',
    '| E1 | the suite is green | api | |', '',
  ].join('\n');
  const charterEdit = (input) => JSON.parse(execFileSync(
    'node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit', '--json'],
    { cwd: dir, input, encoding: 'utf8' },
  ));
  charterEdit(withRow);
  run('wave.mjs', ['evidence', 'E1', '--by', 'verifier1'], dir);

  const kept = charterEdit(withRow.replace('| api | |', '| api | verifier1 |'));
  assert.equal(kept.evidenceReproduced, 1);
  assert.deepEqual(kept.droppedEvidence, []);

  const dropped = charterEdit(withRow);
  assert.deepEqual(dropped.droppedEvidence, [{ id: 'E1', was: 'verifier1' }]);
});
