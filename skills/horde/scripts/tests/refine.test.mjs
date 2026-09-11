import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, initHorde, addNode, addAspect, run, yg, MARKER_CHECK,
} from './helpers.mjs';

// Every refusal below is exercised through run() — a child process — and never by importing
// refine.mjs here: fail() calls process.exit(), which would take this whole test run with it (the
// same reason lib.test.mjs keeps teamPath's refusals at the CLI level).

function git(args, dir) { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); }

function writeFile(dir, rel, text) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

// A real graph with three components, three files and one rule that reaches exactly one of them —
// enough for a cut with a boundary between territories, and for the rule bytes to be a number a
// threshold test can pin.
function graphFixture(dir) {
  yg(dir, ['init']);
  addNode(dir, 'auth', { description: 'Signing people in.', mapping: ['src/auth/**'], aspects: ['no-marker'] });
  addNode(dir, 'api', { description: 'The HTTP surface.', mapping: ['src/api/**'] });
  addNode(dir, 'reporting', { description: 'Numbers for the month.', mapping: ['src/reporting/**'] });
  addAspect(dir, 'no-marker', { check: MARKER_CHECK });
  writeFile(dir, 'src/auth/login.mjs', 'export const login = 1;\n');
  writeFile(dir, 'src/api/routes.mjs', 'export const routes = 1;\n');
  writeFile(dir, 'src/reporting/month.mjs', 'export const month = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
}

function hordeFile(dir, horde, name) {
  return join(dir, '.horde', 'hordes', horde, name);
}

function writeTerritories(dir, horde, doc) {
  writeFileSync(hordeFile(dir, horde, 'territories.json'), `${JSON.stringify(doc, null, 2)}\n`);
}

const TWO_TERRITORIES = {
  'the front door': { nodes: ['auth', 'api'], class: 'sonnet', why: 'Both of these are how a request gets in.' },
  numbers: { nodes: ['reporting'], class: 'haiku', why: 'The month-end figures, and nothing else.' },
};

// The charter's evidence catalogue, written the way a framing session would leave it.
function seedCharter(dir, horde, rows) {
  const path = hordeFile(dir, horde, 'charter.md');
  const text = readFileSync(path, 'utf8').replace('| | | |', rows.map((r) => `| ${r.id} | ${r.evidence} | ${r.node} | |`).join('\n'));
  writeFileSync(path, text);
}

function fileTicket(dir, horde, args) {
  const r = run('tk.mjs', ['new', ...args, '--horde', horde], dir);
  assert.equal(r.code, 0, r.stderr);
  return r.json.id;
}

// A real program standing in for the Grain CLI, in the shape the other Grain fixture in this suite
// already uses: started for real, answering each subcommand with something recognisable.
const GRAIN_STUB = [
  "const argv = process.argv.slice(2);",
  "if (argv[0] === '--version') { console.log('0.0.0-stub'); process.exit(0); }",
  "console.log('grain-stub answering: ' + argv.join(' '));",
  '',
].join('\n');

test('refine.mjs --step cut: the cut is checked against the graph, not trusted', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');

  await t.test('with no cut on file yet, it prints the architect brief and writes nothing', () => {
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'awaiting');
    assert.match(r.json.brief, /territories\.json/);
    assert.match(r.json.brief, /\*\*whole components\*\*/);
    assert.equal(existsSync(join(dir, '.horde', 'leases.json')), false, 'a brief takes no lease');
  });

  await t.test('a territory naming a file inside a component is refused, naming the component it would split', () => {
    writeTerritories(dir, 'm1', { doors: { nodes: ['src/auth/login.mjs'], class: 'sonnet', why: 'w' } });
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /src\/auth\/login\.mjs/);
    assert.match(r.stderr, /part of the component "auth"/);
    assert.match(r.stderr, /WHOLE components/);
  });

  await t.test('two territories sharing one component are refused, naming the component and both territories', () => {
    writeTerritories(dir, 'm1', {
      doors: { nodes: ['auth'], class: 'sonnet', why: 'w' },
      'also doors': { nodes: ['auth', 'api'], class: 'sonnet', why: 'w' },
    });
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"auth"/);
    assert.match(r.stderr, /"doors"/);
    assert.match(r.stderr, /"also doors"/);
  });

  await t.test('a component the graph does not have is refused by name, with the ones it does have', () => {
    writeTerritories(dir, 'm1', { doors: { nodes: ['billing'], class: 'sonnet', why: 'w' } });
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no component "billing"/);
    assert.match(r.stderr, /auth/);
  });

  await t.test('an empty territory is refused', () => {
    writeTerritories(dir, 'm1', { doors: { nodes: [], class: 'sonnet', why: 'w' } });
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /territory "doors" is empty/);
  });

  await t.test('a class this horde does not have is refused, listing the ones it does', () => {
    writeTerritories(dir, 'm1', { doors: { nodes: ['auth'], class: 'gpt', why: 'w' } });
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /class "gpt"/);
    assert.match(r.stderr, /haiku, sonnet, opus, fable/);
  });

  await t.test('a territory that says no why is refused — the client reads it', () => {
    writeTerritories(dir, 'm1', { doors: { nodes: ['auth'], class: 'sonnet', why: '  ' } });
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /says no why/);
  });

  await t.test('none of those refusals left a lease behind', () => {
    const leases = existsSync(join(dir, '.horde', 'leases.json'))
      ? JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8')).leases
      : {};
    assert.deepEqual(Object.keys(leases), []);
  });

  await t.test('a good cut is accepted, measured, and leased one territory at a time', () => {
    writeTerritories(dir, 'm1', TWO_TERRITORIES);
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'accepted');
    assert.deepEqual(r.json.territories.map((x) => x.territory).sort(), ['numbers', 'the front door']);
    const front = r.json.territories.find((x) => x.territory === 'the front door');
    assert.deepEqual(front.nodes, ['auth', 'api']);
    assert.equal(front.class, 'sonnet');
    assert.ok(front.bytes.code > 0, 'the code it maps is counted');
    assert.ok(front.bytes.aspects > 0, 'so is the text of the rule that reaches it');
    assert.equal(front.bytes.total, front.bytes.code + front.bytes.aspects + front.bytes.logs);

    const leases = JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8'));
    assert.deepEqual(Object.keys(leases.leases).sort(), ['numbers', 'the front door']);
    assert.equal(leases.leases['the front door'].horde, 'm1');
  });
});

test('refine.mjs --step cut: one size for the whole horde, and the limit is closed', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');
  writeTerritories(dir, 'm1', { doors: { nodes: ['auth'], class: 'sonnet', why: 'The way in.' } });

  const measured = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).json.territories[0].bytes;

  await t.test('over the limit is refused, with the count broken into code, rules and logs', () => {
    assert.equal(run('horde.mjs', ['config', 'set', 'territory.maxBytes', String(measured.total - 1)], dir).code, 0);
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${measured.total} bytes against a limit of ${measured.total - 1}`));
    assert.match(r.stderr, new RegExp(`code ${measured.code}`));
    assert.match(r.stderr, new RegExp(`rules ${measured.aspects}`));
    assert.match(r.stderr, new RegExp(`logs ${measured.logs}`));
    assert.match(r.stderr, /Cut it finer/);
  });

  await t.test('exactly at the limit passes — the boundary is closed', () => {
    assert.equal(run('horde.mjs', ['config', 'set', 'territory.maxBytes', String(measured.total)], dir).code, 0);
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.territories[0].bytes.total, measured.total);
  });

  await t.test('the same territory passes again once the limit is raised', () => {
    assert.equal(run('horde.mjs', ['config', 'set', 'territory.maxBytes', String(measured.total + 1000)], dir).code, 0);
    assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);
  });

  await t.test('the limit is one number for the horde, not one per class — a heavier class does not buy room', () => {
    writeTerritories(dir, 'm1', { doors: { nodes: ['auth'], class: 'opus', why: 'The way in.' } });
    assert.equal(run('horde.mjs', ['config', 'set', 'territory.maxBytes', String(measured.total - 1)], dir).code, 0);
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 1, 'opus is more expensive, not bigger');
    assert.match(r.stderr, new RegExp(`limit of ${measured.total - 1}`));
  });
});

test('refine.mjs: a territory is leased across every live horde on the repository', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');
  initHorde(dir, 'm2');

  writeTerritories(dir, 'm1', TWO_TERRITORIES);
  assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);

  await t.test('two territories of the same horde do not collide with each other', () => {
    const leases = JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8')).leases;
    assert.deepEqual(Object.keys(leases).sort(), ['numbers', 'the front door']);
  });

  await t.test('another live horde is refused, and told who holds it and when they last moved', () => {
    writeTerritories(dir, 'm2', { 'the front door': { nodes: ['auth'], class: 'sonnet', why: 'Mine now.' } });
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm2'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /territory "the front door" is leased by horde "m1"/);
    assert.match(r.stderr, /last activity \d{4}-\d{2}-\d{2}/);
    assert.match(r.stderr, /horde\.mjs archive m1/);
  });

  await t.test('the refusal points at the client, never at a take-over that does not exist', () => {
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm2'], dir);
    assert.match(r.stderr, /put it to the client/);
    assert.doesNotMatch(r.stderr, /escalation/, 'a territory is never taken over on an escalation');
  });

  await t.test('archiving the holder releases its territories, and the same cut then passes', () => {
    const archived = run('horde.mjs', ['archive', 'm1'], dir);
    assert.equal(archived.code, 0, archived.stderr);
    assert.deepEqual(archived.json.releasedLeases.sort(), ['numbers', 'the front door']);
    const leases = JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8')).leases;
    assert.deepEqual(Object.keys(leases), [], 'the file itself no longer holds them');

    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm2'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8')).leases['the front door'].horde, 'm2');
  });

  await t.test('a leases.json written only half way is refused by name, never read as empty', () => {
    const path = join(dir, '.horde', 'leases.json');
    const whole = readFileSync(path, 'utf8');
    writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)));
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm2'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /leases\.json/);
    assert.match(r.stderr, /not an empty one/);
    writeFileSync(path, whole);
  });
});

test('refine.mjs --step consult: one spawn per territory, each seeing only its own', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');
  seedCharter(dir, 'm1', [
    { id: 'E1', evidence: 'a signed-in user reaches /me', node: 'auth' },
    { id: 'E2', evidence: 'the month figures match the ledger', node: 'reporting' },
  ]);
  writeTerritories(dir, 'm1', TWO_TERRITORIES);
  assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);

  const r = run('refine.mjs', ['--step', 'consult', '--horde', 'm1'], dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('exactly as many spawns as territories, each with its own class', () => {
    assert.equal(r.json.spawns.length, 2);
    assert.deepEqual(
      r.json.spawns.map((s) => [s.territory, s.class]).sort(),
      [['numbers', 'haiku'], ['the front door', 'sonnet']],
    );
  });

  await t.test('every brief carries the five questions, in order', () => {
    for (const spawn of r.json.spawns) {
      const at = [
        'What must change in me?',
        'Is this a new module, or a change inside one that exists?',
        'Does this break single responsibility?',
        'What pattern do I want here, and is it already law?',
        'What contract do I need from a neighbour?',
      ].map((q) => spawn.brief.indexOf(q));
      assert.ok(at.every((i) => i !== -1), `${spawn.territory} is missing one of the five questions`);
      assert.deepEqual(at, [...at].sort((a, b) => a - b), 'the five questions are in order');
    }
  });

  await t.test('a brief carries its own components, their rules and their paths', () => {
    const front = r.json.spawns.find((s) => s.territory === 'the front door').brief;
    assert.match(front, /### auth/);
    assert.match(front, /### api/);
    assert.match(front, /Signing people in\./);
    assert.match(front, /src\/auth\/\*\*/);
    assert.match(front, /\*\*no-marker\*\* \[enforced\]/);
  });

  await t.test('and carries no component id from outside it — the negative assertion', () => {
    const front = r.json.spawns.find((s) => s.territory === 'the front door').brief;
    assert.doesNotMatch(front, /reporting/, 'a consultant never sees another territory');
    const numbers = r.json.spawns.find((s) => s.territory === 'numbers').brief;
    assert.doesNotMatch(numbers, /\bauth\b/);
    assert.doesNotMatch(numbers, /\bapi\b/);
  });

  await t.test('the evidence it is shown is its own, and the rest of the catalogue is not in it', () => {
    const front = r.json.spawns.find((s) => s.territory === 'the front door').brief;
    assert.match(front, /a signed-in user reaches \/me/);
    assert.doesNotMatch(front, /the month figures match the ledger/);
  });

  await t.test('it names the commands a consultant answers with, --depends among them', () => {
    const front = r.json.spawns.find((s) => s.territory === 'the front door').brief;
    assert.match(front, /tk\.mjs new/);
    assert.match(front, /queue\.mjs add <NNN> --proposed/);
    assert.match(front, /tk\.mjs edit <NNN> --depends/);
    assert.match(front, /node\.mjs propose rule/);
  });

  await t.test('without a Grain CLI the brief still renders, and says what is missing', () => {
    const front = r.json.spawns.find((s) => s.territory === 'the front door').brief;
    assert.match(front, /no Grain CLI is configured/);
    assert.match(front, /say in your\ntickets where you were guessing/);
  });

  await t.test('with one configured, what it answered is in the brief', () => {
    const stub = join(dir, 'grain-stub.mjs');
    writeFileSync(stub, GRAIN_STUB);
    assert.equal(run('horde.mjs', ['config', 'set', 'grainCommand', `node ${stub}`], dir).code, 0);
    const withGrain = run('refine.mjs', ['--step', 'consult', '--horde', 'm1'], dir);
    assert.equal(withGrain.code, 0, withGrain.stderr);
    const front = withGrain.json.spawns.find((s) => s.territory === 'the front door').brief;
    assert.match(front, /grain-stub answering: where/);
    assert.match(front, /grain-stub answering: how/);
    assert.match(front, /grain-stub answering: obligation src\/auth/);
    assert.doesNotMatch(front, /no Grain CLI is configured/);
    assert.equal(run('horde.mjs', ['config', 'set', 'grainCommand', ''], dir).code, 0);
  });
});

test('refine.mjs: a consultant\'s ticket is a proposal — in the queue, never dispatched', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');
  seedCharter(dir, 'm1', [{ id: 'E1', evidence: 'a signed-in user reaches /me', node: 'auth' }]);

  const id = fileTicket(dir, 'm1', [
    'login', '--title', 'Let a user sign in', '--node', 'auth', '--class', 'sonnet',
    '--files', 'src/auth/login.mjs', '--evidence', 'E1', '--evidence', 'a signed-in user reaches /me',
  ]);

  await t.test('it is filed "proposed" by the tool that makes it', () => {
    const r = run('tk.mjs', ['show', id, '--horde', 'm1'], dir);
    assert.match(r.json.text, /\*\*Status:\*\* proposed/);
  });

  await t.test('the queue takes it as a proposal, and says so', () => {
    const r = run('queue.mjs', ['add', id, '--proposed', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'proposed');
  });

  await t.test('and "next" offers nothing, even with nothing else waiting', () => {
    const r = run('queue.mjs', ['next', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json, null, 'a proposal is never a dispatch candidate');
  });
});

test('refine.mjs --step review: the architect\'s ruling is the only way out of "proposed"', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');
  seedCharter(dir, 'm1', [
    { id: 'E1', evidence: 'a signed-in user reaches /me', node: 'auth' },
    { id: 'E2', evidence: 'the route answers 404 for a stranger', node: 'api' },
  ]);
  writeTerritories(dir, 'm1', TWO_TERRITORIES);
  assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);

  const first = fileTicket(dir, 'm1', [
    'login', '--title', 'Let a user sign in', '--node', 'auth', '--class', 'sonnet',
    '--files', 'src/auth/login.mjs', '--evidence', 'E1', '--evidence', 'a signed-in user reaches /me',
  ]);
  const second = fileTicket(dir, 'm1', [
    'route', '--title', 'Answer 404 for a stranger', '--node', 'api', '--class', 'haiku',
    '--files', 'src/api/routes.mjs', '--evidence', 'E2', '--evidence', 'the route answers 404',
  ]);
  assert.equal(run('queue.mjs', ['add', first, '--proposed', '--horde', 'm1'], dir).code, 0);
  assert.equal(run('queue.mjs', ['add', second, '--proposed', '--horde', 'm1'], dir).code, 0);

  let planFile;
  await t.test('the plan goes to the architect as a file, whole, not as a summary', () => {
    const r = run('refine.mjs', ['--step', 'review', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'awaiting');
    planFile = r.json.plan;
    assert.ok(existsSync(planFile), 'the plan was written to a file');
    const onDisk = readFileSync(planFile, 'utf8');
    assert.match(onDisk, /Critical path/i);
    // The brief carries that file's own text, not a précis of it.
    const body = onDisk.split('\n').filter((l) => l.trim() && !l.startsWith('tree: '));
    for (const line of body) assert.ok(r.json.brief.includes(line), `the brief is missing a plan line: ${line}`);
    assert.match(r.json.brief, new RegExp(planFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('the brief carries the five questions the architect rules a plan by, from its own role file', () => {
    const r = run('refine.mjs', ['--step', 'review', '--horde', 'm1'], dir);
    for (const q of ['Completeness', 'Buildability', 'Cycles', 'Decomposition', 'Collision']) {
      assert.match(r.json.brief, new RegExp(`\\*\\*${q}\\*\\*`));
    }
  });

  await t.test('a pass moves the ticket to queued, on the ticket and in the queue', () => {
    writeFileSync(hordeFile(dir, 'm1', 'review.json'), JSON.stringify({
      [first]: { verdict: 'pass' },
      [second]: { verdict: 'reject', why: 'It answers a route the mission does not own.' },
    }));
    const r = run('refine.mjs', ['--step', 'review', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'applied');
    assert.match(run('tk.mjs', ['show', first, '--horde', 'm1'], dir).json.text, /\*\*Status:\*\* queued/);
    const items = run('queue.mjs', ['list', '--horde', 'm1'], dir).json;
    assert.equal(items.find((i) => i.ticket === first).state, 'queued');
  });

  await t.test('a rejection leaves it proposed, with the reason on its own log', () => {
    assert.match(run('tk.mjs', ['show', second, '--horde', 'm1'], dir).json.text, /\*\*Status:\*\* proposed/);
    const items = run('queue.mjs', ['list', '--horde', 'm1'], dir).json;
    assert.equal(items.find((i) => i.ticket === second).state, 'proposed');
    const log = run('tk.mjs', ['show', second, '--horde', 'm1', '--log'], dir);
    assert.match(log.json.log, /rejected at the plan review: It answers a route the mission does not own\./);
  });

  await t.test('only the passed one is a dispatch candidate now', () => {
    const r = run('queue.mjs', ['next', '--horde', 'm1'], dir);
    assert.equal(r.json.ticket, first);
  });

  await t.test('a rejection with no reason is refused before anything is applied', () => {
    writeFileSync(hordeFile(dir, 'm1', 'review.json'), JSON.stringify({ [second]: { verdict: 'reject' } }));
    const r = run('refine.mjs', ['--step', 'review', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rejected with no reason/);
  });

  await t.test('a verdict that is neither pass nor reject is refused by name', () => {
    writeFileSync(hordeFile(dir, 'm1', 'review.json'), JSON.stringify({ [second]: { verdict: 'maybe' } }));
    const r = run('refine.mjs', ['--step', 'review', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /verdict "maybe"/);
  });
});

test('refine.mjs --step review: a circle is refused, and the circle travels with the refusal', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');
  seedCharter(dir, 'm1', [{ id: 'E1', evidence: 'a signed-in user reaches /me', node: 'auth' }]);

  const a = fileTicket(dir, 'm1', [
    'first', '--title', 'First', '--node', 'auth', '--class', 'sonnet',
    '--files', 'src/auth/login.mjs', '--evidence', 'E1', '--evidence', 'a signed-in user reaches /me',
  ]);
  const b = fileTicket(dir, 'm1', [
    'second', '--title', 'Second', '--node', 'api', '--class', 'sonnet',
    '--files', 'src/api/routes.mjs', '--evidence', 'the route answers',
  ]);
  assert.equal(run('queue.mjs', ['add', a, '--proposed', '--horde', 'm1'], dir).code, 0);
  assert.equal(run('queue.mjs', ['add', b, '--proposed', '--horde', 'm1'], dir).code, 0);
  // The queue refuses a circle it can see coming, so the one that only shows up once the whole DAG
  // is built is written onto the tickets themselves — which is exactly the case plan catches.
  const issues = join(dir, '.horde', 'hordes', 'm1', 'teams', 'trunk', 'issues');
  for (const [id, dep] of [[a, b], [b, a]]) {
    const folder = readFileSync(join(issues, `${id}-${id === a ? 'first' : 'second'}`, 'issue.md'), 'utf8');
    writeFileSync(
      join(issues, `${id}-${id === a ? 'first' : 'second'}`, 'issue.md'),
      folder.replace(/\*\*Depends on:\*\*[^·\n]*/, `**Depends on:** ${dep} `),
    );
  }

  const r = run('refine.mjs', ['--step', 'review', '--horde', 'm1'], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /depend on each other in a circle/);
  assert.match(r.stderr, new RegExp(`${a}.*→.*${b}|${b}.*→.*${a}`));
});

test('refine.mjs --step frame: three sections, in the client\'s words and nobody else\'s', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1', ['--title', 'Let people sign in again']);
  seedCharter(dir, 'm1', [
    { id: 'E1', evidence: 'a signed-in user reaches /me', node: 'auth' },
    { id: 'E2', evidence: 'the month figures match the ledger', node: 'reporting' },
  ]);
  writeTerritories(dir, 'm1', TWO_TERRITORIES);
  assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);

  const id = fileTicket(dir, 'm1', [
    'login', '--title', 'Let a user sign in', '--node', 'auth', '--class', 'sonnet',
    '--files', 'src/auth/login.mjs', '--evidence', 'E1', '--evidence', 'a signed-in user reaches /me',
  ]);
  assert.equal(run('queue.mjs', ['add', id, '--proposed', '--horde', 'm1'], dir).code, 0);
  assert.equal(run('node.mjs', ['propose', 'rule', 'Every route says who it is for.', '--node', 'api', '--by', 'consultant-a', '--horde', 'm1'], dir).code, 0);

  const r = run('refine.mjs', ['--step', 'frame', '--horde', 'm1'], dir);
  assert.equal(r.code, 0, r.stderr);

  await t.test('three sections, in that order', () => {
    assert.equal(r.json.sections.length, 3);
    assert.deepEqual(r.json.sections.map((s) => s.title), [
      'What will change, and where', 'What it will prove', 'What the rules gain',
    ]);
  });

  await t.test('what changes: area to components to work', () => {
    const [changes] = r.json.sections;
    const front = changes.areas.find((a) => a.area === 'the front door');
    assert.deepEqual(front.parts, ['auth', 'api']);
    assert.deepEqual(front.work, [{ ref: id, what: 'Let a user sign in' }]);
    assert.match(front.why, /how a request gets in/);
  });

  await t.test('an evidence row nobody has taken is visible as exactly that', () => {
    const proves = r.json.sections[1];
    assert.deepEqual(proves.untaken, ['E2']);
    const row = proves.proofs.find((p) => p.id === 'E2');
    assert.equal(row.taken, false);
    assert.deepEqual(row.takenBy, []);
    assert.match(proves.note, /nobody is building yet/);
  });

  await t.test('what the rules gain is one sentence per proposal', () => {
    assert.deepEqual(r.json.sections[2].rules, [{ says: 'Every route says who it is for.', where: 'api' }]);
  });

  await t.test('not one tool, script or state file is named anywhere in it', () => {
    const text = JSON.stringify(r.json);
    assert.doesNotMatch(text, /\.mjs/);
    assert.doesNotMatch(text, /\.horde\//);
    assert.doesNotMatch(text, /territories\.json|queue|ticket/i);
  });

  await t.test('rendered for a reader, it is the same three sections and still names nothing', () => {
    const plain = run('refine.mjs', ['--step', 'frame', '--horde', 'm1'], dir, { json: false });
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /What will change, and where/);
    assert.match(plain.stdout, /What it will prove/);
    assert.match(plain.stdout, /What the rules gain/);
    assert.doesNotMatch(plain.stdout, /\.mjs/);
    assert.doesNotMatch(plain.stdout, /\.horde\//);
  });
});

test('refine.mjs --step frame: one area with one piece of work says so plainly', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');
  seedCharter(dir, 'm1', [{ id: 'E1', evidence: 'a signed-in user reaches /me', node: 'auth' }]);
  writeTerritories(dir, 'm1', { doors: { nodes: ['auth'], class: 'sonnet', why: 'The way in, and nothing else.' } });
  assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);
  const id = fileTicket(dir, 'm1', [
    'login', '--title', 'Let a user sign in', '--node', 'auth', '--class', 'sonnet',
    '--files', 'src/auth/login.mjs', '--evidence', 'E1', '--evidence', 'a signed-in user reaches /me',
  ]);
  assert.equal(run('queue.mjs', ['add', id, '--proposed', '--horde', 'm1'], dir).code, 0);

  const r = run('refine.mjs', ['--step', 'frame', '--horde', 'm1'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.shape, /^One area, one piece of work, one check before it counts as done\.$/);
  assert.equal(r.json.sections[0].note, r.json.shape);
});

test('refine.mjs: the broken states, each refused in its own words', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  graphFixture(dir);
  initHorde(dir, 'm1');

  await t.test('no cut yet at --step consult names the step that makes one', () => {
    const r = run('refine.mjs', ['--step', 'consult', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /there is no cut yet/);
    assert.match(r.stderr, /--step cut/);
  });

  await t.test('a territories.json that will not parse is refused by name, never read as empty', () => {
    writeFileSync(hordeFile(dir, 'm1', 'territories.json'), '{"doors": {"nodes": ["auth"], "cla');
    const r = run('refine.mjs', ['--step', 'consult', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /territories\.json/);
    assert.match(r.stderr, /not an empty one/);
  });

  await t.test('an unknown --step lists the four there are', () => {
    const r = run('refine.mjs', ['--step', 'plan', '--horde', 'm1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown step: plan/);
    assert.match(r.stderr, /cut, consult, review, frame/);
  });

  await t.test('two hordes and no --horde is refused naming both', () => {
    initHorde(dir, 'm2');
    const r = run('refine.mjs', ['--step', 'cut'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /multiple hordes exist \(m1, m2\)/);
  });

  await t.test('an interrupted cut — territories.json half written — holds no lease, and a re-run works', () => {
    const path = hordeFile(dir, 'm1', 'territories.json');
    writeFileSync(path, JSON.stringify(TWO_TERRITORIES, null, 2).slice(0, 60));
    const crashed = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(crashed.code, 1);

    const leasesPath = join(dir, '.horde', 'leases.json');
    const held = existsSync(leasesPath) ? JSON.parse(readFileSync(leasesPath, 'utf8')).leases : {};
    assert.deepEqual(Object.keys(held), [], 'a refused cut takes nothing');

    writeTerritories(dir, 'm1', TWO_TERRITORIES);
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      Object.keys(JSON.parse(readFileSync(leasesPath, 'utf8')).leases).sort(),
      ['numbers', 'the front door'],
    );
  });
});
