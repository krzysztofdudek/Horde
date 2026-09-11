import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, writeCostRuns, requireYg,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const charterPath = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'charter.md');
const planPath = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'plan.md');

// A minimal ticket folder — issue.md with an Acceptance checklist mentioning the evidence id,
// log.md with a the deleted verify tool-shaped verdict block — written directly rather than through tk.mjs /
// the deleted verify tool, so this test doesn't depend on that other tool's exact CLI.
function writeTicketFixture(dir, { team = 'trunk', ticket, evidenceId, verifier, result = 'reproduced' }) {
  const ticketDir = join(dir, '.horde', 'hordes', 'mission1', 'teams', team, 'issues', `${ticket}-slug`);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(
    join(ticketDir, 'issue.md'),
    `# ${ticket} · slug\n\n**Status:** landed\n\n## Acceptance — evidence\n\n- [x] covers ${evidenceId}\n`,
  );
  writeFileSync(
    join(ticketDir, 'log.md'),
    `## Verdict · ${ticket} · 2026-01-01 · by ${verifier} (sonnet)\n\n**Result:** ${result}\n`,
  );
}

test('wave.mjs: start, note, merged, close, current', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('current is "none" with no wave started', () => {
    const r = run('wave.mjs', ['current'], dir);
    assert.equal(r.json.current, null);
  });

  await t.test('close refuses when no wave is open', () => {
    const r = run('wave.mjs', ['close'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no open wave/);
  });

  await t.test('start opens wave 1, auto-incrementing when no number is given', () => {
    const r = run('wave.mjs', ['start'], dir);
    assert.equal(r.json.n, '1');
    const current = run('wave.mjs', ['current'], dir);
    assert.equal(current.json.current, '1');
  });

  await t.test('note and merged append dated bullets to the journal', () => {
    run('wave.mjs', ['note', 'DAG composed'], dir);
    writeCostRuns(dir, 'mission1', [
      { name: 'mission1-worker-trunk-1', role: 'worker', class: 'sonnet', ticket: '001', team: 'trunk', wave: '1', at: new Date().toISOString() },
    ]);
    run('wave.mjs', ['merged', '001', 'abc1234'], dir);
    const text = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
    assert.match(text, /# Wave 1 — start/);
    assert.match(text, /DAG composed/);
    assert.match(text, /merged: 001 abc1234/);
  });

  await t.test('close with --sha records the level gate; --evidence fills rows the gate proves; a wrong id is refused', () => {
    const charterPath = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
    const charter = readFileSync(charterPath, 'utf8').replace(/\| +\| +\| +\| +\|\n/, '| E9 | gate green on trunk | checks | |\n');
    writeFileSync(charterPath, charter);
    const bad = run('wave.mjs', ['close', '--gate', 'green', '--sha', 'abc1234', '--evidence', 'E42'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /E42 is not in the charter/);
    const red = run('wave.mjs', ['close', '--gate', 'red', '--evidence', 'E9'], dir);
    assert.equal(red.code, 1);
    assert.match(red.stderr, /gate is not green/);
    assert.equal(run('wave.mjs', ['current'], dir).json.current, '1');
  });

  await t.test('close renders wave-close.md and appends it, then the wave is no longer current', () => {
    const r = run('wave.mjs', ['close', '--gate', 'green', '--sha', 'abc1234', '--evidence', 'E9'], dir);
    assert.equal(r.code, 0);
    const gateCache = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'cache', 'last-gate.json'), 'utf8'));
    assert.equal(gateCache.trunk.sha, 'abc1234');
    assert.equal(gateCache.trunk.result, 'green');
    assert.match(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'charter.md'), 'utf8'), /\| E9 \|[^\n]*\| wave 1 gate on abc1234 \|/);
    assert.equal(r.json.n, '1');
    assert.equal(r.json.gate, 'green');
    const text = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'plan.md'), 'utf8');
    assert.match(text, /# Wave 1 — close/);
    assert.match(text, /\*\*Cost:\*\* 1 runs · weighted 3 · mission to date 3/);
    const current = run('wave.mjs', ['current'], dir);
    assert.equal(current.json.current, null);
  });

  await t.test('close refuses --gate with a bad value', () => {
    run('wave.mjs', ['start'], dir);
    const r = run('wave.mjs', ['close', '--gate', 'purple'], dir);
    assert.equal(r.code, 1);
  });
});

test('wave.mjs close: a row goes green from a merged ticket\'s reproduced verdict, and the charter is stamped', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  // Give the charter a real evidence row (the template ships one empty placeholder row).
  const charter = readFileSync(charterPath(dir), 'utf8').replace('| | | | |', '| E1 | some check | auth | |');
  writeFileSync(charterPath(dir), charter);

  writeTicketFixture(dir, { ticket: '001', evidenceId: 'E1', verifier: 'verifier-1', result: 'reproduced' });

  run('wave.mjs', ['start'], dir);
  run('wave.mjs', ['merged', '001', 'abc1234'], dir);
  const r = run('wave.mjs', ['close', '--gate', 'green'], dir);

  assert.equal(r.code, 0);
  assert.equal(r.json.green, 1);
  assert.equal(r.json.total, 1);

  const stamped = readFileSync(charterPath(dir), 'utf8');
  assert.match(stamped, /\| E1 \| some check \| auth \| verifier-1 \|/);

  const plan = readFileSync(planPath(dir), 'utf8');
  assert.match(plan, /\*\*Evidence catalogue:\*\* 1\/1 green/);
});

test('wave.mjs close: a merged ticket without a "reproduced" verdict leaves the row red', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const charter = readFileSync(charterPath(dir), 'utf8').replace('| | | | |', '| E1 | some check | auth | |');
  writeFileSync(charterPath(dir), charter);

  writeTicketFixture(dir, { ticket: '001', evidenceId: 'E1', verifier: 'verifier-1', result: 'not-reproduced' });

  run('wave.mjs', ['start'], dir);
  run('wave.mjs', ['merged', '001', 'abc1234'], dir);
  const r = run('wave.mjs', ['close'], dir);

  assert.equal(r.json.green, 0);
  assert.equal(r.json.total, 1);
  const stamped = readFileSync(charterPath(dir), 'utf8');
  assert.match(stamped, /\| E1 \| some check \| auth \| \|/);
});

test('wave.mjs close: human decisions per merged ticket, and the trend across waves', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('wave 1: two rulings over two merged tickets', () => {
    run('wave.mjs', ['start'], dir);
    run('wave.mjs', ['merged', '001', 'aaa1111'], dir);
    run('wave.mjs', ['merged', '002', 'bbb2222'], dir);
    for (const why of ['who owns this contract', 'is this a boundary']) {
      const opened = run('ask.mjs', ['add', why, '--kind', 'stop'], dir);
      run('ask.mjs', ['answer', opened.json.id, 'ruled it'], dir);
    }
    const r = run('wave.mjs', ['close'], dir);
    assert.equal(r.json.decisions.ruled, 2);
    assert.equal(r.json.decisions.merged, 2);
    assert.equal(r.json.decisions.perMergedTicket, '1.00');
    assert.match(
      readFileSync(planPath(dir), 'utf8'),
      /\*\*Decisions per merged ticket:\*\* 1\.00 \(2 ruled \/ 2 merged\)/,
    );
  });

  await t.test('wave 2: one ruling over four merges is the KPI falling, and the trend says so', () => {
    run('wave.mjs', ['start'], dir);
    for (const [id, sha] of [['003', 'ccc3333'], ['004', 'ddd4444'], ['005', 'eee5555'], ['006', 'fff6666']]) {
      run('wave.mjs', ['merged', id, sha], dir);
    }
    const opened = run('ask.mjs', ['add', 'one more question', '--kind', 'stop'], dir);
    run('ask.mjs', ['answer', opened.json.id, 'ruled it'], dir);
    const r = run('wave.mjs', ['close'], dir);
    assert.equal(r.json.decisions.ruled, 1);
    assert.equal(r.json.decisions.merged, 4);
    assert.equal(r.json.decisions.perMergedTicket, '0.25');
    assert.match(
      readFileSync(planPath(dir), 'utf8'),
      /\*\*Decisions per merged ticket:\*\* 0\.25 \(1 ruled \/ 4 merged\) · trend 1\.00 → 0\.25/,
    );
  });
});

// ---- E14: what a wave close tells the chairman ------------------------------------------------
//
// One wave, run end to end on a real repository with a real Yggdrasil graph: three tickets with a
// dependency between two of them, two of them merged, one of them catching up with the other's
// landing, one ruling made. tk.mjs key/review, the deleted verify tool and the checklist's own "keys" item
// item are all gone (shared context point 4) — nothing computes a keys-transferred figure from a
// real gate run any more, so that one bullet is written by hand below, the way a pre-migration
// the checklist used to, purely to keep exercising the close's own reporting of it. Everything else
// here is real state, not seeded by hand.

const LIB_LINES = Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`);

function libWith(line, value) {
  const lines = [...LIB_LINES];
  lines[line - 1] = `export const v${line} = ${value};`;
  return `${lines.join('\n')}\n`;
}

// A real Yggdrasil graph: `yg init` from the installed CLI, then one component mapping the two
// source files and one enforced deterministic rule over them. The rule is a real check.mjs the
// CLI runs, not a description of one — the quality index is only worth measuring against a graph
// that actually enforces something.
function graphFixture(dir, ygCommand) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'e14', version: '1.0.0', type: 'module' }, null, 2)}\n`);
  const parts = ygCommand.split(/\s+/);
  execFileSync(parts[0], [...parts.slice(1), 'init', '--no-reviewer'], { cwd: dir, stdio: 'ignore' });

  mkdirSync(join(dir, '.yggdrasil', 'model', 'feature'), { recursive: true });
  writeFileSync(join(dir, '.yggdrasil', 'model', 'feature', 'yg-node.yaml'), [
    'name: Feature',
    'type: module',
    'description: The one component this fixture mission works on.',
    'aspects:',
    '  - no-marker',
    'mapping:',
    '  - lib.mjs',
    '  - other.mjs',
    'relations: []',
    '',
  ].join('\n'));

  mkdirSync(join(dir, '.yggdrasil', 'aspects', 'no-marker'), { recursive: true });
  writeFileSync(join(dir, '.yggdrasil', 'aspects', 'no-marker', 'yg-aspect.yaml'), [
    'name: NoMarker',
    'description: Source files must not be left carrying an unfinished-work marker.',
    'errs: under',
    'status: enforced',
    'review_by: 2099-01-01',
    '',
  ].join('\n'));
  writeFileSync(join(dir, '.yggdrasil', 'aspects', 'no-marker', 'check.mjs'), [
    'export function check(ctx) {',
    '  const violations = [];',
    '  for (const file of ctx.files) {',
    "    const lines = file.content.split('\\n');",
    '    for (let i = 0; i < lines.length; i++) {',
    "      if (lines[i].includes('UNFINISHED')) {",
    "        violations.push({ file: file.path, line: i + 1, column: 0, message: 'unfinished-work marker left behind.' });",
    '      }',
    '    }',
    '  }',
    '  return violations;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(dir, 'lib.mjs'), `${LIB_LINES.join('\n')}\n`);
  writeFileSync(join(dir, 'other.mjs'), 'export const other = 0;\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
}

test('E14 — a wave close states parallelism, keys transferred, decisions per merged ticket and the quality index', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, yg);
  initHorde(dir);

  // Three tickets, one of them waiting on another: the DAG the wave is planned against.
  const alpha = run('tk.mjs', ['new', 'change-the-middle', '--title', 'One line in the middle of lib', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  const beta = run('tk.mjs', ['new', 'follow-on', '--title', 'The follow-on that waits', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  const gamma = run('tk.mjs', ['new', 'the-sibling', '--title', 'The sibling that lands first', '--node', 'feature', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;
  run('queue.mjs', ['add', alpha], dir);
  run('queue.mjs', ['add', beta, '--depends', alpha], dir);
  run('queue.mjs', ['add', gamma], dir);

  const started = run('wave.mjs', ['start'], dir);
  assert.equal(started.code, 0, started.stderr);
  assert.deepEqual(started.json.layers, [2, 1], 'two tickets can start at once, one waits on alpha');
  assert.equal(started.json.plannedParallelism, 2);

  // Both startable tickets go out in the wave.
  const alphaRun = run('queue.mjs', ['set', alpha, 'running', '--agent', 'worker-alpha'], dir).json;
  const gammaRun = run('queue.mjs', ['set', gamma, 'running', '--agent', 'worker-gamma'], dir).json;

  writeFileSync(join(alphaRun.worktree, 'lib.mjs'), libWith(20, 2000));
  git(['add', 'lib.mjs'], alphaRun.worktree);
  git(['commit', '-qm', `ticket ${alpha}`], alphaRun.worktree);
  // queue.mjs's own "merged" no longer checks any keys/approvals at all (shared context point 4)
  // — a ticket lands with no prior review step.

  writeFileSync(join(gammaRun.worktree, 'other.mjs'), 'export const other = 1;\n');
  git(['add', 'other.mjs'], gammaRun.worktree);
  git(['commit', '-qm', `ticket ${gamma}`], gammaRun.worktree);

  // Gamma lands first, which makes alpha's base stale.
  git(['checkout', '-q', 'mission1/trunk'], dir);
  git(['merge', '--no-ff', gammaRun.branch, '-m', `merge ${gamma}`], dir);
  run('queue.mjs', ['set', gamma, 'merged', '--sha', git(['rev-parse', '--short', 'HEAD'], dir)], dir);

  // Alpha catches up. land.mjs has no "keys" checklist item and nothing computes a
  // keys-transferred count from a real gate run any more; wave.mjs's own reading of a "keys
  // transferred" bullet stays only for a journal written before this migration, so the bullet is
  // written by hand here to keep exercising the close's own reporting of the figure.
  git(['merge', 'mission1/trunk', '-m', 'catch up with the team branch'], alphaRun.worktree);
  const diffId = git(['rev-parse', '--short', 'HEAD'], alphaRun.worktree);
  run('wave.mjs', ['note', `keys transferred: ${alpha} 2 at diff ${diffId}`], dir);
  assert.match(
    readFileSync(planPath(dir), 'utf8'),
    new RegExp(`keys transferred: ${alpha} 2 at diff [0-9a-f]{7}`),
  );

  git(['merge', '--no-ff', alphaRun.branch, '-m', `merge ${alpha}`], dir);
  const trunkTip = git(['rev-parse', '--short', 'HEAD'], dir);
  run('queue.mjs', ['set', alpha, 'merged', '--sha', trunkTip], dir);

  // One question went to a human this wave; one is still open, so it is not a decision yet.
  const asked = run('ask.mjs', ['add', 'who owns the contract lib publishes', '--kind', 'stop', '--ticket', alpha], dir);
  run('ask.mjs', ['answer', asked.json.id, 'the feature node owns it; the consumer asks'], dir);
  run('ask.mjs', ['add', 'still thinking about this one', '--kind', 'stop'], dir);

  const closed = run('wave.mjs', ['close', '--gate', 'green', '--sha', trunkTip], dir);
  assert.equal(closed.code, 0, closed.stderr);

  const plan = readFileSync(planPath(dir), 'utf8');
  const block = plan.slice(plan.lastIndexOf('# Wave 1 — close'));

  await t.test('parallelism: what the plan allowed against what the merges show', () => {
    assert.equal(closed.json.plannedParallelism, 2);
    assert.equal(closed.json.achievedParallelism, 2);
    assert.match(block, /\*\*Parallelism:\*\* planned 2 · achieved 2/);
  });

  await t.test('keys transferred: the review the horde did not have to buy twice', () => {
    assert.equal(closed.json.keysTransferred, 2);
    assert.match(block, /\*\*Keys transferred:\*\* 2 without re-review/);
  });

  await t.test('decisions per merged ticket counts the rulings, not the open questions', () => {
    assert.equal(closed.json.decisions.ruled, 1);
    assert.equal(closed.json.decisions.merged, 2);
    assert.match(block, /\*\*Decisions per merged ticket:\*\* 0\.50 \(1 ruled \/ 2 merged\)/);
  });

  await t.test('the quality index is read from yg-check/1 and yg-aspects/1, not scraped as text, or plainly says it was not', () => {
    if (yg) {
      assert.equal(closed.json.quality.measured, true, JSON.stringify(closed.json.quality));
      assert.equal(closed.json.quality.enforced, 1);
      assert.equal(closed.json.quality.coveredFiles, 2, 'lib.mjs and other.mjs are the mapped files');
      // Fields only the document carries, never the text report: nobody judged outside the
      // configured reviewer on this fixture, and the full verdict breakdown is passed through.
      assert.equal(closed.json.quality.judges, 0);
      assert.ok(closed.json.quality.verdicts, 'totals.verdicts from yg-check/1 is carried through');
      assert.match(block, /\*\*Quality index:\*\* enforced 1 · advisory clean 0\/0 · baseline \d+ · noise floor \d+ · coverage 2\/\d+ · judges 0 \(first reading\)/);
    } else {
      assert.equal(closed.json.quality.measured, false);
      assert.match(block, /\*\*Quality index:\*\* not measured — the Yggdrasil CLI could not be started/);
    }
  });

  await t.test('a CLI that answers no yg-check/1 document is refused with the release to upgrade to, never parsed as text', () => {
    const stub = join(dir, 'stub-yg.mjs');
    writeFileSync(stub, [
      "if (process.argv.includes('--version')) { console.log('5.7.9'); process.exit(0); }",
      "console.log('enforced 1 [enforced]');",
      'process.exit(0);',
      '',
    ].join('\n'));
    const bad = run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stub}`], dir);
    assert.equal(bad.code, 0, bad.stderr);
    run('wave.mjs', ['start'], dir);
    const r = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /predates/);
    assert.match(r.stderr, /yg-check\/1 and yg-aspects\/1/);
    assert.match(r.stderr, /later than 5\.8\.0/);
    assert.match(r.stderr, /reports version 5\.7\.9/);
    run('horde.mjs', ['config', 'set', 'ygCommand', yg], dir);
  });

  // Printed so the block this evidence row is about is readable in the test output itself.
  console.log(block.split('\n## ')[0]);
});

test('wave.mjs close: a quality index that fell is a line in the report, not an escalation', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, requireYg());
  initHorde(dir);

  run('wave.mjs', ['start'], dir);
  const first = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.quality.enforced, 1);
  assert.deepEqual(first.json.qualityDeclined, [], 'a first reading has nothing to have fallen from');

  // The rule is taken off the node — enforcement the graph had, and now does not.
  const nodeFile = join(dir, '.yggdrasil', 'model', 'feature', 'yg-node.yaml');
  writeFileSync(nodeFile, readFileSync(nodeFile, 'utf8').replace('aspects:\n  - no-marker\n', ''));
  rmSync(join(dir, '.yggdrasil', 'aspects', 'no-marker'), { recursive: true, force: true });

  run('wave.mjs', ['start'], dir);
  const second = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.quality.enforced, 0);
  assert.deepEqual(second.json.qualityDeclined, ['enforced rules 1 → 0']);
  assert.equal(second.json.qualityEscalation, undefined, 'escalations are gone — nothing opens on a fallen index');
  assert.deepEqual(run('ask.mjs', ['list'], dir).json, [], 'no ask was filed for it either — this is a rendering line only, per the coordinator\'s provisional call');

  const plan = readFileSync(planPath(dir), 'utf8');
  const closeBlock = plan.slice(plan.lastIndexOf('# Wave 2 — close'));
  assert.match(closeBlock, /\*\*Quality index:\*\* enforced 0 [^\n]*Δ enforced -1/);
  assert.match(closeBlock, /The quality index fell this wave: enforced rules 1 → 0/);
});
