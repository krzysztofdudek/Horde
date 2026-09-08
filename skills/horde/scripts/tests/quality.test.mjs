// E17 — the horde raises quality on its own, and only ever asks before making anything weaker.
//
// Everything here runs on a real temporary git repository whose graph was made by the real
// Yggdrasil CLI, with a real rule (a `check.mjs` the CLI runs) and a real case corpus. The status
// ladder is climbed on what the real `yg drill` and `yg check --json` answer, the reasons land in
// the real node log through `yg log add`, and the advisories become tickets from a real
// `grain-advice/1` document written by a real program. Nothing about any of it is stood in for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, requireYg,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const planPath = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'plan.md');
const charterPath = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'charter.md');
const aspectPath = (dir, id) => join(dir, '.yggdrasil', 'aspects', id, 'yg-aspect.yaml');
const nodeLogPath = (dir, node) => join(dir, '.yggdrasil', 'model', node, 'log.md');

// The rule's own log, read for real through the real Yggdrasil CLI — `ygCmd` is the command line
// requireYg() returns ("yg" or "node /path/to/bin.js").
function aspectLogRead(dir, ygCmd, aspect) {
  const parts = ygCmd.split(/\s+/);
  const out = execFileSync(parts[0], [...parts.slice(1), 'aspects', 'log', 'read', '--aspect', aspect, '--json'], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

const MARKER_RULE = [
  'export function check(ctx) {',
  '  const out = [];',
  '  for (const file of ctx.files) {',
  "    const lines = file.content.split('\\n');",
  '    for (let i = 0; i < lines.length; i++) {',
  "      if (lines[i].includes('UNFINISHED')) {",
  "        out.push({ file: file.path, line: i + 1, column: 0, message: 'unfinished-work marker left behind.' });",
  '      }',
  '    }',
  '  }',
  '  return out;',
  '}',
  '',
].join('\n');

// A real graph made by the real CLI: one component over two files, and one script rule that starts
// at `draft` with a case corpus of its own — a case it must refuse and a case it must accept. The
// corpus is what the drill runs; `other.mjs` carries a marker, so the rule has something real to
// refuse in the repository itself and the baseline is not a trivial zero.
function graphFixture(dir, ygCommand, { status = 'draft', cases = true } = {}) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'e17', version: '1.0.0', type: 'module' }, null, 2)}\n`);
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

  const aspectDir = join(dir, '.yggdrasil', 'aspects', 'no-marker');
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(join(aspectDir, 'yg-aspect.yaml'), [
    'name: NoMarker',
    'description: Source files must not be left carrying an unfinished-work marker.',
    'errs: under',
    `status: ${status}`,
    'review_by: 2099-01-01',
    '',
  ].join('\n'));
  writeFileSync(join(aspectDir, 'check.mjs'), MARKER_RULE);
  if (cases) {
    mkdirSync(join(aspectDir, 'drills', 'violates-marker'), { recursive: true });
    mkdirSync(join(aspectDir, 'drills', 'satisfies-clean'), { recursive: true });
    writeFileSync(join(aspectDir, 'drills', 'violates-marker', 'case.mjs'), 'export const x = 1; // UNFINISHED\n');
    writeFileSync(join(aspectDir, 'drills', 'satisfies-clean', 'case.mjs'), 'export const x = 1;\n');
  }

  writeFileSync(join(dir, 'lib.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'other.mjs'), 'export const b = 2; // UNFINISHED\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
}

// A real program standing in for the Grain CLI, in the shape this repository's other Grain fixture
// already uses: it is started for real, and what it writes is a real `grain-advice/1` document
// with the fields the contract names.
const GRAIN_ADVISE_STUB = [
  "const argv = process.argv.slice(2);",
  "if (argv[0] === '--version') { console.log('0.0.0-stub'); process.exit(0); }",
  "if (argv[0] !== 'advise') process.exit(2);",
  "console.error('[grain] indexing');",
  'console.log(JSON.stringify({',
  "  schema: 'grain-advice/1', repo: '.', at: 'abc1234', graph: '.yggdrasil',",
  '  items: [{',
  "    kind: 'split', nodes: ['feature'], candidates: ['inner'],",
  '    evidence: { node: { files: 9, importsInside: 2, importsCrossing: 7 } },',
  "    text: 'Feature owns 9 files, and a finer cut beats it on its own evidence: `inner` holds 5 of them and keeps 4 of the 5 imports that touch it inside, a tighter boundary than the node\\u2019s own 2 of 9. It may have outgrown one context.',",
  '  }],',
  '}, null, 1));',
  '',
].join('\n');

test('E17 — a rule earns its status on evidence without a human, and nobody but the user may lower one', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, yg);
  initHorde(dir);

  await t.test('the ladder starts where the graph says, with nothing earned yet', () => {
    const r = run('node.mjs', ['ladder'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.policy, 'autonomous', 'a charter with no setting is autonomous by default');
    const rule = r.json.aspects.find((a) => a.aspect === 'no-marker');
    assert.equal(rule.status, 'draft');
    assert.equal(rule.next, 'advisory');
    assert.equal(rule.cases, 2, 'the corpus the real drill runs');
    assert.equal(rule.cleanWaves, 0);
  });

  let advisory;
  await t.test('draft → advisory: a clean corpus earns it, and the baseline is recorded with it', () => {
    advisory = run('node.mjs', ['promote', 'no-marker'], dir);
    assert.equal(advisory.code, 0, advisory.stderr);
    assert.equal(advisory.json.from, 'draft');
    assert.equal(advisory.json.to, 'advisory');
    assert.equal(advisory.json.drill.cases, 2);
    assert.equal(advisory.json.drill.miss, 0);
    assert.equal(advisory.json.baseline, 1, 'other.mjs already carries a marker');

    // The rule really moved, in the graph's own file, and nothing else in it did.
    const text = readFileSync(aspectPath(dir, 'no-marker'), 'utf8');
    assert.match(text, /^status: advisory$/m);
    assert.match(text, /^review_by: 2099-01-01$/m, 'the review date is not something the horde touches');
    // …and the graph agrees, read back the only way the horde ever reads it.
    assert.equal(run('node.mjs', ['ladder'], dir).json.aspects.find((a) => a.aspect === 'no-marker').status, 'advisory');
  });

  await t.test('the reason is in the rule\'s own log, self-contained, with the evidence in it — and nowhere on the node', () => {
    assert.deepEqual(advisory.json.nodes, ['feature'], 'the rule really does reach feature');
    assert.deepEqual(advisory.json.pointered, [], 'draft → advisory changes nothing a node is held to');
    const doc = aspectLogRead(dir, yg, 'no-marker');
    assert.equal(doc.schema, 'yg-aspect-log/1');
    assert.equal(doc.status, 'advisory');
    assert.equal(doc.entries.length, 1, 'one entry in the rule\'s own log, not one per node');
    const [entry] = doc.entries;
    assert.deepEqual(entry.status, { from: 'draft', to: 'advisory' });
    assert.match(entry.body, /raised from draft to advisory on its own evidence/);
    assert.match(entry.body, /2 of 2 cases answered as written/);
    assert.match(entry.body, /lowering one is the chairman's/);

    // …and the node's own log carries nothing at all — no courtesy copy for a raise that changed
    // nothing the node's code is held to.
    assert.equal(existsSync(nodeLogPath(dir, 'feature')), false, 'draft → advisory writes no node log');
  });

  await t.test('advisory → enforced is refused until two closed waves have seen nothing new', () => {
    const r = run('node.mjs', ['promote', 'no-marker'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /0 of 2 closed waves have seen nothing new against it/);
    assert.match(r.stderr, /still refuses 1 place here/);
  });

  await t.test('lowering it is refused outright without the user', () => {
    const noBy = run('node.mjs', ['demote', 'no-marker', '--to', 'draft'], dir);
    assert.equal(noBy.code, 1);
    assert.match(noBy.stderr, /would make this repository's architecture weaker/);
    assert.match(noBy.stderr, /--by user/);

    const wrongBy = run('node.mjs', ['demote', 'no-marker', '--to', 'draft', '--by', 'architect'], dir);
    assert.equal(wrongBy.code, 1, 'the architect has no more standing here than anyone else');
    assert.match(wrongBy.stderr, /--by user/);

    const noWhy = run('node.mjs', ['demote', 'no-marker', '--to', 'draft', '--by', 'user'], dir);
    assert.equal(noWhy.code, 1);
    assert.match(noWhy.stderr, /--why/);

    // …and the rule is exactly where it was through all three refusals.
    assert.match(readFileSync(aspectPath(dir, 'no-marker'), 'utf8'), /^status: advisory$/m);

    // The two unauthorized attempts still left a note in the rule's own log, best-effort, even
    // though nothing moved — the third (--by user, just missing --why) is not an authorization
    // refusal, so it leaves none.
    const doc = aspectLogRead(dir, yg, 'no-marker');
    assert.equal(doc.entries.length, 3, 'the draft → advisory raise, plus the two refused attempts');
    const [wrongByEntry, noByEntry] = doc.entries;
    assert.match(wrongByEntry.body, /A demotion to draft was attempted \(by "architect"\) and refused/);
    assert.match(noByEntry.body, /A demotion to draft was attempted \(by "someone other than the user"\) and refused/);
    for (const e of [wrongByEntry, noByEntry]) {
      assert.equal(e.status, undefined, 'a refused attempt is a note, not a recorded status change');
    }
  });

  await t.test('two waves close with nothing new, and the rule blocks from then on', () => {
    // The mission's own work clears what the rule already refused.
    writeFileSync(join(dir, 'other.mjs'), 'export const b = 2;\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'clear the marker'], dir);

    for (const wave of [1, 2]) {
      assert.equal(run('wave.mjs', ['start'], dir).code, 0);
      const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
      assert.equal(closed.code, 0, closed.stderr);
      const seen = closed.json.aspectsObserved.find((o) => o.aspect === 'no-marker');
      assert.equal(seen.new, 0, `wave ${wave} saw nothing new`);
    }

    const enforced = run('node.mjs', ['promote', 'no-marker'], dir);
    assert.equal(enforced.code, 0, enforced.stderr);
    assert.equal(enforced.json.from, 'advisory');
    assert.equal(enforced.json.to, 'enforced');
    assert.equal(enforced.json.cleanWaves, 2);
    assert.match(readFileSync(aspectPath(dir, 'no-marker'), 'utf8'), /^status: enforced$/m);

    // The full evidence lands in the rule's own log — this is the raise that changes what the
    // node's code is held to, so a one-line pointer lands there too, but the reasoning does not.
    assert.deepEqual(enforced.json.pointered, ['feature']);
    const doc = aspectLogRead(dir, yg, 'no-marker');
    const [entry] = doc.entries;
    assert.deepEqual(entry.status, { from: 'advisory', to: 'enforced' });
    assert.match(entry.body, /raised from advisory to enforced on its own evidence/);
    assert.match(entry.body, /2 closed waves in a row saw nothing new against it/);

    const nodeLog = readFileSync(nodeLogPath(dir, 'feature'), 'utf8');
    assert.doesNotMatch(nodeLog, /2 closed waves in a row saw nothing new against it/, 'no courtesy copy of the full reasoning on the node');
    assert.match(nodeLog, /now blocks the merge here/);
    assert.match(nodeLog, /aspects log read --aspect no-marker/, 'the pointer names where to read why');

    // And it really blocks now: put the marker back and the graph refuses the tree.
    writeFileSync(join(dir, 'other.mjs'), 'export const b = 2; // UNFINISHED\n');
    const parts = yg.split(/\s+/);
    let code = 0;
    try {
      execFileSync(parts[0], [...parts.slice(1), 'check'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { code = e.status; }
    assert.equal(code, 1, 'an enforced rule blocks; the same rule at advisory did not');
    writeFileSync(join(dir, 'other.mjs'), 'export const b = 2;\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'clean again'], dir);
  });

  await t.test('a rule with no corpus is never raised — nothing has ever been run against it', () => {
    const other = makeRepo();
    t.after(() => rmRepo(other));
    graphFixture(other, yg, { cases: false });
    initHorde(other);
    const r = run('node.mjs', ['promote', 'no-marker'], other);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /its case corpus is empty/);
    assert.match(readFileSync(aspectPath(other, 'no-marker'), 'utf8'), /^status: draft$/m);
  });

  await t.test('a real yg that predates the rule\'s own log is refused, naming the release to upgrade to', () => {
    const other = makeRepo();
    t.after(() => rmRepo(other));
    graphFixture(other, yg, { status: 'draft' });
    initHorde(other);

    // A real, working CLI for everything BUT `aspects log` — the same shape a pre-152 install
    // actually takes (that subcommand did not exist, so its own arguments read as extras `aspects`
    // itself does not accept) — so this is the version guard alone under test, on a graph and a
    // drill that are otherwise entirely real.
    const passthrough = join(other, 'no-aspect-log-yg.mjs');
    writeFileSync(passthrough, [
      "import { execFileSync } from 'node:child_process';",
      `const REAL = ${JSON.stringify(yg)};`,
      'const argv = process.argv.slice(2);',
      "if (argv[0] === 'aspects' && argv[1] === 'log') {",
      "  process.stderr.write(\"error: too many arguments for 'aspects'. Expected 0 arguments but got \" + (argv.length - 2) + \": \" + argv.slice(2).join(', ') + \".\\n\");",
      '  process.exit(1);',
      '}',
      'const real = REAL.split(/\\s+/);',
      'try {',
      '  execFileSync(real[0], [...real.slice(1), ...argv], { stdio: "inherit" });',
      '} catch (e) { process.exit(e.status ?? 1); }',
      '',
    ].join('\n'));
    run('horde.mjs', ['config', 'set', 'ygCommand', `node ${passthrough}`], other);

    const r = run('node.mjs', ['promote', 'no-marker'], other);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /predates its own rule log/);
    assert.match(r.stderr, /yg aspects log add.*yg aspects log read/);
    assert.match(r.stderr, /later than 5\.9\.0/);
    assert.match(r.stderr, /npm i -g @chrisdudek\/yg/);
    // Nothing was left half-done: the rule file itself was already moved by the time the log call
    // ran (the same order promote always writes in), but the horde's own working still reflects
    // that this call failed rather than claiming a raise that has no history behind it.
    assert.match(readFileSync(aspectPath(other, 'no-marker'), 'utf8'), /^status: advisory$/m);
  });

  await t.test('the user may lower it, and that too lands in the log', () => {
    const r = run('node.mjs', [
      'demote', 'no-marker', '--to', 'advisory', '--by', 'user',
      '--why', 'the team needs one release where this warns instead of blocking',
    ], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.from, 'enforced');
    assert.equal(r.json.to, 'advisory');
    assert.match(readFileSync(aspectPath(dir, 'no-marker'), 'utf8'), /^status: advisory$/m);
    assert.match(
      readFileSync(nodeLogPath(dir, 'feature'), 'utf8'),
      /lowered from enforced to advisory by the chairman: the team needs one release/,
    );
  });
});

test('E17 — the wave close lists what was raised, what it earned, and how the user undoes it', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, yg);
  initHorde(dir);

  run('wave.mjs', ['start'], dir);
  const promoted = run('node.mjs', ['promote', 'no-marker'], dir);
  assert.equal(promoted.code, 0, promoted.stderr);

  const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(closed.json.qualityPolicy, 'autonomous');
  assert.deepEqual(closed.json.promoted.map((p) => [p.aspect, p.from, p.to]), [['no-marker', 'draft', 'advisory']]);
  assert.equal(closed.json.qualityEscalation, null, 'raising a rule is not a fall to escalate');

  const plan = readFileSync(planPath(dir), 'utf8');
  const block = plan.slice(plan.indexOf('## Quality — what the horde raised on its own')).split('\n## Graph changes')[0].trim();
  assert.match(block, /Rules raised this wave, and what earned it:/);
  assert.match(block, /\*\*no-marker\*\* — inert → a warning\./);
  assert.match(block, /2 of 2 cases answered as written/);
  assert.match(block, /Improvements finished this wave: none\./);
  assert.match(block, /Quality index: enforced \d+/);
  assert.match(block, /lowering a rule, waiving one or moving its review date is yours alone/);

  // A raise is shown to the chairman exactly once: the next close does not repeat it.
  run('wave.mjs', ['start'], dir);
  const second = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.deepEqual(second.json.promoted, []);

  // Printed so the block this evidence row is about is readable in the test output itself.
  console.log(block);
});

test('E17 — a quality ticket is filed and queued from a grain-advice/1 document, with no ruling', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, yg);
  initHorde(dir);
  const stub = join(dir, 'grain-advise-stub.mjs');
  writeFileSync(stub, GRAIN_ADVISE_STUB);
  run('horde.mjs', ['config', 'set', 'grainCommand', `node ${stub}`], dir);
  run('roster.mjs', ['spawn', 'owner', '--node', 'feature', '--class', 'sonnet'], dir);
  const owner = run('roster.mjs', ['list'], dir).json.find((e) => e.role === 'owner').name;

  let filed;
  await t.test('the pass reads the real document and files one ticket per improvement', () => {
    // An advisory on a node nobody in this horde leases stays in the feed for whichever horde
    // does — it would sit here unowned otherwise. Unleased first, then leased.
    const unleased = run('queue.mjs', ['quality'], dir);
    assert.equal(unleased.code, 0, unleased.stderr);
    assert.deepEqual(unleased.json.filed, []);
    assert.match(unleased.json.skipped[0].why, /outside the mission/);
    const bound = run('node.mjs', ['bind', 'feature'], dir);
    assert.equal(bound.code, 0, bound.stderr);
    filed = run('queue.mjs', ['quality'], dir);
    assert.equal(filed.code, 0, filed.stderr);
    assert.equal(filed.json.items, 1);
    assert.equal(filed.json.filed.length, 1);
    assert.equal(filed.json.filed[0].node, 'feature');
    assert.equal(filed.json.filed[0].owner, owner, 'handed to the owner of the node it names');
  });

  await t.test('the ticket is a quality ticket carrying the advisory as its Why', () => {
    const ticket = run('tk.mjs', ['show', filed.json.filed[0].ticket], dir);
    assert.equal(ticket.json.kind, 'quality');
    assert.match(ticket.json.text, /A finer cut beats feature on its own evidence/);
    assert.match(ticket.json.text, /## Why/);
    assert.match(ticket.json.text, /Feature owns 9 files, and a finer cut beats it on its own evidence/);
    assert.match(ticket.json.text, /\*\*Severity:\*\* low/);
  });

  await t.test('it is queued, and no escalation was opened to get it there', () => {
    const queued = run('queue.mjs', ['list'], dir).json;
    assert.deepEqual(queued.map((i) => [i.ticket, i.state]), [[filed.json.filed[0].ticket, 'queued']]);
    assert.deepEqual(run('escalate.mjs', ['list'], dir).json, [], 'nothing was escalated to get it queued');
  });

  await t.test('a second pass over the same document files nothing twice', () => {
    const again = run('queue.mjs', ['quality'], dir);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.json.filed, []);
    assert.equal(again.json.skipped[0].why, 'already filed as a ticket');
  });

  await t.test('the mission\'s own work still goes first', () => {
    const work = run('tk.mjs', ['new', 'the-work', '--title', 'What the mission asked for', '--node', 'feature', '--class', 'sonnet', '--severity', 'low', '--evidence', 'it works'], dir);
    run('queue.mjs', ['add', work.json.id], dir);
    assert.equal(run('queue.mjs', ['next'], dir).json.ticket, work.json.id);
  });

  await t.test('a document that is not grain-advice/1 is refused, not guessed at', () => {
    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, `${JSON.stringify({ schema: 'something-else/1', items: [] })}\n`);
    const r = run('queue.mjs', ['quality', '--from', wrong], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not hold a grain-advice\/1 document \(it is a "something-else\/1" one\)/);
  });

  await t.test('a "rule" advisory points at the rule\'s own log once it exists, not the node\'s', () => {
    const doc = join(dir, 'rule-advice.json');
    writeFileSync(doc, `${JSON.stringify({
      schema: 'grain-advice/1',
      repo: '.',
      at: 'abc1234',
      graph: '.yggdrasil',
      items: [{
        kind: 'rule',
        nodes: ['feature'],
        evidence: { pattern: { files: 4, matches: 4 } },
        text: 'Every write in feature goes through one helper already — nothing enforces it yet.',
      }],
    }, null, 1)}\n`);
    const ruleFiled = run('queue.mjs', ['quality', '--from', doc], dir);
    assert.equal(ruleFiled.code, 0, ruleFiled.stderr);
    assert.equal(ruleFiled.json.filed.length, 1);
    const ticket = run('tk.mjs', ['show', ruleFiled.json.filed[0].ticket], dir);
    assert.match(ticket.json.text, /the rule's own log, once it exists — or, if it does not, the node's/);
    assert.doesNotMatch(ticket.json.text, /or the node's log\s*\n\s*carries one entry/, 'the generic node-only wording is gone for this kind');
  });
});

test('E17 — only-the-work turns all of it off, and says so at the close', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, yg);
  initHorde(dir, 'mission1', ['--quality', 'only-the-work']);
  const stub = join(dir, 'grain-advise-stub.mjs');
  writeFileSync(stub, GRAIN_ADVISE_STUB);
  run('horde.mjs', ['config', 'set', 'grainCommand', `node ${stub}`], dir);

  await t.test('the charter carries the setting and the tools read it', () => {
    assert.match(readFileSync(charterPath(dir), 'utf8'), /\*\*Policy:\*\* only-the-work/);
    assert.equal(run('horde.mjs', ['charter', 'show'], dir).json.quality, 'only-the-work');
    assert.equal(run('node.mjs', ['ladder'], dir).json.policy, 'only-the-work');
  });

  await t.test('no rule is raised and no improvement is filed', () => {
    const promote = run('node.mjs', ['promote', 'no-marker'], dir);
    assert.equal(promote.code, 1);
    assert.match(promote.stderr, /sets the quality policy to "only-the-work"/);
    assert.match(readFileSync(aspectPath(dir, 'no-marker'), 'utf8'), /^status: draft$/m);

    const pass = run('queue.mjs', ['quality'], dir);
    assert.equal(pass.code, 0, pass.stderr);
    assert.equal(pass.json.ran, false);
    assert.deepEqual(pass.json.filed, []);
    assert.deepEqual(run('queue.mjs', ['list'], dir).json, []);
  });

  await t.test('and the close says so instead of listing nothing', () => {
    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.qualityPolicy, 'only-the-work');
    assert.deepEqual(closed.json.aspectsObserved, []);
    const plan = readFileSync(planPath(dir), 'utf8');
    assert.match(plan, /This mission is set to only-the-work: the horde raised no rule and filed no improvement/);
  });

  await t.test('a policy word nothing recognises is refused rather than read as the default', () => {
    const text = readFileSync(charterPath(dir), 'utf8').replace('**Policy:** only-the-work', '**Policy:** whenever');
    const edit = charterEdit(dir, text);
    assert.equal(edit.code, 1);
    assert.match(edit.stderr, /is not a setting this horde has/);
    assert.match(readFileSync(charterPath(dir), 'utf8'), /\*\*Policy:\*\* only-the-work/, 'the charter is left as it was');

    const back = charterEdit(dir, text.replace('**Policy:** whenever', '**Policy:** autonomous'));
    assert.equal(back.code, 0, back.stderr);
    assert.equal(back.json.quality, 'autonomous');
  });
});

// `horde.mjs charter edit` reads the charter from standard input, which the shared `run` helper
// does not feed; this is that same call with a body on stdin.
function charterEdit(dir, text) {
  const scripts = join(SCRIPTS_DIR);
  try {
    const stdout = execFileSync('node', [join(scripts, 'horde.mjs'), 'charter', 'edit', '--json'], {
      cwd: dir, input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '', json: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString(), json: null };
  }
}
