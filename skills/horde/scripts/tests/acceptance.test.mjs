import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRepo, rmRepo, run, initHorde, addNode,
} from './helpers.mjs';
import { acceptanceLines } from '../tk.mjs';

// A ticket with no acceptance line has nothing a verifier can reproduce, so nothing could ever
// prove it done. The queue is where that is refused: a real mission found such a ticket only at
// verifier briefing time, with the work already written.
test('acceptanceLines: real checklist lines under "## Acceptance", never the template placeholder', () => {
  const text = '# 001 · X\n\n## Acceptance — evidence\n\nEach line is reproduced.\n\n- [ ] …\n- [ ] the page renders\n- [x] E3 the audit event lands\n\n## Notes\n\n- [ ] not acceptance';
  assert.deepEqual(acceptanceLines(text), ['- [ ] the page renders', '- [x] E3 the audit event lands']);
  assert.deepEqual(acceptanceLines('no section at all'), []);
  assert.deepEqual(acceptanceLines('## Acceptance — evidence\n\n- [ ] …\n'), []);
});

test('queue.mjs add: refuses a ticket with no acceptance line, accepts one with a line', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  addNode(dir, 'nodeA', { mapping: ['src/nodeA/**'] });
  const bare = run('tk.mjs', ['new', 'bare', '--title', 'No evidence', '--node', 'nodeA', '--class', 'sonnet'], dir);
  assert.equal(bare.code, 0);
  const refused = run('queue.mjs', ['add', bare.json.id], dir);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /no acceptance line/);
  const good = run('tk.mjs', ['new', 'good', '--title', 'With evidence', '--node', 'nodeA', '--class', 'sonnet', '--evidence', 'the page renders'], dir);
  assert.equal(good.code, 0);
  const queued = run('queue.mjs', ['add', good.json.id], dir);
  assert.equal(queued.code, 0, queued.stderr);
  assert.equal(queued.json.ticket, good.json.id);
});
