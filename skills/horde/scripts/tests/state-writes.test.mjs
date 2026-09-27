// The state files more than one process rewrites: a ticket's issue.md and log.md, the shared
// leases.json, and a mission's decisions.md. Each is a read-modify-write, and each is measured
// here against a second writer that holds the file's lock across its own read and write-back
// (lock-race/rewriter.mjs). A writer that honours the lock waits and then works on the file as it
// stands, so both changes survive. One that does not writes inside the other's hold and is erased.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, rmSync, chmodSync, readdirSync, realpathSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

const REWRITER = join(dirname(fileURLToPath(import.meta.url)), 'lock-race', 'rewriter.mjs');
const HOLD_MS = 2500;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Starts the rule-abiding writer and returns once it holds the lock and has read the file. The
// promise of its exit comes back wrapped, since an async function handed a bare promise would wait
// for it.
async function startRewriter(dir, args) {
  const marker = join(dir, `.rewriter-ready-${Math.random().toString(36).slice(2, 8)}`);
  rmSync(marker, { force: true });
  const child = spawn('node', [REWRITER, args.kind, args.file, marker, String(HOLD_MS), args.addition, args.extra || ''], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => { child.on('close', (code) => resolve({ code, err })); });
  const deadline = Date.now() + 30000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error(`the rewriter never took its lock: ${err}`);
    await new Promise((r) => { setTimeout(r, 10); });
  }
  return { done };
}

// Runs `fn` with the process inside the fixture repository, where every tool resolves `.horde/`.
async function inRepo(dir, fn) {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

function newTicket(dir) {
  const r = run('tk.mjs', ['new', 'sample', '--title', 'Sample', '--node', 'feature', '--class', 'standard'], dir);
  assert.equal(r.code, 0, r.stderr);
}

test('a ticket\'s Status is written on issue.md as it stands, never on a copy read earlier', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  newTicket(dir);

  await inRepo(dir, async () => {
    const { findTicket, transitionStatus, setTicketBody } = await import('../tk.mjs');
    const stale = findTicket('mission1', '1');
    assert.ok(stale, 'the ticket exists');
    // Somebody edits the body after this copy was read.
    setTicketBody('mission1', '1', '## What\n\nthe body written in between\n', 'tester');
    transitionStatus(stale, 'queued', 'moved from an older copy');

    const text = readFileSync(stale.issuePath, 'utf8');
    assert.match(text, /^\*\*Status:\*\* queued$/m, 'the transition was written');
    assert.match(text, /the body written in between/, 'and the edit made since the copy was read survived it');
  });
});

test('a ticket\'s Status waits for a writer holding the ticket lock', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  newTicket(dir);

  await inRepo(dir, async () => {
    const { findTicket, transitionStatus } = await import('../tk.mjs');
    const ticket = findTicket('mission1', '1');
    const { done } = await startRewriter(dir, {
      kind: 'ticket', file: ticket.issuePath, addition: '\nwritten under the ticket lock\n', extra: ticket.dir,
    });
    transitionStatus(findTicket('mission1', '1'), 'queued', 'while another writer held the lock');
    const holder = await done;
    assert.equal(holder.code, 0, holder.err);

    const text = readFileSync(ticket.issuePath, 'utf8');
    assert.match(text, /written under the ticket lock/, 'the lock holder\'s write survived');
    assert.match(text, /^\*\*Status:\*\* queued$/m, 'and so did the transition that waited for it');
    assert.match(readFileSync(ticket.logPath, 'utf8'), /status: queued — while another writer held the lock/);
  });
});

test('writeText replaces a file whole: a reader never sees it empty or half-written', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  const file = join(dir, 'big.md');
  const full = (n) => `${n}${'x'.repeat(4 * 1024 * 1024)}\n`;
  writeFileSync(file, full(0));

  // A reader in its own process, reading as fast as it can while this one rewrites the file. On
  // Windows it rests a moment between reads: there a rename over a file another process holds open is
  // refused for as long as the handle lives, so a reader that never lets go would keep every write
  // out (renameReplacing waits two seconds, then gives up) — a real reader closes the file between
  // reads, and what is under test is only that each read sees one whole version.
  const rest = process.platform === 'win32' ? 15 : 0;
  const reader = spawn('node', ['--input-type=module', '-e', `
    import { readFileSync, existsSync } from 'node:fs';
    const file = ${JSON.stringify(file)};
    const stop = file + '.stop';
    let torn = 0; let reads = 0;
    while (!existsSync(stop)) {
      const text = readFileSync(file, 'utf8');
      reads += 1;
      if (text.length !== ${full(0).length}) torn += 1;
      if (${rest}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${rest});
    }
    process.stdout.write(JSON.stringify({ torn, reads }));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  reader.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((resolve) => { reader.on('close', resolve); });

  const { writeText } = await import('../_lib.mjs');
  sleepSync(100);
  for (let i = 1; i <= 80; i += 1) writeText(file, full(i % 10));
  writeFileSync(`${file}.stop`, '');
  await closed;

  const seen = JSON.parse(out);
  assert.ok(seen.reads > 0, 'the reader read the file at least once');
  assert.equal(seen.torn, 0, `${seen.torn} of ${seen.reads} reads caught the file part-written`);
});

test('a lease claim waits for a writer holding the leases lock, so neither lease is lost', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir, 'alpha');
  const leasesFile = join(dir, '.horde', 'leases.json');
  if (!existsSync(leasesFile)) writeFileSync(leasesFile, `${JSON.stringify({ leases: {}, history: [] }, null, 2)}\n`);

  const { done } = await startRewriter(dir, {
    kind: 'leases', file: leasesFile, addition: JSON.stringify({ 'held-elsewhere': { horde: 'alpha', since: '2026-09-27T00:00:00.000Z' } }),
  });
  const bound = run('node.mjs', ['bind', 'claimed-meanwhile', '--horde', 'alpha'], dir);
  const holder = await done;
  assert.equal(holder.code, 0, holder.err);
  assert.equal(bound.code, 0, bound.stderr);

  const { leases } = JSON.parse(readFileSync(leasesFile, 'utf8'));
  assert.ok(leases['held-elsewhere'], 'the lock holder\'s lease survived');
  assert.ok(leases['claimed-meanwhile'], 'and so did the claim that waited for it');
});

test('a spent "once" answer is marked under the decisions lock, so nothing recorded meanwhile is lost', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const path = join(dir, '.horde', 'hordes', 'mission1', 'decisions.md');
  const block = [
    '## 2026-09-27 · ask-lower-no-marker', '',
    '**Kind:** lower · **Aspect:** no-marker · **Scope:** once',
    '**Question:** may this branch demote the rule?',
    '**Answer:** approved — superseded.',
    '**By:** client · **At:** 2026-09-27T09:00:00Z', '',
  ].join('\n');
  writeFileSync(path, `# Decisions\n\n${block}`);

  await inRepo(dir, async () => {
    const { consumeAnswer } = await import('../land.mjs');
    const { done } = await startRewriter(dir, {
      kind: 'decisions', file: path, addition: '\n## 2026-09-27 · recorded-meanwhile\n\n**Decision:** kept.\n', extra: 'mission1',
    });
    consumeAnswer('mission1', { body: block, scope: 'once' }, '001', 'a'.repeat(40));
    const holder = await done;
    assert.equal(holder.code, 0, holder.err);
  });

  const text = readFileSync(path, 'utf8');
  assert.match(text, /recorded-meanwhile/, 'the entry recorded under the lock survived');
  assert.match(text, /\*\*Consumed:\*\* ticket 001 at a{40} on /, 'and so did the mark that waited for it');
});

// A "once" answer spent twice is said so, not passed over: the second consumeAnswer reports that
// the answer was already consumed and leaves the first mark alone.
test('consumeAnswer reports an answer another landing already spent', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const path = join(dir, '.horde', 'hordes', 'mission1', 'decisions.md');
  const block = [
    '## 2026-09-27 · ask-lower-twice', '',
    '**Kind:** lower · **Aspect:** no-marker · **Scope:** once',
    '**Answer:** approved — superseded.',
    '**By:** client · **At:** 2026-09-27T09:00:00Z', '',
  ].join('\n');
  writeFileSync(path, `# Decisions\n\n${block}`);

  await inRepo(dir, async () => {
    const { consumeAnswer } = await import('../land.mjs');
    const first = consumeAnswer('mission1', { body: block, scope: 'once' }, '001', 'a'.repeat(40));
    assert.equal(first.consumed, true);
    const second = consumeAnswer('mission1', { body: block, scope: 'once' }, '002', 'b'.repeat(40));
    assert.equal(second.consumed, false);
    assert.match(second.note, /already consumed \(ticket 001 at a{40}/);
  });
  const text = readFileSync(path, 'utf8');
  assert.equal((text.match(/\*\*Consumed:\*\*/g) || []).length, 1, 'marked once');
});

// A merge that happened stays a merge when the answer cannot be marked spent afterwards: the failure
// comes back as a note beside it, never as a throw that would skip the rest of the landing's record.
test('mergeSpendingAnswers: a mark that fails after the merge is a note, not a throw', { skip: process.getuid && process.getuid() === 0 ? 'root ignores the read-only directory this relies on' : false }, async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const hordeDir = join(dir, '.horde', 'hordes', 'mission1');
  const path = join(hordeDir, 'decisions.md');
  const block = [
    '## 2026-09-27 · ask-lower-unwritable', '',
    '**Kind:** lower · **Aspect:** no-marker · **Scope:** once',
    '**Answer:** approved — superseded.',
    '**By:** client · **At:** 2026-09-27T09:00:00Z', '',
  ].join('\n');
  writeFileSync(path, `# Decisions\n\n${block}`);

  await inRepo(dir, async () => {
    const { mergeSpendingAnswers } = await import('../land.mjs');
    let out;
    try {
      out = mergeSpendingAnswers('mission1', [{ body: block, scope: 'once' }], '001', 'a'.repeat(40), () => {
        // The merge succeeds, and then the file can no longer be replaced. A read-only directory does
        // that on POSIX; Windows ignores a directory's mode, but refuses a rename over a read-only file.
        if (process.platform === 'win32') chmodSync(path, 0o444);
        else chmodSync(hordeDir, 0o555);
        return { ok: true, sha: 'c'.repeat(40), note: 'merged' };
      });
    } finally {
      chmodSync(hordeDir, 0o755);
      chmodSync(path, 0o644);
    }
    assert.equal(out.merged.ok, true, 'the merge stands');
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0], /could not be marked spent/);
  });
});

// Moving a ticket to another team rewrites its issue.md and renames its directory. Both happen
// under the ticket's lock: between a release and the rename, another writer could take the lock
// on the old directory and write into a directory about to move out from under it.
test('tk.mjs move renames the ticket\'s directory while holding the ticket lock', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  newTicket(dir);
  const issues = join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'issues');
  // The real path, as the tools resolve `.horde/` through git: a temporary directory can sit behind a
  // symlink (macOS's /var is /private/var).
  const ticketDir = realpathSync(join(issues, readdirSync(issues).find((n) => n.startsWith('001-'))));
  const marker = join(dir, '.move-paused');
  // A nested team exists only in a mission started before 6.0.0; its roster entry is what makes one.
  writeFileSync(join(dir, '.horde', 'hordes', 'mission1', 'roster.json'), JSON.stringify({
    entries: [{ name: 'mission1-steward-allies-1', role: 'steward', team: 'allies', parent: 'trunk' }],
  }));

  const tk = join(dirname(fileURLToPath(import.meta.url)), '..', 'tk.mjs');
  const register = join(dirname(fileURLToPath(import.meta.url)), 'move-race', 'register.mjs');
  const child = spawn('node', ['--import', pathToFileURL(register).href, tk, 'move', '1', '--team', 'trunk/allies', '--json'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HORDE_MOVE_RACE_DIR: ticketDir, HORDE_MOVE_RACE_DELAY_MS: '1500', HORDE_MOVE_RACE_MARKER: marker,
    },
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => { child.on('close', resolve); });

  const deadline = Date.now() + 30000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error(`the move never reached its rename: ${err}`);
    await new Promise((r) => { setTimeout(r, 10); });
  }
  const lock = join(ticketDir, 'issue.md.lock');
  const heldDuringRename = existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf8')).pid : null;
  const code = await done;
  assert.equal(code, 0, err);
  assert.equal(heldDuringRename, child.pid, 'the ticket lock was held by the move while it renamed the directory');

  const moved = join(realpathSync(dir), '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'teams', 'allies', 'issues', basename(ticketDir));
  assert.ok(existsSync(join(moved, 'issue.md')), 'the ticket is in its new team');
  assert.equal(existsSync(join(moved, 'issue.md.lock')), false, 'with no lock left behind');
  assert.equal(existsSync(ticketDir), false, 'and nothing left at the old path');
});

// The fix loop's round number is read off the ticket's log, and the "changes" line that carries it
// is written to that same log. Both happen under the ticket lock, in one hold: counted before the
// lock, two transitions to "changes" at once both read the same last round and both write the next
// one, and one round of the loop's breaker goes uncounted.
test('a round of changes is counted from the log as it stands under the ticket lock', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  newTicket(dir);

  await inRepo(dir, async () => {
    const { findTicket } = await import('../tk.mjs');
    const ticket = findTicket('mission1', '1');
    // Another transition to "changes", holding the lock, counts round 1 while this one waits.
    const { done } = await startRewriter(dir, {
      kind: 'ticket',
      file: ticket.logPath,
      addition: `- ${new Date().toISOString()} status: changes — the other one (round 1/5 — resume same worker)\n`,
      extra: ticket.dir,
    });
    const r = run('tk.mjs', ['status', '1', 'changes', 'this one'], dir);
    const holder = await done;
    assert.equal(holder.code, 0, holder.err);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.round, 2, 'the round after the one counted while this transition waited');

    const rounds = [...readFileSync(ticket.logPath, 'utf8').matchAll(/\(round (\d+)\/5/g)].map((m) => Number(m[1]));
    assert.deepEqual(rounds, [1, 2], 'two transitions, two rounds — never the same one twice');
  });
});

test('the landing\'s and the loop\'s round go through the same locked count', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  newTicket(dir);

  await inRepo(dir, async () => {
    const { findTicket, advanceChangesRound } = await import('../tk.mjs');
    const ticket = findTicket('mission1', '1');
    const { done } = await startRewriter(dir, {
      kind: 'ticket',
      file: ticket.logPath,
      addition: `- ${new Date().toISOString()} status: changes — the other one (round 1/5 — resume same worker)\n`,
      extra: ticket.dir,
    });
    const info = advanceChangesRound('mission1', findTicket('mission1', '1'), 'gate red');
    const holder = await done;
    assert.equal(holder.code, 0, holder.err);
    assert.equal(info.refused, false);
    assert.equal(info.round, 2);
    assert.match(readFileSync(ticket.logPath, 'utf8'), /status: changes — gate red \(round 2\/5 — resume same worker\)/);
    assert.match(readFileSync(ticket.issuePath, 'utf8'), /^\*\*Status:\*\* changes$/m);
  });
});

test('a spent fix loop is refused inside the lock and writes nothing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  newTicket(dir);

  await inRepo(dir, async () => {
    const { findTicket, advanceChangesRound } = await import('../tk.mjs');
    const ticket = findTicket('mission1', '1');
    const rounds = [1, 2, 3, 4, 5].map((n) => `- 2026-09-27T10:0${n}:00.000Z status: changes — red (round ${n}/5 — x)\n`).join('');
    writeFileSync(ticket.logPath, rounds);
    const info = advanceChangesRound('mission1', ticket, 'red again');
    assert.equal(info.refused, true);
    assert.equal(info.round, 6);
    assert.equal(readFileSync(ticket.logPath, 'utf8'), rounds, 'the log is untouched');
    assert.doesNotMatch(readFileSync(ticket.issuePath, 'utf8'), /^\*\*Status:\*\* changes$/m);
  });
});

// charter.md is rewritten by the wave close, the mission's evidence stamps, a prototype's acceptance
// and the charter edit. Each reads the file, changes one part, and writes the whole file back, so
// each holds the charter lock across the three steps: a stamp written from a copy read before
// another writer's change would erase that change.
function charterWithRow(dir) {
  const path = join(dir, '.horde', 'hordes', 'mission1', 'charter.md');
  writeFileSync(path, [
    '# Mission · mission1', '', '## Acceptance — the evidence catalogue', '',
    '| id | evidence | node | reproduced by |', '|---|---|---|---|',
    '| E1 | `true` is green | api | |', '',
  ].join('\n'));
  return path;
}

test('wave.mjs evidence waits for a writer holding the charter lock, and both changes survive', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const path = charterWithRow(dir);

  const { done } = await startRewriter(dir, {
    kind: 'charter', file: path, addition: '\nwritten under the charter lock\n', extra: 'mission1',
  });
  const r = run('wave.mjs', ['evidence', 'E1', '--run', 'true'], dir);
  const holder = await done;
  assert.equal(holder.code, 0, holder.err);
  assert.equal(r.code, 0, r.stderr);

  const text = readFileSync(path, 'utf8');
  assert.match(text, /written under the charter lock/, 'the lock holder\'s write survived');
  assert.match(text, /\| E1 \| `true` is green \| api \| `true` passed at [0-9a-f]{7} \|/, 'and so did the stamp that waited for it');
});

test('tk.mjs accept waits for a writer holding the charter lock, and both changes survive', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const path = charterWithRow(dir);
  const proto = run('tk.mjs', [
    'new', 'board', '--title', 'Something to look at', '--node', 'api', '--class', 'standard', '--kind', 'prototype', '--evidence', 'E1',
  ], dir);
  assert.equal(proto.code, 0, proto.stderr);

  const { done } = await startRewriter(dir, {
    kind: 'charter', file: path, addition: '\nwritten under the charter lock\n', extra: 'mission1',
  });
  const r = run('tk.mjs', ['accept', proto.json.id, '--by', 'Anna Kowalska', '--sha256', 'b'.repeat(64)], dir);
  const holder = await done;
  assert.equal(holder.code, 0, holder.err);
  assert.equal(r.code, 0, r.stderr);

  const text = readFileSync(path, 'utf8');
  assert.match(text, /written under the charter lock/, 'the lock holder\'s write survived');
  assert.match(text, /Anna Kowalska/, 'and so did the acceptance that waited for it');
});
