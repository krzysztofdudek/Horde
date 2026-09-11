// The two guards that run before a landing is judged at all: a branch may not weaken the rules it
// is judged by, and a branch may not sharpen a rule and change the code that rule refuses in the
// same landing. Both are deterministic — no model is asked whether a change is a weakening;
// Yggdrasil's own documents say so — and both are measured here against the real CLI and a real
// graph, never a stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, addNode, addAspect, MARKER_CHECK,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, rel, text) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// Per file, over the two source files only — so the reach of this rule is a set of file units the
// fixture can shrink by narrowing one glob, which is exactly what "narrowed" has to be measured on.
const WIDE_SCOPE = ['  per: file', '  files:', '    path: "src/**/*.mjs"'].join('\n');
const NARROW_SCOPE = ['  per: file', '  files:', '    path: "src/a.mjs"'].join('\n');

// The mission, its graph, and one landable ticket branch — with everything the branch touches
// declared on the ticket, since a rule's own files are nobody's node boundary.
const DECLARED = [
  'src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs',
  '.yggdrasil/aspects/no-marker/yg-aspect.yaml',
  '.yggdrasil/aspects/no-marker/check.mjs',
  '.yggdrasil/aspects/no-marker/content.md',
  '.yggdrasil/aspects/second-rule/yg-aspect.yaml',
  '.yggdrasil/aspects/second-rule/check.mjs',
  '.yggdrasil/model/feature/yg-node.yaml',
];

function baseGraph(dir, { scope = WIDE_SCOPE, status = 'enforced', reviewBy = '2099-01-01' } = {}) {
  addAspect(dir, 'no-marker', {
    description: 'Source files must not carry an unfinished-work marker.',
    check: MARKER_CHECK,
    status,
    reviewBy,
    scope,
  });
  addNode(dir, 'feature', {
    mapping: ['src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs'],
    aspects: ['no-marker'],
  });
}

// A repository with a graph on its trunk and a ticket branch that has not changed the graph yet.
// `mutate` is what this branch does to the law; it runs inside the branch's own worktree.
function lawFixture(dir, id, mutate, { declared = DECLARED, graph = {}, extraBase = null } = {}) {
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);
  run('horde.mjs', ['config', 'set', 'judge', 'one-shot'], dir);

  git(['checkout', '-q', 'mission1/trunk'], dir);
  write(dir, 'src/a.mjs', 'export const a = 1;\n');
  write(dir, 'src/b.mjs', 'export const b = 2;\n');
  write(dir, 'tests/feature.test.mjs', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { a } from '../src/a.mjs';",
    "test('a', () => { assert.equal(a, 1); });",
    '',
  ].join('\n'));
  git(['add', 'src', 'tests'], dir);
  git(['commit', '-qm', 'the code both trees have'], dir);

  baseGraph(dir, graph);
  if (extraBase) extraBase(dir);
  git(['add', '.yggdrasil'], dir);
  git(['commit', '-qm', 'graph: the rule and the component it reaches'], dir);

  const branch = `mission1/t-${id}`;
  git(['checkout', '-q', '-b', branch], dir);
  mutate(dir);
  git(['add', '-A', '--', 'src', 'tests', '.yggdrasil'], dir);
  git(['commit', '-qm', `ticket ${id}`], dir);
  git(['checkout', '-q', 'mission1/trunk'], dir);

  const dst = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', `${id}-sample-ticket`);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'issue.md'), [
    `# ${id} · Sample ticket`, '',
    '**Status:** landed',
    '**Node:** feature · **Class:** standard · **Severity:** medium · **Team:** trunk',
    `**Depends on:** none · **Branch:** ${branch}`,
    `**Files:** ${declared.join(', ')}`, '',
    '## Acceptance — evidence', '', '- [ ] does the thing', '',
  ].join('\n'));
  writeFileSync(join(dst, 'log.md'), `- ${new Date().toISOString()} status: landed — ready to land\n`);

  const queuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json');
  const doc = JSON.parse(readFileSync(queuePath, 'utf8'));
  doc.items.push({
    ticket: id, state: 'landed', class: 'standard', branch, dependsOn: [], agent: 'worker1', sha: null, notes: [], worktree: null,
  });
  writeFileSync(queuePath, JSON.stringify(doc, null, 2));
  return { branch, issueDir: dst };
}

// The client's answer. Kind "lower" goes through the real ask.mjs channel — the exact path
// land.mjs's law guard now points to. `answer: null` leaves the ask open (filed, never
// answered), which is what "nobody has answered yet" means for the guard.
//
// Kind "conflict" (the conflict-of-interest guard, further down this file) is NOT one of
// ask.mjs's four kinds (019 defines stop/stuck/lower/charter only, and inventing a fifth was
// explicitly out of scope) — flagged in land.mjs's own header comment as a real gap. Until that
// is resolved, its only path is decisions.md written directly, exactly as ask.mjs's answerAsk
// would shape it, which is what this branch does.
function recordAnswer(dir, {
  kind = 'lower', aspect = 'no-marker', scope = 'once', answer = 'approved — we agreed this rule is superseded.',
} = {}) {
  if (kind !== 'lower') {
    const path = join(dir, '.horde', 'hordes', 'mission1', 'decisions.md');
    const existing = readFileSync(path, 'utf8');
    const id = `manual-${kind}-${aspect}`;
    const block = [`## 2026-09-11 · ask-${id}`, '', `**Kind:** ${kind} · **Aspect:** ${aspect}`,
      '**Question:** this branch sharpens a rule and changes the code it reaches in the same landing.'];
    if (answer !== null) block.push(`**Answer:** ${answer}`, '**By:** client · **At:** 2026-09-11T09:00:00Z');
    writeFileSync(path, `${existing}\n${block.join('\n')}\n`);
    return;
  }
  const opened = run('ask.mjs', ['add', 'this branch weakens a rule the mission is judged by.', '--kind', kind, '--aspect', aspect], dir);
  if (opened.code !== 0) throw new Error(`ask.mjs add failed: ${opened.stderr}`);
  if (answer === null) return;
  const args = ['answer', opened.json.id, answer];
  if (scope) args.push('--scope', scope);
  const answered = run('ask.mjs', args, dir);
  if (answered.code !== 0) throw new Error(`ask.mjs answer failed: ${answered.stderr}`);
}

function said(r) { return `${r.stdout}${r.stderr}`; }

// ---- the six ways a branch can weaken the law -------------------------------------------

const CASES = [
  {
    name: 'an aspect deleted on the branch',
    label: 'deleted',
    mutate: (dir) => {
      rmSync(join(dir, '.yggdrasil', 'aspects', 'no-marker'), { recursive: true, force: true });
      addNode(dir, 'feature', { mapping: ['src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs'], aspects: [] });
    },
  },
  {
    name: 'a status demoted on the branch',
    label: 'demoted',
    mutate: (dir) => baseGraph(dir, { status: 'advisory' }),
  },
  {
    name: 'a review_by moved on the branch',
    label: 'review_by moved',
    mutate: (dir) => baseGraph(dir, { reviewBy: '2098-01-01' }),
  },
  {
    name: 'a narrowed scope on the branch',
    label: 'narrowed',
    mutate: (dir) => baseGraph(dir, { scope: NARROW_SCOPE }),
  },
  {
    name: 'a yg-suppress marker added on the branch',
    label: 'suppressed',
    mutate: (dir) => write(dir, 'src/a.mjs', '// yg-suppress-disable(no-marker) the fixture says so\nexport const a = 1;\n'),
  },
  {
    name: 'an aspect detached from the node on the branch',
    label: 'detached',
    mutate: (dir) => addNode(dir, 'feature', { mapping: ['src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs'], aspects: [] }),
  },
];

for (const [i, kase] of CASES.entries()) {
  test(`law guard: ${kase.name} refuses, naming the rule and the case`, async (t) => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = lawFixture(dir, String(101 + i), kase.mutate);

    const r = run('land.mjs', [branch], dir);
    assert.equal(r.code, 1, said(r));
    const out = said(r);
    assert.match(out, /may not land as it stands/);
    assert.match(out, /no-marker/, 'the refusal names the rule');
    assert.match(out, new RegExp(kase.label.replace(/[_ ]/g, '[_ ]')), `the refusal names the case (${kase.label})`);
    assert.match(out, /decisions\.md/, 'and names the way out');
    assert.match(out, /ask\.mjs add/);
    assert.match(out, /--kind lower/);
    // Nothing landed, and nothing this run made is left behind.
    assert.equal(git(['rev-list', '--count', '--merges', 'mission1/trunk'], dir), '0');
  });

  test(`law guard: ${kase.name} passes once the client has answered for that rule`, async (t) => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = lawFixture(dir, String(111 + i), kase.mutate);
    recordAnswer(dir, { scope: 'mission' });

    const r = run('land.mjs', [branch], dir);
    assert.doesNotMatch(said(r), /may not land as it stands/, said(r));
    assert.equal(r.code, 0, said(r));
    assert.ok(r.json.landed, 'and it landed');
  });
}

// The regression pin for where this guard reads reach from. A rule at `draft` is inert, so the
// gate reports no pairs about it — and while reach was read off `yg check --json --full`'s pairs,
// a draft rule's reach was the empty set on BOTH trees. Empty is never a strict subset of empty,
// so every narrowing of a rule at the first rung walked straight through the guard that exists to
// catch narrowings. A rung says whether a rule bites, never whether it applies, and what this
// guard compares is where it applies.
test('law guard: a rule narrowed at draft is caught, exactly as one narrowed at enforced is', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(
    dir,
    '130',
    (dir2) => baseGraph(dir2, { status: 'draft', scope: NARROW_SCOPE }),
    { graph: { status: 'draft' } },
  );

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  const out = said(r);
  assert.match(out, /may not land as it stands/);
  assert.match(out, /no-marker \(narrowed\)/, 'the rule is named, and so is the case');
  assert.match(out, /src\/b\.mjs/, 'and so is the unit it stopped reaching');
});

test('law guard: a rule that really does reach nothing is still free to be tidied away', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // Declared by nothing and matching nothing: the honest empty reach. Deleting it weakens nobody,
  // and the guard has to keep letting it go — the draft fix must not turn every deletion into a
  // refusal.
  const { branch } = lawFixture(
    dir,
    '131',
    (dir2) => rmSync(join(dir2, '.yggdrasil', 'aspects', 'loose-rule'), { recursive: true, force: true }),
    {
      declared: [...DECLARED, '.yggdrasil/aspects/loose-rule/yg-aspect.yaml', '.yggdrasil/aspects/loose-rule/check.mjs'],
      extraBase: (dir2) => addAspect(dir2, 'loose-rule', {
        description: 'A rule no component declares and no file matches.',
        check: MARKER_CHECK,
        status: 'draft',
      }),
    },
  );

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /loose-rule/, said(r));
  assert.equal(r.code, 0, said(r));
  assert.ok(r.json.landed, 'and it landed');
});

test('law guard: an answer about a different rule does not let this one through', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '121', (dir2) => baseGraph(dir2, { status: 'advisory' }));
  recordAnswer(dir, { aspect: 'some-other-rule', scope: 'mission' });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  assert.match(said(r), /no-marker \(demoted\)/);
});

test('law guard: an ask nobody has answered yet lets nothing through', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '122', (dir2) => baseGraph(dir2, { status: 'advisory' }));
  recordAnswer(dir, { scope: 'mission', answer: null });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  assert.match(said(r), /no-marker \(demoted\)/);
});

test('law guard: an answer that refused the ask lets nothing through either', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '123', (dir2) => baseGraph(dir2, { status: 'advisory' }));
  recordAnswer(dir, { scope: 'mission', answer: 'no — that rule is the reason we started.' });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  assert.match(said(r), /no-marker \(demoted\)/);
});

test('law guard: "scope: once" is spent by the landing that used it; "scope: mission" stands', async (t) => {
  await t.test('once — the first landing consumes it, the second is refused', async (tt) => {
    const dir = makeRepo();
    tt.after(() => rmRepo(dir));
    const { branch } = lawFixture(dir, '124', (dir2) => baseGraph(dir2, { status: 'advisory' }));
    recordAnswer(dir, { scope: 'once' });

    const first = run('land.mjs', [branch], dir);
    assert.equal(first.code, 0, said(first));
    assert.ok(first.json.landed);
    // The answer now says, in the file itself, which landing spent it.
    const decisions = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'decisions.md'), 'utf8');
    assert.match(decisions, /\*\*Consumed:\*\* ticket 124 at [0-9a-f]{40} on /);

    // A second branch weakening the same rule finds the answer spent.
    git(['checkout', '-q', '-b', 'mission1/t-125', 'mission1/trunk'], dir);
    addAspect(dir, 'no-marker', {
      description: 'Source files must not carry an unfinished-work marker.',
      check: MARKER_CHECK,
      status: 'draft',
      scope: WIDE_SCOPE,
    });
    git(['add', '.yggdrasil'], dir);
    git(['commit', '-qm', 'ticket 125'], dir);
    git(['checkout', '-q', 'mission1/trunk'], dir);
    const dst = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', '125-sample-ticket');
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'issue.md'), [
      '# 125 · Sample ticket', '',
      '**Status:** landed',
      '**Node:** feature · **Class:** standard · **Severity:** medium · **Team:** trunk',
      '**Depends on:** none · **Branch:** mission1/t-125',
      `**Files:** ${DECLARED.join(', ')}`, '',
      '## Acceptance — evidence', '', '- [ ] does the thing', '',
    ].join('\n'));
    writeFileSync(join(dst, 'log.md'), `- ${new Date().toISOString()} status: landed\n`);
    const queuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json');
    const doc = JSON.parse(readFileSync(queuePath, 'utf8'));
    doc.items.push({
      ticket: '125', state: 'landed', class: 'standard', branch: 'mission1/t-125', dependsOn: [], agent: 'worker1', sha: null, notes: [], worktree: null,
    });
    writeFileSync(queuePath, JSON.stringify(doc, null, 2));

    const second = run('land.mjs', ['mission1/t-125'], dir);
    assert.equal(second.code, 1, said(second));
    assert.match(said(second), /no-marker \(demoted\)/);
  });

  await t.test('mission — it is not consumed at all', async (tt) => {
    const dir = makeRepo();
    tt.after(() => rmRepo(dir));
    const { branch } = lawFixture(dir, '126', (dir2) => baseGraph(dir2, { status: 'advisory' }));
    recordAnswer(dir, { scope: 'mission' });

    const r = run('land.mjs', [branch], dir);
    assert.equal(r.code, 0, said(r));
    const decisions = readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'decisions.md'), 'utf8');
    assert.doesNotMatch(decisions, /\*\*Consumed:\*\*/, 'a mission-scope answer stands until the mission closes');
  });
});

// ---- what counts as a narrowing --------------------------------------------------------

test('law guard: a WIDENED scope is not a lowering — it goes down the conflict path instead', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // Base reaches src/a.mjs only; the branch widens it to both source files.
  const { branch } = lawFixture(dir, '131', (dir2) => baseGraph(dir2, { scope: WIDE_SCOPE }), {
    graph: { scope: NARROW_SCOPE },
  });

  const r = run('land.mjs', [branch], dir);
  const out = said(r);
  assert.doesNotMatch(out, /\(narrowed\)/, out);
  assert.doesNotMatch(out, /\(deleted\)|\(demoted\)|\(detached\)/, out);
  // The branch changed the rule's own text and nothing else, so no code file it reaches moved
  // either — nothing to be in conflict with, and it lands.
  assert.equal(r.code, 0, out);
});

test('law guard: identical reach with changed rule text is editorial and stops nothing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // A different spelling of the same set: both globs reach exactly src/a.mjs and src/b.mjs.
  const sameReach = ['  per: file', '  files:', '    any_of:', '      - path: "src/a.mjs"', '      - path: "src/b.mjs"'].join('\n');
  const { branch } = lawFixture(dir, '132', (dir2) => baseGraph(dir2, { scope: sameReach }));

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /may not land as it stands/, said(r));
  assert.equal(r.code, 0, said(r));
});

test('law guard: a file the branch ADDS does not read as a widening, and one it DELETES does not read as a narrowing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // The rule's own text is untouched. The branch adds one file the rule reaches and deletes
  // another — both change the raw pair count, and neither is a change to the law.
  const { branch } = lawFixture(dir, '133', (dir2) => {
    write(dir2, 'src/c.mjs', 'export const c = 3;\n');
    rmSync(join(dir2, 'src/b.mjs'), { force: true });
    addNode(dir2, 'feature', {
      mapping: ['src/a.mjs', 'src/c.mjs', 'tests/feature.test.mjs'],
      aspects: ['no-marker'],
    });
  }, { declared: [...DECLARED, 'src/c.mjs'] });

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /may not land as it stands/, said(r));
  assert.equal(r.code, 0, said(r));
});

test('law guard: a rule that reaches nothing in either tree is deletable with no signature', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // second-rule is declared but no node ever carries it, so it judges nothing. Deleting it takes
  // nothing away from anybody — and a guard that refused it would be refusing tidying up.
  const { branch } = lawFixture(dir, '134', (dir2) => {
    rmSync(join(dir2, '.yggdrasil', 'aspects', 'second-rule'), { recursive: true, force: true });
  }, {
    extraBase: (dir2) => addAspect(dir2, 'second-rule', {
      description: 'A rule no component ever carries.',
      check: MARKER_CHECK,
      scope: WIDE_SCOPE,
    }),
  });

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /may not land as it stands/, said(r));
  assert.equal(r.code, 0, said(r));
});

// ---- the conflict-of-interest guard ------------------------------------------------------

test('conflict guard: sharpening a rule and changing code it reaches in one landing is refused', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '141', (dir2) => {
    // The rule gains a second thing it refuses, and the very file it judges changes in the same
    // commit. Which way the rule now reads, it reads that way because this code needed it to.
    writeFileSync(join(dir2, '.yggdrasil', 'aspects', 'no-marker', 'check.mjs'), MARKER_CHECK.replace('UNFINISHED', 'TODO'));
    write(dir2, 'src/a.mjs', 'export const a = 11;\n');
  });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  const out = said(r);
  assert.match(out, /conflict of interest/);
  assert.match(out, /no-marker/, 'the rule is named');
  assert.match(out, /src\/a\.mjs/, 'and so is the file');
  assert.match(out, /one ticket for the code, one for the rule/, 'and the way out');
});

test('conflict guard: the same branch lands once the client has answered the conflict ask', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '142', (dir2) => {
    writeFileSync(join(dir2, '.yggdrasil', 'aspects', 'no-marker', 'check.mjs'), MARKER_CHECK.replace('UNFINISHED', 'TODO'));
    write(dir2, 'src/a.mjs', 'export const a = 11;\n');
  });
  recordAnswer(dir, { kind: 'conflict', scope: 'mission', answer: 'approved — the rule and the fix were agreed together.' });

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /conflict of interest/, said(r));
  assert.equal(r.code, 0, said(r));
});

test('conflict guard: a brand-new rule is not a conflict, whatever code lands beside it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '143', (dir2) => {
    addAspect(dir2, 'second-rule', {
      description: 'A rule that did not exist before this branch.',
      check: MARKER_CHECK,
      scope: WIDE_SCOPE,
    });
    addNode(dir2, 'feature', {
      mapping: ['src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs'],
      aspects: ['no-marker', 'second-rule'],
    });
    write(dir2, 'src/a.mjs', 'export const a = 11;\n');
  });

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /conflict of interest/, said(r));
  assert.equal(r.code, 0, said(r));
});

test('conflict guard: raising an existing rule without touching its text is not a conflict', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // advisory on the base, enforced on the branch — a rule getting stronger, with the code it
  // judges changing too. Sharpening what a rule SAYS is the conflict; raising how hard it bites
  // is not, because the text that judges this code is the one that already judged it.
  const { branch } = lawFixture(dir, '144', (dir2) => {
    baseGraph(dir2, { status: 'enforced' });
    write(dir2, 'src/a.mjs', 'export const a = 11;\n');
  }, { graph: { status: 'advisory' } });

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /conflict of interest/, said(r));
  assert.equal(r.code, 0, said(r));
});

test('conflict guard: changing a rule that reaches none of the changed files is not a conflict', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '145', (dir2) => {
    // The rule is narrowed to src/a.mjs only... and the file that changes is src/b.mjs, which it
    // no longer reaches. (The narrowing itself is a lowering, so the client has to have said so —
    // that is a different guard, and the answer below is about that one, not this one.)
    baseGraph(dir2, { scope: NARROW_SCOPE });
    write(dir2, 'src/b.mjs', 'export const b = 22;\n');
  });
  recordAnswer(dir, { scope: 'mission' });

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /conflict of interest/, said(r));
  assert.equal(r.code, 0, said(r));
});

// ---- the guard's own dependencies -------------------------------------------------------

test('law guard: a CLI that cannot answer reach stops the run, and never falls back to the older document', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '152', (dir2) => write(dir2, 'src/a.mjs', 'export const a = 111;\n'));

  const real = JSON.parse(readFileSync(join(dir, '.horde', 'config.json'), 'utf8')).ygCommand;
  const stub = join(dir, 'yg-no-reach.mjs');
  writeFileSync(stub, [
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'aspects' && args.includes('--reach')) {",
    '  process.stderr.write("error: unknown option \'--reach\'\\n");',
    '  process.exit(1);',
    '}',
    `const real = ${JSON.stringify(real)}.split(/\\s+/);`,
    "const r = spawnSync(real[0], [...real.slice(1), ...args], { stdio: 'inherit' });",
    'process.exit(r.status === null ? 1 : r.status);',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stub}`], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  const out = said(r);
  assert.match(out, /aspects --json --reach/, 'the command it could not run is named');
  assert.match(out, /which units each rule reaches/);
  assert.match(out, /npm i -g @chrisdudek\/yg|config\.ygCommand at a build/);
  assert.doesNotMatch(out, /check --json --full/, 'the two documents answer different questions; there is no quiet fallback');
  assert.equal(git(['rev-list', '--count', '--merges', 'mission1/trunk'], dir), '0', 'and nothing landed');
});

test('law guard: a CLI that takes the reach flag and ignores it is refused, not read as an empty law', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // The narrowing from the draft case above, in front of a CLI that drops the flag. A guard that
  // read the flagless answer as data would see every rule reaching nothing on both trees and wave
  // the narrowing through — the exact reading this whole reading moved to stop.
  const { branch } = lawFixture(
    dir,
    '153',
    (dir2) => baseGraph(dir2, { status: 'draft', scope: NARROW_SCOPE }),
    { graph: { status: 'draft' } },
  );

  const real = JSON.parse(readFileSync(join(dir, '.horde', 'config.json'), 'utf8')).ygCommand;
  const stub = join(dir, 'yg-drops-reach.mjs');
  writeFileSync(stub, [
    "import { spawnSync } from 'node:child_process';",
    "const args = process.argv.slice(2).filter((a) => a !== '--reach');",
    `const real = ${JSON.stringify(real)}.split(/\\s+/);`,
    "const r = spawnSync(real[0], [...real.slice(1), ...args], { stdio: 'inherit' });",
    'process.exit(r.status === null ? 1 : r.status);',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stub}`], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  assert.match(said(r), /no reach on any rule/);
  assert.match(said(r), /a missing reach is not an empty one/);
  assert.equal(git(['rev-list', '--count', '--merges', 'mission1/trunk'], dir), '0', 'and nothing landed');
});

test('law guard: a CLI that cannot inventory suppressions stops the run rather than reading text', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // An ordinary code change: the guard has to read the waiver inventory on every landing, not
  // only on one that touched a rule, since a marker is added in a source file like any other line.
  const { branch } = lawFixture(dir, '151', (dir2) => write(dir2, 'src/a.mjs', 'export const a = 111;\n'));

  // A CLI that answers every other document but has no `suppressions` command — Yggdrasil before
  // it grew one. A guard that shrugged here would be a guard that cannot see a rule switched off.
  const real = JSON.parse(readFileSync(join(dir, '.horde', 'config.json'), 'utf8')).ygCommand;
  const stub = join(dir, 'yg-no-suppressions.mjs');
  writeFileSync(stub, [
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'suppressions') {",
    "  process.stderr.write(\"error: unknown command 'suppressions'\\n\");",
    '  process.exit(1);',
    '}',
    `const real = ${JSON.stringify(real)}.split(/\\s+/);`,
    "const r = spawnSync(real[0], [...real.slice(1), ...args], { stdio: 'inherit' });",
    'process.exit(r.status === null ? 1 : r.status);',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${stub}`], dir);

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  const out = said(r);
  assert.match(out, /suppressions --json/, 'the missing command is named');
  assert.match(out, /yg-suppressions\/1/);
  assert.match(out, /added yg-suppress marker is exactly that/);
  assert.match(out, /npm i -g @chrisdudek\/yg|config\.ygCommand at a build/);
  assert.equal(git(['rev-list', '--count', '--merges', 'mission1/trunk'], dir), '0', 'and nothing landed');
});
