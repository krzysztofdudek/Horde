// The suite's own setup, under a Yggdrasil older than Horde's floor: one refusal naming the CLI and
// the release to install, before any test runs — never hundreds of failures that each say it again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { YG_DOCUMENTS_AFTER } from '../node.mjs';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

// A stand-in CLI that only answers `--version`, with the version it is given. On Windows it is what
// npm installs there: a `yg.cmd` shim that runs node on a script, and `bin` is that script's node line.
function fakeYg(version) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-old-yg-'));
  if (process.platform === 'win32') {
    const js = join(dir, 'yg.js');
    writeFileSync(js, `console.log(${JSON.stringify(version)});\n`);
    writeFileSync(join(dir, 'yg.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\yg.js" %*\r\n');
    return { dir, bin: `node ${js}` };
  }
  const bin = join(dir, 'yg');
  writeFileSync(bin, `#!/bin/sh\necho ${version}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

function loadHelpers(env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    const h = await import(${JSON.stringify(pathToFileURL(join(TESTS_DIR, 'helpers.mjs')).href)});
    console.log('loaded:' + h.findRealYg());
  `], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('test setup: a Yggdrasil below the floor stops the file once, naming the CLI and the release to install', () => {
  const old = fakeYg('6.0.0');
  try {
    const r = loadHelpers({ HORDE_TEST_YG: old.bin });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /loaded:/, 'nothing after the helpers ran');
    assert.match(r.stderr, /reports 6\.0\.0/);
    assert.match(r.stderr, new RegExp(`needs ${YG_DOCUMENTS_AFTER.replace(/\./g, '\\.')} or newer`));
    assert.match(r.stderr, /HORDE_TEST_YG/);
    assert.equal(r.stderr.match(/error:/g).length, 1, 'said once');

    const pre = spawnSync(process.execPath, [join(TESTS_DIR, 'yg-floor.mjs')], {
      encoding: 'utf8', env: { ...process.env, HORDE_TEST_YG: old.bin },
    });
    assert.equal(pre.status, 1);
    assert.match(pre.stderr, /reports 6\.0\.0/);
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
  }
});

test('test setup: a Yggdrasil at the floor or above is taken', () => {
  for (const version of [YG_DOCUMENTS_AFTER, '6.10.0', '7.0.0']) {
    const ok = fakeYg(version);
    try {
      const r = loadHelpers({ HORDE_TEST_YG: ok.bin });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`loaded:${ok.bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }
  }
});

test('test setup: an older yg on PATH is passed over for a build that meets the floor, or refused by name', () => {
  const old = fakeYg('6.0.0');
  try {
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const env = { [pathKey]: `${old.dir}${delimiter}${process.env[pathKey]}` };
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const h = await import(${JSON.stringify(pathToFileURL(join(TESTS_DIR, 'helpers.mjs')).href)});
      console.log('loaded:' + h.findRealYg());
    `], { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'HORDE_TEST_YG')), ...env } });
    if (r.status === 0) {
      assert.doesNotMatch(r.stdout, /loaded:yg$/m, 'the old yg on PATH was not taken');
      assert.doesNotMatch(r.stdout, /loaded:null/);
    } else {
      assert.match(r.stderr, /reports 6\.0\.0/);
    }
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
  }
});
