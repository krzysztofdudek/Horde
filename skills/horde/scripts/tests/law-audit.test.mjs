// The law audit at a wave close — nobody in this family guards the law from a seat of its own, so
// closing a wave does it.
//
// Everything below runs on a real temporary git repository whose graph was made by the real
// Yggdrasil CLI. The overdue review date is a real `review_by` in a real rule file; the attention
// items are whatever the real `yg advise --json` actually nominates about that graph (an uncovered
// hot spot, an overdue review date) rather than a document written here to be convenient; the
// decision that hides one is the real `yg advise dismiss --reason`; the Grain document comes out of
// a real program started for real. The only thing stood in for anywhere is `yg aspects --health`'s
// signal telemetry, which a fixture cannot produce without a verdict history — and there the stub
// is a passthrough to the real CLI for every other question, printing the real table shape with
// Yggdrasil's own words in it, so what is under test is Horde reading that label rather than
// coining one of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde, requireYg,
} from './helpers.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const planPath = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'plan.md');
const aspectPath = (dir, id) => join(dir, '.yggdrasil', 'aspects', id, 'yg-aspect.yaml');
const queuePath = (dir, horde = 'mission1') => join(dir, '.horde', 'hordes', horde, 'teams', 'trunk', 'queue.json');

function write(dir, rel, text) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

// The section the close appends, read back out of the journal it was appended to.
function auditSection(dir, horde = 'mission1') {
  const plan = readFileSync(planPath(dir, horde), 'utf8');
  const from = plan.lastIndexOf('## Law audit — what nobody was asked to check');
  assert.notEqual(from, -1, 'the wave close wrote no law-audit section');
  const rest = plan.slice(from);
  const next = rest.indexOf('\n## Graph changes');
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

// A real graph made by the real CLI: one component with a rule over it, one component with no rule
// at all (which the real feed nominates as an uncovered hot spot the moment a commit touches it),
// and the rule's review date, which is what the first sweep is about.
function graphFixture(dir, ygCommand, { reviewBy = '2020-01-01', hotSpot = true } = {}) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'law-audit', version: '1.0.0', type: 'module' }, null, 2)}\n`);
  const parts = ygCommand.split(/\s+/);
  execFileSync(parts[0], [...parts.slice(1), 'init', '--no-reviewer'], { cwd: dir, stdio: 'ignore' });

  write(dir, '.yggdrasil/model/feature/yg-node.yaml', [
    'name: Feature',
    'type: module',
    'description: The one component this fixture mission works on.',
    'aspects:',
    '  - no-marker',
    'mapping:',
    '  - lib.mjs',
    'relations: []',
    '',
  ].join('\n'));
  write(dir, '.yggdrasil/aspects/no-marker/yg-aspect.yaml', [
    'name: NoMarker',
    'description: Source files must not be left carrying an unfinished-work marker.',
    'errs: under',
    'status: enforced',
    `review_by: ${reviewBy}`,
    '',
  ].join('\n'));
  write(dir, '.yggdrasil/aspects/no-marker/check.mjs', 'export function check() { return []; }\n');
  write(dir, 'lib.mjs', 'export const a = 1;\n');

  if (hotSpot) {
    write(dir, '.yggdrasil/model/billing/yg-node.yaml', [
      'name: Billing',
      'type: module',
      'description: Taking the money, and nothing else about it.',
      'mapping:',
      '  - billing.mjs',
      'relations: []',
      '',
    ].join('\n'));
    write(dir, 'billing.mjs', 'export const price = 1;\n');
  }

  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the graph and the code it governs'], dir);
  git(['branch', '-f', 'develop', 'HEAD'], dir);
}

function ygRaw(dir, ygCommand, args) {
  const parts = ygCommand.split(/\s+/);
  try {
    return { code: 0, out: execFileSync(parts[0], [...parts.slice(1), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${(e.stdout || '').toString()}${(e.stderr || '').toString()}` };
  }
}

// A passthrough to the real CLI that answers ONE question differently — the shape quality.test.mjs
// already uses for the pre-152 `aspects log` guard. `intercept` is the argv prefix to catch and the
// body to run instead; everything else reaches the real Yggdrasil unchanged, so the graph under
// test is real in every other respect.
function passthroughYg(dir, realYg, name, matchJs, bodyJs) {
  const path = join(dir, name);
  writeFileSync(path, [
    "import { execFileSync } from 'node:child_process';",
    `const REAL = ${JSON.stringify(realYg)};`,
    'const argv = process.argv.slice(2);',
    `if (${matchJs}) {`,
    bodyJs,
    '}',
    'const real = REAL.split(/\\s+/);',
    'try {',
    '  execFileSync(real[0], [...real.slice(1), ...argv], { stdio: "inherit" });',
    '} catch (e) { process.exit(e.status ?? 1); }',
    '',
  ].join('\n'));
  return `node ${path}`;
}

// The real table `yg aspects --health` prints, with the one row a fixture cannot earn: a rule with
// recorded exposure and zero catches. Both the `decorative?` cell and the plain-words line under
// the table are copied verbatim from Yggdrasil's own renderer (cli/aspects.ts's HEALTH_HEADERS and
// core/aspect-health-signals.ts's covenantLine) — the point of the test is that Horde repeats
// Yggdrasil's reading, so inventing a nicer sentence here would test nothing.
const HEALTH_WITH_A_QUIET_RULE = [
  'aspect     kind           status    nodes  pairs  refused  suppresses  errs   age  catch  exposure  signal       fp  wrong-rule  files',
  'no-marker  deterministic  enforced  1      1      0        0           under  <1d  0      40        decorative?  —   —           0',
  '',
  'Signal detail (catch = violations caught; exposure = times the reviewer judged):',
  '  no-marker: enforceable but never violated — may be deterring violations (0 of 40 recorded checks; estimated catch rate ~2%).',
  '',
].join('\\n');

test('the law audit: an overdue review date becomes a ticket that ends in a proposal, never in an edit to the date', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, yg);
  initHorde(dir);
  assert.equal(run('node.mjs', ['bind', 'feature'], dir).code, 0);

  let closed;
  await t.test('closing a wave sweeps the review dates and files one ticket on the rule\'s own component', () => {
    assert.equal(run('wave.mjs', ['start'], dir).code, 0);
    closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);

    const sweep = closed.json.audit.reviewDates;
    assert.equal(sweep.overdue, 1);
    assert.equal(sweep.filed.length, 1);
    assert.equal(sweep.filed[0].aspect, 'no-marker');
    assert.equal(sweep.filed[0].reviewBy, '2020-01-01');
    assert.equal(sweep.filed[0].node, 'feature');
  });

  await t.test('the ticket says renew or retire, and its acceptance is a g- proposal — not a new date', () => {
    const ticket = run('tk.mjs', ['show', closed.json.audit.reviewDates.filed[0].ticket], dir);
    assert.equal(ticket.code, 0, ticket.stderr);
    assert.equal(ticket.json.kind, 'quality');
    assert.match(ticket.json.text, /Renew or retire the rule `no-marker`/);
    assert.match(ticket.json.text, /review date \(2020-01-01\) has passed/);
    assert.match(ticket.json.text, /this ends in a `g-` proposal/);
    assert.match(ticket.json.text, /`node\.mjs propose rule/);
    assert.match(ticket.json.text, /`review_by` in the rule's own file is UNCHANGED by this ticket/);
    assert.match(ticket.json.text, /marking its own homework/);
    // A rule nothing has ever been said about says so, rather than quoting an empty history.
    assert.match(ticket.json.text, /\(nothing has ever been recorded about this rule\)/);
  });

  await t.test('nothing touched the date itself — that is the client\'s to move, and only theirs', () => {
    assert.match(readFileSync(aspectPath(dir, 'no-marker'), 'utf8'), /^review_by: 2020-01-01$/m);
  });

  await t.test('the ticket is queued, and the wave report names it with its territory or its component', () => {
    const queued = JSON.parse(readFileSync(queuePath(dir), 'utf8')).items;
    assert.ok(queued.some((i) => i.ticket === closed.json.audit.reviewDates.filed[0].ticket && i.state === 'queued'));
    const block = auditSection(dir);
    assert.match(block, /Review dates: 1 rule\(s\) past the date somebody set to look at them again\./);
    assert.match(block, /\*\*no-marker\*\* — due 2020-01-01, ticket \d+ on feature/);
    assert.match(block, /the date itself is the client's to move/);
  });

  await t.test('a second close files it again for nobody — the sweep remembers what it raised', () => {
    assert.equal(run('wave.mjs', ['start'], dir).code, 0);
    const again = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.audit.reviewDates.overdue, 1, 'the rule is still overdue — it has not been answered');
    assert.deepEqual(again.json.audit.reviewDates.filed, []);
    assert.equal(again.json.audit.reviewDates.skipped[0].why, 'already filed as a ticket');
  });
});

test('the law audit: a rule inside its own review date is not a finding', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, yg, { reviewBy: '2099-01-01', hotSpot: false });
  initHorde(dir);
  assert.equal(run('node.mjs', ['bind', 'feature'], dir).code, 0);

  run('wave.mjs', ['start'], dir);
  const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(closed.json.audit.reviewDates.overdue, 0);
  assert.deepEqual(closed.json.audit.reviewDates.filed, []);
  assert.match(auditSection(dir), /Review dates: every rule on the trunk is inside its own review date\./);
});

test('the law audit: an attention item nobody has answered is queued; one the client has decided on is left alone', async (t) => {
  const yg = requireYg();

  await t.test('undecided: the real feed nominates it, and the close puts it on the queue in Yggdrasil\'s own words', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg);
    initHorde(dir);
    assert.equal(run('node.mjs', ['bind', 'feature'], dir).code, 0);
    assert.equal(run('node.mjs', ['bind', 'billing'], dir).code, 0);

    // What the real CLI actually says about this graph, read here so the test is pinned to the
    // feed rather than to a document written to suit it.
    const feed = JSON.parse(ygRaw(dir, yg, ['advise', '--json']).out);
    assert.ok(feed.items.some((i) => i.id === 'uncovered-hot-spot:billing'), `the feed nominated ${feed.items.map((i) => i.id).join(', ')}`);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    const sweep = closed.json.audit.advise;
    assert.equal(sweep.read, true);
    assert.equal(sweep.decided, 0);
    assert.equal(sweep.filed.length, 1);
    assert.equal(sweep.filed[0].item, 'uncovered-hot-spot:billing');
    assert.equal(sweep.filed[0].node, 'billing');

    const ticket = run('tk.mjs', ['show', sweep.filed[0].ticket], dir);
    assert.match(ticket.json.text, /Node 'billing' is changing but has no rule covering it/);
    assert.match(ticket.json.text, /an uncovered hot spot/, 'Yggdrasil\'s own why, carried verbatim');
    assert.match(ticket.json.text, /Attention item id: `uncovered-hot-spot:billing`/);
    assert.match(ticket.json.text, /reason is a signature, so it is theirs to give, not the horde's/);

    // The overdue review date is raised by the feed too, and is not filed twice under two ids.
    assert.ok(sweep.skipped.some((s) => s.key === 'advise:overdue-review-by:no-marker' && /review-date sweep/.test(s.why)));
    assert.equal(JSON.parse(readFileSync(queuePath(dir), 'utf8')).items.length, 2, 'the review date and the hot spot, once each');
  });

  await t.test('decided: a dismissal signed with a reason hides it, and the close never re-raises it', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg);

    // The client's answer, recorded through the real command — a dismissal takes a mandatory
    // human-signed reason, which is exactly what makes it a decision rather than a preference.
    const dismissed = ygRaw(dir, yg, ['advise', 'dismiss', 'uncovered-hot-spot:billing', '--reason', 'billing is a spike we delete next month; a rule on it would outlive the code']);
    assert.equal(dismissed.code, 0, dismissed.out);
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'the client decided about the hot spot'], dir);
    git(['branch', '-f', 'develop', 'HEAD'], dir);

    initHorde(dir);
    assert.equal(run('node.mjs', ['bind', 'billing'], dir).code, 0);
    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    const sweep = closed.json.audit.advise;
    assert.equal(sweep.decided, 1, 'the feed hands the decided item back in its own suppressed list');
    assert.deepEqual(sweep.filed, [], 'nothing is filed from an item somebody signed a reason about');
    assert.equal(JSON.parse(readFileSync(queuePath(dir), 'utf8')).items.length, 0);
    assert.match(auditSection(dir), /1 already decided on and left alone/);
  });
});

test('the law audit: the Grain sweep reads the leased territories, down the same path the quality pass walks', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  // Every rule inside its own review date and no uncovered component: the only thing this close
  // has to report is what Grain says, which is what the test is about.
  graphFixture(dir, yg, { reviewBy: '2099-01-01', hotSpot: false });
  initHorde(dir);

  // A real program in the Grain CLI's place, in the shape this suite already uses for it: started
  // for real, writing a real grain-advice/1 document on stdout with its progress on stderr.
  const stub = join(dir, 'grain-advise-stub.mjs');
  writeFileSync(stub, [
    "const argv = process.argv.slice(2);",
    "if (argv[0] === '--version') { console.log('0.0.0-stub'); process.exit(0); }",
    "if (argv[0] !== 'advise') process.exit(2);",
    "console.error('[grain] indexing');",
    'console.log(JSON.stringify({',
    "  schema: 'grain-advice/1', repo: '.', at: 'abc1234', graph: '.yggdrasil',",
    "  items: [{ kind: 'split', nodes: ['feature'], candidates: ['inner'], evidence: { node: { files: 9 } },",
    "    text: 'Feature owns 9 files, and a finer cut beats it on its own evidence.' }],",
    '}, null, 1));',
    '',
  ].join('\n'));
  run('horde.mjs', ['config', 'set', 'grainCommand', `node ${stub}`], dir);

  await t.test('with nothing leased, the advisory is somebody else\'s — the same answer the quality pass gives', () => {
    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.grain.read, true);
    assert.equal(closed.json.audit.grain.items, 1);
    assert.equal(closed.json.audit.grain.mine, 0);
    assert.equal(closed.json.audit.grain.elsewhere, 1);

    const quality = run('queue.mjs', ['quality', '--dry-run'], dir);
    assert.equal(quality.code, 0, quality.stderr);
    assert.deepEqual(quality.json.filed, [], 'the two sweeps agree about whose advisory it is');
    assert.match(quality.json.skipped[0].why, /outside the mission/);
  });

  await t.test('a leased TERRITORY makes the component this mission\'s, for the close and for the quality pass alike', () => {
    // The real cut: territories.json written the way the architect writes it, then refine.mjs's
    // own step, which validates it and takes the lease. The lease is on the TERRITORY — no
    // component of it is ever bound by name — which is exactly the case a node-keyed lookup got
    // wrong.
    writeFileSync(join(dir, '.horde', 'hordes', 'mission1', 'territories.json'), `${JSON.stringify({
      'the feature': { nodes: ['feature'], class: 'sonnet', why: 'The one area this mission is about.' },
    }, null, 2)}\n`);
    const cut = run('refine.mjs', ['--step', 'cut'], dir);
    assert.equal(cut.code, 0, cut.stderr);
    const leases = JSON.parse(readFileSync(join(dir, '.horde', 'leases.json'), 'utf8')).leases;
    assert.deepEqual(Object.keys(leases), ['the feature'], 'the lease is on the territory, not on the component');

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.grain.mine, 1);
    assert.deepEqual(closed.json.audit.grain.territories, ['the feature']);

    const block = auditSection(dir);
    assert.match(block, /1 on this mission's own territories \(the feature\)/);
    assert.match(block, /`queue\.mjs quality` files them/, 'the close reports the advisory and names the one command that files it');

    // …and the close filed nothing from Grain: one filer, one ledger.
    const fromGrain = JSON.parse(readFileSync(queuePath(dir), 'utf8')).items;
    assert.deepEqual(fromGrain, [], 'the close reports Grain advisories and files none of them');

    // The quality pass, walking the same lease filter, now agrees the component is this mission's.
    const quality = run('queue.mjs', ['quality', '--dry-run'], dir);
    assert.equal(quality.code, 0, quality.stderr);
    assert.equal(quality.json.filed.length, 1);
    assert.equal(quality.json.filed[0].node, 'feature');
  });
});

test('the law audit: a rule nothing has hit is reported in Yggdrasil\'s words, and in nobody else\'s', async (t) => {
  const yg = requireYg();

  await t.test('with the real health reading, no rule qualifies and the close says exactly that', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg, { reviewBy: '2099-01-01', hotSpot: false });
    initHorde(dir);
    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.health.read, true, 'the real `yg aspects --health` answers its own table');
    assert.deepEqual(closed.json.audit.quiet, []);
    assert.match(auditSection(dir), /Rules nothing has hit: none — no rule has gone 2 closed waves without something against it\./);
  });

  await t.test('a rule the graph reads as decorative? carries Yggdrasil\'s own sentence into the wave report', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg, { reviewBy: '2099-01-01', hotSpot: false });
    initHorde(dir);
    const stubbed = passthroughYg(
      dir, yg, 'health-yg.mjs',
      "argv[0] === 'aspects' && argv[1] === '--health'",
      `  process.stdout.write("${HEALTH_WITH_A_QUIET_RULE}");\n  process.exit(0);`,
    );
    run('horde.mjs', ['config', 'set', 'ygCommand', stubbed], dir);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.health.read, true);
    assert.equal(closed.json.audit.quiet.length, 1);
    const [quiet] = closed.json.audit.quiet;
    assert.equal(quiet.aspect, 'no-marker');
    assert.equal(quiet.signal, 'decorative?', "the graph's own label, read off its own table");
    assert.equal(
      quiet.reading,
      'enforceable but never violated — may be deterring violations (0 of 40 recorded checks; estimated catch rate ~2%).',
      'Yggdrasil\'s own reading, carried verbatim',
    );

    const block = auditSection(dir);
    assert.match(block, /Rules nothing has hit:/);
    assert.match(block, /may be deterring violations/);
    assert.doesNotMatch(block, /useless|pointless|dead rule/i, 'a rule nothing hits is not a rule Horde calls worthless');
  });

  await t.test('a health reading that cannot be had is a named absence, never an invented label', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg, { reviewBy: '2099-01-01', hotSpot: false });
    initHorde(dir);
    const stubbed = passthroughYg(
      dir, yg, 'no-health-yg.mjs',
      "argv[0] === 'aspects' && argv[1] === '--health'",
      "  process.stderr.write(\"error: unknown option '--health'\\n\");\n  process.exit(1);",
    );
    run('horde.mjs', ['config', 'set', 'ygCommand', stubbed], dir);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr, 'a wave still closes when one reading cannot be had');
    assert.equal(closed.json.audit.health.read, false);
    assert.match(closed.json.audit.health.why, /aspects --health/);
    assert.deepEqual(closed.json.audit.quiet, [], 'no label was invented to fill the gap');
  });
});

test('the law audit: every read it cannot make is a note in the report, and the wave still closes', async (t) => {
  const yg = requireYg();

  await t.test('an attention feed that refuses: named, nothing filed, and the rest of the close intact', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg);
    initHorde(dir);
    assert.equal(run('node.mjs', ['bind', 'feature'], dir).code, 0);
    const stubbed = passthroughYg(
      dir, yg, 'no-advise-yg.mjs',
      "argv[0] === 'advise'",
      '  process.stderr.write("error: the graph could not be loaded\\n");\n  process.exit(1);',
    );
    run('horde.mjs', ['config', 'set', 'ygCommand', stubbed], dir);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.advise.read, false);
    assert.match(closed.json.audit.advise.why, /advise --json/);
    assert.deepEqual(closed.json.audit.advise.filed, []);
    // The wave's own record is whole — the audit is a courtesy, the close is the record.
    assert.equal(closed.json.gate, 'green');
    assert.ok(closed.json.law.path, 'the law diff still ran');
    // …and the review-date sweep, which does not need the feed, still did its work.
    assert.equal(closed.json.audit.reviewDates.filed.length, 1);
    assert.match(auditSection(dir), /The graph's attention feed: not read/);
    assert.match(auditSection(dir), /it will be read again at the next close/);
  });

  await t.test('an attention feed that answers the wrong document is named for what it said, never parsed anyway', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg, { hotSpot: false });
    initHorde(dir);
    const stubbed = passthroughYg(
      dir, yg, 'wrong-advise-yg.mjs',
      "argv[0] === 'advise'",
      '  process.stdout.write(JSON.stringify({ schema: "yg-advise/9", items: [{ id: "made-up:thing" }] }));\n  process.exit(0);',
    );
    run('horde.mjs', ['config', 'set', 'ygCommand', stubbed], dir);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.advise.read, false);
    assert.match(closed.json.audit.advise.why, /yg-advise\/9/);
    assert.deepEqual(closed.json.audit.advise.filed, [], 'a document that is not the document is not a smaller answer');
  });

  await t.test('an empty attention feed is an answer, not a failure', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg, { hotSpot: false });
    initHorde(dir);
    const stubbed = passthroughYg(
      dir, yg, 'empty-advise-yg.mjs',
      "argv[0] === 'advise'",
      '  process.stdout.write(JSON.stringify({ schema: "yg-advise/1", attention: [], items: [], suppressed: [] }));\n  process.exit(0);',
    );
    run('horde.mjs', ['config', 'set', 'ygCommand', stubbed], dir);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.advise.read, true);
    assert.equal(closed.json.audit.advise.items, 0);
    assert.deepEqual(closed.json.audit.advise.filed, []);
    assert.match(auditSection(dir), /0 item\(s\) standing · nothing new for this mission/);
  });

  await t.test('a Grain CLI that will not run is a note at the close — and still a refusal to the command whose whole job it is', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg, { hotSpot: false });
    initHorde(dir);
    const broken = join(dir, 'broken-grain.mjs');
    writeFileSync(broken, 'process.stderr.write("grain: no index here\\n");\nprocess.exit(3);\n');
    run('horde.mjs', ['config', 'set', 'grainCommand', `node ${broken}`], dir);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.grain.configured, true);
    assert.equal(closed.json.audit.grain.read, false);
    assert.match(closed.json.audit.grain.why, /did not run \(exit 3\)/);
    assert.match(auditSection(dir), /What the repository says about itself: not read/);

    // The divergence, on purpose: `queue.mjs quality` IS the Grain read, so it stops. The close is
    // eight readings and a record, so it notes and goes on.
    const quality = run('queue.mjs', ['quality'], dir);
    assert.equal(quality.code, 1);
    assert.match(quality.stderr, /did not run \(exit 3\)/);
  });

  await t.test('a Grain document that is not grain-advice/1 is named for what it is', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg, { hotSpot: false });
    initHorde(dir);
    const wrong = join(dir, 'wrong-grain.mjs');
    writeFileSync(wrong, 'console.log(JSON.stringify({ schema: "grain-advice/9", items: [] }));\n');
    run('horde.mjs', ['config', 'set', 'grainCommand', `node ${wrong}`], dir);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.json.audit.grain.read, false);
    assert.match(closed.json.audit.grain.why, /grain-advice\/9/);
  });

  await t.test('a CLI that cannot answer the rule inventory stops the close in the law diff, before the audit is reached', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    graphFixture(dir, yg, { hotSpot: false });
    initHorde(dir);
    const stubbed = passthroughYg(
      dir, yg, 'no-aspects-yg.mjs',
      "argv[0] === 'aspects' && argv[1] === '--json'",
      '  process.stdout.write(JSON.stringify({ schema: "yg-aspects/9", aspects: [] }));\n  process.exit(0);',
    );
    run('horde.mjs', ['config', 'set', 'ygCommand', stubbed], dir);

    run('wave.mjs', ['start'], dir);
    const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
    assert.equal(closed.code, 1, 'the rule inventory is read once, by the law diff, and it is not optional there');
    assert.match(closed.stderr, /yg-aspects\/1/);
    // The audit never asks that question a second time; there is one reading of one commit.
  });
});

test('the law audit: only-the-work turns the whole sweep off and says so', async (t) => {
  const yg = requireYg();
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  graphFixture(dir, yg);
  initHorde(dir, 'mission1', ['--quality', 'only-the-work']);
  assert.equal(run('node.mjs', ['bind', 'feature'], dir).code, 0);

  run('wave.mjs', ['start'], dir);
  const closed = run('wave.mjs', ['close', '--gate', 'green'], dir);
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(closed.json.audit.ran, false);
  assert.deepEqual(closed.json.audit.reviewDates.filed, []);
  assert.deepEqual(JSON.parse(readFileSync(queuePath(dir), 'utf8')).items, []);
  assert.match(auditSection(dir), /This mission is set to only-the-work: the horde audited nothing of the law this wave/);
  assert.match(readFileSync(aspectPath(dir, 'no-marker'), 'utf8'), /^review_by: 2020-01-01$/m);
});
