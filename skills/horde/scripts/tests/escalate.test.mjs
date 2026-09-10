import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

test('escalate.mjs: add, list, rule (direct and via --to-user), show, refusals', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('add refuses an unknown kind', () => {
    const r = run('escalate.mjs', ['add', 'why', '--kind', 'bogus'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--kind is required/);
  });

  let id;
  await t.test('add opens an escalation, listed under --open', () => {
    const r = run('escalate.mjs', ['add', 'scope question', '--kind', 'charter', '--by', 'steward', '--ticket', '3'], dir);
    assert.equal(r.code, 0);
    id = r.json.id;
    assert.equal(r.json.state, 'open');
    const open = run('escalate.mjs', ['list', '--open'], dir);
    assert.equal(open.json.length, 1);
  });

  await t.test('rule closes it directly and records a decision esc-<id>', () => {
    const r = run('escalate.mjs', ['rule', id, 'ruling text'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.state, 'ruled');
    const open = run('escalate.mjs', ['list', '--open'], dir);
    assert.equal(open.json.length, 0);
    const decision = run('decide.mjs', ['show', `esc-${id}`], dir);
    assert.equal(decision.code, 0);
    assert.equal(decision.json.body, 'ruling text');
  });

  await t.test('rule refuses an already-ruled escalation', () => {
    const r = run('escalate.mjs', ['rule', id, 'again'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already ruled/);
  });

  let forwardedId;
  await t.test('rule --to-user forwards without closing; a second rule call finalizes it', () => {
    const opened = run('escalate.mjs', ['add', 'cost question', '--kind', 'cost', '--by', 'steward'], dir);
    forwardedId = opened.json.id;
    const forwarded = run('escalate.mjs', ['rule', forwardedId, 'forwarding this', '--to-user'], dir);
    assert.equal(forwarded.code, 0);
    assert.equal(forwarded.json.state, 'forwarded');
    const stillOpen = run('escalate.mjs', ['list', '--open'], dir);
    assert.equal(stillOpen.json.some((i) => i.id === forwardedId), true);
    const noDecisionYet = run('decide.mjs', ['show', `esc-${forwardedId}`], dir);
    assert.equal(noDecisionYet.code, 1);

    const finalized = run('escalate.mjs', ['rule', forwardedId, 'chairman says proceed'], dir);
    assert.equal(finalized.code, 0);
    assert.equal(finalized.json.state, 'ruled');
    const decision = run('decide.mjs', ['show', `esc-${forwardedId}`], dir);
    assert.equal(decision.code, 0);
    assert.equal(decision.json.body, 'chairman says proceed');
  });

  await t.test('rule refuses an unknown escalation id', () => {
    const r = run('escalate.mjs', ['rule', '9999', 'x'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such escalation/);
  });

  await t.test('add refuses kind "structure" and "adjudicate" — sub-teams and the old fix-loop escalation no longer exist', () => {
    const structure = run('escalate.mjs', ['add', 'a sub-team for this', '--kind', 'structure'], dir);
    assert.equal(structure.code, 1);
    assert.match(structure.stderr, /--kind is required, one of:/);
    assert.doesNotMatch(structure.stderr, /structure/);

    const adjudicate = run('escalate.mjs', ['add', 'ticket stuck past the fix-loop cap', '--kind', 'adjudicate', '--ticket', '7'], dir);
    assert.equal(adjudicate.code, 1);
    assert.match(adjudicate.stderr, /--kind is required, one of:/);
    assert.doesNotMatch(adjudicate.stderr, /adjudicate/);
  });

  await t.test('rule --by records the ruler\'s name without any roster to trace', () => {
    const opened = run('escalate.mjs', ['add', 'ruling to attribute', '--kind', 'rules'], dir);
    const ruled = run('escalate.mjs', ['rule', opened.json.id, 'ruling text', '--by', 'architect'], dir);
    assert.equal(ruled.code, 0, ruled.stderr);
  });
});

test('escalate.mjs recurring: the third ruling of a kind on one node is a rule proposal', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));

  // A repository whose nodes come from the graph, so the proposal names the graph's own log.
  mkdirSync(join(dir, '.yggdrasil', 'model', 'checkout'), { recursive: true });
  writeFileSync(join(dir, '.yggdrasil', 'model', 'checkout', 'yg-node.yaml'), 'name: Checkout\ntype: module\ndescription: d\nmapping:\n  - src/\nrelations: []\n');
  mkdirSync(join(dir, '.yggdrasil', 'model', 'billing'), { recursive: true });
  writeFileSync(join(dir, '.yggdrasil', 'model', 'billing', 'yg-node.yaml'), 'name: Billing\ntype: module\ndescription: d\nmapping:\n  - billing/\nrelations: []\n');
  initHorde(dir);
  run('horde.mjs', ['config', 'set', 'ygCommand', 'node ./vendor/yg.mjs'], dir);

  const onCheckout = [];
  for (let i = 0; i < 3; i++) {
    const created = run('tk.mjs', ['new', `checkout-${i}`, '--title', `Checkout question ${i}`, '--node', 'checkout', '--class', 'sonnet', '--evidence', 'it works'], dir);
    assert.equal(created.code, 0, created.stderr);
    onCheckout.push(created.json.id);
  }
  const onBilling = run('tk.mjs', ['new', 'billing-0', '--title', 'Billing question', '--node', 'billing', '--class', 'sonnet', '--evidence', 'it works'], dir).json.id;

  await t.test('nothing to propose while no answer has been given three times', () => {
    for (const [i, ticket] of onCheckout.slice(0, 2).entries()) {
      const opened = run('escalate.mjs', ['add', `contract question ${i}`, '--kind', 'contract', '--ticket', ticket], dir);
      run('escalate.mjs', ['rule', opened.json.id, `the producing node decides, round ${i}`], dir);
    }
    const r = run('escalate.mjs', ['recurring'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.groups, []);
    const human = run('escalate.mjs', ['recurring'], dir, { json: false });
    assert.match(human.stdout, /no ruling has recurred 3 times yet/);
  });

  await t.test('the third one proposes the rule, with the rulings as its evidence', () => {
    const opened = run('escalate.mjs', ['add', 'contract question 2', '--kind', 'contract', '--ticket', onCheckout[2]], dir);
    run('escalate.mjs', ['rule', opened.json.id, 'the producing node decides, round 2'], dir);

    const r = run('escalate.mjs', ['recurring'], dir);
    assert.equal(r.json.groups.length, 1);
    const [group] = r.json.groups;
    assert.equal(group.kind, 'contract');
    assert.equal(group.node, 'checkout');
    assert.equal(group.count, 3);
    assert.deepEqual(group.escalations.map((e) => e.ticket), onCheckout);
    assert.match(group.rule, /contract on checkout: answered the same way 3 times/);
    assert.equal(
      group.command,
      'file the rule (.yggdrasil/aspects/<id>/yg-aspect.yaml, attached to checkout), then '
      + 'node ./vendor/yg.mjs aspects log add --aspect <id> --reason "' + group.rule + '"'
      + ' — its own log is where the reasoning belongs, not the node\'s',
    );

    const human = run('escalate.mjs', ['recurring'], dir, { json: false });
    assert.match(human.stdout, /contract · node checkout — 3 rulings/);
    assert.match(human.stdout, /file it: file the rule \(\.yggdrasil\/aspects\/<id>\/yg-aspect\.yaml, attached to checkout\)/);
    assert.match(human.stdout, /node \.\/vendor\/yg\.mjs aspects log add --aspect <id> --reason/);
    assert.match(human.stdout, /The architect does that filing — this tool proposes, it never files/);
  });

  await t.test('a ruling of the same kind on another node is another question, not a fourth answer', () => {
    const opened = run('escalate.mjs', ['add', 'contract question on billing', '--kind', 'contract', '--ticket', onBilling], dir);
    run('escalate.mjs', ['rule', opened.json.id, 'billing decides its own'], dir);
    const r = run('escalate.mjs', ['recurring'], dir);
    assert.equal(r.json.groups.length, 1);
    assert.equal(r.json.groups[0].node, 'checkout');
  });

  await t.test('--min lowers the bar, and an open escalation is never evidence', () => {
    run('escalate.mjs', ['add', 'not answered yet', '--kind', 'contract', '--ticket', onBilling], dir);
    const r = run('escalate.mjs', ['recurring', '--min', '2'], dir);
    const billing = r.json.groups.find((g) => g.node === 'billing');
    assert.equal(billing, undefined, 'one ruling plus one open question is one ruling');
    const bad = run('escalate.mjs', ['recurring', '--min', '1'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--min must be a whole number of at least 2/);
  });
});

test('escalate.mjs: "quality" is a kind, so a fallen quality index has a channel up', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const r = run('escalate.mjs', ['add', 'the graph got weaker over this wave', '--kind', 'quality'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.kind, 'quality');
});
