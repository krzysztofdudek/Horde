// A bare `yg check` is read-only only until the repository sets `auto_approve` in yg-config.yaml;
// from then on it fills verdicts by itself, the paid reviewer's included, and rewrites the lock in
// whatever tree it ran in. Every read Horde documents as free must therefore say `--no-approve`
// itself. The CLI here is a real program that records the arguments it was started with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runYgCheck, ygCheckDoc, ygCheckJson } from '../node.mjs';

test('every yg check Horde runs to read the graph passes --no-approve', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-no-approve-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'argv.log');
  const stub = join(dir, 'yg-stub.mjs');
  writeFileSync(stub, [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "console.log(JSON.stringify({ schema: 'yg-check/1', ok: true }));",
    '',
  ].join('\n'));
  const cfg = { ygCommand: `${process.execPath} ${stub}` };

  runYgCheck(cfg, dir);
  runYgCheck(cfg, dir, ['--details']);
  ygCheckDoc(dir, cfg);
  ygCheckJson(dir, cfg);

  // The version check Horde makes once per CLI (6.0.0 or newer) is not a read of the graph.
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((argv) => argv[0] !== '--version');
  assert.equal(calls.length, 4);
  for (const argv of calls) {
    assert.equal(argv[0], 'check');
    assert.ok(argv.includes('--no-approve'), `\`yg ${argv.join(' ')}\` would approve under auto_approve`);
  }
});
