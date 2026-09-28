// The vendored Runes code (the MCP adapter, the command table it reads, and the parity, measure and client parts of
// the test kit), the shared skill fragment in SKILL.md (between the RUNES markers) and the vendoring tool are pinned
// in vendor/runes.pin.json and checked by that tool, offline. The CI job adds the fresh-clone half.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = fileURLToPath(new URL('../../', import.meta.url));
const check = (skillDir) =>
  spawnSync(process.execPath, [join(skillDir, 'scripts', 'runes.mjs'), 'check', '--offline', '--pin', join(skillDir, 'scripts', 'vendor', 'runes.pin.json')], { encoding: 'utf8' });

const tmps = [];
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

// A throwaway repository holding the skill directory as it is here: the tool's own copy, the pin and SKILL.md.
function copyOfSkill() {
  const repo = mkdtempSync(join(tmpdir(), 'horde-runes-'));
  tmps.push(repo);
  mkdirSync(join(repo, '.git'));
  const dir = join(repo, 'skills', 'horde');
  mkdirSync(join(dir, 'scripts', 'vendor'), { recursive: true });
  cpSync(join(SKILL, 'SKILL.md'), join(dir, 'SKILL.md'));
  cpSync(join(SKILL, 'scripts', 'runes.mjs'), join(dir, 'scripts', 'runes.mjs'));
  cpSync(join(SKILL, 'scripts', 'vendor', 'runes.pin.json'), join(dir, 'scripts', 'vendor', 'runes.pin.json'));
  cpSync(join(SKILL, 'scripts', 'vendor', 'runes'), join(dir, 'scripts', 'vendor', 'runes'), { recursive: true });
  return dir;
}

test('the vendored copy, the tool and the skill fragment match the pin, at tag v1.0.0', () => {
  const r = check(SKILL);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\d+ vendored files, 1 skill fragments? and the tool match v1\.0\.0/);
  const pin = JSON.parse(readFileSync(join(SKILL, 'scripts', 'vendor', 'runes.pin.json'), 'utf8'));
  assert.equal(pin.tag, 'v1.0.0');
  assert.deepEqual(pin.paths, ['dist/version.mjs', 'dist/cli', 'dist/mcp', 'dist/testkit/parity.mjs', 'dist/testkit/measure.mjs', 'dist/testkit/client.mjs']);
  assert.ok(Object.keys(pin.files).length > 0 && Object.keys(pin.files).every((f) => pin.paths.some((p) => f === p || f.startsWith(`${p}/`))));
});

test('a hand edit of a vendored file turns the gate red and names the file', () => {
  const dir = copyOfSkill();
  const path = join(dir, 'scripts', 'vendor', 'runes', 'dist', 'mcp', 'tools.mjs');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n// edited\n`);
  const r = check(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /dist\/mcp\/tools\.mjs/);
});

test('SKILL.md carries the mcp-first fragment between its markers, once', () => {
  const pin = JSON.parse(readFileSync(join(SKILL, 'scripts', 'vendor', 'runes.pin.json'), 'utf8'));
  const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  assert.deepEqual(pin.fragments.map((f) => f.name), ['mcp-first']);
  for (const edge of ['START', 'END']) assert.equal(text.split(`<!-- RUNES:mcp-first:${edge} -->`).length, 2, `mcp-first ${edge} marker`);
});

test('a hand edit inside the fragment turns the gate red; an edit outside it leaves the gate green; a lost marker turns it red', () => {
  const dir = copyOfSkill();
  const path = join(dir, 'SKILL.md');
  const text = readFileSync(path, 'utf8');
  const inside = text.replace('**The CLI is the fallback.**', '**The CLI is a fallback.**');
  assert.notEqual(inside, text);
  writeFileSync(path, inside);
  const r = check(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /fragment mcp-first in \.\.\/\.\.\/SKILL\.md: the block between the markers differs/);
  writeFileSync(path, text.replace('many cheap hands, one will', 'many cheap hands and one will'));
  assert.equal(check(dir).status, 0);
  writeFileSync(path, text.replace('<!-- RUNES:mcp-first:END -->\n', ''));
  const lost = check(dir);
  assert.equal(lost.status, 1, lost.stdout);
  assert.match(lost.stderr, /fragment mcp-first/);
});
