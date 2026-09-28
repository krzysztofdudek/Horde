// The architect measures with Grain (issue 448). Grain is required, like Yggdrasil: the cut is
// scored against the seams the repository's own history shows (`grain cochange --partition`,
// grain-cochange/1), the legislator starts from the rules Grain drafts (`grain advise --json`, the
// `rule` items of grain-advice/1), and the client's report measures the mission's territory before
// and after (`grain measure`, grain-measure/1).
//
// The readings are taken by the real Grain over a real repository with real history wherever the
// answer depends on the numbers. A stand-in program answers only where the test is about how Horde
// reads a document Grain would not write on so small a repository (a rule draft), or one written in
// a version Horde does not know — each started for real, never an import standing in for a CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, addNode, git, yg,
} from './helpers.mjs';

function writeFile(dir, rel, text) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

function hordeFile(dir, name) {
  return join(dir, '.horde', 'hordes', 'm1', name);
}

function writeTerritories(dir, doc) {
  writeFileSync(hordeFile(dir, 'territories.json'), `${JSON.stringify(doc, null, 2)}\n`);
}

// Three components and a history with one seam in it: `alpha` and `beta` change together in ten
// commits, `gamma` changes alone in four. A cut that keeps alpha and beta together follows that
// seam; a cut that parts them crosses it.
function seamRepo() {
  const dir = makeRepo();
  yg(dir, ['init']);
  addNode(dir, 'alpha', { description: 'The first half of one change.', mapping: ['src/alpha/**'] });
  addNode(dir, 'beta', { description: 'The second half of the same change.', mapping: ['src/beta/**'] });
  addNode(dir, 'gamma', { description: 'Something that moves on its own.', mapping: ['src/gamma/**'] });
  writeFile(dir, 'src/alpha/a.mjs', 'export const a = 0;\n');
  writeFile(dir, 'src/beta/b.mjs', "import { a } from '../alpha/a.mjs';\nexport const b = a;\n");
  writeFile(dir, 'src/gamma/c.mjs', 'export const c = 0;\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  for (let i = 1; i <= 10; i++) {
    writeFile(dir, 'src/alpha/a.mjs', `export const a = ${i};\n`);
    writeFile(dir, 'src/beta/b.mjs', `import { a } from '../alpha/a.mjs';\nexport const b = a + ${i};\n`);
    git(['add', '-A'], dir);
    git(['commit', '-qm', `alpha and beta, together ${i}`], dir);
  }
  for (let i = 1; i <= 4; i++) {
    writeFile(dir, 'src/gamma/c.mjs', `export const c = ${i};\n`);
    git(['add', '-A'], dir);
    git(['commit', '-qm', `gamma alone ${i}`], dir);
  }
  git(['branch', '-f', 'develop', 'HEAD'], dir);
  initHorde(dir, 'm1');
  return dir;
}

// A program in Grain's place that answers `version` as a 6.1.0 Grain does, and every other command
// with what `answers` holds for it (a JSON document on stdout), or exits 2.
function grainStub(dir, answers) {
  const path = join(dir, 'grain-stub.mjs');
  writeFileSync(path, [
    'const argv = process.argv.slice(2);',
    "if (argv[0] === 'version') { console.log('grain 6.1.0 · stub'); process.exit(0); }",
    `const answers = ${JSON.stringify(answers)};`,
    'if (!(argv[0] in answers)) { console.error(`stub: no answer for ${argv[0]}`); process.exit(2); }',
    "console.error('[grain] indexing');",
    'console.log(JSON.stringify(answers[argv[0]]));',
    '',
  ].join('\n'));
  return `node ${path}`;
}

const FOLLOWS = {
  'with the seam': { nodes: ['alpha', 'beta'], class: 'standard', why: 'One change, two halves.' },
  'on its own': { nodes: ['gamma'], class: 'light', why: 'It moves alone.' },
};

const CROSSES = {
  first: { nodes: ['alpha'], class: 'standard', why: 'Half of it.' },
  rest: { nodes: ['beta', 'gamma'], class: 'light', why: 'The rest of it.' },
};

test('the cut: Grain is required, and one that does not run stops it before a brief or a lease', async (t) => {
  const dir = seamRepo();
  t.after(() => rmRepo(dir));
  assert.equal(run('horde.mjs', ['config', 'set', 'grainCommand', `node ${join(dir, 'no-such-grain.mjs')}`], dir).code, 0);

  const asked = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
  assert.equal(asked.code, 1);
  assert.match(asked.stderr, /The cut needs Grain 6\.1\.0 or newer/);
  assert.match(asked.stderr, /git clone https:\/\/github\.com\/krzysztofdudek\/Grain/);

  writeTerritories(dir, FOLLOWS);
  const answered = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
  assert.equal(answered.code, 1);
  assert.match(answered.stderr, /The cut needs Grain/);
  assert.equal(existsSync(join(dir, '.horde', 'leases.json')), false, 'nothing was leased');
  assert.equal(existsSync(hordeFile(dir, 'cut-score.json')), false);
});

test('the cut is scored by the real Grain against the history, and the score reaches the plan\'s review', async (t) => {
  const dir = seamRepo();
  t.after(() => rmRepo(dir));

  await t.test('the brief tells the architect to cut along the seams, with the command that weighs a cut', () => {
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, /\*\*It follows the seams\.\*\*/);
    assert.match(r.json.brief, /cochange --nodes <component>,<component> --level node --json/);
    assert.match(r.json.brief, /cochange --partition '\{"<territory>": \["<component>", …\], …\}' --level node/);
  });

  let follows;
  await t.test('a cut along the seam keeps every commit but the first inside one territory, and random cuts do worse', () => {
    writeTerritories(dir, FOLLOWS);
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    follows = r.json.score;
    assert.equal(follows.scored, true, JSON.stringify(follows));
    assert.equal(follows.territories, 2);
    // The one commit that crosses is the first, which wrote all three components at once.
    assert.equal(follows.commits.crossing, 1);
    assert.equal(follows.commits.inside + follows.commits.crossing, follows.commits.total);
    assert.ok(follows.commits.total >= 15, `commits counted: ${follows.commits.total}`);
    assert.deepEqual(follows.crossing, []);
    assert.ok(follows.control.cuts >= 10, JSON.stringify(follows.control));
    assert.ok(follows.commits.share > follows.control.commitShareMean, JSON.stringify(follows));
    assert.deepEqual(JSON.parse(readFileSync(hordeFile(dir, 'cut-score.json'), 'utf8')), follows);
  });

  await t.test('a cut across the seam is accepted all the same, and the score names the seam it crosses', () => {
    writeTerritories(dir, CROSSES);
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir, { json: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /cut accepted: 2 territories/);
    assert.match(r.stdout, /how the cut follows this repository's history \(Grain, advice only\):/);
    const score = JSON.parse(readFileSync(hordeFile(dir, 'cut-score.json'), 'utf8'));
    assert.equal(score.scored, true);
    assert.ok(score.commits.crossing >= 10, `commits crossing: ${score.commits.crossing}`);
    assert.ok(score.commits.share < follows.commits.share);
    assert.ok(score.imports.crossing >= 1, 'beta imports alpha across the cut');
    assert.ok(score.crossing.some((c) => [c.a, c.b].sort().join(' ') === 'alpha beta' && c.together >= 10), JSON.stringify(score.crossing));
    assert.match(r.stdout, /across: (alpha \(first\) and beta \(rest\)|beta \(rest\) and alpha \(first\)) changed together in \d+ commits/);
    assert.match(r.stdout, new RegExp(`commits: ${score.commits.inside} of ${score.commits.total} that touched these territories stayed inside one`));
    assert.match(r.stdout, /advice: /);
  });

  await t.test('the plan\'s review brief carries the score, with its denominators', () => {
    const r = run('refine.mjs', ['--step', 'review', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.brief, /## How the cut follows this repository's history/);
    assert.match(r.json.brief, /- commits: \d+ of \d+ that touched these territories stayed inside one/);
    assert.match(r.json.brief, /- imports: \d+ of \d+ between these territories' files stay inside one/);
  });
});

test('the cut stands whatever Grain answers: one territory, or a document of another version, is not scored and says why', async (t) => {
  const dir = seamRepo();
  t.after(() => rmRepo(dir));

  await t.test('one territory has no seam to score', () => {
    writeTerritories(dir, { all: { nodes: ['alpha', 'beta', 'gamma'], class: 'standard', why: 'All of it.' } });
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.score.scored, false);
    assert.match(r.json.score.why, /one territory/);
  });

  await t.test('a grain-cochange/2 is not read around, and names the release to install', () => {
    const stub = grainStub(dir, { cochange: { schema: 'grain-cochange/2', partition: {} } });
    assert.equal(run('horde.mjs', ['config', 'set', 'grainCommand', stub], dir).code, 0);
    writeTerritories(dir, FOLLOWS);
    const r = run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'accepted');
    assert.equal(r.json.score.scored, false);
    assert.match(r.json.score.why, /answered `grain-cochange\/2`, not `grain-cochange\/1`/);
    assert.match(r.json.score.why, /install the Grain release this Horde ships with/);
  });
});

test('the client report: the mission\'s territory measured before and after by the real Grain', async (t) => {
  const dir = seamRepo();
  t.after(() => rmRepo(dir));

  await t.test('with no cut there is no territory, and the page says so in plain words', () => {
    const r = run('report.mjs', ['--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.measure.measured, false);
    assert.match(r.json.measure.why, /no cut yet/);
    assert.match(readFileSync(hordeFile(dir, 'report.md'), 'utf8'), /## What the work did to its part of the code\n\nNot measured: the mission has no cut yet/);
  });

  await t.test('with a cut and nothing landed, there is no after yet', () => {
    writeTerritories(dir, FOLLOWS);
    assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);
    const r = run('report.mjs', ['--horde', 'm1'], dir);
    assert.equal(r.json.measure.measured, false);
    assert.match(r.json.measure.why, /nothing has landed yet/);
  });

  let measured;
  await t.test('once the trunk moves, the territory is measured at the start and at the tip', () => {
    // The trunk moved the way a landing moves it: a commit on the mission's trunk branch. This one
    // adds a file to alpha and makes gamma import it.
    git(['checkout', '-q', 'm1/trunk'], dir);
    writeFile(dir, 'src/alpha/extra.mjs', 'export const extra = 1;\n');
    writeFile(dir, 'src/gamma/c.mjs', "import { extra } from '../alpha/extra.mjs';\nexport const c = extra;\n");
    git(['add', 'src'], dir);
    git(['commit', '-qm', 'the mission\'s work'], dir);
    const tip = git(['rev-parse', 'HEAD'], dir);
    git(['checkout', '-q', '-'], dir);
    const start = JSON.parse(readFileSync(hordeFile(dir, 'start.json'), 'utf8')).sha;

    const r = run('report.mjs', ['--horde', 'm1'], dir);
    assert.equal(r.code, 0, r.stderr);
    measured = r.json.measure;
    assert.equal(measured.measured, true, JSON.stringify(measured));
    assert.equal(measured.from, start);
    assert.equal(measured.to, tip);
    assert.deepEqual(measured.scope, ['alpha', 'beta', 'gamma']);
    assert.equal(measured.before.files, 3);
    assert.equal(measured.after.files, 4);
    assert.ok(measured.after.importsInside > measured.before.importsInside, JSON.stringify(measured));
    assert.equal(measured.range.commits, 1);
    assert.ok(measured.range.baseline, 'the territory\'s own commits just before the mission are the control');

    const page = readFileSync(hordeFile(dir, 'report.md'), 'utf8');
    assert.match(page, /- Files: 3 → 4\./);
    assert.match(page, /- Changes this mission made here that also touched something outside: 0 of 1 \(0%\); before the mission, \d+ of \d+/);
    assert.doesNotMatch(page, /grain|Grain|cochange|measure --/, 'the client\'s page names no tool');

    // Grain ran in the trunk tree and kept its store there, and the trunk tree shows nothing for it.
    const trunkTree = join(dir, '.horde', 'worktrees', 'm1', 'trunk');
    assert.ok(existsSync(join(trunkTree, '.grain', 'cache')), 'Grain\'s store is in the trunk tree');
    assert.equal(git(['status', '--porcelain'], trunkTree), '', 'and the trunk tree\'s status is clean');
  });

  await t.test('a report that does not measure carries the last reading, as it was', () => {
    const r = run('report.mjs', ['--horde', 'm1', '--no-measure'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.measure, measured);
  });
});

test('the legislator starts from the rules Grain drafts for its territory, and from nobody else\'s', async (t) => {
  const dir = seamRepo();
  t.after(() => rmRepo(dir));
  const advice = {
    schema: 'grain-advice/1',
    repo: '.',
    at: 'abc1234',
    graph: '.yggdrasil',
    items: [
      {
        kind: 'rule',
        nodes: ['alpha'],
        confidence: 0.9,
        text: 'every module under alpha exports one const named after its file',
        evidence: {
          origin: 'convention',
          rule: 'nameshape||const|module',
          aspect: 'grain/alpha/const-per-file',
          name: 'One const per file, named after it',
          conforming: 9,
          deviating: 1,
          draft: {
            form: 'aspect',
            attachTo: 'alpha',
            aspect: 'grain/alpha/const-per-file',
            yaml: 'name: One const per file\nstatus: draft\n',
            check: 'export function check(ctx) { return []; }\n',
          },
        },
      },
      {
        kind: 'rule',
        nodes: ['gamma'],
        text: 'something about gamma',
        evidence: {
          origin: 'convention', rule: 'other||x|module', aspect: 'grain/gamma/other', name: 'A gamma habit', conforming: 3, deviating: 0,
        },
      },
      {
        kind: 'rule',
        nodes: ['beta'],
        text: 'beta never imports gamma',
        evidence: {
          origin: 'boundary', decision: 'd1', from: 'src/beta', neverImports: 'src/gamma', decidedBy: 'maintainer', decidedAt: '2026-09-01', violations: 0,
          draft: { form: 'architecture-relations', deny: [{ type: 'module', mustNotReach: 'module' }] },
        },
      },
      {
        // One rule Grain finds in two components, the strongest another territory's: only the draft that
        // attaches to this territory's own component is its to write.
        kind: 'rule',
        nodes: ['gamma', 'alpha'],
        text: 'every module logs on entry',
        evidence: {
          origin: 'convention',
          rule: 'call|log|true|method',
          aspect: 'grain/gamma/logs-on-entry',
          name: 'Every module logs on entry',
          conforming: 12,
          deviating: 0,
          draft: {
            form: 'aspect', attachTo: 'gamma', aspect: 'grain/gamma/logs-on-entry', conforming: 8, deviating: 0,
            yaml: 'name: gamma logs on entry\nstatus: draft\n', check: 'export function gammaCheck() { return []; }\n',
          },
          alsoIn: [{
            form: 'aspect', attachTo: 'alpha', aspect: 'grain/alpha/logs-on-entry', conforming: 4, deviating: 0,
            yaml: 'name: alpha logs on entry\nstatus: draft\n', check: 'export function alphaCheck() { return []; }\n',
          }],
        },
      },
      { kind: 'split', nodes: ['alpha'], text: 'a finer cut', evidence: {} },
    ],
  };
  writeTerritories(dir, FOLLOWS);
  // The cut first, with the real Grain; then Grain's place taken by a program answering this advice.
  assert.equal(run('refine.mjs', ['--step', 'cut', '--horde', 'm1'], dir).code, 0);
  assert.equal(run('horde.mjs', ['config', 'set', 'grainCommand', grainStub(dir, { advise: advice })], dir).code, 0);

  const r = run('brief.mjs', ['legislate', 'with the seam', '--name', 'm1-legislate-1', '--horde', 'm1'], dir);
  assert.equal(r.code, 0, r.stderr);
  const brief = r.json.brief;
  assert.doesNotMatch(brief, /\{\{/);
  assert.match(brief, /### Rules this territory's code already keeps/);
  assert.match(brief, /\*\*One const per file, named after it\*\* \(`grain\/alpha\/const-per-file` on `alpha`\) — followed at 9 of 10 site\(s\) \(90%\)/);
  assert.match(brief, /name: One const per file/);
  assert.match(brief, /export function check\(ctx\)/);
  assert.match(brief, /\*\*src\/beta never imports src\/gamma\*\* — a maintainer's decision \(maintainer, 2026-09-01\)/);
  assert.doesNotMatch(brief, /A gamma habit/, 'a draft for another territory\'s component is that territory\'s');
  assert.doesNotMatch(brief, /a finer cut/, 'only rule drafts reach the legislator');
  assert.match(brief, /\*\*Every module logs on entry\*\* \(`grain\/alpha\/logs-on-entry` on `alpha`\) — followed at 4 of 4 site\(s\) \(100%\); holds in alpha\./);
  assert.match(brief, /name: alpha logs on entry/);
  assert.doesNotMatch(brief, /gamma logs on entry|gammaCheck|grain\/gamma\/logs-on-entry/, 'the draft for another territory\'s component is not this one\'s to write');
  assert.match(brief, /enters this pass no higher than\s+\*\*advisory\*\*/);

  // A draft the quality pass already filed says which ticket it answers.
  const filed = run('queue.mjs', ['quality', '--all', '--horde', 'm1'], dir);
  assert.equal(filed.code, 0, filed.stderr);
  const ticket = filed.json.filed.find((f) => f.node === 'alpha' && f.kind === 'rule').ticket;
  const again = run('brief.mjs', ['legislate', 'with the seam', '--name', 'm1-legislate-2', '--horde', 'm1'], dir);
  assert.match(again.json.brief, new RegExp(`already filed it as ticket ${ticket}; writing it here answers that ticket`));

  // A Grain that does not answer leaves the section saying so, and the brief still renders.
  assert.equal(run('horde.mjs', ['config', 'set', 'grainCommand', grainStub(dir, {})], dir).code, 0);
  const broken = run('brief.mjs', ['legislate', 'with the seam', '--name', 'm1-legislate-3', '--horde', 'm1'], dir);
  assert.equal(broken.code, 0, broken.stderr);
  assert.match(broken.json.brief, /### Rules this territory's code already keeps\n\n\(not read — `node .*grain-stub\.mjs advise --json.*` did not run \(exit 2\)/);
});
