import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, writeCostRuns, requireYg, addNode,
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
    const r = run('horde.mjs', ['init', 'mission1', '--base', 'develop', ...YG], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.gates.team, gate);
    assert.equal(r.json.gates.trunk, gate);
    if (glob) assert.ok(r.json.testGlobs.includes(glob), `${glob} not in ${JSON.stringify(r.json.testGlobs)}`);
  });
}

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

// E13 — dropping a row outright is free before the mission's wave 1 starts, and needs a ruled
// escalation naming it afterwards.
test('horde.mjs charter edit: dropping a row is free before wave 1, refused after without a ruled escalation naming it', async (t) => {
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

  await t.test('after wave 1, dropping E2 without --escalation is refused', () => {
    const r = charterEditRaw(withOne);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /drops evidence row\(s\) E2/);
    assert.match(r.stderr, /escalate\.mjs add/);
  });

  await t.test('an --escalation that is not yet ruled is refused', () => {
    const esc = run('escalate.mjs', ['add', 'field is unreachable', '--kind', 'charter', '--by', 'steward'], dir);
    const r = charterEditRaw(withOne, ['--escalation', esc.json.id]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not ruled yet/);
  });

  await t.test('a ruled escalation whose text never names the dropped row is refused', () => {
    const esc = run('escalate.mjs', ['add', 'field is unreachable', '--kind', 'charter', '--by', 'steward'], dir);
    run('escalate.mjs', ['rule', esc.json.id, 'agreed, dropping a row', '--by', 'director'], dir);
    const r = charterEditRaw(withOne, ['--escalation', esc.json.id]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not mention dropped row\(s\): E2/);
  });

  await t.test('a ruled escalation naming the row lets the drop through', () => {
    const esc = run('escalate.mjs', ['add', 'E2 cannot be reproduced in this environment', '--kind', 'charter', '--by', 'steward'], dir);
    run('escalate.mjs', ['rule', esc.json.id, 'agreed, E2 is dropped', '--by', 'director'], dir);
    const r = charterEditRaw(withOne, ['--escalation', esc.json.id]);
    assert.equal(r.code, 0);
    assert.equal(r.json.evidenceRows, 1);
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
    assert.match(r.stderr, /no cost has ever been recorded/);
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
  writeFileSync(join(ticketDir, 'log.md'), '## Verdict · 001 · 2026-01-01 · by verifier-1 (sonnet)\n\n**Result:** reproduced\n');

  await t.test('refuses naming the missing cost report once evidence and gate are clear', () => {
    // The audit condition (and the "no wave has ever been started" check that gated it) is gone
    // entirely — done's gate is now just evidence, trunk gate, cost — so with evidence reproduced
    // and the gate green, cost is the only reason left.
    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, /evidence row\(s\) not reproduced/);
    assert.match(r.stderr, /no cost has ever been recorded/);
  });

  writeCostRuns(dir, 'mission1', [
    { name: 'mission1-worker-trunk-1', role: 'worker', class: 'sonnet', ticket: '001', team: 'trunk', wave: '1', at: new Date().toISOString() },
  ]);

  await t.test('passes once every reason is met — stamps the charter and appends the completion block', () => {
    const r = run('horde.mjs', ['done'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.evidence.green, 1);
    assert.equal(r.json.evidence.total, 1);
    assert.equal(r.json.gate.result, 'green');
    assert.equal(r.json.cost.runs, 1);

    const stamped = readFileSync(charterPath, 'utf8');
    assert.match(stamped, /\| E1 \| the suite is green \| api \| verifier-1 \|/);

    const plan = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
    assert.match(plan, /# Mission complete/);
    assert.match(plan, /Evidence catalogue:\*\* 1\/1 green/);
    assert.match(plan, /Ready to push: `mission1\/trunk`/);
  });

  await t.test('status.mjs now shows the row as reproduced', () => {
    const r = run('status.mjs', ['--horde', 'mission1'], dir);
    assert.equal(r.json.hordes[0].evidence.rows[0].state, 'reproduced');
    assert.equal(r.json.hordes[0].evidence.rows[0].reproducedBy, 'verifier-1');
  });
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
    execFileSync('git', ['commit', '-qm', 'the code the graph will describe'], { cwd: dir });

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
