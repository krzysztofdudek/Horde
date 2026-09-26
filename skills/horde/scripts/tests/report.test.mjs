// Issue 306: the client can see the mission without the director's chat. One plain-language page
// per horde (report.md), rewritten by tick, by a wave close and by every filed question; the
// config.notify hook run when a question is filed and when a wave closes; and the wave close's two
// pre-6.0.0 lines left out while they would only print a zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

const hordeDir = (dir) => join(dir, '.horde', 'hordes', 'mission1');

// The hook runs detached, so what it wrote arrives after the call that started it returned.
async function waitForText(path, re, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path) && re.test(readFileSync(path, 'utf8'))) return readFileSync(path, 'utf8');
    await new Promise((r) => { setTimeout(r, 100); });
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
const reportText = (dir) => readFileSync(join(hordeDir(dir), 'report.md'), 'utf8');

function withRows(dir) {
  const charterPath = join(hordeDir(dir), 'charter.md');
  const charter = readFileSync(charterPath, 'utf8').replace(
    '| | | | |',
    [
      '| E1 | a visitor can sign up with an email address | api | |',
      '| E2 | a signed-up visitor gets a welcome mail | api | |',
      '| E3 | the price page shows the yearly plan | web | the sales demo |',
    ].join('\n'),
  );
  writeFileSync(charterPath, charter);
}

function ticket(dir, id, status, evidenceId) {
  const dst = join(hordeDir(dir), 'teams', 'trunk', 'issues', `${id}-slug`);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'issue.md'), `# ${id} · Sign-up form\n\n**Status:** ${status}\n\n## Acceptance — evidence\n\n- [ ] covers ${evidenceId}\n`);
  writeFileSync(join(dst, 'log.md'), `- 2026-01-01 status: ${status}\n`);
}

// Nothing a client has to know the tool set to read: no script, no command, no branch.
function assertPlain(text) {
  assert.doesNotMatch(text, /\.mjs|\byg\b|--[a-z]|\/trunk|\btick\b|\bqueue\b/, text);
}

test('report.mjs: one plain page — what waits on the client, what has been proven, what landed', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  withRows(dir);
  ticket(dir, '002', 'running', 'E2');

  await t.test('written on request, to the horde and to --out', () => {
    const r = run('report.mjs', ['--out', 'client-report.md'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.schema, 'horde-report/1');
    assert.ok(existsSync(join(dir, 'client-report.md')));
    const text = reportText(dir);
    assert.equal(readFileSync(join(dir, 'client-report.md'), 'utf8'), text);
    assert.match(text, /## Waiting on you\n\nNothing\. No question is open\./);
    assert.match(text, /1 of 3 proven\./);
    assert.match(text, /- a visitor can sign up with an email address — \*\*not started\*\*/);
    assert.match(text, /- a signed-up visitor gets a welcome mail — \*\*being worked on\*\*/);
    assert.match(text, /- the price page shows the yearly plan — \*\*proven\*\*/);
    assertPlain(text);
  });

  await t.test('a filed question is on the page at once, in its own words', () => {
    const r = run('ask.mjs', ['add', 'Should a visitor without an email be allowed to sign up with a phone number?', '--kind', 'stop'], dir);
    assert.equal(r.code, 0, r.stderr);
    const text = reportText(dir);
    assert.match(text, new RegExp(`\\*\\*Question ${r.json.id}\\*\\* \\(asked [^;]+; the work cannot go on without your decision\\): Should a visitor without an email be allowed to sign up with a phone number\\?`));
    assertPlain(text);
  });

  await t.test('tick rewrites it every pass and says where', () => {
    const r = run('tick.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.report.path, /\/\.horde\/hordes\/mission1\/report\.md$/);
    const human = run('tick.mjs', [], dir, { json: false });
    assert.match(human.stdout, /client report: .*report\.md/);
  });

  await t.test('config.report.out puts a copy per horde where the client can open it', () => {
    run('horde.mjs', ['config', 'set', 'report.out', 'shared/<horde>-status.md'], dir);
    const r = run('tick.mjs', [], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'shared', 'mission1-status.md')), JSON.stringify(r.json.report));
  });
});

test('config.notify: run with the event filled in when a question is filed, whoever files it, and never stops the filing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const log = join(dir, 'notified.log');
  run('horde.mjs', ['config', 'set', 'notify', `printf '%s|%s|%s|%s|%s\\n' <event> <kind> <id> <horde> <text> >> "${log}"`], dir);

  await t.test('one line per question, the text passed as one argument whatever it holds', async () => {
    const r = run('ask.mjs', ['add', "It's the client's call: keep the old API? $(touch pwned)", '--kind', 'charter'], dir);
    assert.equal(r.code, 0, r.stderr);
    const text = await waitForText(log, /\n$/);
    assert.equal(text, `ask|charter|${r.json.id}|mission1|It's the client's call: keep the old API? $(touch pwned)\n`);
    assert.ok(!existsSync(join(dir, 'pwned')), 'nothing in the text was run');
  });

  await t.test('a hook that fails is written down, and the question is filed all the same', async () => {
    run('horde.mjs', ['config', 'set', 'notify', 'exit 3'], dir);
    const r = run('ask.mjs', ['add', 'A second question', '--kind', 'stop'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.notified.started, true);
    assert.match(await waitForText(join(hordeDir(dir), 'notify.log'), /exited 3/), /exited 3/);
    assert.equal(run('ask.mjs', ['list', '--open'], dir).json.length, 2);
  });

  await t.test('a hook that takes its time holds nothing up: the filing returns at once', () => {
    run('horde.mjs', ['config', 'set', 'notify', 'sleep 8'], dir);
    const started = Date.now();
    const r = run('ask.mjs', ['add', 'A third question', '--kind', 'stop'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - started < 5000, `returned in ${Date.now() - started}ms`);
  });

  // Review of 306: inside quotes of the template's own, the filled-in quoting would end the quote
  // and hand the question's text to the shell. Refused where it is set, and never run.
  await t.test('a placeholder inside quotes is refused where it is set', () => {
    for (const bad of ["echo '<text>'", 'notify-send "Horde: <text>"']) {
      const r = run('horde.mjs', ['config', 'set', 'notify', bad], dir);
      assert.equal(r.code, 1, bad);
      assert.match(r.stderr, /inside (single|double) quotes in config\.notify — .*write it bare/);
    }
  });

  await t.test('and one written into the config by hand is not run', () => {
    const cfgPath = join(dir, '.horde', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.notify = `echo '<text>' > "${join(dir, 'ran.txt')}"`;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const r = run('ask.mjs', ['add', 'A fourth question', '--kind', 'stop'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.notified.started, false);
    assert.match(r.json.notified.note, /inside single quotes/);
    assert.ok(!existsSync(join(dir, 'ran.txt')));
  });
});

test('wave.mjs close: the client is told and the page rewritten; the two pre-6.0.0 lines print nothing while they would say zero', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  const log = join(dir, 'notified.log');
  run('horde.mjs', ['config', 'set', 'notify', `printf '%s|%s|%s|%s\\n' <event> <kind> <id> <text> >> "${log}"`], dir);
  run('wave.mjs', ['start'], dir);
  const r = run('wave.mjs', ['close'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.report, /\/\.horde\/hordes\/mission1\/report\.md$/);
  assert.match(await waitForText(log, /wave-close/), /^wave-close\|wave\|1\|wave 1 closed — \d+\/\d+ evidence rows proven, gate /m);
  const plan = readFileSync(join(hordeDir(dir), 'plan.md'), 'utf8');
  const block = plan.slice(plan.lastIndexOf('# Wave 1 — close'));
  assert.doesNotMatch(block, /Escalated \(pre-6\.0\.0 legacy\)/);
  assert.doesNotMatch(block, /Keys transferred/);
  assert.match(block, /\*\*Merged:\*\* 0 tickets · \*\*Open:\*\*/);
});

test('report.mjs: what landed since the last report, once, and a row whose landed work came back says so', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);
  withRows(dir);
  ticket(dir, '002', 'merged', 'E2');
  ticket(dir, '003', 'merged', 'E1');
  const queuePath = join(hordeDir(dir), 'teams', 'trunk', 'queue.json');
  const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  queue.items = [
    { ticket: '002', state: 'merged', class: 'standard', branch: 'mission1/t-002', dependsOn: [], notes: [] },
  ];
  writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  mkdirSync(join(hordeDir(dir), 'land'), { recursive: true });
  writeFileSync(join(hordeDir(dir), 'land', '002.json'), JSON.stringify({ ticket: '002', ok: true, fates: [{ fate: 'reverted', by: 'abc1234', at: '2026-01-02' }] }));

  await t.test('the first report names it as landed since the last one', () => {
    run('report.mjs', [], dir);
    const text = reportText(dir);
    assert.match(text, /## Landed since the last report\n\n- Sign-up form\n/);
    assert.match(text, /1 piece\(s\) of work landed in all\./);
    assert.match(text, /- a signed-up visitor gets a welcome mail — \*\*came back — the work that landed for it was undone\*\*/);
  });

  await t.test('the next one does not name it again', () => {
    run('report.mjs', [], dir);
    assert.match(reportText(dir), /## Landed since the last report\n\nNothing new since /);
  });
});

