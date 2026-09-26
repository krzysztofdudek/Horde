// The guards that run before a landing is judged at all. A branch may not weaken the rules it is
// judged by, may not weaken the proof or the gates it is measured with, and may not sharpen a rule
// and change the code that rule refuses in the same landing. Every one of them is deterministic —
// no model is asked whether a change is a weakening; two trees and Yggdrasil's own documents say
// so — and every one of them is measured here against the real CLI, a real graph, a real suite and
// a real gate, never a stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode, addAspect, MARKER_CHECK, git, requireYg, yg,
} from './helpers.mjs';

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
function lawFixture(dir, id, mutate, {
  declared = DECLARED, graph = {}, extraBase = null,
  noNewTests = 'synthetic law-guard fixture — proves the law guard, not the revert test',
} = {}) {
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);

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
    `**Files:** ${declared.join(', ')}`,
    ...(noNewTests ? [`**No new tests:** ${noNewTests}`] : []),
    '',
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
// Kind "conflict" is not one of ask.mjs's four kinds (019 defines stop/stuck/lower/charter
// only) and the conflict-of-interest guard (further down this file) has no waiver at all — this
// helper can still write a "conflict"-kind block by hand, shaped exactly as ask.mjs's answerAsk
// would shape a real one, so the guard-always-refuses test below can prove the guard ignores it.
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

test('conflict guard: a file whose owner the CLI cannot answer for stops the landing, never reads as "no owner"', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '149', (dir2) => {
    writeFileSync(join(dir2, '.yggdrasil', 'aspects', 'no-marker', 'check.mjs'), MARKER_CHECK.replace('UNFINISHED', 'TODO'));
    write(dir2, 'src/a.mjs', 'export const a = 11;\n');
  });
  // The real CLI for everything but `context`, which answers a version this Horde does not know.
  const real = requireYg().split(/\s+/);
  const shim = join(dir, 'yg-shim.mjs');
  writeFileSync(shim, [
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'context') { console.log(JSON.stringify({ schema: 'yg-context/2' })); process.exit(0); }",
    `const r = spawnSync(${JSON.stringify(real[0])}, [...${JSON.stringify(real.slice(1))}, ...args], { stdio: 'inherit' });`,
    'process.exit(r.status === null ? 1 : r.status);',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'ygCommand', `node ${shim}`], dir);

  const r = run('land.mjs', [branch], dir);
  assert.notEqual(r.code, 0, said(r));
  assert.match(said(r), /did not answer with the yg-context\/1 document Horde reads/, said(r));
  assert.match(said(r), /who owns src\/a\.mjs/, said(r));
});

test('conflict guard: a hand-written "conflict"-kind decision lets nothing through — there is no waiver', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = lawFixture(dir, '142', (dir2) => {
    writeFileSync(join(dir2, '.yggdrasil', 'aspects', 'no-marker', 'check.mjs'), MARKER_CHECK.replace('UNFINISHED', 'TODO'));
    write(dir2, 'src/a.mjs', 'export const a = 11;\n');
  });
  // Nobody can answer a "lower" ask their way past the conflict guard, because it never reads
  // asks — only a decisions.md entry written by hand even claims to be an approved "conflict"
  // decision, and the guard still refuses: there is no sanctioned or unsanctioned path through it.
  recordAnswer(dir, { kind: 'conflict', scope: 'mission', answer: 'approved — the rule and the fix were agreed together.' });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  assert.match(said(r), /conflict of interest/, said(r));
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

// ---- the proof and the gates: everything else that protects (021) --------------------------
//
// The law guard above says a branch may not weaken the rules it is judged by. Two more say the
// same about the other two things a mission is held to — the proof it is judged by and the gates
// it is measured through — through the same ask.mjs channel, one answered question per exact
// thing being weakened.
//
// The fixture below is a real repository of each: two source files, two test files, a promise with
// a real test keeping it, the repository's own gate script, and a commit hook. Nothing here is a
// stand-in, and nothing here is mapped to a node except what the rule already reached — a promise
// and a suite are not a component's own files, and a fixture that pretended otherwise would be
// measuring Yggdrasil's mapping rules rather than these guards.

const SECOND_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { a } from '../src/a.mjs';",
  "import { b } from '../src/b.mjs';",
  '',
  "test('a is one', () => { assert.equal(a, 1); });",
  "test('b is two', () => { assert.equal(b, 2); });",
  '',
].join('\n');

const PROMISE_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { a } from '../src/a.mjs';",
  "import { b } from '../src/b.mjs';",
  '',
  "test('adds two numbers', () => { assert.equal(a + b, 3); });",
  '',
].join('\n');

function promiseDoc(status) {
  return [
    '---',
    'id: adds-two-numbers',
    `status: ${status}`,
    '---',
    '',
    '## What it checks',
    '',
    'Adding the two numbers gives their sum.',
    '',
  ].join('\n');
}

const GATE_SCRIPT = ["# this repository's own gate", 'exit 0', ''].join('\n');
const HOOK_SCRIPT = ['#!/bin/sh', 'sh gate.sh', ''].join('\n');

const PROTECTED_DECLARED = [
  'src/a.mjs', 'src/b.mjs',
  'tests/feature.test.mjs', 'tests/second.test.mjs', 'tests/renamed.test.mjs',
  'promises/adds-two-numbers.md', 'promises/adds-two-numbers.test.mjs',
  'gate.sh', '.husky/pre-commit',
  '.yggdrasil/model/feature/yg-node.yaml',
];

// Breaks both source files at once, in a throwaway copy of the branch's own tip, so whichever case
// a ticket below leaves running goes red under it. The revert-test item is not what any of these
// tests is about — this is what keeps it honest while they run.
const MUTATE = 'node -e "const f=require(\'fs\');f.writeFileSync(\'src/a.mjs\',\'export const a = 999;\');f.writeFileSync(\'src/b.mjs\',\'export const b = 999;\')"';

function seedProtectionTicket(dir, id, branch, declared) {
  const dst = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues', `${id}-sample-ticket`);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'issue.md'), [
    `# ${id} · Sample ticket`, '',
    '**Status:** landed',
    '**Node:** feature · **Class:** standard · **Severity:** medium · **Team:** trunk',
    `**Depends on:** none · **Branch:** ${branch}`,
    `**Files:** ${declared.join(', ')}`,
    `**Mutate:** ${MUTATE}`,
    '**No new tests:** what this ticket exercises is a guard, and the suite it starts from already covers the code',
    '',
    '## Acceptance — evidence', '', '- [ ] does the thing', '',
  ].join('\n'));
  writeFileSync(join(dst, 'log.md'), `- ${new Date().toISOString()} status: landed — ready to land\n`);
  const queuePath = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json');
  const doc = JSON.parse(readFileSync(queuePath, 'utf8'));
  doc.items.push({
    ticket: id, state: 'landed', class: 'standard', branch, dependsOn: [], agent: 'worker1', sha: null, notes: [], worktree: null,
  });
  writeFileSync(queuePath, JSON.stringify(doc, null, 2));
  return dst;
}

function protectionFixture(dir, id, mutate, { declared = PROTECTED_DECLARED } = {}) {
  initHorde(dir);
  // A gate command that names a file this repository actually tracks — which is the only kind a
  // two-tree guard can say anything about, and the only kind a branch can quietly rewrite.
  run('horde.mjs', ['config', 'set', 'gates.team', 'sh gate.sh'], dir);

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
  write(dir, 'tests/second.test.mjs', SECOND_TEST);
  write(dir, 'promises/adds-two-numbers.md', promiseDoc('implemented'));
  write(dir, 'promises/adds-two-numbers.test.mjs', PROMISE_TEST);
  write(dir, 'gate.sh', GATE_SCRIPT);
  write(dir, '.husky/pre-commit', HOOK_SCRIPT);
  git(['add', '--', 'src', 'tests', 'promises', 'gate.sh', '.husky'], dir);
  git(['commit', '-qm', 'the code, the proof and the gates both trees start from'], dir);

  baseGraph(dir);
  git(['add', '.yggdrasil'], dir);
  git(['commit', '-qm', 'graph: the rule and the component it reaches'], dir);

  const branch = `mission1/t-${id}`;
  git(['checkout', '-q', '-b', branch], dir);
  mutate(dir);
  git(['add', '-A', '--', 'src', 'tests', 'promises', 'gate.sh', '.husky', '.yggdrasil'], dir);
  git(['commit', '-qm', `ticket ${id}`], dir);
  git(['checkout', '-q', 'mission1/trunk'], dir);

  seedProtectionTicket(dir, id, branch, declared);
  return { branch };
}

function decisionsOf(dir) {
  return readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'decisions.md'), 'utf8');
}

function asRegExp(literal) {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// ---- the six ways a branch can weaken what protects it ------------------------------------

const PROTECTION_CASES = [
  {
    name: 'a test file removed on the branch',
    label: 'test removed',
    target: 'evidence:tests/second.test.mjs',
    mutate: (dir) => rmSync(join(dir, 'tests', 'second.test.mjs'), { force: true }),
  },
  {
    name: 'an assertion removed on the branch',
    label: 'assertions dropped',
    target: 'evidence:tests/second.test.mjs',
    mutate: (dir) => write(dir, 'tests/second.test.mjs', SECOND_TEST.replace("test('b is two', () => { assert.equal(b, 2); });\n", '')),
  },
  {
    name: 'a skip marker added on the branch',
    label: 'skip added',
    target: 'evidence:tests/second.test.mjs',
    mutate: (dir) => write(dir, 'tests/second.test.mjs', SECOND_TEST.replace("test('a is one'", "test.skip('a is one'")),
  },
  {
    name: 'a promise put back to planned on the branch',
    label: 'promise parked',
    target: 'evidence:adds-two-numbers',
    mutate: (dir) => write(dir, 'promises/adds-two-numbers.md', promiseDoc('planned')),
  },
  {
    name: "the gate command's own script changed on the branch",
    label: 'gate changed',
    target: 'gate:gate.sh',
    mutate: (dir) => write(dir, 'gate.sh', GATE_SCRIPT.replace('own gate', 'own gate, loosened')),
  },
  {
    name: 'a commit hook removed on the branch',
    label: 'gate removed',
    target: 'gate:.husky/pre-commit',
    mutate: (dir) => rmSync(join(dir, '.husky', 'pre-commit'), { force: true }),
  },
];

for (const [i, kase] of PROTECTION_CASES.entries()) {
  test(`protection guards: ${kase.name} refuses, naming the exact thing and the case`, async (t) => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = protectionFixture(dir, String(201 + i), kase.mutate);

    const r = run('land.mjs', [branch], dir);
    assert.equal(r.code, 1, said(r));
    const out = said(r);
    assert.match(out, /may not land as it stands/);
    assert.match(out, asRegExp(kase.target), 'the refusal names the exact thing that weakened');
    assert.match(out, asRegExp(`(${kase.label})`), `the refusal names the case (${kase.label})`);
    assert.match(out, /decisions\.md/, 'and names the way out');
    assert.match(out, /ask\.mjs add/);
    assert.match(out, /--kind lower/);
    // Nothing landed.
    assert.equal(git(['rev-list', '--count', '--merges', 'mission1/trunk'], dir), '0');
  });

  test(`protection guards: ${kase.name} passes on the client's answer, and spends a "once" one`, async (t) => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const id = String(211 + i);
    const { branch } = protectionFixture(dir, id, kase.mutate);
    recordAnswer(dir, { aspect: kase.target, scope: 'once' });

    const r = run('land.mjs', [branch], dir);
    assert.doesNotMatch(said(r), /may not land as it stands/, said(r));
    assert.equal(r.code, 0, said(r));
    assert.ok(r.json.landed, 'and it landed');
    // The answer now says, in the file itself, which landing spent it.
    assert.match(decisionsOf(dir), new RegExp(`\\*\\*Consumed:\\*\\* ticket ${id} at [0-9a-f]{40} on `));
  });
}

test('protection guards: an answer about something else lets none of this through', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = protectionFixture(dir, '221', (d) => rmSync(join(d, 'tests', 'second.test.mjs'), { force: true }));
  // A real rule id, answered for real — and nothing to do with the test file this branch deleted.
  // One answer lets one thing through, never a category and never a neighbour.
  recordAnswer(dir, { aspect: 'no-marker', scope: 'mission' });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  assert.match(said(r), asRegExp('evidence:tests/second.test.mjs (test removed)'));
});

test('protection guards: an ask nobody has answered yet lets nothing through', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = protectionFixture(dir, '222', (d) => write(d, 'promises/adds-two-numbers.md', promiseDoc('planned')));
  recordAnswer(dir, { aspect: 'evidence:adds-two-numbers', scope: 'mission', answer: null });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  assert.match(said(r), asRegExp('evidence:adds-two-numbers (promise parked)'));
});

test('protection guards: an answer that refused the ask lets nothing through either', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = protectionFixture(dir, '223', (d) => rmSync(join(d, '.husky', 'pre-commit'), { force: true }));
  recordAnswer(dir, { aspect: 'gate:.husky/pre-commit', scope: 'mission', answer: 'no — that hook is why we stopped shipping this by hand.' });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  assert.match(said(r), asRegExp('gate:.husky/pre-commit (gate removed)'));
});

// ---- what is not a weakening ----------------------------------------------------------------

test('protection guards: more assertions than it found is never a weakening', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = protectionFixture(dir, '224', (d) => write(
    d,
    'tests/second.test.mjs',
    `${SECOND_TEST}test('a and b differ', () => { assert.notEqual(a, b); });\n`,
  ));

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /may not land as it stands/, said(r));
  assert.equal(r.code, 0, said(r));
  assert.ok(r.json.landed, 'and it landed');
});

test('protection guards: a test file that moved is not a test file that went', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  // The same bytes under a new name. Nothing stopped being run, so nothing here is the client's to
  // sign off — a guard that refused this would be refusing tidying up.
  const { branch } = protectionFixture(dir, '225', (d) => {
    write(d, 'tests/renamed.test.mjs', SECOND_TEST);
    rmSync(join(d, 'tests', 'second.test.mjs'), { force: true });
    addNode(d, 'feature', {
      mapping: ['src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs', 'tests/renamed.test.mjs'],
      aspects: ['no-marker'],
    });
  });

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /test removed/, said(r));
  assert.doesNotMatch(said(r), /may not land as it stands/, said(r));
  assert.equal(r.code, 0, said(r));
});

test('protection guards: a branch that touches none of it is not asked about any of it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = protectionFixture(dir, '226', (d) => write(d, 'src/a.mjs', 'export const a = 1; // reworded\n'));

  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /may not land as it stands/, said(r));
  assert.equal(r.code, 0, said(r));
  assert.ok(r.json.landed);
});

// ---- a spent answer stays spent --------------------------------------------------------------

test('protection guards: "scope: once" is spent by the landing that used it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = protectionFixture(dir, '231', (d) => write(d, 'gate.sh', GATE_SCRIPT.replace('own gate', 'own gate, loosened')));
  recordAnswer(dir, { aspect: 'gate:gate.sh', scope: 'once' });

  const first = run('land.mjs', [branch], dir);
  assert.equal(first.code, 0, said(first));
  assert.ok(first.json.landed);
  assert.match(decisionsOf(dir), /\*\*Consumed:\*\* ticket 231 at [0-9a-f]{40} on /);

  // A second branch rewriting the same gate script finds the answer spent.
  git(['checkout', '-q', '-b', 'mission1/t-232', 'mission1/trunk'], dir);
  write(dir, 'gate.sh', ["# this repository's own gate, loosened again", 'exit 0', ''].join('\n'));
  git(['add', '--', 'gate.sh'], dir);
  git(['commit', '-qm', 'ticket 232'], dir);
  git(['checkout', '-q', 'mission1/trunk'], dir);
  seedProtectionTicket(dir, '232', 'mission1/t-232', PROTECTED_DECLARED);

  const second = run('land.mjs', ['mission1/t-232'], dir);
  assert.equal(second.code, 1, said(second));
  assert.match(said(second), asRegExp('gate:gate.sh (gate changed)'));
});

// ---- the has-evidence aspect's own pin (issue 126) -----------------------------------------
//
// A repository may PIN one pairing for every promise, via the has-evidence aspect's own
// `config.evidence` setting, instead of each promise's own frontmatter saying which of the four
// it uses. The unit-level proofs of this live beside `pairingOf`/`pairingKind`/`evidencePinAt` in
// land.test.mjs; this is the one end-to-end proof that the pin actually changes what a real
// landing refuses.
//
// A promise whose own frontmatter would auto-derive a DIFFERENT pairing than the one pinned is
// the case that matters: a reader who only watched what auto mode watches would miss exactly what
// broke. So the fixture below pins `named`, on a promise carrying a stale, COMPLETE `artefact:`
// block — the shape auto mode reads FIRST, unconditionally, before ever considering the pin — and
// its real evidence, per the pin, is a named case inside a plain tracked file that matches none of
// `config.testGlobs`. That isolation is deliberate: it is the only way to tell "the pin decided
// this" from "the glob-based test-file guard would have caught it anyway".
const HAS_EVIDENCE_DECLARED = [
  'src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs',
  'promises/named-target.md', 'promises/checked-in-note.txt',
  '.yggdrasil/aspects/has-evidence/yg-aspect.yaml', '.yggdrasil/aspects/has-evidence/check.mjs',
  '.yggdrasil/model/feature/yg-node.yaml',
];

function hasEvidenceAspectYaml(pin) {
  return [
    'name: has-evidence',
    'description: Fixture has-evidence rule, pinned for this test.',
    'errs: under',
    'status: enforced',
    'review_by: 2099-01-01',
    'config:',
    `  evidence: ${pin}`,
    '',
  ].join('\n');
}

function pinnedEvidenceFixture(dir, id, pin, { installed = false } = {}) {
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'gates.team', 'true'], dir);

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
  write(dir, 'promises/named-target.md', [
    '---',
    'id: named-target',
    'status: implemented',
    'evidence: promises/checked-in-note.txt#the target runs',
    'artefact:',
    '  path: promises/checked-in-note.txt',
    `  sha256: ${'0'.repeat(64)}`,
    '  accepted_by: client',
    '  at: 2026-09-01T00:00:00Z',
    '---',
    '',
    '## What it checks',
    '',
    'Something the product does.',
    '',
  ].join('\n'));
  write(dir, 'promises/checked-in-note.txt', 'Scenario: the target runs\n');
  if (installed) {
    // The rule as `yg pack add` puts it, and the pin where an adopter writes it: in the adaptation
    // beside the copy, never in the copy itself. `pin: null` leaves the adaptation as written.
    installPromises(dir);
    if (pin) write(dir, `${INSTALLED_HAS_EVIDENCE}/yg-aspect.adapt.yaml`, `config:\n  evidence: ${pin}\n`);
  } else {
    write(dir, '.yggdrasil/aspects/has-evidence/yg-aspect.yaml', hasEvidenceAspectYaml(pin));
    write(dir, '.yggdrasil/aspects/has-evidence/check.mjs', MARKER_CHECK);
  }
  git(['add', '--', 'src', 'tests', 'promises'], dir);
  git(['commit', '-qm', 'the code and the pinned promise both trees start from'], dir);

  baseGraph(dir);
  git(['add', '.yggdrasil'], dir);
  git(['commit', '-qm', 'graph: the rule and the component it reaches, plus the has-evidence pin'], dir);

  const branch = `mission1/t-${id}`;
  git(['checkout', '-q', '-b', branch], dir);
  // Delete ONLY the real named evidence. The promise's own file — carrying the stale artefact
  // block auto mode would have read instead — is left completely untouched.
  rmSync(join(dir, 'promises', 'checked-in-note.txt'), { force: true });
  git(['add', '-A', '--', 'promises'], dir);
  git(['commit', '-qm', `ticket ${id}: delete the real named evidence, leave the promise doc alone`], dir);
  git(['checkout', '-q', 'mission1/trunk'], dir);

  seedProtectionTicket(dir, id, branch, HAS_EVIDENCE_DECLARED);
  return { branch };
}

test('protection guards: a `named` pin overrides a promise\'s own stale `artefact:` block — deleting the real evidence refuses as "pairing gone"', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const { branch } = pinnedEvidenceFixture(dir, '241', 'named');

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  const out = said(r);
  assert.match(out, /may not land as it stands/);
  assert.match(out, asRegExp('evidence:named-target (pairing gone)'), 'the pin decided the pairing, and its real evidence going missing is what refuses');
  // Nothing landed.
  assert.equal(git(['rev-list', '--count', '--merges', 'mission1/trunk'], dir), '0');
});

// ---- rule ids that hold a `/` (issue 290) --------------------------------------------------
//
// A rule id is its directory's path under `.yggdrasil/aspects/`, and two ordinary shapes hold a `/`:
// a rule nested under another, and every rule `yg pack add` installs, which lands under
// `packages/<owner>/<repo>/<package>/`. The guards resolve a changed path to the longest rule id
// above it, so neither shape walks past them — and the has-evidence pin is read where an installed
// rule keeps it, in the adaptation beside the copy.

const HORDE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INSTALLED_HAS_EVIDENCE = '.yggdrasil/aspects/packages/o/r/promises/has-evidence';

// Horde's own `promises` package, installed the way an adopter installs it — through the real
// `yg pack add` — from a plain copy of this checkout's package under the identity o/r.
function installPromises(dir) {
  const source = mkdtempSync(join(tmpdir(), 'promises-source-'));
  cpSync(join(HORDE_ROOT, 'packages'), join(source, 'packages'), { recursive: true });
  cpSync(join(HORDE_ROOT, 'yg-marketplace.yaml'), join(source, 'yg-marketplace.yaml'));
  const r = yg(dir, ['pack', 'add', `${source}#promises`, '--as', 'o/r']);
  rmSync(source, { recursive: true, force: true });
  if (r.code !== 0) throw new Error(`yg pack add failed: ${r.out}`);
}

// An installed copy is never edited — Yggdrasil refuses a changed copy on its own, and its context
// cannot even be assembled over one — so the way an adopter changes what an installed rule says is
// its adaptation. That file sits in the rule's own directory, under the rule's full id.
test('conflict guard: an installed rule\'s adaptation changed beside a promise it reaches is refused, under the rule\'s full id', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const declared = [...DECLARED, 'promises/keeps-a.md', `${INSTALLED_HAS_EVIDENCE}/yg-aspect.adapt.yaml`];
  const { branch } = lawFixture(dir, '291', (dir2) => {
    write(dir2, `${INSTALLED_HAS_EVIDENCE}/yg-aspect.adapt.yaml`, 'config:\n  spec_suffix: ".spec"\n');
    write(dir2, 'promises/keeps-a.md', '---\nid: keeps-a\nstatus: implemented\n---\n\nThe feature adds two numbers, and nothing else.\n');
    git(['add', 'promises'], dir2);
  }, {
    declared,
    extraBase: (dir2) => {
      installPromises(dir2);
      write(dir2, 'promises/keeps-a.md', '---\nid: keeps-a\nstatus: implemented\n---\n\nThe feature adds two numbers.\n');
      git(['add', 'promises'], dir2);
      addNode(dir2, 'feature', {
        mapping: ['src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs', 'promises/keeps-a.md'],
        aspects: ['no-marker', 'packages/o/r/promises/has-evidence'],
      });
    },
  });

  const r = run('land.mjs', [branch], dir);
  assert.equal(r.code, 1, said(r));
  const out = said(r);
  assert.match(out, /packages\/o\/r\/promises\/has-evidence \(conflict of interest\)/, out);
  assert.match(out, /yg-aspect\.adapt\.yaml/, 'the file that changed the rule is named');
  assert.match(out, /promises\/keeps-a\.md/, 'and so is the promise it reaches');
  assert.equal(git(['rev-list', '--count', '--merges', 'mission1/trunk'], dir), '0');
});

test('conflict guard: an adaptation that only raises an installed rule\'s status is not a change to what it says', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const declared = [...DECLARED, `${INSTALLED_HAS_EVIDENCE}/yg-aspect.adapt.yaml`];
  const { branch } = lawFixture(dir, '296', (dir2) => {
    write(dir2, `${INSTALLED_HAS_EVIDENCE}/yg-aspect.adapt.yaml`, '# raised once the promises are in\nstatus: enforced\n');
    write(dir2, 'src/a.mjs', 'export const a = 11;\n');
  }, {
    declared,
    extraBase: (dir2) => {
      installPromises(dir2);
      write(dir2, `${INSTALLED_HAS_EVIDENCE}/yg-aspect.adapt.yaml`, 'status: advisory\n');
      addNode(dir2, 'feature', {
        mapping: ['src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs'],
        aspects: ['no-marker', 'packages/o/r/promises/has-evidence'],
      });
    },
  });
  const r = run('land.mjs', [branch], dir);
  assert.doesNotMatch(said(r), /conflict of interest/, said(r));
});

test('conflict guard: a nested rule\'s helper file counts as its text; its drill corpus and its history do not', async (t) => {
  const nested = (dir2, extra = {}) => {
    addAspect(dir2, 'boundary/no-marker', {
      description: 'Source files must not carry an unfinished-work marker.',
      check: "import { MARK } from './mark.mjs';\n" + MARKER_CHECK.replace("'UNFINISHED'", 'MARK'),
      scope: WIDE_SCOPE,
    });
    write(dir2, '.yggdrasil/aspects/boundary/no-marker/mark.mjs', extra.mark || "export const MARK = 'UNFINISHED';\n");
    addNode(dir2, 'feature', {
      mapping: ['src/a.mjs', 'src/b.mjs', 'tests/feature.test.mjs'],
      aspects: ['no-marker', 'boundary/no-marker'],
    });
  };
  const declared = [...DECLARED,
    '.yggdrasil/aspects/boundary/no-marker/mark.mjs',
    '.yggdrasil/aspects/boundary/no-marker/log.md',
    '.yggdrasil/aspects/boundary/no-marker/drills/violates-marker/src/a.mjs'];

  await t.test('the helper the check imports changed beside the code it judges: refused', async () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = lawFixture(dir, '292', (dir2) => {
      write(dir2, '.yggdrasil/aspects/boundary/no-marker/mark.mjs', "export const MARK = 'TODO';\n");
      write(dir2, 'src/a.mjs', 'export const a = 11;\n');
    }, { declared, extraBase: (dir2) => nested(dir2) });
    const r = run('land.mjs', [branch], dir);
    assert.equal(r.code, 1, said(r));
    assert.match(said(r), /boundary\/no-marker \(conflict of interest\)/, said(r));
    assert.match(said(r), /mark\.mjs/);
  });

  await t.test('only its history and its drill corpus changed beside the code: not a conflict', async () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = lawFixture(dir, '293', (dir2) => {
      write(dir2, '.yggdrasil/aspects/boundary/no-marker/log.md', '## 2026-09-26\n\nWhy the rule reads the marker from a table.\n');
      write(dir2, '.yggdrasil/aspects/boundary/no-marker/drills/violates-marker/src/a.mjs', 'export const a = 1; // UNFINISHED\n');
      write(dir2, 'src/a.mjs', 'export const a = 11;\n');
    }, { declared, extraBase: (dir2) => nested(dir2) });
    const r = run('land.mjs', [branch], dir);
    assert.doesNotMatch(said(r), /conflict of interest/, said(r));
  });
});

test('protection guards: a pin written in an installed rule\'s adaptation decides the pairing; with none, the promise\'s own frontmatter does', async (t) => {
  await t.test('pinned `named` in yg-aspect.adapt.yaml: deleting the named evidence refuses as "pairing gone"', async () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = pinnedEvidenceFixture(dir, '294', 'named', { installed: true });
    const r = run('land.mjs', [branch], dir);
    assert.equal(r.code, 1, said(r));
    assert.match(said(r), asRegExp('evidence:named-target (pairing gone)'), said(r));
  });

  await t.test('no pin: the complete artefact block keeps the promise, and the same deletion is no weakening of it', async () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    const { branch } = pinnedEvidenceFixture(dir, '295', null, { installed: true });
    const r = run('land.mjs', [branch], dir);
    assert.doesNotMatch(said(r), /evidence:named-target \(pairing gone\)/, said(r));
  });
});
