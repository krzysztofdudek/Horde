// What a mission decided about code reaches the graph's own logs (issue 436). A ruling about one component
// (decide.mjs add --node) is its why and needs nobody's consent; one about a whole type (--area, with --reach
// and --rule) is a ruling of the mission until the client ratifies it (decide.mjs ratify, ask.mjs answer).
// horde.mjs done writes every node ruling in force and every ratified area ruling (with its rule's
// ratification) into the graph's logs with Horde's own code, as one commit of log entries on the trunk, and
// marks each ruling so nothing is ever written twice. The real Yggdrasil writes every entry here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, git, yg, addNode, addAspect, issueFileOf,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// A repository whose graph, committed on the mission's base, has one type (module) and one component of it
// (app), and a mission opened on it: the trunk holds that graph.
function missionOnGraph() {
  const dir = makeRepo();
  const made = yg(dir, ['init']);
  if (made.code !== 0) throw new Error(`yg init failed: ${made.out}`);
  writeFileSync(join(dir, '.yggdrasil', 'yg-architecture.yaml'), 'node_types:\n  module:\n    description: "A module"\n    parents: [root]\n');
  addNode(dir, 'app', { type: 'module' });
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'graph'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
  initHorde(dir);
  return dir;
}

const decisions = (dir, horde = 'mission1') => readFileSync(join(dir, '.horde', 'hordes', horde, '.jarl', 'decisions.md'), 'utf8');
const show = (dir, ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: dir, encoding: 'utf8' });

test('decide.mjs add: --node records the component on the ruling, --area its type, reach and rule; the two exclude each other', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  const node = run('decide.mjs', ['add', 'app-why', 'The app keeps its config in one file.', '--node', 'app'], dir);
  assert.equal(node.code, 0, node.stderr);
  assert.equal(node.json.node, 'app');
  assert.match(decisions(dir), /## \S+ · app-why\n\*\*Node:\*\* app\nThe app keeps its config in one file\./);
  const listed = run('decide.mjs', ['list', '--node', 'app'], dir);
  assert.deepEqual(listed.json.map((e) => e.slug), ['app-why']);

  const area = run('decide.mjs', ['add', 'mod-validate', 'Every module validates its input.', '--area', 'module', '--reach', '7', '--rule', 'validates-input'], dir);
  assert.equal(area.code, 0, area.stderr);
  assert.deepEqual([area.json.area, area.json.reach, area.json.rule], ['module', 7, 'validates-input']);
  assert.match(decisions(dir), /\*\*Area:\*\* module\n\*\*Reach:\*\* 7\n\*\*Rule:\*\* validates-input/);

  const both = run('decide.mjs', ['add', 'both', 'x', '--node', 'app', '--area', 'module'], dir);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /--node and --area exclude each other/);
  const bad = run('decide.mjs', ['add', 'bad', 'x', '--node', '../etc'], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--node names one component/);
  const reach = run('decide.mjs', ['add', 'r', 'x', '--reach', '3'], dir);
  assert.equal(reach.code, 1);
  assert.match(reach.stderr, /--reach .* needs --area/);
  assert.doesNotMatch(decisions(dir), /· both\n|· bad\n|· r\n/, 'a refused ruling writes nothing');
});

test('decide.mjs ratify: the batch is filed widest reach first and never twice; ask.mjs answer takes one word and marks the ruling', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  run('decide.mjs', ['add', 'narrow', 'Modules log refusals.', '--area', 'module', '--reach', '2'], dir);
  run('decide.mjs', ['add', 'wide', 'Modules validate input.', '--area', 'module', '--reach', '40'], dir);
  run('decide.mjs', ['add', 'plain', 'A ruling about nothing in the graph.'], dir);
  const first = run('decide.mjs', ['ratify'], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.json.items.map((i) => i.ruling), ['wide', 'narrow']);
  assert.match(first.json.items[0].question, /area module · 40 files · wide: "Modules validate input\." — tak \(yes\)/);
  // Asked once: a second call files nothing new and lists the same open items.
  const again = run('decide.mjs', ['ratify'], dir);
  assert.deepEqual(again.json.filed, []);
  assert.deepEqual(again.json.items.map((i) => i.id), first.json.items.map((i) => i.id));
  // Ratify items are not questions the landing guards read.
  assert.deepEqual(run('ask.mjs', ['list'], dir).json, []);

  const [wide, narrow] = first.json.items.map((i) => i.id);
  const vague = run('ask.mjs', ['answer', wide, 'maybe later'], dir);
  assert.equal(vague.code, 1);
  assert.match(vague.stderr, /the answer starts with one word/);
  const yes = run('ask.mjs', ['answer', wide, 'tak'], dir);
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual([yes.json.kind, yes.json.ruling, yes.json.verdict], ['ratify', 'wide', 'ratified']);
  const no = run('ask.mjs', ['answer', narrow, 'nie'], dir);
  assert.equal(no.json.verdict, 'rejected');
  assert.match(decisions(dir), /## \S+ · wide\n[\s\S]*?\*\*Ratified:\*\* a-001/);
  assert.match(decisions(dir), /## \S+ · narrow\n[\s\S]*?\*\*Rejected:\*\* a-002/);
  assert.equal(run('ask.mjs', ['answer', wide, 'tak'], dir).code, 1, 'an answered item is not answered again');
  assert.equal(run('decide.mjs', ['ratify'], dir).json.items.length, 0, 'a ruling ratified or rejected is never asked again');
});

// writeGraphLogs, as done calls it, run in the repository by a process of its own.
function writeLogs(dir) {
  const script = [
    `import { writeGraphLogs } from ${JSON.stringify(pathToFileURL(join(SCRIPTS_DIR, 'decide.mjs')).href)};`,
    `import { readConfig, git } from ${JSON.stringify(pathToFileURL(join(SCRIPTS_DIR, '_lib.mjs')).href)};`,
    "const sha = git(['rev-parse', 'mission1/trunk']);",
    "console.log(JSON.stringify(writeGraphLogs('mission1', readConfig() || {}, { branch: 'mission1/trunk', sha })));",
  ].join('\n');
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop());
}

test('the graph\'s logs: node rulings and ratified area rulings reach the trunk as one commit, each marked, never twice; the rest is reported', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  run('decide.mjs', ['add', 'app-why', 'The app keeps its config in one file.', '--node', 'app'], dir);
  run('decide.mjs', ['add', 'mod-one', 'Every module validates its input.', '--area', 'module', '--reach', '5'], dir);
  run('decide.mjs', ['add', 'mod-later', 'Modules name their errors.', '--area', 'module', '--reach', '5'], dir);
  run('decide.mjs', ['add', 'ghost-rule', 'Ghosts do not exist.', '--area', 'ghost', '--reach', '1'], dir);
  run('decide.mjs', ['add', 'old-why', 'Superseded before it was ever written.', '--node', 'app'], dir);
  run('decide.mjs', ['add', 'new-why', 'The app reads its config once, at start.', '--node', 'app', '--supersedes', 'old-why'], dir);
  const batch = run('decide.mjs', ['ratify'], dir).json.items;
  const id = (slug) => batch.find((i) => i.ruling === slug).id;
  run('ask.mjs', ['answer', id('mod-one'), 'yes'], dir);
  run('ask.mjs', ['answer', id('ghost-rule'), 'tak'], dir);
  const before = git(['rev-parse', 'mission1/trunk'], dir);

  const out = writeLogs(dir);
  assert.ok(out.commit, JSON.stringify(out));
  assert.equal(out.from, before);
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), out.commit);
  assert.equal(git(['rev-parse', `${out.commit}^`], dir), before, 'one commit, over the tip it was given');
  assert.deepEqual(out.written.map((w) => `${w.kind}:${w.slug}`).sort(), ['node:app-why', 'node:new-why', 'type:mod-one']);
  const changed = git(['diff', '--name-only', before, out.commit], dir).split('\n').sort();
  assert.ok(changed.every((p) => p.startsWith('.yggdrasil/')), `log entries only: ${changed.join(', ')}`);
  assert.match(show(dir, out.commit, '.yggdrasil/model/app/log.md'), /The app keeps its config in one file\.\n\n\(ruling app-why, mission mission1\)/);
  assert.match(show(dir, out.commit, '.yggdrasil/model/app/log.md'), /The app reads its config once, at start\./);
  assert.doesNotMatch(show(dir, out.commit, '.yggdrasil/model/app/log.md'), /Superseded before|\*\*Node:\*\*/, 'a superseded ruling is not written, and the field line is not the why');
  assert.match(show(dir, out.commit, '.yggdrasil/types/module/log.md'), /Every module validates its input\.\n\n\(ratified: mod-one, a-\d{3}; mission mission1\)/);
  // What yg refused is reported with the command to run by hand, and stays a ruling of the mission.
  assert.deepEqual(out.failed.map((f) => f.slug), ['ghost-rule']);
  assert.match(out.failed[0].reason, /type-not-found/);
  assert.match(out.failed[0].retry, /log add --type ghost --reason/);
  assert.deepEqual(out.unratified, ['mod-later']);
  assert.deepEqual(out.pending, [id('mod-later')]);
  // Each written ruling is marked where Jarl's own views read it.
  const d = decisions(dir);
  assert.match(d, /\*\*Node:\*\* app · \*\*Node log:\*\* \d{4}-\d\d-\d\dT[0-9:.]+Z\nThe app keeps/);
  assert.match(d, /## \S+ · mod-one\n[\s\S]*?\*\*Type log:\*\* module · \d{4}-\d\d-\d\dT[0-9:.]+Z/);
  assert.doesNotMatch(d, /## \S+ · ghost-rule\n[^#]*Type log/);

  // Nothing is written twice: a second pass owes the graph nothing it has already been given.
  const second = writeLogs(dir);
  assert.equal(second.commit, null);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.failed.map((f) => f.slug), ['ghost-rule']);
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), out.commit, 'the trunk did not move');

  // A ruling ratified later, superseding one written there, replaces it there too — as yg itself asks.
  run('decide.mjs', ['add', 'mod-two', 'Every module validates its input with the shared schema.', '--area', 'module', '--reach', '5', '--supersedes', 'mod-one'], dir);
  const item = run('decide.mjs', ['ratify'], dir).json.items.find((i) => i.ruling === 'mod-two');
  run('ask.mjs', ['answer', item.id, 'ok'], dir);
  const third = writeLogs(dir);
  assert.deepEqual(third.written.map((w) => w.slug), ['mod-two']);
  const typeLog = show(dir, third.commit, '.yggdrasil/types/module/log.md');
  assert.match(typeLog, /shared schema/);
  const read = yg(dir, ['log', 'read', '--type', 'module']);
  assert.equal(read.code, 0, read.out);
});

test('the graph\'s logs: a trunk that moved while they were written is left alone, and nothing is marked', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  run('decide.mjs', ['add', 'app-why', 'The app keeps its config in one file.', '--node', 'app'], dir);
  const script = [
    `import { writeGraphLogs } from ${JSON.stringify(pathToFileURL(join(SCRIPTS_DIR, 'decide.mjs')).href)};`,
    `import { readConfig, git } from ${JSON.stringify(pathToFileURL(join(SCRIPTS_DIR, '_lib.mjs')).href)};`,
    // The sha done was given is no longer the trunk's tip: something landed on it meanwhile.
    "const sha = git(['rev-parse', 'mission1/trunk']);",
    "git(['update-ref', 'refs/heads/mission1/trunk', git(['commit-tree', '-p', sha, '-m', 'landed meanwhile', `${sha}^{tree}`])]);",
    "console.log(JSON.stringify(writeGraphLogs('mission1', readConfig() || {}, { branch: 'mission1/trunk', sha })));",
  ].join('\n');
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(out.commit, null);
  assert.deepEqual(out.written, []);
  assert.match(out.failed[0].reason, /moved while the entries were written/);
  assert.doesNotMatch(decisions(dir), /Node log/);
  assert.equal(git(['log', '-1', '--format=%s', 'mission1/trunk'], dir), 'landed meanwhile');
});

test('the graph\'s logs: a commit the adopter\'s own hook refuses is reported with what the hook said, the trunk stays, and nothing is marked', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  run('decide.mjs', ['add', 'app-why', 'The app keeps its config in one file.', '--node', 'app'], dir);
  const hooks = join(dir, git(['rev-parse', '--git-path', 'hooks'], dir));
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "adopter hook says no" >&2\nexit 1\n', { mode: 0o755 });
  const before = git(['rev-parse', 'mission1/trunk'], dir);
  const out = writeLogs(dir);
  assert.equal(out.commit, null);
  assert.deepEqual(out.written, []);
  assert.deepEqual(out.failed.map((f) => f.slug), ['app-why']);
  assert.match(out.failed[0].reason, /commit on mission1\/trunk was refused/);
  assert.match(out.failed[0].reason, /adopter hook says no/);
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), before, 'the trunk did not move');
  assert.doesNotMatch(decisions(dir), /Node log/);
  // Once the hook lets it through, the same ruling is still owed and is written then.
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.deepEqual(writeLogs(dir).written.map((w) => w.slug), ['app-why']);
});

test('horde.mjs done writes the mission\'s rulings into the graph\'s logs on the trunk it hands over, and says what it could not', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  run('horde.mjs', ['config', 'set', 'gates.trunk', 'true'], dir);
  const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  writeFileSync(charterPath, readFileSync(charterPath, 'utf8').replace('| | | | |', '| E1 | the suite is green | api | |'));
  const ticketDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', '001-slug');
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(issueFileOf(ticketDir), '# 001 · slug\n\n**Status:** merged\n\n## Acceptance — evidence\n\n- [x] covers E1\n');
  writeFileSync(join(ticketDir, 'log.md'), '## Verdict · 001 · 2026-01-01 · by verifier-1 (standard)\n\n**Result:** reproduced\n');
  writeFileSync(join(dir, '.horde', 'hordes', 'mission1', 'retro-classes.json'), '{"items": {}}\n');
  assert.equal(run('retro.mjs', ['--tree', dir, '--horde', 'mission1'], dir).code, 0);

  run('decide.mjs', ['add', 'app-why', 'The app keeps its config in one file.', '--node', 'app'], dir);
  run('decide.mjs', ['add', 'mod-one', 'Every module validates its input.', '--area', 'module', '--reach', '5'], dir);
  run('decide.mjs', ['add', 'mod-later', 'Modules name their errors.', '--area', 'module'], dir);
  const items = run('decide.mjs', ['ratify'], dir).json.items;
  run('ask.mjs', ['answer', items.find((i) => i.ruling === 'mod-one').id, 'tak'], dir);
  const gated = git(['rev-parse', 'mission1/trunk'], dir);

  const r = run('horde.mjs', ['done'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.gate.sha, gated, 'the gate is reported at the tip it passed');
  assert.equal(r.json.graphLog.from, gated);
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), r.json.graphLog.commit);
  assert.match(show(dir, 'mission1/trunk', '.yggdrasil/model/app/log.md'), /The app keeps its config in one file\./);
  assert.match(show(dir, 'mission1/trunk', '.yggdrasil/types/module/log.md'), /Every module validates its input\./);
  assert.doesNotMatch(show(dir, 'mission1/trunk', '.yggdrasil/types/module/log.md'), /name their errors/, 'an unratified ruling never enters the type\'s decisions');
  assert.deepEqual(r.json.graphLog.unratified, ['mod-later']);
  const archived = readFileSync(join(r.json.archived.to, '.jarl', 'decisions.md'), 'utf8');
  assert.match(archived, /\*\*Type log:\*\* module · /);
  assert.match(archived, /\*\*Node log:\*\* /);
  const said = run('horde.mjs', ['done'], dir, { json: false });
  assert.equal(said.code, 1, 'a done mission is archived: there is nothing left to finish');
});

test('horde.mjs done with nothing decided about code moves nothing: the trunk stays at the tip the gate passed', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  run('horde.mjs', ['config', 'set', 'gates.trunk', 'true'], dir);
  run('decide.mjs', ['add', 'plain', 'A ruling of the mission alone.'], dir);
  const before = git(['rev-parse', 'mission1/trunk'], dir);
  const out = writeLogs(dir);
  assert.deepEqual(out, {
    commit: null, from: before, written: [], failed: [], unratified: [], pending: [], unasked: [],
  });
  assert.equal(git(['rev-parse', 'mission1/trunk'], dir), before);
});

// Issue 515: a rule's ratification names whoever answered the ratify item — the name ask.mjs answer --by
// recorded as the By of the answer's ruling — and "the client" when nobody was named; never the name git
// holds for whoever runs done (here "Test User").
test('the graph\'s logs: a rule\'s ratification names who answered (ask.mjs answer --by), else the client — never git\'s user.name', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  addAspect(dir, 'validates-input', { content: 'Every module validates its input.\n' });
  addAspect(dir, 'names-errors', { content: 'Every module names its errors.\n' });
  // The type lists both rules, so a ratification of either admits it on that type.
  writeFileSync(join(dir, '.yggdrasil', 'yg-architecture.yaml'), 'node_types:\n  module:\n    description: "A module"\n    parents: [root]\n    aspects:\n      - validates-input\n      - names-errors\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'rules'], dir);
  git(['branch', '-f', 'mission1/trunk', 'HEAD'], dir);
  run('decide.mjs', ['add', 'mod-validate', 'Every module validates its input.', '--area', 'module', '--reach', '5', '--rule', 'validates-input'], dir);
  run('decide.mjs', ['add', 'mod-errors', 'Every module names its errors.', '--area', 'module', '--reach', '3', '--rule', 'names-errors'], dir);
  const batch = run('decide.mjs', ['ratify'], dir).json.items;
  const id = (slug) => batch.find((i) => i.ruling === slug).id;

  const unsafe = run('ask.mjs', ['answer', id('mod-validate'), 'tak', '--by', 'Jan "Kowalski"'], dir);
  assert.equal(unsafe.code, 1, 'a name yg could not take safely is refused at the answer');
  assert.match(unsafe.stderr, /--by names who answered/);
  const named = run('ask.mjs', ['answer', id('mod-validate'), 'tak', '--by', 'Anna Nowak'], dir);
  assert.equal(named.code, 0, named.stderr);
  assert.equal(named.json.by, 'Anna Nowak');
  assert.match(decisions(dir), new RegExp(`## \\S+ · ask-${id('mod-validate').slice(2)}\\n[\\s\\S]*?\\*\\*By:\\*\\* Anna Nowak`));
  assert.equal(run('ask.mjs', ['answer', id('mod-errors'), 'yes'], dir).code, 0);

  const out = writeLogs(dir);
  assert.ok(out.commit, JSON.stringify(out));
  const rules = Object.fromEntries(out.written.filter((w) => w.kind === 'rule').map((w) => [w.rule, w.by]));
  assert.deepEqual(rules, { 'validates-input': 'Anna Nowak', 'names-errors': 'the client' });
  // Read by yg itself, on the trunk the entries were committed to.
  git(['checkout', '-q', 'mission1/trunk'], dir);
  const validates = yg(dir, ['log', 'read', '--aspect', 'validates-input']);
  assert.equal(validates.code, 0, validates.out);
  assert.match(validates.out, /Anna Nowak/);
  assert.doesNotMatch(validates.out, /Test User/);
  const errors = yg(dir, ['log', 'read', '--aspect', 'names-errors']);
  assert.match(errors.out, /the client/);
  assert.doesNotMatch(errors.out, /Test User/);
  assert.match(git(['log', '-1', '--format=%b', 'mission1/trunk'], dir), /rule validates-input \(ratified by Anna Nowak\)/);
});

// Issue 515: yg refuses a type decision that says nothing about the decisions in force for that type, and
// the command to write it by hand names both ways to answer that: --adds, or --supersedes.
test('the graph\'s logs: a type decision yg refuses over decisions in force is reported with a hand-run command naming --adds beside --supersedes', (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  run('decide.mjs', ['add', 'mod-one', 'Every module validates its input.', '--area', 'module', '--reach', '5'], dir);
  run('ask.mjs', ['answer', run('decide.mjs', ['ratify'], dir).json.items[0].id, 'tak'], dir);
  assert.deepEqual(writeLogs(dir).written.map((w) => w.slug), ['mod-one']);
  // A second decision about the same type, neither replacing the first nor saying it adds to it.
  run('decide.mjs', ['add', 'mod-two', 'Every module names its errors.', '--area', 'module', '--reach', '5'], dir);
  run('ask.mjs', ['answer', run('decide.mjs', ['ratify'], dir).json.items[0].id, 'tak'], dir);
  const out = writeLogs(dir);
  assert.deepEqual(out.failed.map((f) => f.slug), ['mod-two'], JSON.stringify(out));
  assert.match(out.failed[0].retry, /log add --type module --reason '<the ruling>' --adds \(or --supersedes <datetime> of each decision in force it replaces\)/);
  // What the hint says works: the entry written by hand with --adds is taken.
  const file = join(dir, 'mod-two.md');
  writeFileSync(file, 'Every module names its errors.\n');
  const byHand = yg(dir, ['log', 'add', '--type', 'module', '--reason-file', file, '--adds']);
  assert.equal(byHand.code, 0, byHand.out);
});

// Issue 515: an area ruling no ratification batch ever put to the client is named at done, apart from the
// ones the client was asked about and has not answered — nobody declined it; nobody asked.
test('horde.mjs done warns about area rulings no ratification batch was filed for', async (t) => {
  const dir = missionOnGraph();
  t.after(() => rmRepo(dir));
  run('decide.mjs', ['add', 'mod-asked', 'Modules log refusals.', '--area', 'module', '--reach', '2'], dir);
  run('decide.mjs', ['ratify'], dir);
  run('decide.mjs', ['add', 'mod-never', 'Modules name their errors.', '--area', 'module', '--reach', '4'], dir);
  const out = writeLogs(dir);
  assert.deepEqual(out.unratified, ['mod-asked', 'mod-never']);
  assert.deepEqual(out.unasked, ['mod-never']);
  const { graphLogLines } = await import(pathToFileURL(join(SCRIPTS_DIR, 'horde.mjs')).href);
  const lines = graphLogLines(out, 'mission1/trunk').join('\n');
  assert.match(lines, /WARNING: 1 area ruling\(s\) were never put to the client — no ratification batch was filed for them \(decide\.mjs ratify\)[^\n]*: mod-never\./);
  assert.doesNotMatch(graphLogLines({ ...out, unasked: [] }, 'mission1/trunk').join('\n'), /WARNING/);
});
