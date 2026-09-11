#!/usr/bin/env node
// horde skill — tick.mjs
//
// The steward, entirely, as a script. One run does four things in order and exits:
//
//   1. settles every branch a call left behind (reconcile),
//   2. puts every branch that is ready through the landing gate, and rules on what came back,
//   3. says what to start now — the dispatch list,
//   4. says whether the queue has emptied.
//
// Nothing lives between runs. There is no roster to keep alive, no liveness threshold, nothing to
// wake up, and no minute count anywhere in this file: a run that dies costs the next run nothing,
// because the next run reads the same state from disk and works out the same answers. That is the
// whole point — the two mission reports this closes are closed by removing the mechanism that
// needed tuning, not by tuning it.
//
// **Tick never spawns.** Whoever calls it spawns. Under the default runner the caller is the
// session itself: it runs tick, issues the calls on the dispatch list in one turn, and runs tick
// again once they come back. With `--runner external` the caller is a process outside any agent at
// all, starting workers through the host's own headless CLI (`config.runner.spawn`) so the loop
// survives a closed session. That is the entire difference the two runners make: WHO starts what
// this hands out, not whether the work can happen. Everything below is the same either way.
//
// What tick does write: the queue (reconcile's settlements, the gate's verdicts, and the state of
// what it just handed out), the fix-round counter on a ticket that came back red, `asks.json` when
// a ticket's rounds are spent, and one cost entry per thing it hands out. It holds the landing
// gate's own lock while it does — the same lock, not a second one, because two ticks on one
// repository must not hand the same ticket to two workers, and a second lock would not stop them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hordePath, teamPath, readJSON, writeJSON, readText, readConfig, nowIso, fail, parseArgs, emit,
  isMain, resolveHorde, git, resolveTree, withProvenance, provenanceLine,
} from './_lib.mjs';
import {
  loadQueue, saveQueue, reconcileRunning, rankedCandidates, recordMerged, startRunning, stackedLine,
} from './queue.mjs';
import {
  findTicket, parseField, changesRoundInfo, transitionStatus,
} from './tk.mjs';
import { readLandResult, acquireGateLock, gateLockWaitMs } from './land.mjs';
import { currentWaveNumber } from './wave.mjs';
import { asksPath, loadAsks, addAsk } from './ask.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
// Sub-teams are gone, so there is one queue and it is the trunk's. Nothing here takes --team: a
// second value would only be a way of pointing this at a queue that no longer exists.
const TEAM = 'trunk';
const RUNNERS = ['session', 'external'];

const USAGE = `usage: tick.mjs [--runner session|external] [--watch] [--stack]
                [--tree <path>] [--horde h] [--json]

One run: reconcile what a returned call left behind, put every ready branch through the gate, print
what to start now, and say whether the queue has emptied. Then it exits — nothing lives between
runs.

--json prints {tree, branch, sha, spawn: [{ticket, model, brief}], judge: [{ticket, pairs, brief}],
askClient: [{id, kind, why}], close: <bool>}. Everything on "spawn" has had its branch and worktree
cut already, so the brief command on it renders against a tree that exists; tick does not start the
agent, because the caller is what starts agents.

--stack also hands out a ticket whose unmerged dependencies are all on a branch in this horde,
started from one of those tips. Such an entry carries the line "STACKED, parent t-NNN unmerged" so
nobody reads it as ready.

--runner names who is spinning the loop, and only "external" changes what this script does: it
starts each worker itself through config.runner.spawn. "session" (the default) starts nothing — the
caller does.

--watch repeats the run every config.tick.interval seconds until the queue empties or a signal
arrives. A signal exits cleanly: no lock left held, nothing half-written.

options: --json  --help`;

// ---- asks.json ---------------------------------------------------------------------------
//
// The client's own in-tray (ask.mjs, 019): the questions this horde cannot answer for itself.
// Tick is one of two writers — the other is a worker filing "stop" through the same tool — and
// the only one that ever files "stuck": a ticket whose fix rounds are spent.
//
// Read defensively on purpose, unlike ask.mjs's own strict reader: a missing file is the ordinary
// state (nothing has ever been asked) and must read as an empty in-tray rather than a refusal; an
// unreadable one reads the same way, for the same reason the landing gate's result file does — a
// document that records something is never a substitute for the thing it records, so the worst a
// bad read costs here is a question asked twice.
function loadAsksSafe(horde) {
  try {
    const doc = JSON.parse(readFileSync(asksPath(horde), 'utf8'));
    return doc && Array.isArray(doc.items) ? doc : { items: [] };
  } catch {
    return { items: [] };
  }
}

function openAsks(horde) {
  return loadAsksSafe(horde).items
    .filter((a) => a && a.state === 'open')
    .map((a) => ({ id: a.id, kind: a.kind, why: a.why }));
}

// One ask per (kind, ticket) while it is open: a ticket that is stuck stays stuck across every
// later run, and re-filing the same question every five minutes is how an in-tray stops being
// read. The write itself goes through ask.mjs's own addAsk, so the id comes from the one shared
// counter and asks.md renders alongside asks.json exactly as every other write to it does.
function fileAsk(horde, { kind, ticket, why, log }) {
  const existing = loadAsksSafe(horde).items.find((a) => a.kind === kind && a.ticket === ticket && a.state === 'open');
  if (existing) return { ask: existing, filed: false };
  const ask = addAsk(horde, { kind, ticket, why, log });
  return { ask, filed: true };
}

// ---- the queue, read once and named when it is broken ------------------------------------
//
// A queue.json caught half-written is the one state this tool must never "recover" from. The queue
// IS the mission's state, and `{items: []}` written over a truncated document loses every ticket in
// it silently — the worst failure mode this tool has. So the read refuses, names the file, and
// writes nothing at all.
function readQueue(horde) {
  try {
    return loadQueue(horde, TEAM);
  } catch (e) {
    fail(`${e.message}\nNothing was changed. ${teamPath(horde, TEAM, 'queue.json')} is the mission's own state, `
      + 'and tick will not write an empty queue over one it could not read — restore the file (git, a backup, or by hand) and run again.');
    return null;
  }
}

// ---- cost ---------------------------------------------------------------------------------
//
// Every worker and every judge this run hands out is one run somebody pays for, so it is booked the
// moment it goes on the list, in the shape the deleted roster tool used to write:
// `{name, role, class, ticket, wave, at}`. `cost.mjs` reads it unchanged.
//
// Booked at most once per ticket, per wave, per role — the key, deliberately not the timestamp:
// two runs against a state nothing changed must leave the ledger exactly as they found it, and two
// ticks racing each other must not bill the same worker twice. A fix round is a genuinely new run
// of a new worker, so the round number rides in `name` and makes its own key: round 0 is the plain
// `(ticket, wave, role)` the contract names, and nothing below it can be double-booked.
function costKey(entry) {
  return `${entry.role}|${entry.ticket}|${entry.wave === null || entry.wave === undefined ? '' : entry.wave}|${entry.name}`;
}

function bookCost(horde, entries) {
  if (!entries.length) return [];
  const path = hordePath(horde, 'cost.json');
  const doc = readJSON(path, { runs: [] });
  if (!Array.isArray(doc.runs)) doc.runs = [];
  const seen = new Set(doc.runs.map(costKey));
  const added = [];
  for (const e of entries) {
    const key = costKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = {
      name: e.name, role: e.role, class: e.class, ticket: e.ticket, wave: e.wave, at: nowIso(),
    };
    doc.runs.push(row);
    added.push(row);
  }
  if (added.length) writeJSON(path, doc);
  return added;
}

function waveNumber(horde) {
  return currentWaveNumber(readText(hordePath(horde, 'plan.md'))) || null;
}

// ---- 2. land what is ready ----------------------------------------------------------------

function landCommand(horde, ticket) {
  return ['node', join(SCRIPTS, 'land.mjs'), ticket, '--background', '--horde', horde, '--json'];
}

function startGate(horde, ticket, root) {
  const [, ...args] = landCommand(horde, ticket);
  try {
    const out = execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out);
    return { started: true, resultFile: parsed.resultFile || null, note: null };
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr).trim() : String((e && e.message) || e);
    return { started: false, resultFile: null, note: stderr };
  }
}

// The gate's own words for a red result, in the order the checks ran.
function redWords(result) {
  const red = (result.checks || []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.note}`);
  return red.join(' · ') || 'the gate came back red without naming a check';
}

// A landed item's branch decides everything here, so it has to exist. A branch that vanished under
// a recorded result is somebody's `git branch -D` or a checkout nobody expected, and there is no
// safe guess: a green result for a branch that is gone would otherwise merge a sha nothing can be
// read off any more. Checked for every landed item before a single one is touched, so a refusal
// never lands in the middle of a half-applied pass.
function assertLandedBranches(horde, doc, root) {
  for (const item of doc.items) {
    if (item.state !== 'landed' || !item.branch) continue;
    if (git(['rev-parse', '--verify', item.branch], root) !== null) continue;
    fail(`queue item ${item.ticket} is "landed" on branch ${item.branch}, and ${item.branch} no longer exists in this repository. `
      + 'Nothing was changed, and no result recorded against it is trusted — a landing that merged this branch would have left the item merged, '
      + `so work out what happened to ${item.branch} before running tick again.`);
  }
}

function landTheLanded(horde, cfg, root) {
  const doc = readQueue(horde);
  assertLandedBranches(horde, doc, root);

  const plan = [];
  for (const item of doc.items) {
    if (item.state !== 'landed') continue;
    if (!item.branch) {
      plan.push({ ticket: item.ticket, action: 'skipped', note: 'landed with no branch — nothing to put through the gate' });
      continue;
    }
    const tip = git(['rev-parse', '--verify', item.branch], root);
    const result = readLandResult(horde, item.ticket);
    // Absent, truncated mid-write (readLandResult reads that as absent, on purpose), or recorded
    // against a sha the branch has since moved past: all three mean the same thing — there is no
    // answer about the branch as it stands now — and all three get the same one, which is to ask
    // the gate again rather than to trust a record of some other commit.
    if (!result || result.sha !== tip) {
      plan.push({
        ticket: item.ticket,
        action: 'gate',
        note: result ? `the recorded result is about ${result.sha}, and ${item.branch} now stands at ${tip} — running the gate again` : `no readable gate result for ${item.branch} at ${tip} — running the gate`,
      });
      continue;
    }
    if (result.ok) {
      plan.push({
        ticket: item.ticket, action: 'merge', sha: (result.landed && result.landed.sha) || tip, note: `the gate came back green on ${tip}`,
      });
      continue;
    }
    plan.push({ ticket: item.ticket, action: 'red', words: redWords(result), note: null });
  }

  const results = [];
  // The gates first: they start a detached process and touch no state, so nothing below depends on
  // the order and a refusal further down leaves no half-started run behind.
  for (const step of plan.filter((s) => s.action === 'gate')) {
    const started = startGate(horde, step.ticket, root);
    results.push({
      ticket: step.ticket,
      action: started.started ? 'gate' : 'gate-refused',
      note: started.started ? `${step.note} (result will be written to ${started.resultFile})` : `could not start the gate: ${started.note}`,
      resultFile: started.resultFile,
    });
  }

  // Each merge is its own write — recordMerged owns the queue document while it applies one, and
  // writes the wave-journal bullet in the same breath, which is the whole reason it is called
  // rather than reimplemented here.
  for (const step of plan.filter((s) => s.action === 'merge')) {
    const { journal } = recordMerged(horde, TEAM, step.ticket, step.sha, { tree: root });
    results.push({
      ticket: step.ticket, action: 'merged', sha: step.sha, note: `${step.note} — merged, journal: ${journal.bullet}`,
    });
  }

  const reds = plan.filter((s) => s.action === 'red');
  if (reds.length) {
    const fresh = readQueue(horde);
    for (const step of reds) {
      const item = fresh.items.find((i) => i.ticket === step.ticket);
      if (!item) continue;
      const ticket = findTicket(horde, step.ticket);
      const roundInfo = ticket ? changesRoundInfo(horde, ticket) : { refused: false, round: 1 };
      if (roundInfo.refused) {
        // The rounds are spent, including the ones a fresh worker was given, so another round would
        // be a state pretending to be progress. The ticket stops here and the client is asked —
        // there is no escalation path to take instead, and inventing one would only be this tool
        // ruling on a product decision that was never its to rule on.
        item.state = 'blocked';
        item.notes.push({ at: nowIso(), text: `tick: ${roundInfo.message}` });
        if (ticket) transitionStatus(ticket, 'blocked', `fix rounds spent — ${step.words}`);
        const { ask, filed } = fileAsk(horde, {
          kind: 'stuck',
          ticket: step.ticket,
          why: `${roundInfo.message} The gate's last words: ${step.words}`,
          log: ticket ? ticket.logPath : null,
        });
        results.push({
          ticket: step.ticket, action: 'blocked', ask: ask.id, note: `${roundInfo.message}${filed ? ` Filed as ${ask.id} (stuck).` : ` Already filed as ${ask.id}.`}`,
        });
        continue;
      }
      // A round the landing gate already counted is not counted again here: the gate writes the
      // ticket's "changes" line with the round number in it the moment it comes back red, and a
      // second write would tick the counter for one red gate twice. The status is only written
      // when nothing wrote it — a result read back after a run that died before recording it.
      if (ticket && parseField(ticket.text, 'Status') !== 'changes') {
        transitionStatus(ticket, 'changes', step.words, roundInfo);
      }
      item.state = 'queued';
      item.notes.push({ at: nowIso(), text: `tick: gate red (round ${roundInfo.round}/${roundInfo.cap} — ${roundInfo.label}) — ${step.words}` });
      results.push({
        ticket: step.ticket, action: 'changes', round: roundInfo.round, note: `gate red, round ${roundInfo.round}/${roundInfo.cap} (${roundInfo.label}) — ${step.words}`,
      });
    }
    saveQueue(horde, TEAM, fresh);
  }

  return results;
}

// ---- 3. the dispatch list ------------------------------------------------------------------

// The name a run is booked under, and the name the brief is rendered for. A fix round is a new run
// of a new worker on the same ticket, so it carries the round: that is what keeps the ledger honest
// without letting two ticks over one unchanged state bill the same worker twice.
function workerName(ticket, round) {
  return round > 0 ? `w-${ticket}-r${round}` : `w-${ticket}`;
}

function briefCommand(horde, ticket, name, worktree, takeover) {
  const parts = ['node', join(SCRIPTS, 'brief.mjs'), 'worker', ticket, '--name', name, '--horde', horde];
  if (worktree) parts.push('--tree', worktree);
  if (takeover) parts.push('--takeover');
  return parts.join(' ');
}

// How many rounds of changes this ticket has already been through: changesRoundInfo answers with
// the round the NEXT one would be, so the rounds behind it are one less. Zero for a ticket that has
// never come back red, which is every ticket the first time it is handed out.
function priorRounds(horde, ticketId) {
  const ticket = findTicket(horde, ticketId);
  if (!ticket) return { prior: 0, ticket: null, info: null };
  const info = changesRoundInfo(horde, ticket);
  return { prior: Math.max(0, info.round - 1), ticket, info };
}

function dispatch(horde, cfg, root, flags) {
  const doc = readQueue(horde);
  const parallelism = Number(cfg.parallelism ?? 6);
  const running = doc.items.filter((i) => i.state === 'running').length;
  // The knob says how many workers run at once, so what is already running counts against it —
  // otherwise every run would hand out a full list on top of the last one's and the number would
  // mean nothing at all.
  const budget = Math.max(0, parallelism - running);
  const { picked } = rankedCandidates(horde, TEAM, {
    stack: !!flags.stack, tree: root, limit: budget,
  });

  const out = [];
  for (const candidate of picked || []) {
    const id = candidate.item.ticket;
    const { prior, ticket, info } = priorRounds(horde, id);
    // "resume the same worker" and "a fresh worker, one class heavier" are the two shapes a fix
    // round takes; the brief's own --takeover section is what the second is briefed with.
    const takeover = !!(info && prior > 0 && prior >= Number(info.resume ?? 3));
    const started = startRunning(horde, TEAM, id, {
      tree: root,
      on: candidate.stackOn && candidate.stackOn.length ? candidate.stackOn[0] : undefined,
      agent: workerName(id, prior),
    });
    out.push({
      ticket: id,
      model: (ticket && parseField(ticket.text, 'Class')) || started.class || null,
      brief: briefCommand(horde, id, workerName(id, prior), started.worktree, takeover),
      stacked: stackedLine(candidate.stackOn),
      worktree: started.worktree,
      branch: started.branch,
      round: prior,
    });
  }
  return out;
}

// Every prose pair the landing gate handed back rather than judged. Only under `config.judge:
// one-shot` — under "tier" the repository has a reviewer of its own and an unjudged pair is a
// finding about that reviewer, not work to hand somebody.
function judgeList(horde, cfg, doc) {
  if (cfg.judge !== 'one-shot') return [];
  const out = [];
  for (const item of doc.items) {
    const result = readLandResult(horde, item.ticket);
    if (!result || !Array.isArray(result.pairs) || result.pairs.length === 0) continue;
    out.push({ ticket: item.ticket, pairs: result.pairs, brief: result.brief || null });
  }
  return out;
}

// ---- 4. close ------------------------------------------------------------------------------
//
// Tick raises the flag and names the command; closing the wave is that command's own job. The
// narrower of the two readings on purpose: this run's four things do not include ruling that a
// mission is over.
function closeCommand(horde) {
  return `node ${join(SCRIPTS, 'wave.mjs')} close --horde ${horde}`;
}

// ---- the external runner -------------------------------------------------------------------
//
// The only place this script starts anything that is not git or one of its own tools, and only
// under `--runner external`: a loop outside any agent has nobody to hand a dispatch list to, so it
// starts the workers itself through the host's own headless CLI. The command line is the operator's
// (`config.runner.spawn`), with `<class>` and `<brief>` filled in.
function externalStart(horde, cfg, entries, root) {
  const template = cfg.runner && cfg.runner.spawn;
  const started = [];
  for (const entry of entries) {
    const path = hordePath(horde, 'briefs', `${entry.ticket}.md`);
    let text;
    try {
      text = execFileSync(process.execPath, [join(SCRIPTS, 'brief.mjs'), 'worker', entry.ticket, '--name', `w-${entry.ticket}`, '--horde', horde, '--tree', entry.worktree], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      started.push({ ticket: entry.ticket, started: false, note: `could not render the brief: ${e && e.stderr ? String(e.stderr).trim() : e}` });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    const command = String(template).split('<class>').join(entry.model || '').split('<brief>').join(path);
    const child = spawnProcess('sh', ['-c', command], { cwd: root, detached: true, stdio: 'ignore' });
    child.unref();
    started.push({
      ticket: entry.ticket, started: true, brief: path, command,
    });
  }
  return started;
}

// ---- one run --------------------------------------------------------------------------------

function runOnce(horde, cfg, flags, runner) {
  const info = resolveTree({ tree: flags.tree }, { cwd: process.cwd() });
  const root = info.path;
  // The landing gate's lock, not a second one: two ticks on one repository would otherwise settle
  // the same branch twice, hand the same ticket to two workers and bill both.
  const lock = acquireGateLock('tick', null, { waitMs: gateLockWaitMs(cfg) });
  if (!lock.ok) fail(lock.note);
  try {
    // Read before anything is written: a queue.json caught half-written refuses here, cleanly,
    // naming the file, while every other read below is safe because this one passed.
    readQueue(horde);
    const reconciled = reconcileRunning(horde, TEAM, { tree: root });
    const landed = landTheLanded(horde, cfg, root);
    const spawn = dispatch(horde, cfg, root, flags);

    const doc = readQueue(horde);
    const judge = judgeList(horde, cfg, doc);
    const wave = waveNumber(horde);
    const booked = bookCost(horde, [
      ...spawn.map((s) => ({
        name: workerName(s.ticket, s.round), role: 'worker', class: s.model, ticket: s.ticket, wave,
      })),
      ...judge.map((j) => ({
        // A judge is billed at the class that answers the pairs, and under one-shot — the only
        // policy that puts anything on this list — that is a judge called once for this ticket,
        // not the repository's own reviewer tier. Recorded as "one-shot" rather than guessed at a
        // model name this tool was never told.
        name: `judge-${j.ticket}`, role: 'judge', class: 'one-shot', ticket: j.ticket, wave,
      })),
    ]);

    const close = doc.items.every((i) => i.state === 'merged');
    const external = runner === 'external' ? externalStart(horde, cfg, spawn, root) : [];

    return withProvenance({
      horde,
      runner,
      reconciled,
      landed,
      spawn: spawn.map((s) => ({
        ticket: s.ticket, model: s.model, brief: s.brief, stacked: s.stacked, worktree: s.worktree, branch: s.branch,
      })),
      judge,
      askClient: openAsks(horde),
      close,
      closeCommand: close ? closeCommand(horde) : null,
      cost: booked,
      external,
    }, info);
  } finally {
    lock.release();
  }
}

function render(out) {
  const lines = [];
  for (const r of out.reconciled) lines.push(`reconciled ${r.ticket} -> ${r.state} · ${r.note}`);
  for (const l of out.landed) lines.push(`gate ${l.ticket}: ${l.action} · ${l.note}`);
  if (out.spawn.length) {
    lines.push(`spawn (${out.spawn.length}):`);
    for (const s of out.spawn) {
      lines.push(`  ${s.ticket} (${s.model}) — ${s.brief}`);
      if (s.stacked) lines.push(`  ${s.stacked}`);
    }
  } else {
    lines.push('spawn: (nothing ready)');
  }
  for (const j of out.judge) lines.push(`judge ${j.ticket}: ${j.pairs.length} prose pair(s) waiting`);
  for (const a of out.askClient) lines.push(`ask client ${a.id} (${a.kind}): ${a.why}`);
  for (const e of out.external) lines.push(`started ${e.ticket}: ${e.started ? e.command : e.note}`);
  if (out.cost.length) lines.push(`cost: ${out.cost.length} new entr${out.cost.length === 1 ? 'y' : 'ies'}`);
  lines.push(out.close ? `close: the queue holds nothing unmerged — ${out.closeCommand}` : 'close: not yet');
  lines.push(provenanceLine({ path: out.tree, branch: out.branch, sha: out.sha }));
  return lines.join('\n');
}

// ---- --watch ---------------------------------------------------------------------------------
//
// The loop, for a runner with nowhere else to live. Each pass acquires and releases the gate lock
// inside runOnce, so a signal between passes finds nothing held; a signal during one is handled
// after that pass's own `finally` has already let go. Interrupted, this exits 0 with the queue
// exactly as the last completed pass left it.
async function watch(horde, cfg, flags, runner) {
  const seconds = Number((cfg.tick && cfg.tick.interval) ?? 300);
  const interval = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 300000;
  let stop = false;
  let wake = null;
  const onSignal = () => {
    stop = true;
    if (wake) wake();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  for (;;) {
    const out = runOnce(horde, cfg, flags, runner);
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else console.log(render(out));
    if (stop || out.close) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, interval);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    wake = null;
    if (stop) break;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv, { flags: ['watch', 'stack'] });
  if (flags.help) { console.log(USAGE); process.exit(0); }

  const horde = resolveHorde(flags);
  const cfg = readConfig() || {};
  const runner = flags.runner || (cfg.runner && cfg.runner.kind) || 'session';
  if (!RUNNERS.includes(runner)) fail(`unknown runner: ${runner} (runners: ${RUNNERS.join(', ')})`);
  // A loop that starts nothing is worse than no loop: it looks like it is working. Refused here,
  // naming the key to set, before a single thing is read.
  if (runner === 'external' && !(cfg.runner && cfg.runner.spawn)) {
    fail('runner "external" starts each worker itself, and config.runner.spawn names no command to start one with. '
      + 'Set it to the host\'s own headless CLI — "<class>" is filled in with the ticket\'s class and "<brief>" with the path of the rendered brief, for example:\n'
      + `  node ${join(SCRIPTS, 'horde.mjs')} config set runner.spawn "claude -p --model <class> < <brief>"`);
  }

  if (flags.watch) {
    watch(horde, cfg, flags, runner).catch((e) => fail(e.message));
    return;
  }
  const out = runOnce(horde, cfg, flags, runner);
  emit(out, flags, () => render(out));
}

if (isMain(import.meta.url)) main();
