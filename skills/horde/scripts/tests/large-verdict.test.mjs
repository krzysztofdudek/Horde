import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runYgCheck } from '../node.mjs';

// A large repository's `yg check --json` runs to several megabytes. Node's default buffer for a
// child process is one megabyte, and a verdict cut off there surfaced as ENOBUFS on a real
// mission, with the architect reading rules straight from files instead. The document is read
// whole, whatever its size.
test('node.mjs runYgCheck: reads a yg document larger than the default child-process buffer whole', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-large-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fake-yg.mjs');
  // A 3 MB yg-check/1 document: three thousand pairs, each carrying a 1 KB refusal report.
  writeFileSync(fake, [
    "if (process.argv[2] === '--version') { console.log('6.0.0'); process.exit(0); }",
    "const pairs = Array.from({ length: 3072 }, (_, i) => ({ aspect: 'no-marker', unit: { kind: 'file', path: `f${i}.mjs` }, node: 'feature', kind: 'deterministic', status: 'advisory', verdict: 'refused', report: 'x'.repeat(1000) }));",
    "process.stdout.write(JSON.stringify({ schema: 'yg-check/1', exit: { code: 0, status: 'pass', reason: 'Nothing blocks this run.' }, pairs }));",
  ].join('\n'));
  const res = runYgCheck({ ygCommand: `node ${fake}` }, dir);
  assert.equal(res.available, true);
  assert.equal(res.ok, true, res.summary);
  assert.equal(res.doc.pairs.length, 3072);
  assert.ok(JSON.stringify(res.doc).length > 3 * 1024 * 1024, 'read whole');
  assert.match(res.summary, /^yg check: PASS/);
});
