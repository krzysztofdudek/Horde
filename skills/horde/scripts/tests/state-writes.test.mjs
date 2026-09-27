// The state files more than one process rewrites: a ticket's issue.md and log.md, the shared
// leases.json, and a mission's decisions.md. Each is a read-modify-write, and each is measured
// here against a second writer that holds the file's lock across its own read and write-back
// (lock-race/rewriter.mjs). A writer that honours the lock waits and then works on the file as it
// stands, so both changes survive. One that does not writes inside the other's hold and is erased.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // A reader in its own process, reading as fast as it can while this one rewrites the file.
  const reader = spawn('node', ['--input-type=module', '-e', `
    import { readFileSync, existsSync } from 'node:fs';
    const file = ${JSON.stringify(file)};
    const stop = file + '.stop';
    let torn = 0; let reads = 0;
    while (!existsSync(stop)) {
      const text = readFileSync(file, 'utf8');
      reads += 1;
      if (text.length !== ${full(0).length}) torn += 1;
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
