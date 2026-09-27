// The platform layer in _lib.mjs: how a configured command line becomes a program to start, which
// shell runs gate/notify/runner commands, how a process tree is stopped, and how paths git prints
// are compared with paths Node builds. Most of it only differs on Windows, so the Windows-only
// cases skip elsewhere and run in the windows-latest CI job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  splitCommandLine, cmdShimTarget, programFor, posixShell, samePath, toPosix, runCommandGroup,
  readText, IS_WINDOWS,
} from '../_lib.mjs';

const onlyWindows = { skip: !IS_WINDOWS && 'Windows only' };

// What npm's cmd-shim writes for a package bin (abridged to the lines that matter).
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\bin\\cli.js" %*',
  '',
].join('\r\n');

test('splitCommandLine keeps a double-quoted path with spaces as one word', () => {
  assert.deepEqual(splitCommandLine('yg'), ['yg']);
  assert.deepEqual(splitCommandLine('  node   ./yg/bin.js  '), ['node', './yg/bin.js']);
  assert.deepEqual(
    splitCommandLine('node "C:\\Program Files\\yg cli\\bin.js" --flag'),
    ['node', 'C:\\Program Files\\yg cli\\bin.js', '--flag'],
  );
  assert.deepEqual(splitCommandLine(''), []);
});

test('cmdShimTarget reads the script an npm .cmd shim runs, and nothing from any other batch file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-shim-'));
  try {
    const shim = join(dir, 'fake.cmd');
    writeFileSync(shim, NPM_SHIM);
    assert.equal(cmdShimTarget(shim), join(dir, 'node_modules', 'fake-cli', 'bin', 'cli.js'));
    const other = join(dir, 'other.cmd');
    writeFileSync(other, '@echo off\r\necho hello %*\r\n');
    assert.equal(cmdShimTarget(other), null);
    assert.equal(cmdShimTarget(join(dir, 'missing.cmd')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('programFor leaves a command line as it stands off Windows', { skip: IS_WINDOWS && 'not on Windows' }, () => {
  assert.deepEqual(programFor(['yg', 'check']), { cmd: 'yg', prefix: ['check'] });
});

test('programFor starts an npm shim on PATH as node on its script, arguments untouched', onlyWindows, () => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-shim-'));
  const saved = process.env.PATH;
  try {
    writeFileSync(join(dir, 'fakecli.cmd'), NPM_SHIM);
    const script = join(dir, 'node_modules', 'fake-cli', 'bin', 'cli.js');
    mkdirSync(join(dir, 'node_modules', 'fake-cli', 'bin'), { recursive: true });
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    process.env.PATH = `${dir};${saved}`;
    const { cmd, prefix } = programFor(['fakecli', 'a&b', '100%']);
    assert.equal(cmd, process.execPath);
    assert.equal(prefix[0], script);
    const out = execFileSync(cmd, prefix, { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), ['a&b', '100%']);
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('programFor refuses a batch file that is not an npm shim, naming it', onlyWindows, () => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-shim-'));
  const saved = process.env.PATH;
  try {
    writeFileSync(join(dir, 'plainbat.cmd'), '@echo off\r\necho hi\r\n');
    process.env.PATH = `${dir};${saved}`;
    assert.throws(() => programFor(['plainbat']), /batch file/);
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('posixShell names a POSIX sh that runs a command line', () => {
  const shell = posixShell();
  assert.ok(IS_WINDOWS ? existsSync(shell) : shell === '/bin/sh', shell);
  const out = execFileSync(shell, ['-c', 'echo "$((2 + 3))"'], { encoding: 'utf8' }).trim();
  assert.equal(out, '5');
});

test('runCommandGroup stops a command that outlives its timeout, and what it started', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-group-'));
  try {
    const started = Date.now();
    const res = runCommandGroup('sleep 30 & sleep 30; wait', dir, 1500);
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.ok(Date.now() - started < 20000, 'the run came back long before its sleeps would have ended');
    const green = runCommandGroup('exit 0', dir, 10000);
    assert.equal(green.ok, true);
    const red = runCommandGroup('exit 3', dir, 10000);
    assert.equal(red.ok, false);
    assert.equal(red.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('samePath and toPosix: git\'s path spelling against Node\'s', () => {
  assert.equal(samePath('/a/b', '/a/b'), true);
  assert.equal(samePath(null, '/a'), false);
  assert.equal(toPosix(['a', 'b', 'c'].join(sep)), 'a/b/c');
  if (IS_WINDOWS) {
    assert.equal(samePath('C:/Users/Me/repo', 'c:\\users\\me\\repo\\'), true);
    assert.equal(samePath('C:/Users/Me/repo', 'C:\\Users\\Me\\other'), false);
  } else {
    assert.equal(samePath('/a/B', '/a/b'), false);
  }
});

test('readText reads a CRLF file with \\n line endings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horde-crlf-'));
  try {
    const file = join(dir, 'charter.md');
    writeFileSync(file, '# Title\r\n\r\n## Acceptance\r\n- [ ] one\r\n');
    assert.equal(readText(file), '# Title\n\n## Acceptance\n- [ ] one\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
