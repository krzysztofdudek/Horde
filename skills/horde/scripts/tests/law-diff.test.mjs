// What a mission did to the law, as a document — `horde-law/1`.
//
// Everything here runs against a real graph made by the real Yggdrasil CLI, on two real trees: the
// branch the mission was cut from and the tip of its own trunk. The three sections are read off
// what the CLI answers about each tree, never off a stand-in, because the whole value of the
// document is that it says what the graph says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, requireYg, addAspect, addNode, MARKER_CHECK,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ygRun(dir, ygCommand, args) {
  const parts = ygCommand.split(/\s+/);
  return execFileSync(parts[0], [...parts.slice(1), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const lawPath = (dir, wave, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'law', `wave-${wave}.json`);

// A repository whose BASE already carries a graph: two components and one rule, committed onto
// `develop` before the mission starts. Everything a wave then does to the law is measured against
// this, so "the base had no graph at all" is never what a section is really reporting.
function baseFixture(dir, ygCommand) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'law-diff', version: '1.0.0', type: 'module' }, null, 2)}\n`);
  ygRun(dir, ygCommand, ['init', '--no-reviewer']);
  writeFileSync(join(dir, 'lib.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'other.mjs'), 'export const b = 2;\n');
  addNode(dir, 'feature', { mapping: ['lib.mjs'], aspects: ['no-marker', 'spread-rule'] });
  addNode(dir, 'edge', { mapping: ['other.mjs'] });
  addAspect(dir, 'no-marker', { status: 'draft', check: MARKER_CHECK, description: 'Source files must not be left carrying an unfinished-work marker.' });
  // A rule that already warns on the base and never changes rung: what the mission does to it is
  // attach it somewhere new, which is the third thing a mission can do to the law.
  addAspect(dir, 'spread-rule', { status: 'advisory', check: MARKER_CHECK, description: 'The same marker rule, under a second name.' });
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph the mission starts from'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
}

// Everything the mission's trunk gains, committed onto <horde>/trunk: one rule added, one raised,
// one attached to a component that did not declare it.
function workTheLaw(dir, ygCommand, horde = 'mission1') {
  git(['branch', '-f', `${horde}/trunk`, 'HEAD'], dir);
  // added — at advisory, so it really is verified over something and has components to name
  addAspect(dir, 'tidy-exports', { status: 'advisory', check: MARKER_CHECK, description: 'Every module says what it exports.' });
  // raised: the rule the base carries at draft stands at advisory here
  const aspectFile = join(dir, '.yggdrasil', 'aspects', 'no-marker', 'yg-aspect.yaml');
  writeFileSync(aspectFile, readFileSync(aspectFile, 'utf8').replace(/^status: draft$/m, 'status: advisory'));
  // attached: `edge` did not declare spread-rule on the base and declares it here; the new rule
  // hangs off `feature`, which is what gives the added section components of its own.
  addNode(dir, 'feature', { mapping: ['lib.mjs'], aspects: ['no-marker', 'spread-rule', 'tidy-exports'] });
  addNode(dir, 'edge', { mapping: ['other.mjs'], aspects: ['spread-rule'] });
  // …and every rule gets a reason of its own, which is what `why` reads back
  ygRun(dir, ygCommand, ['aspects', 'log', 'add', '--aspect', 'no-marker', '--reason', 'Raised because two waves in a row saw nothing new against it.']);
  ygRun(dir, ygCommand, ['aspects', 'log', 'add', '--aspect', 'tidy-exports', '--reason', 'Written down because three tickets in a row explained the same convention by hand.']);
  ygRun(dir, ygCommand, ['aspects', 'log', 'add', '--aspect', 'spread-rule', '--reason', 'Attached to the edge because the same convention turned out to hold there.']);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'what this wave did to the law'], dir);
  git(['branch', '-f', `${horde}/trunk`, 'HEAD'], dir);
}

test('horde-law/1: one rule added, one raised, one attached', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  workTheLaw(dir, yg);

  const r = run('law.mjs', ['diff', '--wave', '1'], dir);
  assert.equal(r.code, 0, r.stderr);
  const doc = r.json;

  await t.test('three sections, none of them empty', () => {
    assert.equal(doc.schema, 'horde-law/1');
    assert.equal(doc.horde, 'mission1');
    assert.equal(doc.base, git(['rev-parse', 'develop'], dir));
    assert.equal(doc.trunk, git(['rev-parse', 'mission1/trunk'], dir));
    assert.deepEqual(doc.added.map((i) => i.aspect), ['tidy-exports']);
    assert.deepEqual(doc.raised.map((i) => i.aspect), ['no-marker']);
    assert.deepEqual(doc.attached.map((i) => i.aspect), ['spread-rule']);
  });

  await t.test('each item carries the rule\'s own description and where it stands', () => {
    const [added] = doc.added;
    assert.equal(added.description, 'Every module says what it exports.');
    assert.deepEqual(added.status, { from: null, to: 'advisory' });
    const [raised] = doc.raised;
    assert.deepEqual(raised.status, { from: 'draft', to: 'advisory' });
    assert.deepEqual(doc.attached[0].status, { from: 'advisory', to: 'advisory' }, 'an attachment changes where a rule applies, never where it stands');
  });

  await t.test('`why` is the last thing the rule\'s own history says', () => {
    assert.match(doc.raised[0].why, /Raised because two waves in a row saw nothing new against it/);
    assert.match(doc.added[0].why, /three tickets in a row explained the same convention by hand/);
    assert.match(doc.attached[0].why, /the same convention turned out to hold there/);
  });

  await t.test('every item names the components its rule reaches', () => {
    // Every rule here stands at advisory on the trunk, so the gate really does verify each over the
    // components that declare it — which is what `nodes` reports.
    for (const section of ['added', 'raised', 'attached']) {
      const [item] = doc[section];
      assert.ok(item.nodes.length > 0, `${section}: expected components, got ${JSON.stringify(item.nodes)}`);
    }
    assert.ok(doc.raised[0].nodes.includes('feature'), `expected feature among ${JSON.stringify(doc.raised[0].nodes)}`);
    assert.ok(doc.attached[0].nodes.includes('edge'), `the rule reaches edge here and did not on the base: ${JSON.stringify(doc.attached[0].nodes)}`);
  });

  await t.test('the document is on disk at the wave\'s own path', () => {
    const onDisk = JSON.parse(readFileSync(lawPath(dir, '1'), 'utf8'));
    assert.equal(onDisk.schema, 'horde-law/1');
    assert.deepEqual(onDisk.added.map((i) => i.aspect), ['tidy-exports']);
  });
});

test('horde-law/1: an attachment with no change of standing is its own section', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  // The base carries the rule at advisory, so it has pairs on both sides and the only thing that
  // moves is which components declare it.
  const aspectFile = join(dir, '.yggdrasil', 'aspects', 'no-marker', 'yg-aspect.yaml');
  writeFileSync(aspectFile, readFileSync(aspectFile, 'utf8').replace(/^status: draft$/m, 'status: advisory'));
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the rule already warns on the base'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
  initHorde(dir);

  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);
  addNode(dir, 'edge', { mapping: ['other.mjs'], aspects: ['no-marker'] });
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'edge declares it now too'], dir);
  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);

  const r = run('law.mjs', ['diff', '--wave', '1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.added, []);
  assert.deepEqual(r.json.raised, []);
  assert.deepEqual(r.json.attached.map((i) => i.aspect), ['no-marker']);
  assert.deepEqual(r.json.attached[0].status, { from: 'advisory', to: 'advisory' });
  assert.ok(r.json.attached[0].nodes.includes('edge'));
});

test('horde-law/1: a rule nobody has written anything about gives why: null, not an exception', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);
  addAspect(dir, 'silent-rule', { status: 'draft', check: MARKER_CHECK });
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'a rule with nothing recorded about it'], dir);
  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);

  const r = run('law.mjs', ['diff', '--wave', '1'], dir);
  assert.equal(r.code, 0, r.stderr);
  const item = r.json.added.find((i) => i.aspect === 'silent-rule');
  assert.ok(item, 'the rule is in the document');
  assert.equal(item.why, null);
  // …and it is a draft rule, which removes a rule's pairs entirely: it reaches nothing the gate
  // verifies. It is still new law, and the document carries it rather than leaving it out.
  assert.deepEqual(item.nodes, []);
});

test('horde-law/1: a wave that did nothing to the law gives three empty lists, not a missing file', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);

  const r = run('law.mjs', ['diff', '--wave', '1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.added, []);
  assert.deepEqual(r.json.raised, []);
  assert.deepEqual(r.json.attached, []);
  assert.equal(existsSync(lawPath(dir, '1')), true, 'the document exists and says nothing happened — which is an answer');
});

test('wave close writes the document and prints its path, and a second close of the same wave does not double it', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  workTheLaw(dir, yg);

  run('wave.mjs', ['start'], dir);
  const closed = run('wave.mjs', ['close', '--gate', 'green'], dir, { json: false });
  assert.equal(closed.code, 0, closed.stderr);
  assert.match(closed.stdout, /what this mission has done to the law so far/);
  assert.match(closed.stdout, new RegExp(lawPath(dir, '1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const first = readFileSync(lawPath(dir, '1'), 'utf8');
  const firstDoc = JSON.parse(first);
  assert.deepEqual(firstDoc.added.map((i) => i.aspect), ['tidy-exports']);

  // The same wave, closed twice — a director who ran it again, or a resumed session that did.
  assert.equal(run('wave.mjs', ['start', '1'], dir).code, 0);
  const again = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.equal(again.code, 0, again.stderr);
  const secondDoc = JSON.parse(readFileSync(lawPath(dir, '1'), 'utf8'));
  assert.deepEqual(secondDoc.added.map((i) => i.aspect), ['tidy-exports'], 'one document per wave, replaced rather than appended to');
  assert.deepEqual(secondDoc.raised.map((i) => i.aspect), ['no-marker']);

  // …and the rule's own history gained nothing from either close: the document reads the graph, it
  // never writes to it.
  const log = JSON.parse(ygRun(dir, yg, ['aspects', 'log', 'read', '--aspect', 'no-marker', '--json']));
  assert.equal(log.entries.length, 1, 'two closes, still the one entry the fixture wrote');
});

// ---- broken states -----------------------------------------------------------------------
//
// A document read off one of two trees and not the other is not a smaller answer, it is a wrong
// one. Every failure below stops the whole document and names what could not be read.

test('the base branch is gone: a refusal naming it, and no half-written document', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);
  git(['branch', '-D', 'develop'], dir);

  const r = run('law.mjs', ['diff', '--wave', '1'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no such branch: develop/);
  assert.match(r.stderr, /half a comparison is not a smaller answer than none/);
  assert.equal(existsSync(lawPath(dir, '1')), false, 'nothing was written');
});

test('a Yggdrasil CLI Horde does not know: a refusal naming the version to install', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  workTheLaw(dir, yg);

  // A real, working CLI for everything but `aspects --json`, which answers a document from before
  // the one Horde reads — the shape a too-old install actually takes.
  const passthrough = join(dir, 'stale-yg.mjs');
  writeFileSync(passthrough, [
    "import { execFileSync } from 'node:child_process';",
    `const REAL = ${JSON.stringify(yg)};`,
    'const argv = process.argv.slice(2);',
    "if (argv[0] === 'aspects' && argv.includes('--json') && argv[1] !== 'log') {",
    '  process.stdout.write(JSON.stringify({ schema: "yg-aspects/0", aspects: [] }) + "\\n");',
    '  process.exit(0);',
    '}',
    'const real = REAL.split(/\\s+/);',
    'try {',
    '  execFileSync(real[0], [...real.slice(1), ...argv], { stdio: "inherit" });',
    '} catch (e) { process.exit(e.status ?? 1); }',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${passthrough}`], dir);

  const r = run('law.mjs', ['diff', '--wave', '1'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did not answer with the yg-aspects\/1 document Horde reads/);
  assert.match(r.stderr, /reports version/);
  assert.match(r.stderr, /Upgrade to a release later than 5\.9\.0/);
  assert.match(r.stderr, /npm i -g @chrisdudek\/yg/);
  assert.equal(existsSync(lawPath(dir, '1')), false);
});

test('a CLI that does not know a flag the law diff needs: a refusal naming the command, never a silently empty document', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  workTheLaw(dir, yg);

  // `check --json --full` is where the reach of every rule is read from. A CLI that does not know
  // `--full` must not be read as "every rule reaches nothing".
  const passthrough = join(dir, 'no-full-yg.mjs');
  writeFileSync(passthrough, [
    "import { execFileSync } from 'node:child_process';",
    `const REAL = ${JSON.stringify(yg)};`,
    'const argv = process.argv.slice(2);',
    "if (argv[0] === 'check' && argv.includes('--full')) {",
    '  process.stderr.write("error: unknown option \'--full\'\\n");',
    '  process.exit(1);',
    '}',
    'const real = REAL.split(/\\s+/);',
    'try {',
    '  execFileSync(real[0], [...real.slice(1), ...argv], { stdio: "inherit" });',
    '} catch (e) { process.exit(e.status ?? 1); }',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${passthrough}`], dir);

  const r = run('law.mjs', ['diff', '--wave', '1'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /check --json --full/);
  assert.match(r.stderr, /it does not know that option/);
  assert.equal(existsSync(lawPath(dir, '1')), false);
});

test('an unwritable law/ directory: a refusal naming the path', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);

  const lawDir = join(dir, '.horde', 'hordes', 'mission1', 'law');
  mkdirSync(lawDir, { recursive: true });
  chmodSync(lawDir, 0o500);
  t.after(() => { try { chmodSync(lawDir, 0o700); } catch { /* already gone */ } });

  const r = run('law.mjs', ['diff', '--wave', '1'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the law diff could not be written/);
  assert.match(r.stderr, new RegExp(lawDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('an unparseable graph.json is named, and never overwritten with an empty one', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  baseFixture(dir, yg);
  initHorde(dir);
  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);

  const graphPath = join(dir, '.horde', 'hordes', 'mission1', 'graph.json');
  writeFileSync(graphPath, '{ this is not json\n');

  const r = run('wave.mjs', ['start'], dir);
  assert.equal(r.code, 0, r.stderr);
  const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.equal(closed.code, 1);
  assert.match(closed.stderr, /invalid JSON in .*graph\.json/);
  assert.equal(readFileSync(graphPath, 'utf8'), '{ this is not json\n', 'the file the horde could not read is the file it left alone');
});
