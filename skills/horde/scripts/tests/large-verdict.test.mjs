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
  // 3 MB of output, then the verdict line a real run ends with.
  writeFileSync(fake, [
    "const line = 'x'.repeat(1023) + '\\n';",
    'for (let i = 0; i < 3072; i++) process.stdout.write(line);',
    "process.stdout.write('yg check: PASS  1 nodes\\n');",
  ].join('\n'));
  const res = runYgCheck({ ygCommand: `node ${fake}` }, dir);
  assert.equal(res.available, true);
  assert.equal(res.ok, true, res.summary);
  assert.ok(res.out.length > 3 * 1024 * 1024, `read ${res.out.length} bytes`);
  assert.match(res.summary, /^yg check: PASS/);
});
