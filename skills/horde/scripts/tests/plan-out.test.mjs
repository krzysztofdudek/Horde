import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode, yg, git,
} from './helpers.mjs';
import { sizeRanks } from '../_lib.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

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

// ---- change size, and where it sits among the rest of the plan -------------------------------

// A ticket, queued, started on its own branch, with a change of a known size committed on it.
// A new file of `lineCount` lines is `lineCount` insertions across one file against the team
// branch — a size the assertions below can name exactly rather than approximate.
function ticketWithChange(dir, slug, lineCount) {
  const created = run('tk.mjs', ['new', slug, '--title', `The ${slug}`, '--node', 'nodeA', '--class', 'standard', '--evidence', 'it works'], dir);
  assert.equal(created.code, 0, created.stderr);
  const id = created.json.id;
  assert.equal(run('queue.mjs', ['add', id], dir).code, 0);
  const started = run('queue.mjs', ['set', id, 'running'], dir);
  assert.equal(started.code, 0, started.stderr);
  const tree = started.json.worktree;
  const rel = join('src', 'nodeA', `${slug}.txt`);
  mkdirSync(join(tree, 'src', 'nodeA'), { recursive: true });
  writeFileSync(join(tree, rel), `${Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n')}\n`);
  git(['add', rel], tree);
  git(['commit', '-qm', `${slug}: ${lineCount} line(s)`], tree);
  return id;
}

test('queue.mjs plan: change size and its rank among the plan\'s own tickets', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'nodeA', { mapping: ['src/nodeA/**'] });

  const big = ticketWithChange(dir, 'big', 60);
  const mid = ticketWithChange(dir, 'mid', 20);
  const small = ticketWithChange(dir, 'small', 8);
  const tiny = ticketWithChange(dir, 'tiny', 2);
  // A fifth ticket nobody has started. There is nothing to measure on it, and the plan says so
  // rather than guessing a size out of what the ticket declares.
  const unstarted = run('tk.mjs', ['new', 'unstarted', '--title', 'Not started', '--node', 'nodeA', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
  assert.equal(run('queue.mjs', ['add', unstarted], dir).code, 0);

  const planNow = () => {
    const r = run('queue.mjs', ['plan'], dir);
    assert.equal(r.code, 0, r.stderr);
    return r.json;
  };

  await t.test('every started ticket carries its measured size and its rank in this plan', () => {
    const plan = planNow();
    const sizeOf = (id) => plan.tickets.find((x) => x.id === id).size;
    assert.deepEqual(sizeOf(big), {
      files: 1, lines: 60, rank: 1, of: 4, biggestQuarter: true,
    });
    assert.deepEqual([mid, small, tiny].map((id) => sizeOf(id).lines), [20, 8, 2]);
    assert.deepEqual([mid, small, tiny].map((id) => sizeOf(id).rank), [2, 3, 4]);
    assert.deepEqual([mid, small, tiny].map((id) => sizeOf(id).of), [4, 4, 4]);
    assert.deepEqual([mid, small, tiny].map((id) => sizeOf(id).biggestQuarter), [false, false, false]);
    assert.equal(sizeOf(unstarted), null, 'a ticket with no branch has no size to report');
  });

  await t.test('the plan prints each rank, and offers the biggest quarter as a split to consider', () => {
    const human = run('queue.mjs', ['plan'], dir, { json: false });
    assert.equal(human.code, 0, human.stderr);
    assert.match(
      human.stdout,
      new RegExp(`change size \\(lines/files, biggest first\\): ${big} 60/1 — 1 of 4 · ${mid} 20/1 — 2 of 4 · ${small} 8/1 — 3 of 4 · ${tiny} 2/1 — 4 of 4 · 1 not measured yet`),
    );
    assert.match(human.stdout, new RegExp(`biggest quarter of this plan: ${big} — worth considering a split`));
    // A suggestion, not an action: the plan says outright who rules on it.
    assert.match(human.stdout, /the architect decides, nothing here acts on it/);
    const plan = planNow();
    assert.deepEqual(plan.splitSuggestions, [{
      ticket: big, lines: 60, files: 1, rank: 1, of: 4,
    }]);
  });

  // The point of the whole signal: it is a position in a set, not a size anything is over. The
  // 60-line change below is not touched — the plan around it is — and it stops standing out.
  await t.test('a rank, not a threshold: the same change stops standing out once bigger work joins the plan', () => {
    const bigger = ticketWithChange(dir, 'bigger', 300);
    const alsoBigger = ticketWithChange(dir, 'alsobigger', 200);
    const plan = planNow();
    const sizeOf = (id) => plan.tickets.find((x) => x.id === id).size;
    assert.equal(sizeOf(big).lines, 60, 'the change itself did not move');
    assert.equal(sizeOf(big).rank, 3);
    assert.equal(sizeOf(big).of, 6);
    assert.equal(sizeOf(big).biggestQuarter, false);
    assert.deepEqual(plan.splitSuggestions.map((s) => s.ticket), [bigger, alsoBigger]);
  });
});

// ---- there is no threshold to find ----------------------------------------------------------

// Scale invariance is the strongest statement of "no threshold" there is: multiply every change in
// the set by any factor and the answer is identical, which no fixed size could survive.
test('the size rank is scale-free, and a set with nothing to compare has no biggest quarter', () => {
  const set = (f) => [
    { id: 'a', size: { lines: 100 * f, files: 5 * f } },
    { id: 'b', size: { lines: 50 * f, files: 3 * f } },
    { id: 'c', size: { lines: 10 * f, files: 1 * f } },
    { id: 'd', size: { lines: 5 * f, files: 1 * f } },
  ];
  const shape = (ranks) => [...ranks].map(([id, s]) => [id, s.rank, s.of, s.biggestQuarter]);
  const once = shape(sizeRanks(set(1)));
  assert.deepEqual(once, [['a', 1, 4, true], ['b', 2, 4, false], ['c', 3, 4, false], ['d', 4, 4, false]]);
  assert.deepEqual(shape(sizeRanks(set(1000))), once, 'a thousand times bigger, same answer');
  assert.deepEqual(shape(sizeRanks(set(0.01))), once, 'a hundred times smaller, same answer');

  // Nothing to compare against: a lone change, and a set where every change is the same size.
  const lone = sizeRanks([{ id: 'a', size: { lines: 9000, files: 400 } }]);
  assert.equal(lone.get('a').biggestQuarter, false, 'a change is not outsized against nothing');
  const flat = sizeRanks(['a', 'b', 'c', 'd'].map((id) => ({ id, size: { lines: 9000, files: 400 } })));
  assert.deepEqual([...flat.values()].map((s) => s.biggestQuarter), [false, false, false, false]);

  // A change that could not be measured is left out of the ranking rather than counted as zero.
  const partial = sizeRanks([{ id: 'a', size: { lines: 4, files: 1 } }, { id: 'b', size: null }]);
  assert.equal(partial.has('b'), false);
  assert.equal(partial.get('a').of, 1);
});

// The same claim read off the source: one place decides the rank, and the only number written
// down there is what the word "quartile" means. A threshold would be a size compared against a
// number, and there is none to find.
test('no size threshold is written down anywhere the signal is computed', () => {
  const lib = readFileSync(join(SCRIPTS_DIR, '_lib.mjs'), 'utf8');
  const from = lib.indexOf('// ---- how big a change is');
  const to = lib.indexOf('// repoRoot() —');
  assert.ok(from !== -1 && to > from, 'the change-size section moved — this scan no longer reads it');
  const block = lib.slice(from, to);

  const numbers = [...new Set([...block.matchAll(/(?<![\w$.])\d+(?![\w$])/g)].map((m) => m[0]))].sort();
  assert.deepEqual(numbers, ['0', '1', '4'], `the size section names a number it did not before: ${numbers.join(', ')}`);
  assert.equal([...block.matchAll(/(?<![\w$.])4(?![\w$])/g)].length, 1);
  assert.match(block, /const QUARTERS = 4;/, 'the only figure here is the four quarters of a quartile');
  assert.doesNotMatch(block, /\b(?:lines|files)\b\s*[<>]=?\s*\d/, 'a measured size is compared against a number');
  assert.doesNotMatch(block, /\d\s*[<>]=?\s*\b(?:lines|files)\b/, 'a number is compared against a measured size');

  // Everything else only reads the verdict; nobody re-decides it with a figure of their own.
  for (const file of ['queue.mjs', 'land.mjs', 'wave.mjs']) {
    const text = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
    assert.doesNotMatch(text, /biggestQuarter\s*[:=][^=]/, `${file} decides the biggest quarter for itself`);
  }
});
