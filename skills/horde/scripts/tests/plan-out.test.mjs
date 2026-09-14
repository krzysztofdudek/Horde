import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, addNode, yg,
} from './helpers.mjs';

// The architect reads the plan whole, from a file: relayed through a message it gets summarised
// on the way, and a steward cannot message the architect directly in any case.
test('queue.mjs plan --out: writes the plan to a file and says so on stdout', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'nodeA', { mapping: ['src/nodeA/**'] });
  const created = run('tk.mjs', ['new', 'thing', '--title', 'A thing', '--node', 'nodeA', '--class', 'standard', '--evidence', 'it works'], dir);
  assert.equal(run('queue.mjs', ['add', created.json.id], dir).code, 0);
  const out = join(dir, 'plan.json');
  const r = run('queue.mjs', ['plan', '--out', out], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /plan written to .*plan\.json — 1 ticket\(s\)/);
  assert.ok(existsSync(out));
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(plan.tickets.length, 1);
  assert.equal(plan.tickets[0].id, created.json.id);
});

// ---- a row described by something the client looked at ---------------------------------------
//
// A promise nobody can yet put into words is not planned around, it is shown: a prototype is built
// against that one row, the client answers it, and the answer — what they were shown, who accepted
// it, when — is what the real work is then written from. Everything below is that order, held
// where it can be checked: nothing else is queued against the row until the answer exists, and
// once it does the row reads as answered in both places a person reads, on its own, never folded
// into the figures for work that is actually built.

function git(args, dir) { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); }

function writeFile(dir, rel, text) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

function hordeFile(dir, horde, name) {
  return join(dir, '.horde', 'hordes', horde, name);
}

function seedCharter(dir, horde, rows) {
  const path = hordeFile(dir, horde, 'charter.md');
  const text = readFileSync(path, 'utf8')
    .replace('| | | | |', rows.map((r) => `| ${r.id} | ${r.evidence} | ${r.node} | |`).join('\n'));
  writeFileSync(path, text);
}

test('a prototype answered by the client: the row reads as answered on its own, and nothing else is planned against it before', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  yg(dir, ['init']);
  addNode(dir, 'shifts', { description: 'The week a manager plans.', mapping: ['src/shifts/**'] });
  addNode(dir, 'swaps', { description: 'One person taking another\'s shift.', mapping: ['src/swaps/**'] });
  writeFile(dir, 'src/shifts/board.mjs', 'export const board = 1;\n');
  writeFile(dir, 'src/swaps/swap.mjs', 'export const swap = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
  initHorde(dir, 'm1', ['--title', 'Let a manager see next week']);
  seedCharter(dir, 'm1', [
    { id: 'E1', evidence: 'a manager sees next week at a glance', node: 'shifts' },
    { id: 'E2', evidence: 'a swap is confirmed in one tap', node: 'swaps' },
  ]);
  writeFileSync(hordeFile(dir, 'm1', 'territories.json'), `${JSON.stringify({
    'the week': { nodes: ['shifts'], class: 'standard', why: 'Everything about the week a manager plans.' },
    swapping: { nodes: ['swaps'], class: 'light', why: 'One person taking another\'s shift, and nothing else.' },
  }, null, 2)}\n`);
  assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);

  const proto = run('tk.mjs', [
    'new', 'week-at-a-glance', '--title', 'Something to look at', '--node', 'shifts', '--class', 'standard',
    '--kind', 'prototype', '--evidence', 'E1', '--horde', 'm1',
  ], dir);
  assert.equal(proto.code, 0, proto.stderr);
  const work = run('tk.mjs', [
    'new', 'build-the-week', '--title', 'Build the week view', '--node', 'shifts', '--class', 'standard',
    '--files', 'src/shifts/board.mjs', '--evidence', 'E1', '--evidence', 'a manager sees next week at a glance',
    '--horde', 'm1',
  ], dir);
  assert.equal(work.code, 0, work.stderr);

  await t.test('the prototype itself is queued; the real work against the same row is not, yet', () => {
    assert.equal(run('queue.mjs', ['add', proto.json.id, '--horde', 'm1'], dir).code, 0);
    const refused = run('queue.mjs', ['add', work.json.id, '--horde', 'm1'], dir);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /E1/);
    assert.match(refused.stderr, /no accepted prototype/);
  });

  await t.test('the frame offers a prototype for the row nobody has taken, and marks nothing as answered yet', () => {
    const r = run('refine.mjs', ['--step', 'frame', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    const proves = r.json.sections[1];
    assert.deepEqual(proves.accepted, []);
    assert.deepEqual(proves.proposePrototype, ['E2']);
    assert.match(proves.prototypeOffer, /look at/);
    assert.equal(proves.proofs.find((p) => p.id === 'E1').shown, null);
  });

  const sha = 'e'.repeat(64);
  assert.equal(run('tk.mjs', ['accept', proto.json.id, '--by', 'Marta Zielinska', '--sha256', sha, '--horde', 'm1'], dir).code, 0);

  await t.test('answered, the real work against the row is queued like any other', () => {
    const added = run('queue.mjs', ['add', work.json.id, '--horde', 'm1'], dir);
    assert.equal(added.code, 0, added.stderr);
  });

  await t.test('the frame shows that row as one the client has already seen and said yes to', () => {
    const r = run('refine.mjs', ['--step', 'frame', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    const proves = r.json.sections[1];
    assert.deepEqual(proves.accepted, ['E1']);
    assert.deepEqual(proves.proposePrototype, ['E2']);
    const row = proves.proofs.find((p) => p.id === 'E1');
    assert.equal(row.shown.acceptedBy, 'Marta Zielinska');
    assert.match(row.shown.at, /^\d{4}-\d{2}-\d{2}/);
    // Still what the client reads: no tool, no file, no state of ours is named anywhere in it.
    const plain = run('refine.mjs', ['--step', 'frame', '--horde', 'm1'], dir, { json: false });
    assert.match(plain.stdout, /already seen this and said yes/);
    assert.doesNotMatch(plain.stdout, /\.mjs/);
    assert.doesNotMatch(plain.stdout, /\.horde\//);
  });

  await t.test('and the wave close names it on its own, outside the figures for what was built', () => {
    assert.equal(run('wave.mjs', ['start', '--horde', 'm1'], dir).code, 0);
    const r = run('wave.mjs', ['close', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.prototypes, [{
      id: 'E1', ticket: proto.json.id, sha256: sha, acceptedBy: 'Marta Zielinska', at: r.json.prototypes[0].at,
    }]);
    const text = readFileSync(hordeFile(dir, 'm1', 'plan.md'), 'utf8');
    assert.match(text, /^## Prototypes accepted$/m);
    assert.match(text, /\*\*E1\*\* — shown as \d+, accepted by Marta Zielinska/);
    // The catalogue figures are untouched by it: being shown a thing is not having built it.
    assert.match(text, /\*\*Evidence catalogue:\*\* 0\/2 green/);
  });
});
