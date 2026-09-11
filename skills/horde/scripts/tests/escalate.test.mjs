import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

// escalate.mjs is down to one command after ask.mjs (019) folded escalation and dissent into the
// one channel to the client: recurring, the second legislation trigger. Its input is now the
// ANSWERED asks (kind, territory) — not a ruled escalation, and grouped by territory, not by a
// node derived from the ticket.

test('escalate.mjs recurring: the third answer of a kind on one territory is a rule proposal', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
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
      const opened = run('ask.mjs', ['add', `checkout question ${i}`, '--kind', 'stop', '--ticket', ticket, '--territory', 'checkout'], dir);
      run('ask.mjs', ['answer', opened.json.id, `the producing node decides, round ${i}`], dir);
    }
    const r = run('escalate.mjs', ['recurring'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.groups, []);
    const human = run('escalate.mjs', ['recurring'], dir, { json: false });
    assert.match(human.stdout, /no answer has recurred 3 times yet/);
  });

  await t.test('the third one proposes the rule, with the answers as its evidence', () => {
    const opened = run('ask.mjs', ['add', 'checkout question 2', '--kind', 'stop', '--ticket', onCheckout[2], '--territory', 'checkout'], dir);
    run('ask.mjs', ['answer', opened.json.id, 'the producing node decides, round 2'], dir);

    const r = run('escalate.mjs', ['recurring'], dir);
    assert.equal(r.json.groups.length, 1);
    const [group] = r.json.groups;
    assert.equal(group.kind, 'stop');
    assert.equal(group.territory, 'checkout');
    assert.equal(group.count, 3);
    assert.deepEqual(group.asks.map((e) => e.ticket), onCheckout);
    assert.match(group.rule, /stop on checkout: answered the same way 3 times/);
    assert.equal(
      group.command,
      'file the rule (.yggdrasil/aspects/<id>/yg-aspect.yaml, attached to checkout\'s node), then '
      + 'node ./vendor/yg.mjs aspects log add --aspect <id> --reason "' + group.rule + '"'
      + ' — its own log is where the reasoning belongs, not the node\'s',
    );

    const human = run('escalate.mjs', ['recurring'], dir, { json: false });
    assert.match(human.stdout, /stop · territory checkout — 3 answers/);
    assert.match(human.stdout, /file it: file the rule \(\.yggdrasil\/aspects\/<id>\/yg-aspect\.yaml, attached to checkout's node\)/);
    assert.match(human.stdout, /node \.\/vendor\/yg\.mjs aspects log add --aspect <id> --reason/);
    // After 6.0.0 there is no seat that files law: the agent working that territory writes the
    // rule in its own branch and raises it on evidence. Nobody is asked for permission to write a
    // rule down; permission is only ever needed to take one away.
    assert.match(human.stdout, /The agent that works that territory does the filing, in its own branch/);
    assert.match(human.stdout, /raises the rule on its own evidence with node\.mjs promote/);
    assert.match(human.stdout, /nobody needs a signature to write a rule down — only to take one away/);
    assert.doesNotMatch(human.stdout, /The architect does that filing/);
  });

  await t.test('an answer of the same kind on another territory is another question, not a fourth answer', () => {
    const opened = run('ask.mjs', ['add', 'billing question', '--kind', 'stop', '--ticket', onBilling, '--territory', 'billing'], dir);
    run('ask.mjs', ['answer', opened.json.id, 'billing decides its own'], dir);
    const r = run('escalate.mjs', ['recurring'], dir);
    assert.equal(r.json.groups.length, 1);
    assert.equal(r.json.groups[0].territory, 'checkout');
  });

  await t.test('--min lowers the bar, and an open ask is never evidence', () => {
    run('ask.mjs', ['add', 'not answered yet', '--kind', 'stop', '--ticket', onBilling, '--territory', 'billing'], dir);
    const r = run('escalate.mjs', ['recurring', '--min', '2'], dir);
    const billing = r.json.groups.find((g) => g.territory === 'billing');
    assert.equal(billing, undefined, 'one answer plus one open question is one answer');
    const bad = run('escalate.mjs', ['recurring', '--min', '1'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--min must be a whole number of at least 2/);
  });

  await t.test('an ask with no territory groups under "(no territory)", and still has somewhere to be filed', () => {
    for (let i = 0; i < 3; i++) {
      const opened = run('ask.mjs', ['add', `stray question ${i}`, '--kind', 'charter'], dir);
      run('ask.mjs', ['answer', opened.json.id, `agreed, round ${i}`], dir);
    }
    const r = run('escalate.mjs', ['recurring'], dir);
    const stray = r.json.groups.find((g) => g.kind === 'charter');
    assert.equal(stray.territory, '(no territory)');
    assert.match(stray.command, /^decide\.mjs add <slug> "/);
  });
});
