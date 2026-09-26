import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, requireYg, addNode, addAspect, MARKER_CHECK, git,
} from './helpers.mjs';

// Horde requires Yggdrasil: `init` creates the graph when a repository has none, so every direct
// call to it here names the real build the same way `initHorde` does.
const YG = ['--yg', requireYg()];

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
    // The dissent channel folded into ask.mjs: init used to write an empty dissents.json that
    // nothing in the tool set has read since — a file whose only effect was to suggest a channel
    // that is not there.
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission1', 'dissents.json')), false);
    const branches = execFileSync('git', ['branch'], { cwd: dir, encoding: 'utf8' });
    assert.match(branches, /mission1\/trunk/);
  });

  await t.test('init refuses a duplicate horde name', () => {
    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists/);
  });

  await t.test('config get/set round-trips through dotted paths with type coercion', () => {
    const before = run('horde.mjs', ['config', 'get', 'territory.maxBytes'], dir);
    assert.equal(before.json.value, 400000);

    const setResult = run('horde.mjs', ['config', 'set', 'territory.maxBytes', '500000'], dir);
    assert.equal(setResult.code, 0);
    const after = run('horde.mjs', ['config', 'get', 'territory.maxBytes'], dir);
    assert.equal(after.json.value, 500000);

    run('horde.mjs', ['config', 'set', 'protectedPaths', 'a/b,c/d'], dir);
    const paths = run('horde.mjs', ['config', 'get', 'protectedPaths'], dir);
    assert.deepEqual(paths.json.value, ['a/b', 'c/d']);
  });

  // A fresh mission's default classes are host-neutral (Horde installs the same
  // way on Claude Code, Codex, Cursor…), never named after a Claude model.
  await t.test('a fresh mission\'s default classes carry no Claude model name', () => {
    const classes = run('horde.mjs', ['config', 'get', 'classes'], dir).json.value;
    assert.deepEqual(classes, {
      light: 1, standard: 3, heavy: 10, max: 30,
    });
    for (const name of ['haiku', 'sonnet', 'opus', 'fable']) {
      assert.equal(Object.prototype.hasOwnProperty.call(classes, name), false, `classes should not key on "${name}"`);
    }
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
    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', ...YG], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.gates.team, gate);
    assert.equal(r.json.gates.trunk, gate);
    if (glob) assert.ok(r.json.testGlobs.includes(glob), `${glob} not in ${JSON.stringify(r.json.testGlobs)}`);
  });
}

test('horde.mjs init: a repository with two ecosystems composes both gate commands into one, and the charter says so', async (t) => {
  const dir = ecoRepo({
    'pom.xml': '<project/>\n',
    'go.mod': 'module x\n',
  });
  t.after(() => rmRepo(dir));
  const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', ...YG], dir, { json: false });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /gate: `mvn -B test && go test \.\/\.\.\.`/);
  assert.match(r.stdout, /Maven \+ Go/);
  const asJson = run('horde.mjs', ['init', 'mission2', '--base', 'develop', ...YG], dir);
  assert.equal(asJson.json.gates.team, 'mvn -B test && go test ./...');
  assert.equal(asJson.json.gates.trunk, 'mvn -B test && go test ./...');
  assert.ok(asJson.json.testGlobs.includes('**/*Test.java'));
  assert.ok(asJson.json.testGlobs.includes('**/*_test.go'));
});

test('horde.mjs init: an unrecognised repository is told so, and asked, rather than left with an empty gate', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', ...YG], dir, { json: false });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no gate command could be worked out/);
  assert.match(r.stdout, /What proves this repository still works\?/);
  assert.match(r.stdout, /no test convention could be worked out/);
  assert.match(r.stdout, /config set testGlobs/);
});

test('horde.mjs init: --test-globs names the test patterns outright', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', ...YG, '--test-globs', '**/*Tests.java,**/*Test.java'], dir);
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

// DEFAULT_CLASSES only changes what a FRESH mission's config.json starts with. A
// mission whose config.json was already on disk before this change, still keyed by the old
// Claude model names, reads exactly what is written there (config.classes is a plain map, read
// with no knowledge of any particular name) and keeps working unchanged.
test('horde.mjs: a mission with an old on-disk config.classes (Claude model names) keeps working unchanged', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1');

  const cfgPath = join(dir, '.horde', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.classes = {
    haiku: 1, sonnet: 3, opus: 10, fable: 30,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  let oldSchemeId;
  await t.test('a ticket still takes the old class name', () => {
    const created = run('tk.mjs', [
      'new', 'old-scheme', '--title', 'Old scheme', '--node', 'core', '--class', 'sonnet', '--evidence', 'it works',
    ], dir);
    assert.equal(created.code, 0, created.stderr);
    oldSchemeId = created.json.id;
    const shown = run('tk.mjs', ['show', created.json.id], dir);
    assert.match(shown.json.text, /\*\*Class:\*\* sonnet\b/);
  });

  await t.test('a class this old config never had (a new-scheme name) is still refused, listing the old names', () => {
    const refused = run('tk.mjs', [
      'new', 'new-scheme', '--title', 'New scheme', '--node', 'core', '--class', 'light', '--evidence', 'it works',
    ], dir);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /haiku, sonnet, opus, fable/);
  });

  await t.test('plan weighting still reads the old weight for the old name (sonnet = 3)', () => {
    const plan = run('queue.mjs', ['plan'], dir);
    assert.equal(plan.code, 0, plan.stderr);
    const weighed = plan.json.tickets.find((t) => t.id === oldSchemeId);
    assert.equal(weighed.class, 'sonnet');
    assert.equal(plan.json.weight.estimate, 6, 'the old config\'s own "sonnet": 3 weight × 2 runs, unchanged by DEFAULT_CLASSES');
  });
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

// ---- node-lease-across-hordes: init --nodes, list, archive release --------------------------

test('horde.mjs: init --nodes binds the charter\'s nodes at creation; list and archive reflect it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'alpha', ['--nodes', 'core,ui']);

  await t.test('list shows the nodes alpha leased', () => {
    const r = run('horde.mjs', ['list'], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json[0].leasedNodes, ['core', 'ui']);
  });

  await t.test('a second horde is refused at init over an overlapping node, before anything of its own is created', () => {
    const r = run('horde.mjs', ['init', 'beta', '--base', 'develop', '--nodes', 'core'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /leased by horde "alpha"/);
    assert.match(r.stderr, /last activity/);
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'beta')), false);
  });

  await t.test('a disjoint node set inits cleanly and reports what it leased', () => {
    const r = run('horde.mjs', ['init', 'beta', '--base', 'develop', '--test-globs', '**/*.test.*', '--nodes', 'infra'], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.leased.map((l) => l.node), ['infra']);
  });

  await t.test('archiving alpha releases its leases; list reflects the release', () => {
    const r = run('horde.mjs', ['archive', 'alpha'], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.releasedLeases.sort(), ['core', 'ui']);

    const list = run('horde.mjs', ['list'], dir);
    const beta = list.json.find((h) => h.name === 'beta');
    assert.deepEqual(beta.leasedNodes, ['infra']);
  });

  await t.test('archiving a horde with no leases says so', () => {
    initHorde(dir, 'gamma');
    const r = run('horde.mjs', ['archive', 'gamma'], dir, { json: false });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /held no node leases/);
  });

  await t.test('the freed node can now be bound by beta', () => {
    const r = run('node.mjs', ['bind', 'core', '--horde', 'beta'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.status, 'claimed');
  });
});

test('horde.mjs charter edit: a rewrite that drops a recorded verifier says so', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const withRow = [
    '# Mission · m', '', '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |', '|---|---|---|---|',
    '| E1 | `true` is green | api | |', '',
  ].join('\n');
  const charterEdit = (input) => JSON.parse(execFileSync(
    'node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit', '--json'],
    { cwd: dir, input, encoding: 'utf8' },
  ));
  charterEdit(withRow);
  const proved = run('wave.mjs', ['evidence', 'E1', '--run', 'true'], dir);
  assert.equal(proved.code, 0, proved.stderr);
  const by = proved.json.by;

  const kept = charterEdit(withRow.replace('| api | |', `| api | ${by} |`));
  assert.equal(kept.evidenceReproduced, 1);
  assert.deepEqual(kept.droppedEvidence, []);
  assert.deepEqual(kept.unprovenEvidence, [], 'the cell is the one the tool proved');

  const dropped = charterEdit(withRow);
  assert.deepEqual(dropped.droppedEvidence, [{ id: 'E1', was: by }]);
});

// Issue 303: a cell typed into the charter proves nothing. The charter still takes the text — it is
// the client's document — but says so, and `done` refuses the row until a tool fills it.
test('horde.mjs: a reproduced-by cell typed by hand is flagged by charter edit and refused by done; the proved one passes', () => {
  const dir = makeRepo();
  try {
    initHorde(dir);
    run('horde.mjs', ['config', 'set', 'gates.trunk', 'true'], dir);
    const typed = [
      '# Mission · m', '', '## Acceptance — the evidence catalogue', '',
      '| id | evidence | node | reproduced by |', '|---|---|---|---|',
      '| E1 | `true` is green | api | looks fine |', '',
    ].join('\n');
    const edited = execFileSync('node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit'], { cwd: dir, input: typed, encoding: 'utf8' });
    assert.match(edited, /warning: E1 says it is reproduced by "looks fine", and no tool proved that/);

    const refused = run('horde.mjs', ['done'], dir);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /E1 says "looks fine", and nothing recorded proves it/);

    execFileSync('node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit'], { cwd: dir, input: typed.replace('| looks fine |', '| |'), encoding: 'utf8' });
    assert.equal(run('wave.mjs', ['evidence', 'E1', '--run', 'true'], dir).code, 0);
    const next = run('horde.mjs', ['done'], dir);
    assert.equal(next.code, 1, 'still no retrospective');
    assert.doesNotMatch(next.stderr, /E1/, 'the proved row holds');
  } finally {
    rmRepo(dir);
  }
});

test('horde.mjs charter edit: rewording a stamped row\'s evidence or class leaves the stamp and warns, since the stamp no longer says what it proved', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const row = (evidence, cls) => [
    '# Mission · m', '', '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by | class |', '|---|---|---|---|---|',
    `| E1 | ${evidence} | api | verifier1 | ${cls} |`, '',
  ].join('\n');
  const charterEdit = (input) => JSON.parse(execFileSync(
    'node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit', '--json'],
    { cwd: dir, input, encoding: 'utf8' },
  ));
  charterEdit(row('the suite is green', 'unit'));

  await t.test('the same text, unchanged, warns nothing', () => {
    const same = charterEdit(row('the suite is green', 'unit'));
    assert.deepEqual(same.redraftedEvidence, []);
  });

  await t.test('a reworded evidence text, stamp kept, warns by id and names the stamp', () => {
    const reworded = charterEdit(row('the whole suite is green', 'unit'));
    assert.deepEqual(reworded.redraftedEvidence, [{
      id: 'E1', by: 'verifier1', was: 'the suite is green', now: 'the whole suite is green', wasClass: 'unit', nowClass: 'unit',
    }]);
    charterEdit(row('the suite is green', 'unit'));
    const worded = execFileSync('node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit'], {
      cwd: dir, input: row('the whole suite is green', 'unit'), encoding: 'utf8',
    });
    assert.match(worded, /warning: E1 is still recorded as reproduced by verifier1, but this text changed its evidence — the stamp may no longer match what it now promises/);
  });

  await t.test('a changed class, evidence text unchanged, warns the same way', () => {
    charterEdit(row('the suite is green', 'unit'));
    const reclassed = charterEdit(row('the suite is green', 'e2e'));
    assert.deepEqual(reclassed.redraftedEvidence, [{
      id: 'E1', by: 'verifier1', was: 'the suite is green', now: 'the suite is green', wasClass: 'unit', nowClass: 'e2e',
    }]);
  });

  await t.test('wiping the stamp on a reworded row is the drop warning, not this one — the two never fire together', () => {
    charterEdit(row('the suite is green', 'unit'));
    const wiped = charterEdit(row('the whole suite is green', 'unit').replace('| verifier1 |', '| |'));
    assert.deepEqual(wiped.redraftedEvidence, []);
    assert.deepEqual(wiped.droppedEvidence, [{ id: 'E1', was: 'verifier1' }]);
  });
});

// E13 — dropping a row outright is free before the mission's wave 1 starts, and needs an answered
// ask of kind "charter" naming it afterwards.
test('horde.mjs charter edit: dropping a row is free before wave 1, refused after without an answered ask naming it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const withTwo = [
    '# Mission · m', '', '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |', '|---|---|---|---|',
    '| E1 | the suite is green | api | |',
    '| E2 | the page renders | web | |', '',
  ].join('\n');
  const withOne = [
    '# Mission · m', '', '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |', '|---|---|---|---|',
    '| E1 | the suite is green | api | |', '',
  ].join('\n');

  const charterEdit = (input, extra = []) => execFileSync(
    'node', [join(SCRIPTS_DIR, 'horde.mjs'), 'charter', 'edit', ...extra, '--json'],
    { cwd: dir, input, encoding: 'utf8' },
  );
  const charterEditRaw = (input, extra = []) => {
    try {
      return { code: 0, json: JSON.parse(charterEdit(input, extra)) };
    } catch (e) {
      return { code: e.status ?? 1, stderr: (e.stderr || '').toString() };
    }
  };

  charterEdit(withTwo);

  await t.test('before wave 1, dropping E2 is free', () => {
    const r = charterEditRaw(withOne);
    assert.equal(r.code, 0);
    charterEdit(withTwo); // restore for the next case
  });

  run('wave.mjs', ['start'], dir);

  await t.test('after wave 1, dropping E2 without --ask is refused', () => {
    const r = charterEditRaw(withOne);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /drops evidence row\(s\) E2/);
    assert.match(r.stderr, /ask\.mjs add/);
  });

  await t.test('an --ask that is not yet answered is refused', () => {
    const opened = run('ask.mjs', ['add', 'field is unreachable', '--kind', 'charter'], dir);
    const r = charterEditRaw(withOne, ['--ask', opened.json.id]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not answered yet/);
  });

  await t.test('an --ask of a kind other than "charter" is refused', () => {
    const opened = run('ask.mjs', ['add', 'field is unreachable', '--kind', 'stop'], dir);
    run('ask.mjs', ['answer', opened.json.id, 'agreed, dropping E2'], dir);
    const r = charterEditRaw(withOne, ['--ask', opened.json.id]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is kind "stop", not "charter"/);
  });

  await t.test('an answered ask whose text never names the dropped row is refused', () => {
    const opened = run('ask.mjs', ['add', 'field is unreachable', '--kind', 'charter'], dir);
    run('ask.mjs', ['answer', opened.json.id, 'agreed, dropping a row'], dir);
    const r = charterEditRaw(withOne, ['--ask', opened.json.id]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not mention dropped row\(s\): E2/);
  });

  await t.test('an answered ask naming the row lets the drop through, and the decision is cited in the charter', () => {
    const opened = run('ask.mjs', ['add', 'E2 cannot be reproduced in this environment', '--kind', 'charter'], dir);
    run('ask.mjs', ['answer', opened.json.id, 'agreed, E2 is dropped'], dir);
    const r = charterEditRaw(`${withOne}\n_E2 dropped per ask-${opened.json.id}._\n`, ['--ask', opened.json.id]);
    assert.equal(r.code, 0);
    assert.equal(r.json.evidenceRows, 1);
    const decision = run('decide.mjs', ['show', `ask-${opened.json.id}`], dir);
    assert.equal(decision.code, 0, decision.stderr);
    assert.match(decision.json.body, /E2 is dropped/);
  });
});

// E13 — horde.mjs done: the mission's final gate.
test('horde.mjs done: refuses listing every reason, then passes once each is met', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.trunk', 'true'], dir);

  await t.test('refuses with every reason when nothing has been done yet', () => {
    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /evidence catalogue is empty/);
    assert.match(r.stderr, /no retrospective has been run/);
  });

  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  const charter = readFileSync(charterPath, 'utf8').replace('| | | | |', '| E1 | the suite is green | api | |');
  writeFileSync(charterPath, charter);

  await t.test('refuses naming the red row once the catalogue has one', () => {
    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /E1 \(no-ticket\)/);
  });

  // A ticket merged with a reproduced verdict naming E1 — queue.mjs's own merge refusal is what
  // would have required that verdict for a real ticket; this fixture writes the same shape by
  // hand, matching wave.test.mjs's own convention.
  const ticketDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', '001-slug');
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(join(ticketDir, 'issue.md'), '# 001 · slug\n\n**Status:** merged\n\n## Acceptance — evidence\n\n- [x] covers E1\n');
  writeFileSync(join(ticketDir, 'log.md'), '## Verdict · 001 · 2026-01-01 · by verifier-1 (standard)\n\n**Result:** reproduced\n');

  const retroClasses = join(dir, '.horde', 'hordes', 'mission1', 'retro-classes.json');
  const landResult = join(dir, '.horde', 'hordes', 'mission1', 'land', '001.json');

  await t.test('refuses when the retrospective has never been run, and names the command that runs it', () => {
    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no retrospective has been run on this mission/);
    assert.match(r.stderr, /retro\.mjs --horde mission1/);
  });

  // Read here rather than after "done": the stamp is made by every "done" run, refusal or not
  // (stampMissionEvidence is what the evidence check itself reads), and once the mission is done
  // its horde is archived — a live-horde reader has nothing left to be asked about.
  await t.test('status.mjs shows the row as reproduced, stamped by the checks done already ran', () => {
    const r = run('status.mjs', ['--horde', 'mission1'], dir);
    assert.equal(r.json.hordes[0].evidence.rows[0].state, 'reproduced');
    assert.equal(r.json.hordes[0].evidence.rows[0].reproducedBy, 'verifier-1');
  });

  await t.test('refuses when the retrospective was taken before the last ticket landed', () => {
    // This ticket's log carries no remark and nothing was refused, so the classification is empty
    // and the retrospective is the one run, not the one-shot's answer.
    writeFileSync(retroClasses, '{"items": {}}\n');
    assert.equal(run('retro.mjs', ['--tree', dir, '--horde', 'mission1'], dir).code, 0);

    // …and then something lands, which the document on file never saw.
    mkdirSync(dirname(landResult), { recursive: true });
    writeFileSync(landResult, `${JSON.stringify({
      ticket: '001', branch: 'mission1/t-001', sha: 'a'.repeat(40), ok: true, checks: [],
      pairs: [], brief: null, landed: { ticket: '001', sha: 'b'.repeat(40), at: new Date().toISOString() },
    }, null, 2)}\n`);

    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /retrospective on file is out of date/);
    assert.match(r.stderr, /retro\.mjs --horde mission1/);
  });

  await t.test('passes once every reason is met — stamps the charter and appends the completion block', () => {
    assert.equal(run('retro.mjs', ['--tree', dir, '--horde', 'mission1'], dir).code, 0);
    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.evidence.green, 1);
    assert.equal(r.json.evidence.total, 1);
    assert.equal(r.json.gate.result, 'green');
    assert.equal(r.json.cost, undefined, 'done no longer reports or requires a cost figure');

    // The mission is over, so the horde is archived by "done" itself — everything it wrote is read
    // back from where it now stands, and nothing is left live for a later run to pick up.
    assert.ok(r.json.archived && r.json.archived.to, 'done reports where the horde was archived to');
    assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission1')), false, 'the live horde directory is gone');
    const archivedDir = r.json.archived.to;

    const marker = readFileSync(join(archivedDir, 'archived'), 'utf8');
    assert.equal(marker.trim().split('\n').length, 1, 'the marker is one line, not a log');
    const [markedDate, markedSha] = marker.trim().split(' ');
    assert.equal(markedDate, r.json.archived.date);
    assert.equal(markedSha, r.json.gate.sha, 'the marker carries the trunk sha the mission handed over at');

    const stamped = readFileSync(join(archivedDir, 'charter.md'), 'utf8');
    assert.match(stamped, /\| E1 \| the suite is green \| api \| verifier-1 \|/);

    const plan = readFileSync(join(archivedDir, 'plan.md'), 'utf8');
    assert.match(plan, /# Mission complete/);
    assert.match(plan, /Evidence catalogue:\*\* 1\/1 green/);
    assert.match(plan, /Ready to push: `mission1\/trunk`/);

    // Nothing of .horde/ has ever been a candidate for the index, and "done" is the run most
    // likely to have slipped something in — it writes a charter, a journal and a marker. (The
    // fixture's own untracked files are Yggdrasil's, written by `yg init`, and not this tool's
    // business either way.)
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    assert.equal(porcelain.split('\n').filter((l) => l.includes('.horde')).join('\n'), '', 'done puts nothing of .horde/ in front of git');
    assert.match(readFileSync(join(dir, '.horde', '.gitignore'), 'utf8'), /^\*$/m);

    // The last word on what this mission did to the law, taken at the trunk it is handing over.
    assert.ok(r.json.law && r.json.law.path, 'done reports where the law document is');
    assert.ok(r.json.retro && r.json.retro.path, 'done reports where the retrospective is');
    assert.equal(r.json.retro.law, 0);
    assert.equal(r.json.retro.inexpressible, 0);
    // The reported paths are where the documents now are, not where they were written.
    assert.ok(r.json.law.path.startsWith(archivedDir), 'the law document is reported at its archived path');
    assert.ok(r.json.retro.path.startsWith(archivedDir), 'the retrospective is reported at its archived path');
    const law = JSON.parse(readFileSync(r.json.law.path, 'utf8'));
    assert.equal(law.schema, 'horde-law/1');
    assert.equal(law.horde, 'mission1');
    for (const section of ['added', 'raised', 'attached']) {
      assert.ok(Array.isArray(law[section]), `${section} is a list, empty or not`);
    }
  });
});

// ---- the tree "done" itself runs in, with and without --horde written out (issue 113) ---------
//
// The same shared contract every other tool here reads (node.mjs main()'s own comment above its
// resolveTree call, tree.test.mjs, tick.test.mjs's and land.test.mjs's own versions of this test):
// an ordinary run with neither --tree nor --horde stays on cwd, whatever tree that happens to be —
// a resolvable horde is not by itself a second signal for "read trunk instead" (ask a-002,
// decisions.md: always cwd, full stop). --horde WRITTEN OUT is the one thing that does mean this
// horde's own trunk, exactly as queue.mjs plan/quality, tick.mjs (041) and land.mjs (109) already
// read it. Before this test existed, "done"'s own resolveTree call forwarded the RESOLVED horde
// (resolveHorde's own default-to-the-sole-horde reading) instead of the raw flag, so a bare
// `horde.mjs done` in this single-horde fixture read trunk unconditionally, never cwd.
//
// "done"'s own resolveTree call runs unconditionally, before any of its reasons are worked out, so
// neither sub-test needs the mission to actually be done — both refuse on the empty evidence
// catalogue either way, and that refusal happens after the tree is already resolved. What is left
// to differ, and what this test actually proves, is whether "done" ever provisions this horde's own
// trunk WORKTREE — a resource only --horde written out reaches — while running from a shell sitting
// on "develop" (the mission's own base branch, checked out but never itself mission1/trunk).
test('horde.mjs done: no --horde stays on cwd; --horde written out resolves to that horde\'s own trunk instead', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const trunkWorktree = join(dir, '.horde', 'worktrees', 'mission1', 'trunk');
  execFileSync('git', ['checkout', 'develop'], { cwd: dir });

  await t.test('no --horde at all: cwd — trunk\'s own separate worktree is never touched', () => {
    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /evidence catalogue is empty/);
    assert.equal(existsSync(trunkWorktree), false, 'trunk\'s own separate worktree was never provisioned');
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), 'develop');
  });

  await t.test('--horde mission1 written out: this horde\'s own trunk worktree gets provisioned, a different tree from cwd', () => {
    const r = run('horde.mjs', ['done', '--horde', 'mission1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /evidence catalogue is empty/);
    assert.equal(existsSync(trunkWorktree), true, '--horde written out: trunk\'s own separate worktree was provisioned');
    // Resolving a tree is not a checkout: the shell this ran from stays exactly where it was.
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), 'develop');
  });
});

// ---- the archived marker ----------------------------------------------------------------------
//
// "Archived" has to be readable off the directory itself, not inferred from where it sits: a
// mission read back a year later needs the date it ended and the commit it handed over. The move
// to hordes/_archive/<name>-<date> is unchanged — blame.mjs stands on it — and the marker is what
// is new.

test('horde.mjs archive: the moved directory carries an "archived" marker with the date and the sha', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const trunkSha = execFileSync('git', ['rev-parse', 'mission1/trunk'], { cwd: dir, encoding: 'utf8' }).trim();
  const r = run('horde.mjs', ['archive', 'mission1'], dir);
  assert.equal(r.code, 0, r.stderr);

  const marker = readFileSync(join(r.json.to, 'archived'), 'utf8');
  assert.equal(marker.trim(), `${r.json.date} ${trunkSha}`);
  assert.equal(existsSync(join(dir, '.horde', 'hordes', 'mission1')), false);
});

test('horde.mjs archive: an "archived" file already there is overwritten, never doubled', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  // A mission that was marked once already — by a run that got as far as the marker and no
  // further, or by a hand. The second pass replaces the line; it does not write a second one.
  writeFileSync(join(dir, '.horde', 'hordes', 'mission1', 'archived'), '1999-01-01 deadbeef\n');

  const r = run('horde.mjs', ['archive', 'mission1'], dir);
  assert.equal(r.code, 0, r.stderr);
  const marker = readFileSync(join(r.json.to, 'archived'), 'utf8');
  assert.equal(marker.trim().split('\n').length, 1);
  assert.doesNotMatch(marker, /1999-01-01/);
  assert.match(marker, new RegExp(`^${r.json.date} `));
});

test('horde.mjs archive: a horde directory that cannot be written refuses, naming the path', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('root bypasses file-mode permissions — chmod cannot force a write to fail as root');
    return;
  }
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const hordeDir = join(dir, '.horde', 'hordes', 'mission1');
  chmodSync(hordeDir, 0o500);

  const r = run('horde.mjs', ['archive', 'mission1'], dir);
  // Put it back before asserting: a thrown assertion would otherwise leave a directory the
  // fixture's own cleanup cannot remove.
  chmodSync(hordeDir, 0o700);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /archived/);
  assert.ok(r.stderr.includes(hordeDir), `the refusal names the path it could not write: ${r.stderr}`);
  // Nothing moved: a refusal at the marker leaves the mission exactly where it was.
  assert.equal(existsSync(join(hordeDir, 'charter.md')), true);
});

// ---- the book of closed missions ---------------------------------------------------------------
//
// Archiving keeps everything a mission wrote and, until now, nothing read any of it back. `history`
// is the reader: every closed mission on this repository, newest first, with what it set out to do,
// how much of what it promised was reproduced, what its retrospective proposed as law and what it
// found the law will never say, how many questions the client answered, and what it did to the law.
//
// The two missions below are built the way a real close leaves one — a real charter, real tickets,
// a retrospective written by retro.mjs itself, answers recorded through ask.mjs, a law diff written
// by law.mjs against two real trees, and then the real archive move.

function hordeFile(dir, horde, ...parts) {
  return join(dir, '.horde', 'hordes', horde, ...parts);
}

function ygIn(dir, args) {
  const parts = requireYg().split(/\s+/);
  return execFileSync(parts[0], [...parts.slice(1), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A base that already carries a graph: two real components over real code, committed onto
// `develop` before any mission starts, so what a mission later adds to the law is measured against
// a graph rather than against nothing.
function graphOnDevelop(dir) {
  ygIn(dir, ['init', '--no-reviewer']);
  mkdirSync(join(dir, 'src', 'entry'), { recursive: true });
  mkdirSync(join(dir, 'src', 'figures'), { recursive: true });
  writeFileSync(join(dir, 'src', 'entry', 'door.mjs'), 'export const door = 1;\n');
  writeFileSync(join(dir, 'src', 'figures', 'month.mjs'), 'export const month = 1;\n');
  addNode(dir, 'entry', { description: 'Letting a request in.', mapping: ['src/entry/**'] });
  addNode(dir, 'figures', { description: 'The month-end numbers.', mapping: ['src/figures/**'] });
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph the missions start from'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
}

// One rule, committed onto this mission's own trunk in a worktree of its own, so what the mission
// did to the law is a real difference between two real trees. Run before anything else provisions
// that branch — git checks a branch out in one place at a time.
function addRuleOnTrunk(dir, horde, aspect, description) {
  const tree = join(dir, `.trunk-${horde}`);
  git(['worktree', 'add', '-q', tree, `${horde}/trunk`], dir);
  addAspect(tree, aspect, { status: 'advisory', check: MARKER_CHECK, description });
  ygIn(tree, ['aspects', 'log', 'add', '--aspect', aspect, '--reason', `Written down because ${horde} kept explaining it by hand.`]);
  git(['add', '-A'], tree);
  git(['commit', '-qm', `the rule ${horde} added`], tree);
  git(['worktree', 'remove', tree, '--force'], dir);
}

function closeMission(dir, horde, {
  node, aspect, rule, inexpressible, territory, question, answer, evidence,
}) {
  initHorde(dir, horde);

  // The charter as a framing session leaves it: one promised proof, already reproduced.
  const charterPath = hordeFile(dir, horde, 'charter.md');
  writeFileSync(charterPath, readFileSync(charterPath, 'utf8').replace('| | | |', `| E1 | ${evidence} | ${node} | a verifier |`));

  addRuleOnTrunk(dir, horde, aspect, rule);

  const filed = run('tk.mjs', ['new', `work-on-${node}`, '--title', `Work on ${node}`, '--node', node, '--class', 'standard', '--horde', horde], dir);
  assert.equal(filed.code, 0, filed.stderr);
  for (const text of [`RULE ${rule}`, `NEVER ${inexpressible}`]) {
    assert.equal(run('tk.mjs', ['log', filed.json.id, text, '--horde', horde], dir).code, 0);
  }

  // The retrospective, through retro.mjs itself: gather, classify the keys it printed, write.
  const input = run('retro.mjs', ['--horde', horde], dir);
  assert.equal(input.code, 0, input.stderr);
  const items = {};
  for (const it of input.json.items) {
    items[it.key] = it.text.includes('RULE ')
      ? {
        class: 'rule', rule: it.text.slice(it.text.indexOf('RULE ') + 'RULE '.length), node, kind: 'check', evidence: `what ${node} kept doing`,
      }
      : { class: 'inexpressible' };
  }
  writeFileSync(hordeFile(dir, horde, 'retro-classes.json'), `${JSON.stringify({ items }, null, 2)}\n`);
  assert.equal(run('retro.mjs', ['--horde', horde], dir).code, 0);

  const ask = run('ask.mjs', ['add', question, '--kind', 'charter', '--territory', territory, '--horde', horde], dir);
  assert.equal(ask.code, 0, ask.stderr);
  assert.equal(run('ask.mjs', ['answer', ask.json.id, answer, '--horde', horde], dir).code, 0);

  const law = run('law.mjs', ['diff', '--wave', '1', '--horde', horde], dir);
  assert.equal(law.code, 0, law.stderr);

  const archived = run('horde.mjs', ['archive', horde], dir);
  assert.equal(archived.code, 0, archived.stderr);
  return archived.json.to;
}

test('horde.mjs history: every closed mission, with its charter, evidence, retrospective, answers and law diff', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphOnDevelop(dir);

  await t.test('with nothing archived it says so rather than printing an empty list', () => {
    const r = run('horde.mjs', ['history'], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no mission has closed on this repository yet/);
    assert.deepEqual(run('horde.mjs', ['history'], dir).json, []);
  });

  closeMission(dir, 'first-mission', {
    node: 'entry',
    aspect: 'entry-guard',
    rule: 'every entry point must name the session it trusts.',
    inexpressible: 'how much friction a sign-in step may cost is a judgement no rule holds.',
    territory: 'the front door',
    question: 'Should a stranger reaching a locked page be sent away or asked to sign in?',
    answer: 'Asked to sign in, and never sent away silently.',
    evidence: 'a signed-in person reaches the locked page',
  });
  closeMission(dir, 'second-mission', {
    node: 'figures',
    aspect: 'ledger-named',
    rule: 'every published figure must name the ledger it was taken from.',
    inexpressible: 'which rounding a finance team finds acceptable changes per client.',
    territory: 'numbers',
    question: 'Do the month figures close on the last calendar day or the last working day?',
    answer: 'The last working day, and the boundary is stated on the page.',
    evidence: 'the month figures match the ledger',
  });

  const r = run('horde.mjs', ['history'], dir);
  assert.equal(r.code, 0, r.stderr);
  const byMission = Object.fromEntries(r.json.map((m) => [m.mission, m]));

  await t.test('both closed missions are listed, each addressable as the archived horde it is', () => {
    assert.equal(r.json.length, 2);
    assert.deepEqual(Object.keys(byMission).sort(), ['first-mission', 'second-mission']);
    for (const m of r.json) {
      assert.match(m.id, /^_archive\/(first|second)-mission-\d{4}-\d{2}-\d{2}$/);
      assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(m.sha, git(['rev-parse', `${m.mission}/trunk`], dir));
    }
  });

  await t.test('the charter it closed on', () => {
    assert.match(byMission['first-mission'].charter.title, /Mission · first-mission/);
    assert.ok(byMission['first-mission'].charter.goal, 'the goal it set out with');
    assert.equal(existsSync(byMission['first-mission'].charter.path), true);
  });

  await t.test('what it promised to prove, and how much of it was reproduced', () => {
    const { evidence } = byMission['second-mission'];
    assert.equal(evidence.total, 1);
    assert.equal(evidence.reproduced, 1);
    assert.deepEqual(evidence.rows, [{
      id: 'E1', evidence: 'the month figures match the ledger', node: 'figures', reproducedBy: 'a verifier',
    }]);
  });

  await t.test('what its retrospective proposed as law, and what it found the law will not say', () => {
    const { retro } = byMission['first-mission'];
    assert.deepEqual(retro.law.map((p) => [p.node, p.rule]), [['entry', 'every entry point must name the session it trusts.']]);
    assert.equal(retro.inexpressible.length, 1);
    assert.match(retro.inexpressible[0].text, /how much friction a sign-in step may cost/);
  });

  await t.test('what the client answered', () => {
    const { answers } = byMission['second-mission'];
    assert.equal(answers.length, 1);
    assert.equal(answers[0].kind, 'charter');
    assert.equal(answers[0].territory, 'numbers');
    assert.match(answers[0].question, /last calendar day or the last working day/);
    assert.match(answers[0].answer, /The last working day/);
  });

  await t.test('and what it did to the law, read off the diff it handed over', () => {
    const { law } = byMission['first-mission'];
    assert.equal(law.wave, 1);
    assert.equal(law.base, git(['rev-parse', 'develop'], dir));
    assert.equal(law.trunk, git(['rev-parse', 'first-mission/trunk'], dir));
    assert.deepEqual(law.added.map((i) => i.aspect), ['entry-guard']);
    assert.deepEqual(byMission['second-mission'].law.added.map((i) => i.aspect), ['ledger-named']);
  });

  await t.test('the human rendering names each mission and every part of its account', () => {
    const text = run('horde.mjs', ['history'], dir, { json: false }).stdout;
    assert.match(text, /first-mission {2}closed \d{4}-\d{2}-\d{2} at [0-9a-f]{7}/);
    assert.match(text, /second-mission {2}closed/);
    assert.match(text, /evidence: 1\/1 reproduced/);
    assert.match(text, /retrospective: 1 rule proposal\(s\), 1 the law will not say/);
    assert.match(text, /the client ruled on: 1/);
    assert.match(text, /law: 1 added · 0 raised · 0 newly attached/);
  });

  await t.test('it reads the archive and writes nothing, and refuses an argument it has no use for', () => {
    const before = readdirSync(join(dir, '.horde', 'hordes', '_archive')).sort();
    assert.equal(run('horde.mjs', ['history'], dir).code, 0);
    assert.deepEqual(readdirSync(join(dir, '.horde', 'hordes', '_archive')).sort(), before);

    const refused = run('horde.mjs', ['history', 'first-mission'], dir);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /history takes no argument/);
  });
});

// A mission archived by an older release carries fewer of these files. Half a book is worth more
// than none, so what is missing reads as missing and everything else is still read.
test('horde.mjs history: a sparse archived mission is read as far as it goes, never refused', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'mission1');
  assert.equal(run('horde.mjs', ['archive', 'mission1'], dir).code, 0);

  // A directory somebody moved in by hand: no charter, no marker, no dated name.
  mkdirSync(join(dir, '.horde', 'hordes', '_archive', 'moved-by-hand'), { recursive: true });

  const r = run('horde.mjs', ['history'], dir);
  assert.equal(r.code, 0, r.stderr);
  const byMission = Object.fromEntries(r.json.map((m) => [m.mission, m]));

  const hand = byMission['moved-by-hand'];
  assert.equal(hand.charter, null);
  assert.equal(hand.retro, null);
  assert.equal(hand.law, null);
  assert.equal(hand.date, null);
  assert.deepEqual(hand.answers, []);
  assert.deepEqual(hand.evidence, { total: 0, reproduced: 0, rows: [] });

  // …and the mission beside it, archived by the real thing, is read in full all the same.
  assert.match(byMission.mission1.charter.title, /Mission · mission1/);
  assert.match(byMission.mission1.date, /^\d{4}-\d{2}-\d{2}$/);
});

// ---- E10: the graph is Yggdrasil's, and init makes one where there is none -------------------
//
// horde-requires-yggdrasil. Three cases, all on real temporary repositories against the real
// Yggdrasil build: no CLI at all (a refusal that names the install step, leaving nothing behind),
// a CLI (a real graph, made by `yg init`), and a Grain command as well (a proposal mined from the
// repository and accepted by `yg adopt`, with the baseline of what the new rules already refuse).

// A stand-in for Grain that is a real program: it records the argv it was called with and writes a
// real `grain-proposal/1` staging tree — the scaffold this repository already has, plus one
// component and one rule, with the per-rule count of what that rule already refuses. `yg adopt`
// accepts it or does not; nothing here fakes that answer.
const GRAIN_STUB = [
  "import { cpSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  'const argv = process.argv.slice(2);',
  "if (argv[0] === '--version') { console.log('0.0.0-stub'); process.exit(0); }",
  "appendFileSync('grain-calls.log', `${JSON.stringify(argv)}\\n`);",
  "if (argv[0] !== 'propose') process.exit(2);",
  "const out = argv[1] || '.yggdrasil-proposal';",
  'mkdirSync(out, { recursive: true });',
  "cpSync('.yggdrasil', join(out, '.yggdrasil'), { recursive: true });",
  "const model = join(out, '.yggdrasil', 'model', 'lib');",
  'mkdirSync(model, { recursive: true });',
  "writeFileSync(join(model, 'yg-node.yaml'), [",
  "  'name: lib', 'type: module', 'description: The library this repository is.',",
  "  'aspects:', '  - no-marker',",
  "  'mapping:', '  - \"src/**\"', 'relations: []', '',",
  "].join('\\n'));",
  "const aspect = join(out, '.yggdrasil', 'aspects', 'no-marker');",
  'mkdirSync(aspect, { recursive: true });',
  "writeFileSync(join(aspect, 'yg-aspect.yaml'), [",
  "  'name: NoMarker', 'description: Source files must not carry an unfinished-work marker.',",
  "  'errs: under', 'status: enforced', 'review_by: 2099-01-01', '',",
  "].join('\\n'));",
  "writeFileSync(join(aspect, 'check.mjs'), [",
  "  'export function check(ctx) {',",
  "  '  const out = [];',",
  "  '  for (const file of ctx.files) {',",
  '  "    const lines = file.content.split(String.fromCharCode(10));",',
  "  '    for (let i = 0; i < lines.length; i++) {',",
  '  "      if (lines[i].includes(\'UNFINISHED\')) out.push({ file: file.path, line: i + 1, column: 0, message: \'marker\' });",',
  "  '    }',",
  "  '  }',",
  "  '  return out;',",
  "  '}',",
  "  '',",
  "].join('\\n'));",
  "writeFileSync(join(aspect, 'provenance.json'), `${JSON.stringify({ existingViolations: 1 }, null, 2)}\\n`);",
  "writeFileSync(join(out, 'proposal.json'), `${JSON.stringify({",
  "  schema: 'grain-proposal/1', engine: 'grain-stub', asOf: 'stubbed', files: 1,",
  '}, null, 2)}\\n`);',
  "console.log('proposal written to ' + out);",
  '',
].join('\n');

test('E10 — init refuses without Yggdrasil, creates the graph with it, and mines one with Grain', async (t) => {
  await t.test('no graph and no Yggdrasil: it refuses, names the install step, and leaves nothing behind', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', '--yg', join(dir, 'no-such-yg')], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /this repository has no architecture graph/);
    assert.match(r.stderr, /npm i -g @chrisdudek\/yg/);
    assert.match(r.stderr, /init --yg "node path\/to\/bin\.js"/);
    // nothing of this horde exists: the refusal came before any state was created
    assert.equal(existsSync(join(dir, '.horde')), false);
    assert.equal(existsSync(join(dir, '.yggdrasil')), false);
    assert.equal(execFileSync('git', ['branch', '--list', 'mission1/trunk'], { cwd: dir, encoding: 'utf8' }).trim(), '');
  });

  await t.test('with Yggdrasil and no Grain: the graph is created, empty, and says what naming Grain would add', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', ...YG], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.graph.created, true);
    assert.equal(r.json.graph.mined, false);
    assert.equal(existsSync(join(dir, '.yggdrasil', 'yg-architecture.yaml')), true);
    assert.ok(r.json.graph.notes.some((n) => /the graph is empty/.test(n)), r.json.graph.notes.join('\n'));
    assert.ok(r.json.graph.notes.some((n) => /--grain/.test(n)));
    // and it is really readable through the CLI, which is the only way the horde ever reads it
    assert.equal(run('node.mjs', ['bind'], dir).code, 0);
  });

  await t.test('with Grain as well: propose is called, the proposal is adopted, and the baseline is reported', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'lib.mjs'), 'export const lib = 1; // UNFINISHED\n');
    execFileSync('git', ['add', 'src/lib.mjs'], { cwd: dir });
    git(['commit', '-qm', 'the code the graph will describe'], dir);

    const stub = join(dir, 'grain-stub.mjs');
    writeFileSync(stub, GRAIN_STUB);

    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', ...YG, '--grain', `node ${stub}`], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);

    // Grain was really called, with the staging directory as its argument.
    const calls = readFileSync(join(dir, 'grain-calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls[calls.length - 1], ['propose', '.yggdrasil-proposal']);

    // …and what it proposed is the repository's graph now.
    assert.equal(existsSync(join(dir, '.yggdrasil', 'model', 'lib', 'yg-node.yaml')), true);
    assert.match(r.stdout, /accepted/);
    assert.match(r.stdout, /Already broken/);

    // read back the only way the horde ever reads it
    const bind = run('node.mjs', ['bind'], dir);
    assert.deepEqual(bind.json.nodes, ['lib']);
    const show = run('node.mjs', ['show', 'lib'], dir);
    assert.deepEqual(show.json.boundary, ['src/**']);
    assert.deepEqual(show.json.rules.aspects.map((a) => a.id), ['no-marker']);
  });

  await t.test('a repository that already has a graph keeps it, untouched', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    initHorde(dir, 'first');
    addNode(dir, 'kept', { mapping: ['src/**'] });

    const again = run('horde.mjs', ['init', 'second', '--base', 'develop'], dir);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.graph.created, false);
    assert.deepEqual(run('node.mjs', ['bind', '--horde', 'second'], dir).json.nodes, ['kept']);
  });
});

// When the `promises` package is installed, its doc-shape rule is mapped onto wherever the
// repository chose to keep its promises — not necessarily one of the four guessed paths. The
// evidence layer has to read that off the graph (`yg aspects --json --reach`) rather than guess.
test('detectEvidenceLayer: with the promises package installed, the promises directory is read off the graph, not guessed', async (t) => {
  const { detectEvidenceLayer } = await import('../horde.mjs');
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  // A promises directory at a path none of the guessed fallbacks name.
  const promisesDir = join(dir, 'documentation', 'vows');
  mkdirSync(promisesDir, { recursive: true });
  writeFileSync(
    join(promisesDir, 'orders-are-confirmed.md'),
    '# Orders are confirmed\n\n**status:** implemented\n',
  );

  // Fake graph presence, and a stub Yggdrasil CLI answering `aspects --json --reach` with the
  // doc-shape rule reaching exactly that one file.
  mkdirSync(join(dir, '.yggdrasil'), { recursive: true });
  const stub = join(dir, 'yg-stub-reach.mjs');
  writeFileSync(stub, [
    "const args = process.argv.slice(2);",
    "if (args[0] === 'aspects' && args.includes('--reach')) {",
    '  process.stdout.write(JSON.stringify({',
    "    schema: 'yg-aspects/1',",
    '    aspects: [{',
    "      id: 'krzysztofdudek/Horde/promises/doc-shape',",
    '      reach: { units: [{ unit: { kind: "file", path: "documentation/vows/orders-are-confirmed.md" }, node: "docs" }] },',
    '    }],',
    '  }));',
    '  process.exit(0);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n'));

  const cfg = { ygCommand: `node ${stub}` };
  const layer = detectEvidenceLayer(dir, cfg);
  assert.equal(layer.kind, 'promises');
  assert.equal(layer.promises.dir, 'documentation/vows');
  assert.equal(layer.promises.count, 1);
});

// No graph at all, or a CLI/answer that cannot say where doc-shape reaches: the guessed list of
// four paths still works as the fallback it always was.
test('detectEvidenceLayer: with no graph, the guessed promises paths are still the fallback', async (t) => {
  const { detectEvidenceLayer } = await import('../horde.mjs');
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  const promisesDir = join(dir, 'promises');
  mkdirSync(promisesDir, { recursive: true });
  writeFileSync(
    join(promisesDir, 'orders-are-confirmed.md'),
    '# Orders are confirmed\n\n**status:** implemented\n',
  );

  const layer = detectEvidenceLayer(dir, {});
  assert.equal(layer.kind, 'promises');
  assert.equal(layer.promises.dir, 'promises');
});

// Issue 303: `done` depends only on what ran. A green entry in cache/last-gate.json that no tool here
// ran — what `wave close --gate green --sha` used to write from the flag alone, or anything else
// without `kind: 'ran'` — is never taken: the trunk gate is run again, and its own answer stands.
test('horde.mjs done: a green gate somebody typed is not taken — the trunk gate is run, and a red one refuses', () => {
  const dir = makeRepo();
  try {
    initHorde(dir);
    run('horde.mjs', ['config', 'set', 'gates.trunk', 'node -e "process.exit(1)"'], dir);
    const trunkSha = git(['rev-parse', 'mission1/trunk'], dir);
    const cachePath = join(dir, '.horde', 'hordes', 'mission1', 'cache', 'last-gate.json');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify({
      trunk: {
        result: 'green', sha: trunkSha, count: null, at: new Date().toISOString(), by: 'wave 1 close',
      },
    }, null, 2)}\n`);

    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /trunk gate red at/, 'the typed green was not taken');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cache.trunk.by, 'horde done', 'done ran the gate itself');
    assert.equal(cache.trunk.kind, 'ran');
    assert.equal(cache.trunk.result, 'red');
  } finally {
    rmRepo(dir);
  }
});
