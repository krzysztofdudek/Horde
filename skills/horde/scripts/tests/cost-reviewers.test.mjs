import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A landing worker's `yg check --approve` bills a model per prose pair, and the roster never sees
// it. Yggdrasil writes one line per call to its committed event log, so the mission's calls are
// the lines that file gained between the base and the trunk — read from git, not from disk.
test('cost.mjs report: counts the reviewer calls the mission added to Yggdrasil\'s event log', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const before = run('cost.mjs', ['report'], dir);
  assert.equal(before.code, 0);
  assert.equal(before.json.reviewerCalls, 0);
  const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(dir, ['checkout', '-q', 'mission1/trunk']);
  mkdirSync(join(dir, '.yggdrasil'), { recursive: true });
  const line = (kind, disposition) => JSON.stringify({ v: 1, ts: '2026-09-08T10:00:00.000Z', source: 'fill', aspectId: 'what-why-next', unitKey: 'file:src/a.ts', kind, disposition });
  writeFileSync(join(dir, '.yggdrasil', 'yg-events.llm.jsonl'), [line('llm', 'approved'), line('llm', 'refused'), line('deterministic', 'approved')].join('\n') + '\n');
  git(dir, ['add', '.yggdrasil/yg-events.llm.jsonl']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'events']);
  git(dir, ['checkout', '-q', current]);
  const after = run('cost.mjs', ['report'], dir);
  assert.equal(after.code, 0, after.stderr);
  assert.equal(after.json.reviewerCalls, 2);
  assert.equal(after.json.reviewerCallsNote, null);
  const wave = run('cost.mjs', ['report', '--wave', '1'], dir);
  assert.equal(wave.json.reviewerCalls, null);
  assert.match(wave.json.reviewerCallsNote, /per mission/);
});
