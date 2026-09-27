// The vendored Jarl record (vendor/jarl/, pinned by vendor/jarl.pin.json) and the tool that keeps it
// honest (jarl-vendor.mjs). The copy is what every mission's loop is written through, so a hand edit to
// it, a file dropped from it or one slipped in beside it is refused offline, before any test of the
// tools themselves runs on top of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL = join(SCRIPTS, 'jarl-vendor.mjs');

function runTool(args, cwd = SCRIPTS) {
  try {
    const stdout = execFileSync('node', [TOOL, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

// A throwaway repository holding a copy of the pin and the vendored files, so a test can break one.
function scratchCopy(t) {
  const dir = mkdtempSync(join(tmpdir(), 'horde-vendor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.git'));
  cpSync(join(SCRIPTS, 'vendor'), join(dir, 'vendor'), { recursive: true });
  return { dir, pin: join(dir, 'vendor', 'jarl.pin.json') };
}

test('jarl-vendor check: the committed copy matches its pin, and the pin names the record API Horde is written against', () => {
  const r = runTool(['check']);
  assert.equal(r.code, 0, r.stderr);
  const pin = JSON.parse(readFileSync(join(SCRIPTS, 'vendor', 'jarl.pin.json'), 'utf8'));
  assert.equal(pin.api, 'jarl-record/1');
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(pin.files).sort(), [...pin.paths].sort());
});

test('jarl-vendor check: a hand edit to the vendored record is refused, naming the file', (t) => {
  const { dir, pin } = scratchCopy(t);
  const file = join(dir, 'vendor', 'jarl', 'skills', 'jarl', 'scripts', 'jarl-lib.mjs');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n// a hand edit\n`);
  const r = runTool(['check', '--pin', pin]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /modified: jarl\/skills\/jarl\/scripts\/jarl-lib\.mjs/);
});

test('jarl-vendor check: a file slipped in beside the copy, or one gone from it, is refused', (t) => {
  const { dir, pin } = scratchCopy(t);
  writeFileSync(join(dir, 'vendor', 'jarl', 'skills', 'jarl', 'scripts', 'extra.mjs'), 'export const x = 1;\n');
  rmSync(join(dir, 'vendor', 'jarl', 'skills', 'jarl', 'scripts', 'record.mjs'));
  const r = runTool(['check', '--pin', pin]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /extra: jarl\/skills\/jarl\/scripts\/extra\.mjs/);
  assert.match(r.stderr, /missing: jarl\/skills\/jarl\/scripts\/record\.mjs/);
});

test('jarl-vendor check --source: a Jarl tree whose record differs from the copy is refused, naming the update', (t) => {
  const { dir, pin } = scratchCopy(t);
  const tree = join(dir, 'jarl-tree');
  cpSync(join(dir, 'vendor', 'jarl'), tree, { recursive: true });
  const same = runTool(['check', '--pin', pin, '--source', tree]);
  assert.equal(same.code, 0, same.stderr);
  const lib = join(tree, 'skills', 'jarl', 'scripts', 'jarl-lib.mjs');
  writeFileSync(lib, `${readFileSync(lib, 'utf8')}\n// moved on\n`);
  const moved = runTool(['check', '--pin', pin, '--source', tree]);
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /differs from the JarlSkill tree/);
  assert.match(moved.stderr, /jarl-vendor\.mjs update --source/);
});
