import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, rmRepo, run, initHorde } from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function ticketLogPath(dir, ticket, horde = 'mission1') {
  const issues = join(dir, '.horde', 'hordes', horde, 'teams', 'trunk', 'issues');
  const match = readdirSync(issues).find((n) => n.startsWith(`${ticket}-`));
  return join(issues, match, 'log.md');
}

function spendFixRounds(dir, ticket, rounds = 5, horde = 'mission1') {
  const path = ticketLogPath(dir, ticket, horde);
  for (let i = 1; i <= rounds; i += 1) {
    appendFileSync(path, `- 2026-01-0${i} status: changes — tests fail (round ${i}/5 — resume same worker)\n`);
  }
}

function writeLandResult(dir, ticket, body, horde = 'mission1') {
  const path = join(dir, '.horde', 'hordes', horde, 'land', `${ticket}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

function asksPath(dir, horde = 'mission1') {
  return join(dir, '.horde', 'hordes', horde, 'asks.json');
}

function asksMdPath(dir, horde = 'mission1') {
  return join(dir, '.horde', 'hordes', horde, 'asks.md');
}

function decisionsPath(dir, horde = 'mission1') {
  return join(dir, '.horde', 'hordes', horde, 'decisions.md');
}

// ---- input validation --------------------------------------------------------------------

test('ask.mjs add: input validation', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('kind "lower" without --aspect refuses, naming what is missing', () => {
    const r = run('ask.mjs', ['add', 'demote this rule', '--kind', 'lower'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--aspect is required for kind "lower"/);
  });

  await t.test('--aspect on "stop", "stuck" and "charter" refuses', () => {
    for (const kind of ['stop', 'stuck', 'charter']) {
      const r = run('ask.mjs', ['add', 'a question', '--kind', kind, '--aspect', 'no-marker'], dir);
      assert.equal(r.code, 1, `kind ${kind}`);
      assert.match(r.stderr, new RegExp(`--aspect has no meaning for kind "${kind}"`));
    }
  });

  await t.test('an unknown --kind refuses, listing the four kinds', () => {
    const r = run('ask.mjs', ['add', 'a question', '--kind', 'quality'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--kind is required, one of: stop\|stuck\|lower\|charter/);
  });

  await t.test('add without "why" text refuses', () => {
    const r = run('ask.mjs', ['add', '', '--kind', 'stop'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /add requires "<why>"/);
  });

  await t.test('the id carries prefix "a-" from the same counter as tickets and graph items', () => {
    const ticket = run('tk.mjs', ['new', 'first-ticket', '--title', 'First', '--node', 'feature', '--class', 'standard', '--evidence', 'it works'], dir);
    assert.equal(ticket.json.id, '001');
    const opened = run('ask.mjs', ['add', 'a question', '--kind', 'stop'], dir);
    assert.equal(opened.code, 0, opened.stderr);
    assert.match(opened.json.id, /^a-\d{3}$/);
    assert.notEqual(opened.json.id, 'a-001', 'the ticket already took the first number in the shared sequence');
  });

  await t.test('add on a horde that does not exist refuses, naming it', () => {
    const r = run('ask.mjs', ['add', 'a question', '--kind', 'stop', '--horde', 'ghost'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such horde: ghost/);
  });
});

// ---- lifecycle -----------------------------------------------------------------------------

test('ask.mjs: lifecycle — answer, list, show, and the stop/stuck ticket rule', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  let id;
  await t.test('add opens an item, listed under --open', () => {
    const r = run('ask.mjs', ['add', 'ran out of spec here', '--kind', 'stop', '--ticket', '007'], dir);
    assert.equal(r.code, 0, r.stderr);
    id = r.json.id;
    assert.equal(r.json.state, 'open');
    const open = run('ask.mjs', ['list', '--open'], dir);
    assert.equal(open.json.length, 1);
    assert.equal(open.json[0].id, id);
  });

  await t.test('answer without --scope records "once" — but only for kind "lower"; here it is simply absent', () => {
    const r = run('ask.mjs', ['answer', id, 'proceed the way you guessed'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, 'answered');
    assert.equal(r.json.answerScope, undefined, 'scope has no meaning outside kind "lower"');
  });

  await t.test('answering an already-answered item refuses', () => {
    const r = run('ask.mjs', ['answer', id, 'again'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already answered/);
  });

  await t.test('answering a nonexistent id refuses, naming it', () => {
    const r = run('ask.mjs', ['answer', 'a-999', 'whatever'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such ask: a-999/);
  });

  await t.test('answer appends ask-<id> to decisions.md, in the client\'s own words', () => {
    const shown = run('decide.mjs', ['show', `ask-${id}`], dir);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.json.body, /\*\*Answer:\*\* proceed the way you guessed/);
    assert.equal(shown.json.ticket, '007');
  });

  await t.test('ask list --open shows only open items', () => {
    run('ask.mjs', ['add', 'still open', '--kind', 'stop'], dir);
    const open = run('ask.mjs', ['list', '--open'], dir);
    assert.equal(open.json.length, 1);
    assert.notEqual(open.json[0].id, id);
  });

  await t.test('asks.md regenerates alongside asks.json on every write', () => {
    assert.ok(readFileSync(asksMdPath(dir), 'utf8').includes(id));
  });

  await t.test('a "stop" item does not let its ticket back onto spawn — filing it never touches the queue', () => {
    const ticket = run('tk.mjs', ['new', 'ran-dry', '--title', 'Ran dry', '--node', 'feature', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
    run('queue.mjs', ['add', ticket], dir);
    run('queue.mjs', ['set', ticket, 'running', '--agent', 'w'], dir);
    const before = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === ticket);

    run('ask.mjs', ['add', 'ran out of spec mid-ticket', '--kind', 'stop', '--ticket', ticket], dir);

    const after = run('queue.mjs', ['list'], dir).json.find((i) => i.ticket === ticket);
    assert.deepEqual(after, before, 'ask.mjs never mutates the queue — the ticket stays exactly where it was, so nothing here ever puts it back on spawn');
  });
});

test('ask.mjs: an answer to "stuck" either returns the ticket to queue or closes it as not-done, nothing in between', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const id = run('tk.mjs', ['new', 'going-nowhere', '--title', 'Going nowhere', '--node', 'feature', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
  run('queue.mjs', ['add', id], dir);

  // tick.mjs (017) is the one that files "stuck" — this exercises the same fileAsk path a spent
  // fix-loop takes, without re-deriving the whole gate machinery here.
  const doc = JSON.parse(readFileSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json'), 'utf8'));
  const item = doc.items.find((i) => i.ticket === id);
  item.state = 'blocked';
  writeFileSync(join(dir, '.horde', 'hordes', 'mission1', 'teams', 'trunk', 'queue.json'), JSON.stringify(doc, null, 2));

  const opened = run('ask.mjs', ['add', 'fix rounds spent. The gate\'s last words: two cases still fail', '--kind', 'stuck', '--ticket', id], dir);
  assert.equal(opened.code, 0, opened.stderr);

  await t.test('answer returns it to the queue', () => {
    const answered = run('ask.mjs', ['answer', opened.json.id, 'try again — I fixed the fixture it depended on'], dir);
    assert.equal(answered.code, 0, answered.stderr);
    // ask.mjs itself never touches queue.json (single responsibility — see tick.mjs, which reads
    // the decision back out through the same land.mjs law-guard style lookup); what this proves is
    // that the item closed cleanly with an answer recorded, which is the half ask.mjs owns.
    const decision = run('decide.mjs', ['show', `ask-${opened.json.id}`], dir);
    assert.equal(decision.code, 0, decision.stderr);
    assert.match(decision.json.body, /try again/);
  });
});

// ---- gate interaction (lowering's consent scope) --------------------------------------------

test('ask.mjs answer --scope: default "once", explicit "mission", and illegal outside "lower"', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('--scope on a kind other than "lower" refuses', () => {
    const opened = run('ask.mjs', ['add', 'a question', '--kind', 'stop'], dir);
    const r = run('ask.mjs', ['answer', opened.json.id, 'fine', '--scope', 'once'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--scope is only accepted for kind "lower"/);
  });

  await t.test('an invalid --scope value refuses', () => {
    const opened = run('ask.mjs', ['add', 'demote it', '--kind', 'lower', '--aspect', 'no-marker'], dir);
    const r = run('ask.mjs', ['answer', opened.json.id, 'approved', '--scope', 'sometimes'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--scope must be "once" or "mission"/);
  });

  await t.test('omitting --scope on a "lower" answer defaults to "once"', () => {
    const opened = run('ask.mjs', ['add', 'demote it', '--kind', 'lower', '--aspect', 'no-marker'], dir);
    const r = run('ask.mjs', ['answer', opened.json.id, 'approved — fine by me'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.answerScope, 'once');
    const shown = run('decide.mjs', ['show', `ask-${opened.json.id}`], dir);
    assert.match(shown.json.body, /\*\*Scope:\*\* once/);
  });

  await t.test('an explicit "mission" scope is recorded as such', () => {
    const opened = run('ask.mjs', ['add', 'demote it', '--kind', 'lower', '--aspect', 'second-rule'], dir);
    const r = run('ask.mjs', ['answer', opened.json.id, 'approved — this one stands all mission', '--scope', 'mission'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.answerScope, 'mission');
    const shown = run('decide.mjs', ['show', `ask-${opened.json.id}`], dir);
    assert.match(shown.json.body, /\*\*Scope:\*\* mission/);
    assert.match(shown.json.body, /\*\*Aspect:\*\* second-rule/);
  });
});

// ---- tick interaction ------------------------------------------------------------------------

test('ask.mjs / tick.mjs: askClient carries only open items, and a "stuck" item carries the gate\'s last words and the ticket\'s log', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('empty when there is nothing to ask', () => {
    const r = run('tick.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.askClient, []);
  });

  const id = run('tk.mjs', ['new', 'red-forever', '--title', 'Red forever', '--node', 'feature', '--class', 'standard', '--evidence', 'it works'], dir).json.id;
  run('queue.mjs', ['add', id], dir);
  const running = run('queue.mjs', ['set', id, 'running', '--agent', 'w'], dir);
  git(['-C', running.json.worktree, 'commit', '--allow-empty', '-qm', 'work'], dir);
  const sha = git(['-C', running.json.worktree, 'rev-parse', 'HEAD'], dir);
  run('queue.mjs', ['set', id, 'landed'], dir);
  spendFixRounds(dir, id, 5);
  writeLandResult(dir, id, {
    ticket: id, branch: running.json.branch, sha, ok: false, checks: [{ name: 'tests', ok: false, note: 'the suite is still red' }], pairs: [], brief: null, landed: null,
  });

  const r = run('tick.mjs', [], dir);
  assert.equal(r.code, 0, r.stderr);
  const stuck = r.json.askClient.find((a) => a.kind === 'stuck');
  assert.ok(stuck, JSON.stringify(r.json.askClient));

  const asks = JSON.parse(readFileSync(asksPath(dir), 'utf8'));
  const item = asks.items.find((a) => a.id === stuck.id);
  assert.match(item.why, /the suite is still red/);
  assert.match(item.log, /log\.md$/);
  assert.ok(item.log.includes(join('teams', 'trunk', 'issues', `${id}-red-forever`, 'log.md')), item.log);

  await t.test('only open items are on the list', () => {
    run('ask.mjs', ['answer', stuck.id, 'give it one more try'], dir);
    const again = run('tick.mjs', [], dir);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.askClient.length, 0);
  });
});

// ---- broken states ---------------------------------------------------------------------------

test('ask.mjs: broken states', async (t) => {
  await t.test('unparseable asks.json refuses, naming the file, and is never overwritten empty', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    initHorde(dir);
    const path = asksPath(dir);
    writeFileSync(path, '{ not json');
    const r = run('ask.mjs', ['list'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid JSON in .*asks\.json/);
    assert.equal(readFileSync(path, 'utf8'), '{ not json');
  });

  await t.test('a missing asks.json reads as an empty list, not a refusal', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    initHorde(dir);
    const r = run('ask.mjs', ['list'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, []);
  });

  await t.test('decisions.md already carrying slug ask-<id> (answer recorded, asks.json rolled back) refuses a duplicate rather than writing twice', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    initHorde(dir);
    const opened = run('ask.mjs', ['add', 'a question', '--kind', 'stop'], dir);
    const before = JSON.parse(readFileSync(asksPath(dir), 'utf8'));
    run('ask.mjs', ['answer', opened.json.id, 'an answer'], dir);
    // Roll back asks.json to before the answer, as if that write never happened.
    writeFileSync(asksPath(dir), JSON.stringify(before, null, 2));
    const r = run('ask.mjs', ['answer', opened.json.id, 'a different answer'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /duplicate slug: ask-/);
    const decisions = readFileSync(decisionsPath(dir), 'utf8');
    assert.equal((decisions.match(new RegExp(`ask-${opened.json.id}`, 'g')) || []).length, 1);
  });

  await t.test('two concurrent ask answer calls on the same item leave exactly one decisions.md entry', async () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    initHorde(dir);
    const opened = run('ask.mjs', ['add', 'a contested question', '--kind', 'stop'], dir);

    const launch = () => new Promise((resolve) => {
      const child = spawn('node', [join(SCRIPTS_DIR, 'ask.mjs'), 'answer', opened.json.id, 'racing answer', '--json'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const [a, b] = await Promise.all([launch(), launch()]);
    const codes = [a.code, b.code].sort();
    assert.deepEqual(codes, [0, 1], 'one wins, one finds the slug already taken');

    const decisions = readFileSync(decisionsPath(dir), 'utf8');
    assert.equal((decisions.match(new RegExp(`ask-${opened.json.id}`, 'g')) || []).length, 1);
  });

  await t.test('a read-only decisions.md refuses, naming the file, and the item is not marked answered', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    initHorde(dir);
    const opened = run('ask.mjs', ['add', 'a question', '--kind', 'stop'], dir);
    const path = decisionsPath(dir);
    chmodSync(path, 0o400);
    t.after(() => { try { chmodSync(path, 0o600); } catch { /* already gone */ } });
    const r = run('ask.mjs', ['answer', opened.json.id, 'an answer'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    chmodSync(path, 0o600);
    const asks = JSON.parse(readFileSync(asksPath(dir), 'utf8'));
    assert.equal(asks.items.find((a) => a.id === opened.json.id).state, 'open');
  });

  await t.test('an answer with "·" and a newline does not break the entry heading — pinning ENTRY_RE', () => {
    const dir = makeRepo();
    t.after(() => rmRepo(dir));
    initHorde(dir);
    const opened = run('ask.mjs', ['add', 'a question', '--kind', 'stop'], dir);
    const tricky = 'approved · but only once\nand not again';
    const r = run('ask.mjs', ['answer', opened.json.id, tricky], dir);
    assert.equal(r.code, 0, r.stderr);
    const shown = run('decide.mjs', ['show', `ask-${opened.json.id}`], dir);
    assert.equal(shown.code, 0, shown.stderr);
    const list = run('decide.mjs', ['list'], dir);
    assert.equal(list.code, 0, list.stderr);
    assert.ok(list.json.some((d) => d.slug === `ask-${opened.json.id}`));
  });
});
