#!/usr/bin/env node
// horde skill — tick.mjs
//
// The steward, entirely, as a script. One run does four things in order and exits:
//
//   1. settles every branch a call left behind (reconcile),
//   2. puts every branch that is ready through its one review and then the landing gate, and rules
//      on what came back,
//   3. says what to start now — the dispatch list,
//   4. says whether the queue has emptied.
//
// Nothing lives between runs. There is no roster to keep alive, no liveness threshold, nothing to
// wake up, and no minute count anywhere in this file: a run that dies costs the next run nothing,
// because the next run reads the same state from disk and works out the same answers. That is the
// whole point — the two mission reports this closes are closed by removing the mechanism that
// needed tuning, not by tuning it.
//
// **Under `session` (the default), tick never spawns — the caller does.** Your own turn runs tick,
// issues the calls on the dispatch list, and runs tick again whenever it likes: a ticket whose worker
// has left no evidence of ending (its "landed <sha>" or "stopped: <why>" line, a dead pid, the
// director's --reclaim) is
// shown as working and left alone, so a run between two returns costs a worker nothing. **Under
// `--runner external`, tick.mjs spawns each worker itself**, through the host's own headless CLI
// (`config.runner.spawn`), because nobody outside any agent is there to take a dispatch list and
// issue the calls — so the loop survives a closed session. That is the entire difference the two
// runners make: WHO starts what this hands out, not whether the work can happen. Everything below
// is the same either way.
//
// What tick does write: the queue (reconcile's settlements, the gate's verdicts, when a ticket's one
// review was raised, and the state of what it just handed out), the fix-round counter on a ticket
// that came back red or was sent back by its review, and `asks.json` when a ticket's rounds are
// spent or a landing waits on a decision only the user can make. It holds the landing gate's own
// lock while it does — the same lock, not a second one, because two ticks on one repository must
// not hand the same ticket to two workers, and a second lock would not stop them.

import {
  readFileSync, writeFileSync, mkdirSync, openSync, closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hordePath, teamPath, readText, readConfig, nowIso, fail, HordeError, parseArgs, emit,
  isMain, resolveHorde, git, resolveTree, withProvenance, provenanceLine, withQueueLock,
  runMain, appendText, parseEvidenceRows, classUp, processAlive,
} from './_lib.mjs';
import {
  loadQueue, saveQueue, reconcileRunning, rankedCandidates, recordMerged, startRunning, stackedLine, recordWorkerRun,
} from './queue.mjs';
import {
  findTicket, parseField, changesRoundInfo, lastChangesRoundInfo, transitionStatus, ticketEvidence, readReview,
} from './tk.mjs';
import { readLandResult, acquireGateLock, gateLockWaitMs, landingLoad, landingLine } from './land.mjs';
import { asksPath, loadAsks, addAsk } from './ask.mjs';
import { mentionsEvidenceId } from './wave.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
// Sub-teams are gone, so there is one queue and it is the trunk's. Nothing here takes --team: a
// second value would only be a way of pointing this at a queue that no longer exists.
const TEAM = 'trunk';
const RUNNERS = ['session', 'external'];

const USAGE = `usage: tick.mjs [--runner session|external] [--watch] [--stack] [--reclaim NNN[,MMM]]
                [--tree <path>] [--horde h] [--json]

One run: reconcile what an ended worker left behind, put every ready branch through the gate, print
what to start now, and say whether the queue has emptied. Then it exits — nothing lives between
runs.

A ticket handed out is held by its worker until there is evidence the worker ended: its last line,
tk.mjs log NNN "landed <sha> — …" (or "stopped: <why>" when it stops without landing), in the
ticket's log since it started; the process this tick
started for it gone (--runner external); or --reclaim NNN, the director saying a worker came back
without that line. Until then the ticket is listed on "working" and nothing is committed, removed
or handed out again for it — so tick can run while workers are still working.

Reconcile, the gate and the dispatch list all run in the tree --tree names; without it, cwd —
whatever the calling shell already sits on — same as an ordinary read anywhere else in this tool
set, not this horde's trunk just because a horde was resolvable. --horde h WRITTEN OUT is what
changes that: on its own (no --tree) it resolves to that horde's own trunk worktree instead, exactly
as queue.mjs plan/quality already read it. A bare tick.mjs call — the boot sequence's own — carries
neither flag, so it inherits whatever tree the session is already in.

--json prints {tree, branch, sha, reconciled: [{ticket, state, note}], working: [{ticket, note}],
spawn: [{ticket, model, brief}], review: [{ticket, model, name, brief}], askClient: [{id, kind,
why}], held: [{ticket, ask, kind, holds, note}], close: <bool>}. Everything on "spawn" has had its branch and worktree cut already, so
the brief command on it renders against a tree that exists; tick does not start the agent, because
the caller is what starts agents.

Every ticket gets one review, after its worker and before its landing: the run that first finds its
branch ready for the gate puts it on "review" instead of asking the gate, on the ticket's own class.
The gate then waits — shown on "landed" as "review-waiting", every run, with no timer — until the
ticket's log carries the review's closing line (tk.mjs review-close) or the director's skip with a
reason (tk.mjs review-skip). Then the gate is asked whatever the review found, except that a
Critical or Important finding it logged before that line sends the ticket back to "changes" with a
round counted, as a red gate does; a Minor one never does. The closing line only counts findings,
and nothing reads it as a pass. A fix round goes to the gate with no second review.

A gate this run starts is recorded on the queue item as {pid, sha, at}: a landing does its slow
half (the revert test, the guards) before it takes the gate lock and writes no result until it is
done, so nothing else on disk says the branch is being landed. While that process lives and the
branch has not moved, a later run shows the ticket on "landed" as "gate-running" and does not ask
again; a pid that is gone with no result is a landing that died, and is asked again.

A branch the landing refused as stale (the parent does not merge into it) goes back with no round
counted, and its next worker is briefed on the files the merge stopped on. The second time the same
files stop it, the ticket goes to "blocked" and one "stuck" ask names them: nothing in the loop has
resolved them twice, so it is the client's question now. A landing whose only red was the prose
verdicts its own catch-up merge made stale ("rejudge") also goes back with no round, briefed to
refresh those verdicts; a second one in a row counts its round like any red gate. A landing red
only on a decision the user has to make ("waitingOnUser" in its result: no reviewer configured for
the prose rules, or one that could not be reached) counts no round either: the ticket goes to
"blocked", and one "stuck" ask naming no ticket puts the decision to the client once for the whole
horde. Once it is answered, the next run sends every ticket it held back to a worker, with the
answer in its brief and still no round counted.

An open ask holds only what depends on its answer, and "held" says what each one held: "stop"
everything — the dispatch list, every landing and the close — "stuck" that one ticket, "charter"
every ticket earning an evidence row the question names, "lower" that one branch's landing.
Everything else goes out as usual.

--stack also hands out a ticket whose unmerged dependencies are all on a branch in this horde,
started from one of those tips. Such an entry carries the line "STACKED, parent t-NNN unmerged" so
nobody reads it as ready.

--runner names who is spinning the loop, and only "external" changes what this script does: it
starts each worker itself through config.runner.spawn, and each review the same way. "session" (the
default) starts nothing — the caller does.

--watch repeats the run every config.tick.interval seconds until the queue empties or a signal
arrives — an open "stop" holds the close, so it keeps waiting rather than exiting on an emptied
queue the client still has a question about. A signal exits cleanly: no lock left held, nothing
half-written.

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

// A decision only the user can make — configuring a reviewer, or putting the rules it would judge on
// hold — is asked once per horde, not once per ticket that meets it: it names no ticket, and every
// ticket it holds points at it from its queue item. The same gap met again while the question is
// open finds that question, by its words.
function userDecisionWhy(waiting) {
  return `Landings wait on a decision only you can make: ${waiting.text}. `
    + 'Every ticket that meets it stops at the gate with no fix round counted, and goes back to its worker once this is answered.';
}

function fileUserDecision(horde, waiting) {
  const why = userDecisionWhy(waiting);
  const existing = loadAsksSafe(horde).items.find((a) => a && a.kind === 'stuck' && !a.ticket && a.state === 'open' && a.why === why);
  if (existing) return { ask: existing, filed: false };
  return { ask: addAsk(horde, { kind: 'stuck', why }), filed: true };
}

// The tickets a user decision held, released once it is answered: each goes back to a worker with
// the answer in its brief (brief.mjs, "The user decided"), and no round is counted — the wait was
// never the ticket's. Run before anything is landed or dispatched, so the same run hands them out.
function releaseDecided(horde) {
  const answered = new Map(loadAsksSafe(horde).items
    .filter((a) => a && a.state === 'answered').map((a) => [a.id, a]));
  const doc = readQueue(horde);
  const waiting = doc.items.filter((i) => i.state === 'blocked' && i.returnReason
    && i.returnReason.kind === 'waiting-on-user' && answered.has(i.returnReason.ask));
  if (!waiting.length) return [];
  const out = [];
  withQueueLock(horde, TEAM, () => {
    const fresh = readQueue(horde);
    for (const item of fresh.items) {
      const reason = item.returnReason;
      if (item.state !== 'blocked' || !reason || reason.kind !== 'waiting-on-user') continue;
      const ask = answered.get(reason.ask);
      if (!ask) continue;
      item.state = 'queued';
      item.returnReason = {
        kind: 'user-decided', text: reason.text, ask: ask.id, answer: ask.answer || '', at: nowIso(),
      };
      item.notes.push({ at: nowIso(), text: `tick: ${ask.id} answered — back to a worker, no round counted` });
      const ticket = findTicket(horde, item.ticket);
      if (ticket) transitionStatus(ticket, 'changes', `the user answered ${ask.id}: ${ask.answer || '(no words)'} — back to its worker, no round counted`);
      out.push({
        ticket: item.ticket, action: 'released', ask: ask.id, round: null, note: `the user answered ${ask.id} — back to its worker, no round counted`,
      });
    }
    saveQueue(horde, TEAM, fresh);
  });
  return out;
}

// ---- what an open question holds up ---------------------------------------------------------
//
// An open ask is a question the client has not answered yet, and a client who is not at their desk
// must not cost the mission the work that question has nothing to do with. So each kind holds up
// exactly what depends on the answer, and tick hands out the rest:
//
//   stop     everything, unqualified — the widest kind there is, and the ruling on it is exactly
//            that: the dispatch list, every branch's landing, and the close. A worker ran out of
//            spec, so the ground the next step would stand on is the thing being asked about, and
//            nothing new goes out, nothing merges and no wave closes until the client rules. A
//            call already in flight still comes back and reconciles — that is a branch settling,
//            not the mission taking another step.
//   stuck    that one ticket. Its fix rounds are spent; the rest of the queue never knew.
//   charter  every ticket that earns an evidence row the question names, read by id off the
//            charter's own catalogue the way `charter edit` reads it. A ticket the question does
//            not name goes out as usual, and a question naming no row holds nothing.
//   lower    the landing of that one branch, and nothing else. The work is done and the only
//            question is whether a rule may be weakened to let it in, so the branch waits at the
//            gate while the queue keeps moving — and the fix rounds a red law guard would spend on
//            it are not spent on a question only the client can answer.
//
// Nothing here writes: a hold is a fact about what is open right now, recomputed every run, so an
// answered question releases what it held on the next tick with no state to unwind.
//
// Holding a landing means not asking the gate, not refusing to write the answer down afterwards:
// land.mjs merges the branch into its parent ITSELF the moment every item comes back green. By the
// time a result file exists the merge has already happened, so the only place a landing can be
// held is before the gate is started at all. The same reading spares the ticket its fix rounds: a
// gate that came back red would count one and put the ticket back out, which is the mission taking
// a step on a question nobody in it can answer.

function firstLine(text) {
  return String(text || '').split('\n')[0].trim();
}

function holdNote(ask, what) {
  return `${what} while ask ${ask.id} (${ask.kind}) is open: ${firstLine(ask.why)}`;
}

// The catalogue ids a "charter" question names. Read by word-boundary match against the charter's
// own rows — the same reading horde.mjs's `charter edit --ask` already does, so "E1" means the
// same row in the question there and here.
function rowsNamedBy(rowIds, ask) {
  return rowIds.filter((id) => mentionsEvidenceId(ask.why || '', id));
}

function askHolds(horde, doc) {
  const open = loadAsksSafe(horde).items.filter((a) => a && a.state === 'open');
  const everything = open.filter((a) => a.kind === 'stop');
  const dispatch = new Map();
  const landing = new Map();

  for (const ask of open) {
    if (!ask.ticket) continue;
    if (ask.kind === 'stuck') dispatch.set(String(ask.ticket), ask);
    if (ask.kind === 'lower') landing.set(String(ask.ticket), ask);
  }

  const charterAsks = open.filter((a) => a.kind === 'charter');
  if (charterAsks.length) {
    const rowIds = parseEvidenceRows(readText(hordePath(horde, 'charter.md')) || '')
      .map((r) => r.id).filter(Boolean);
    const naming = charterAsks
      .map((ask) => ({ ask, ids: rowsNamedBy(rowIds, ask) }))
      .filter((n) => n.ids.length);
    for (const item of doc.items) {
      if (dispatch.has(item.ticket)) continue;
      const ticket = findTicket(horde, item.ticket);
      if (!ticket) continue;
      const earns = ticketEvidence(ticket.text);
      const by = naming.find((n) => earns.some((id) => n.ids.includes(id)));
      if (by) dispatch.set(item.ticket, by.ask);
    }
  }

  return { everything, dispatch, landing };
}

function heldEntry(ask, { ticket, holds, note }) {
  return {
    ticket: ticket || null, ask: ask.id, kind: ask.kind, holds, note,
  };
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

// ---- 2. land what is ready ----------------------------------------------------------------
//
// One `land.mjs` call for every ticket this pass found ready, not one call per ticket: land.mjs
// (080) does its own non-overlap/same-parent batching internally, sharing one run of its own
// expensive items across as many of them as it safely can and falling every other one back to
// landing on its own — this loop only has to gather the ready set and hand it over once. Nothing
// about WHICH tickets are ready, or what tick does with the answer, changed to make this true.

function landCommand(horde, tickets) {
  return ['node', join(SCRIPTS, 'land.mjs'), tickets.join(','), '--background', '--horde', horde, '--json'];
}

// startGate(horde, tickets, root) — one `land.mjs --background` call for the whole list, read back
// into one breakdown per ticket, in the caller's own order. land.mjs replies with today's
// single-ticket shape ({ticket, branch, resultFile}) whenever exactly one ticket was actually
// asked for — including when a longer list narrowed to one because land.mjs itself refused every
// other ticket in it inline — and with the batch shape ({items: [...]}) for two or more; either
// way this reads back the same per-ticket {ticket, started, resultFile, note}, so the caller below
// never has to know which shape land.mjs actually sent. A ticket the reply does not mention at all
// (a shape neither of the above ever produces in practice, but never assumed away) is reported the
// same as one land.mjs itself could not start.
function startGate(horde, tickets, root) {
  const [, ...args] = landCommand(horde, tickets);
  try {
    const out = execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out);
    const items = Array.isArray(parsed.items)
      ? parsed.items
      : [{
        ticket: parsed.ticket, branch: parsed.branch, resultFile: parsed.resultFile || null, pid: parsed.pid || null, started: true, note: null,
      }];
    const byTicket = new Map(items.map((it) => [String(it.ticket), it]));
    return tickets.map((t) => {
      const it = byTicket.get(String(t));
      return it
        ? {
          ticket: t, started: !!it.started, resultFile: it.resultFile || null, pid: it.pid || null, note: it.note || null,
        }
        : {
          ticket: t, started: false, resultFile: null, note: 'land.mjs did not report on this ticket',
        };
    });
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr).trim() : String((e && e.message) || e);
    return tickets.map((t) => ({
      ticket: t, started: false, resultFile: null, note: stderr,
    }));
  }
}

// The gate's own words for a red result, in the order the checks ran.
function redWords(result) {
  const red = (result.checks || []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.note}`);
  return red.join(' · ') || 'the gate came back red without naming a check';
}

// ---- the one review a ticket gets, before its gate ---------------------------------------------
//
// Nothing reads a gate for sense: whether a change does what its ticket asks, stays inside it and
// proves it with tests that can fail is what no check measures. So every ticket's change is read
// once, by a one-shot, after its worker and before its first gate — and that one-shot is given no
// way to approve anything, on purpose. Its only outputs are findings, and one closing line that
// counts them; the ticket goes to the gate either way, and nothing here reads the closing line as a
// pass: what happens next depends on the findings alone, so a lazy review can never make a diff
// nobody read look safer than it is.
//
// The queue item carries the record: `review: {name, sha, raisedAt, closedAt}`. `raisedAt` is when
// a run handed the review out; from then the gate waits until the log shows the review ended — its
// closing line (`tk.mjs review-close`) or the director's skip with a reason (`tk.mjs review-skip`).
// There is no timer: a review that never closes shows as waiting on every run until somebody closes
// or skips it. `closedAt` is when the loop moved on — to the gate, or back to a worker — and from
// then on nothing the review wrote is acted on again, so a finding that arrives late, or one already
// answered by a fix round, never sends the same ticket back twice. A ticket is reviewed once: a fix
// round goes to the gate with nothing raised in front of it.

function reviewName(ticket) {
  return `r-${ticket}`;
}

// The argv the review's brief is rendered with — an array for the same reason briefCommandParts is.
// It reads the tree this run reads, so the reviewer sees the rules this run's gate would hold the
// branch to.
function reviewCommandParts(horde, ticket, root) {
  return [join(SCRIPTS, 'brief.mjs'), 'review', ticket, '--name', reviewName(ticket), '--horde', horde, '--tree', root];
}

const SENDS_BACK = new Set(['Critical', 'Important']);

// Where a landed branch stands with its review: null when none has been raised (the caller raises
// it instead of asking the gate), `waiting` while the raised review has not ended, `sendBack` when it
// ended with a Critical or Important finding, and a plain step to the gate otherwise.
function reviewedGateStep(horde, item) {
  if (!item.review) return null;
  if (item.review.closedAt) return { closeReview: false, end: null };
  const ticket = findTicket(horde, item.ticket);
  const said = readReview(ticket ? readText(ticket.logPath) : '', item.review.raisedAt);
  if (!said.end) return { waiting: true };
  const serious = said.findings.filter((f) => f.severities.some((s) => SENDS_BACK.has(s)));
  if (serious.length === 0) return { closeReview: true, end: said.end };
  return { sendBack: serious.map((f) => f.text).join(' · '), counted: said.status };
}

// The landing this item started and has not finished: its record names the sha it was started on, and
// the process is still alive. A pid that is gone with no result written is a landing that died, which
// is asked again like any other missing answer.
function gateInFlight(item, tip) {
  const g = item.gate;
  return !!(g && g.sha === tip && Number.isInteger(g.pid) && g.pid > 0 && processAlive(g.pid));
}

function reviewWaitingNote(item) {
  const { name, raisedAt, sha } = item.review;
  return `waiting on its review ${name}, raised ${raisedAt} on ${sha} — the gate is asked once the review logs its closing line `
    + `(tk.mjs review-close ${item.ticket} --by ${name}), or once the director skips it with a reason (tk.mjs review-skip ${item.ticket} "<why>" --by <name>)`;
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

function landTheLanded(horde, cfg, root, holds) {
  const doc = readQueue(horde);
  assertLandedBranches(horde, doc, root);

  const plan = [];
  const held = [];
  for (const item of doc.items) {
    if (item.state !== 'landed') continue;
    // A "lower" question holds this one branch's landing; a "stop" holds every one of them, being
    // the wider kind. Either way the gate is not asked, so nothing merges, no round is counted and
    // the item stays exactly where it is — a red law guard would otherwise spend this ticket's fix
    // rounds on a question no worker can answer.
    const heldBy = holds.landing.get(item.ticket) || holds.everything[0];
    if (heldBy) {
      held.push(heldEntry(heldBy, {
        ticket: item.ticket, holds: 'landing', note: holdNote(heldBy, `${item.ticket} waits at the gate`),
      }));
      continue;
    }
    if (!item.branch) {
      plan.push({ ticket: item.ticket, action: 'skipped', note: 'landed with no branch — nothing to put through the gate' });
      continue;
    }
    const tip = git(['rev-parse', '--verify', item.branch], root);
    const result = readLandResult(horde, item.ticket);
    // Absent, truncated mid-write (readLandResult reads that as absent, on purpose), or recorded
    // against a sha the branch has since moved past: all three mean the same thing — there is no
    // answer about the branch as it stands now — and all three get the same one, which is to ask
    // the gate again rather than to trust a record of some other commit. Once, before the first of
    // those asks, the ticket's review is raised instead; see "the one review a ticket gets" above.
    if (!result || result.sha !== tip) {
      const reviewed = reviewedGateStep(horde, item);
      if (!reviewed) {
        plan.push({
          ticket: item.ticket, action: 'review', sha: tip, note: `its review is raised on ${tip} — the gate is asked once it logs its closing line`,
        });
        continue;
      }
      if (reviewed.waiting) {
        plan.push({ ticket: item.ticket, action: 'review-waiting', note: reviewWaitingNote(item) });
        continue;
      }
      if (reviewed.sendBack) {
        plan.push({
          ticket: item.ticket, action: 'red', source: 'review', words: reviewed.sendBack, counted: reviewed.counted, note: null,
        });
        continue;
      }
      const skipped = reviewed.end && reviewed.end.kind === 'skipped'
        ? `its review was skipped by ${reviewed.end.by} (${reviewed.end.reason}); `
        : '';
      // A landing does its slow half — the revert test, the guards — before it takes the gate lock, and
      // writes no result until it is done, so for all of that time nothing on disk says this branch is
      // being landed. The run that started it left the pid on the item; while that process lives and the
      // branch has not moved, asking again would be a second landing of the same commit.
      if (gateInFlight(item, tip)) {
        plan.push({
          ticket: item.ticket,
          action: 'gate-running',
          note: `its gate is still running — started ${item.gate.at} as pid ${item.gate.pid} on ${tip}; asking again would land the same commit twice`,
        });
        continue;
      }
      plan.push({
        ticket: item.ticket,
        action: 'gate',
        sha: tip,
        closeReview: reviewed.closeReview,
        note: `${skipped}${result ? `the recorded result is about ${result.sha}, and ${item.branch} now stands at ${tip} — running the gate again` : `no readable gate result for ${item.branch} at ${tip} — running the gate`}`,
      });
      continue;
    }
    if (result.ok) {
      plan.push({
        ticket: item.ticket, action: 'merge', sha: (result.landed && result.landed.sha) || tip, note: `the gate came back green on ${tip}`,
      });
      continue;
    }
    plan.push({
      ticket: item.ticket,
      action: 'red',
      source: 'gate',
      stale: !!result.stale,
      conflictFiles: Array.isArray(result.conflictFiles) ? result.conflictFiles : [],
      rejudge: !!result.rejudge,
      waitingOnUser: result.waitingOnUser && typeof result.waitingOnUser === 'object' ? result.waitingOnUser : null,
      pairs: Array.isArray(result.pairs) ? result.pairs : [],
      sha: result.sha,
      words: redWords(result),
      note: null,
    });
  }

  // A review still open writes nothing and starts nothing: it is only said, every run, until it ends.
  const results = plan.filter((s) => s.action === 'review-waiting' || s.action === 'gate-running')
    .map((s) => ({ ticket: s.ticket, action: s.action, note: s.note }));
  const reviews = [];
  // The review's own record is written before anything is started, under the queue lock like every
  // other write to it: a review raised, or one the loop is moving past to the gate. Written first so
  // that a gate started below is never a gate whose review could still send the ticket back.
  const reviewSteps = plan.filter((s) => s.action === 'review' || s.closeReview);
  if (reviewSteps.length) {
    withQueueLock(horde, TEAM, () => {
      const fresh = readQueue(horde);
      for (const step of reviewSteps) {
        const item = fresh.items.find((i) => i.ticket === step.ticket);
        if (!item) continue;
        const at = nowIso();
        if (step.action === 'review') {
          item.review = {
            name: reviewName(step.ticket), sha: step.sha, raisedAt: at, closedAt: null,
          };
          item.notes.push({ at, text: `tick: review raised on ${step.sha} (${reviewName(step.ticket)}) — the gate is asked on the next run` });
        } else if (item.review && !item.review.closedAt) {
          item.review.closedAt = at;
        }
      }
      saveQueue(horde, TEAM, fresh);
    });
    for (const step of plan.filter((s) => s.action === 'review')) {
      const ticket = findTicket(horde, step.ticket);
      const item = doc.items.find((i) => i.ticket === step.ticket);
      const parts = reviewCommandParts(horde, step.ticket, root);
      reviews.push({
        ticket: step.ticket,
        role: 'review',
        // The review reads on the ticket's own class: the class is a field of the ticket, chosen
        // once for the whole of it, not a choice made in flight for this one read.
        model: (ticket && parseField(ticket.text, 'Class')) || (item && item.class) || null,
        name: reviewName(step.ticket),
        brief: ['node', ...parts].join(' '),
        briefParts: parts,
        briefFile: `${step.ticket}-review.md`,
      });
      results.push({ ticket: step.ticket, action: 'review', note: step.note });
    }
  }

  // The gates first: they start a detached process and touch no state, so nothing below depends on
  // the order and a refusal further down leaves no half-started run behind. One land.mjs call for
  // the whole ready set — not one per ticket — is what lets non-overlapping tickets share a single
  // run of its own expensive items instead of paying for one each.
  const gateSteps = plan.filter((s) => s.action === 'gate');
  if (gateSteps.length) {
    const started = startGate(horde, gateSteps.map((s) => s.ticket), root);
    const byTicket = new Map(started.map((s) => [s.ticket, s]));
    // Written before this run lets go of the gate lock, so the next run — which has to take that lock
    // to start at all — always finds it.
    const marked = started.filter((s) => s.started && s.pid);
    if (marked.length) {
      withQueueLock(horde, TEAM, () => {
        const fresh = readQueue(horde);
        for (const s of marked) {
          const item = fresh.items.find((i) => i.ticket === s.ticket);
          const step = gateSteps.find((g) => g.ticket === s.ticket);
          if (item && step) item.gate = { pid: s.pid, sha: step.sha, at: nowIso() };
        }
        saveQueue(horde, TEAM, fresh);
      });
    }
    for (const step of gateSteps) {
      const s = byTicket.get(step.ticket);
      results.push({
        ticket: step.ticket,
        action: s.started ? 'gate' : 'gate-refused',
        note: s.started ? `${step.note} (result will be written to ${s.resultFile})` : `could not start the gate: ${s.note}`,
        resultFile: s.resultFile,
      });
    }
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

  // A red gate and a review's Critical or Important finding send a ticket back the same way: to
  // "changes", with a round counted against the same cap. Only who said it differs, and the words.
  const reds = plan.filter((s) => s.action === 'red');
  if (reds.length) {
    // Read, mutate every red item and write back, all under the queue lock: two ticks landing
    // red gates on one team at once must not each read the same queue and overwrite the other's
    // update.
    withQueueLock(horde, TEAM, () => {
      const fresh = readQueue(horde);
      for (const step of reds) {
        const item = fresh.items.find((i) => i.ticket === step.ticket);
        if (!item) continue;
        // A branch land refused as stale — the parent moved and does not merge into it — was not gated and
        // is not wrong: it goes back to be brought up to date, with no round counted, so a fix loop is
        // never spent on a merge somebody else's landing made necessary.
        //
        // Except that a merge nobody resolves comes back the same way every time: the worker stops at
        // the conflict, reconcile finds its commits, the gate is stale again — forever, with no round
        // to trip the breaker and nobody asked. So a stale return names the files the merge stopped on,
        // the next worker's brief hands them over to resolve, and the second return on the same files
        // stops the ticket and asks the client once, naming them.
        if (step.stale) {
          const stale = findTicket(horde, step.ticket);
          const files = [...step.conflictFiles].sort();
          if (files.length) {
            const key = files.join('\n');
            const history = Array.isArray(item.staleConflicts) ? item.staleConflicts : [];
            const repeated = history.some((h) => Array.isArray(h.files) && [...h.files].sort().join('\n') === key);
            item.staleConflicts = [...history, { sha: step.sha || null, files, at: nowIso() }];
            if (repeated) {
              const why = `The parent does not merge into ${item.branch}: the catch-up merge stopped on ${files.join(', ')} `
                + 'twice, and neither the landing\'s rules nor the worker sent back to resolve them did. Somebody has to decide how those files come together.';
              item.state = 'blocked';
              item.notes.push({ at: nowIso(), text: `tick: stale on the same files twice (${files.join(', ')}) — blocked, the client is asked` });
              if (stale) transitionStatus(stale, 'blocked', `catch-up conflict repeated — ${files.join(', ')}`);
              const { ask, filed } = fileAsk(horde, {
                kind: 'stuck', ticket: step.ticket, why, log: stale ? stale.logPath : null,
              });
              results.push({
                ticket: step.ticket, action: 'blocked', ask: ask.id, note: `stale on the same files twice (${files.join(', ')})${filed ? ` — filed as ${ask.id} (stuck)` : ` — already filed as ${ask.id}`}`,
              });
              continue;
            }
            item.returnReason = { kind: 'catch-up-conflict', files, at: nowIso() };
          } else {
            delete item.returnReason;
          }
          if (stale && parseField(stale.text, 'Status') !== 'changes') transitionStatus(stale, 'changes', step.words);
          item.state = 'queued';
          item.notes.push({ at: nowIso(), text: `tick: stale, no round counted — ${step.words}` });
          results.push({
            ticket: step.ticket, action: 'changes', round: null, note: `stale, no round counted — ${step.words}`,
          });
          continue;
        }
        // A landing whose only red is a decision the user has to make — no reviewer to judge the prose
        // rules, or one that could not be reached. No worker can clear it, so it costs no round: the
        // ticket waits on "blocked", and the user gets ONE question for the whole horde, however many
        // tickets meet the same gap. Answering it sends every ticket it held back to a worker (see
        // releaseDecided), still with no round counted.
        if (step.waitingOnUser) {
          const ticket = findTicket(horde, step.ticket);
          const { ask, filed } = fileUserDecision(horde, step.waitingOnUser);
          item.state = 'blocked';
          item.returnReason = {
            kind: 'waiting-on-user', text: step.waitingOnUser.text, ask: ask.id, at: nowIso(),
          };
          item.notes.push({ at: nowIso(), text: `tick: waiting on a user decision (${ask.id}), no round counted — ${step.waitingOnUser.text}` });
          if (ticket && parseField(ticket.text, 'Status') !== 'blocked') {
            transitionStatus(ticket, 'blocked', `waiting on a user decision (${ask.id}) — ${step.waitingOnUser.text}`);
          }
          results.push({
            ticket: step.ticket,
            action: 'waiting',
            ask: ask.id,
            round: null,
            note: `waiting on a user decision, no round counted${filed ? ` — filed as ${ask.id} (stuck)` : ` — already asked as ${ask.id}`}: ${step.waitingOnUser.text}`,
          });
          continue;
        }
        // A landing whose only red was the prose verdicts its own catch-up merge moved the code under:
        // not the ticket's doing, so no round — once. A second one in a row is a worker that did not
        // refresh them, and is counted like any red gate below.
        const rejudgeAgain = step.rejudge && item.returnReason && item.returnReason.kind === 'rejudge';
        if (step.rejudge && !rejudgeAgain) {
          const ticket = findTicket(horde, step.ticket);
          if (ticket && parseField(ticket.text, 'Status') !== 'changes') transitionStatus(ticket, 'changes', `rejudge after catch-up — ${step.words}`);
          item.returnReason = { kind: 'rejudge', pairs: step.pairs, at: nowIso() };
          item.state = 'queued';
          item.notes.push({ at: nowIso(), text: `tick: prose verdicts made stale by the catch-up merge, no round counted — ${step.words}` });
          results.push({
            ticket: step.ticket, action: 'changes', round: null, note: `rejudge after catch-up, no round counted — ${step.words}`,
          });
          continue;
        }
        delete item.returnReason;
        const byReview = step.source === 'review';
        const said = byReview ? 'review found' : 'gate red';
        // Whatever sends a ticket back ends its review's say: the fix round the worker gets reads
        // every finding already in the log, so nothing written there so far sends it back again.
        if (item.review && !item.review.closedAt) item.review.closedAt = nowIso();
        const ticket = findTicket(horde, step.ticket);
        // A round the landing gate already counted is not counted again here: the gate writes the
        // ticket's "changes" line with the round number in it the moment it comes back red — read
        // ahead of roundInfo below so that reading, not a second count on top of it, is what a note
        // about this same event reports.
        // A rejudge result is one land.mjs deliberately did not count, so nothing wrote this round yet,
        // whatever status the ticket already carries from the return before it.
        const written = byReview ? !!step.counted : (!step.rejudge && ticket && parseField(ticket.text, 'Status') === 'changes');
        // A review that followed the discipline to the letter wrote the status line itself, and
        // tk.mjs counted that round when it did — the round is that one, never a second on top.
        // Likewise a red gate already recorded by land.mjs: `written` reads that round back instead
        // of computing the next one, which would count the same event twice under two different
        // numbers — the log's own and this note's.
        const roundInfo = byReview && step.counted
          ? { refused: false, ...step.counted }
          : (ticket ? (written ? lastChangesRoundInfo(horde, ticket) : changesRoundInfo(horde, ticket)) : { refused: false, round: 1 });
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
            why: `${roundInfo.message} ${byReview ? 'The review\'s findings' : 'The gate\'s last words'}: ${step.words}`,
            log: ticket ? ticket.logPath : null,
          });
          results.push({
            ticket: step.ticket, action: 'blocked', ask: ask.id, note: `${roundInfo.message}${filed ? ` Filed as ${ask.id} (stuck).` : ` Already filed as ${ask.id}.`}`,
          });
          continue;
        }
        // A second write here would tick the counter for one red gate twice. The status is only
        // written when nothing wrote it — a result read back after a run that died before recording
        // it. A review's finding is written by nobody but this run, unless the review wrote it itself.
        if (ticket && !written) {
          transitionStatus(ticket, 'changes', step.words, roundInfo);
        }
        item.state = 'queued';
        item.notes.push({ at: nowIso(), text: `tick: ${said} (round ${roundInfo.round}/${roundInfo.cap} — ${roundInfo.label}) — ${step.words}` });
        results.push({
          ticket: step.ticket, action: 'changes', round: roundInfo.round, note: `${said}, round ${roundInfo.round}/${roundInfo.cap} (${roundInfo.label}) — ${step.words}`,
        });
      }
      saveQueue(horde, TEAM, fresh);
    });
  }

  return { results, held, reviews };
}

// ---- 3. the dispatch list ------------------------------------------------------------------

// The name a run is identified by, and the name the brief is rendered for. A fix round is a new
// run of a new worker on the same ticket, so it carries the round: that keeps two ticks over one
// unchanged state from being mistaken for the same worker run twice.
function workerName(ticket, round) {
  return round > 0 ? `w-${ticket}-r${round}` : `w-${ticket}`;
}

// The argv a worker's brief is rendered with. Returned as an array, not the joined display string
// below, so a caller that actually RUNS this (externalStart, never a shell) passes each part as its
// own argv entry — a horde or worktree name is never validated against a safe character set at
// creation, so joining these into one string for a shell to reparse would let either one break out
// of its own argument.
//
// No --tree: the worker's worktree comes off the ticket's queue item, and the graph the brief reads
// its ports from has to be the horde's trunk. A ticket's own worktree has just been cut and nothing
// has run in it — no install, no CLI of its own — so a graph read there fails for a reason that has
// nothing to do with the graph.
function briefCommandParts(horde, ticket, name, takeover) {
  const parts = [join(SCRIPTS, 'brief.mjs'), 'worker', ticket, '--name', name, '--horde', horde];
  if (takeover) parts.push('--takeover');
  return parts;
}

// The same command, as the one string a person reads and runs themselves (the session runner's own
// dispatch list, a log line) — never fed to a shell by this tool itself.
function briefCommand(horde, ticket, name, takeover) {
  return ['node', ...briefCommandParts(horde, ticket, name, takeover)].join(' ');
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

function dispatch(horde, cfg, root, flags, holds) {
  const doc = readQueue(horde);
  const held = [];

  // "stop" is the one kind that holds the list whole, and it holds it before anything is ranked:
  // no branch is cut, no worktree is made, nothing is written. A later run with the question
  // answered starts from exactly the state this one found.
  if (holds.everything.length) {
    for (const ask of holds.everything) {
      held.push(heldEntry(ask, { holds: 'dispatch', note: holdNote(ask, 'nothing new goes out') }));
    }
    return { out: [], held };
  }

  const exclude = new Map();
  for (const [ticket, ask] of holds.dispatch) {
    const note = holdNote(ask, `${ticket} is not handed out`);
    exclude.set(ticket, note);
    held.push(heldEntry(ask, { ticket, holds: 'dispatch', note }));
  }

  const parallelism = Number(cfg.parallelism ?? 6);
  const running = doc.items.filter((i) => i.state === 'running').length;
  // The knob says how many workers run at once, so what is already running counts against it —
  // otherwise every run would hand out a full list on top of the last one's and the number would
  // mean nothing at all.
  const budget = Math.max(0, parallelism - running);
  const { picked, entries } = rankedCandidates(horde, TEAM, {
    stack: !!flags.stack, tree: root, limit: budget, exclude,
  });

  // An item that lost its branch is named and left, never a reason to stop: it stays on the held
  // list with the command that puts it right, and everything else is handed out as usual.
  for (const e of entries) {
    if (e.orphan) held.push({ ticket: e.item.ticket, ask: null, kind: 'orphan', holds: 'dispatch', note: `${e.item.ticket}: ${e.reason}` });
  }

  const out = [];
  for (const candidate of picked || []) {
    const id = candidate.item.ticket;
    const { prior, ticket, info } = priorRounds(horde, id);
    // "resume the same worker" and "a fresh worker, one class heavier" are the two shapes a fix
    // round takes; the brief's own --takeover section is what the second is briefed with.
    const takeover = !!(info && prior > 0 && prior >= Number(info.resume ?? 3));
    let started;
    try {
      started = startRunning(horde, TEAM, id, {
        tree: root,
        on: candidate.stackOn && candidate.stackOn.length ? candidate.stackOn[0] : undefined,
        agent: workerName(id, prior),
      });
    } catch (e) {
      // One ticket that cannot be started — a branch appearing between the ranking and the cut, a
      // worktree git will not make — is named and skipped; it must not take the run down with it and
      // leave the tickets before it, already cut and marked running, off the list nobody receives.
      if (!(e instanceof HordeError)) throw e;
      held.push({ ticket: id, ask: null, kind: 'not-started', holds: 'dispatch', note: `${id} could not be started: ${e.message.split('\n')[0]}` });
      continue;
    }
    const baseClass = (ticket && parseField(ticket.text, 'Class')) || started.class || null;
    out.push({
      ticket: id,
      model: takeover ? classUp(cfg, baseClass) : baseClass,
      brief: briefCommand(horde, id, workerName(id, prior), takeover),
      briefParts: briefCommandParts(horde, id, workerName(id, prior), takeover),
      stacked: stackedLine(candidate.stackOn),
      worktree: started.worktree,
      branch: started.branch,
      round: prior,
    });
  }
  return { out, held };
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
//
// The brief itself is rendered from `entry.briefParts` — the same argv dispatch() already built for
// this entry, takeover section and round-aware `--name` included, run directly (never through a
// shell: a horde or worktree name is nobody's to validate as shell-safe, and this is the one path
// that runs a worker's brief with nobody reading the command first). That is the same command the
// session runner would be handed to run itself; the only thing "external" changes is who runs it,
// never what it says (see reference/model.md's Runner section) — so this must never reconstruct a
// narrower call of its own.
//
// A ticket's review is started exactly the same way, from the same template, on the ticket's own
// class: the loop hands it out, and under this runner nobody else is there to start it. Its brief
// is written beside the worker's under a name of its own, so neither ever overwrites the other.
function externalStart(horde, cfg, entries, root) {
  const template = cfg.runner && cfg.runner.spawn;
  const started = [];
  for (const entry of entries) {
    const role = entry.role || 'worker';
    const path = hordePath(horde, 'briefs', entry.briefFile || `${entry.ticket}.md`);
    let text;
    try {
      text = execFileSync(process.execPath, entry.briefParts, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      started.push({
        ticket: entry.ticket, role, started: false, note: `could not render the brief: ${e && e.stderr ? String(e.stderr).trim() : e}`,
      });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    const command = String(template).split('<class>').join(entry.model || '').split('<brief>').join(path);
    // What the headless CLI prints goes to a log of its own beside the brief, not nowhere: a worker
    // that died is otherwise a pid that vanished with no word said.
    const log = hordePath(horde, 'runs', `${(entry.briefFile || `${entry.ticket}.md`).replace(/\.md$/, '')}.log`);
    mkdirSync(dirname(log), { recursive: true });
    const fd = openSync(log, 'a');
    let child;
    try {
      child = spawnProcess('sh', ['-c', command], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    child.unref();
    const pid = Number.isInteger(child.pid) ? child.pid : null;
    // The worker's lease gets the pid now, under the gate lock this run still holds: the next run's
    // reconcile reads a dead pid as the worker having ended, and a live one as it still working.
    if (role === 'worker') recordWorkerRun(horde, TEAM, entry.ticket, { pid, log });
    started.push({
      ticket: entry.ticket, role, started: true, brief: path, command, pid, log,
    });
  }
  return started;
}

// ---- one run --------------------------------------------------------------------------------

function runOnce(horde, cfg, flags, runner) {
  // The landing gate's lock, not a second one: two ticks on one repository would otherwise settle
  // the same branch twice and hand the same ticket to two workers. Taken before the tree is even
  // resolved, and on purpose: --horde named explicitly (below) falls through to this horde's own
  // trunk, which provisions that worktree the first time anything asks and `git reset --hard`s it
  // on every ask after — both are their own small race between two ticks that reach this line at
  // the same moment, and this is the one lock already serializing tick against itself, so
  // resolving under it costs nothing new to set up.
  const lock = acquireGateLock('tick', null, { waitMs: gateLockWaitMs(cfg) });
  if (!lock.ok) fail(lock.note);
  try {
    // No --tree: cwd, same as an ordinary graph read everywhere else in this tool set (see
    // node.mjs main()'s own comment above its resolveTree call) — NOT this horde's trunk just
    // because a horde was resolvable, which is the one question still open on ask a-002. What
    // this DOES now honor is --horde typed explicitly: `flags.horde`, never the `horde` this
    // function was handed (resolveHorde's own default-to-the-sole-horde reading), so a bare
    // `tick.mjs` run is untouched and only a caller who actually wrote --horde gets trunk instead
    // of whatever branch the shell happened to be sitting on — the same distinction queue.mjs
    // plan/quality already draw, and the one 037 broke by forwarding the resolved horde instead.
    const info = resolveTree({ tree: flags.tree, horde: flags.horde }, { cwd: process.cwd() });
    const root = info.path;
    // Read before anything is written: a queue.json caught half-written refuses here, cleanly,
    // naming the file, while every other read below is safe because this one passed.
    // The holds are worked out off this same read, once, so the landing gate and the dispatch list
    // rule on one in-tray rather than on two reads of a file the client could answer between.
    const holds = askHolds(horde, readQueue(horde));
    const reclaim = flags.reclaim ? String(flags.reclaim).split(',').map((x) => x.trim()).filter(Boolean) : [];
    const settled = reconcileRunning(horde, TEAM, { tree: root, reclaim });
    const reconciled = settled.filter((r) => r.state !== 'working');
    const working = settled.filter((r) => r.state === 'working').map((r) => ({ ticket: r.ticket, note: r.note }));
    const released = releaseDecided(horde);
    const landed = landTheLanded(horde, cfg, root, holds);
    landed.results.unshift(...released);
    const spawn = dispatch(horde, cfg, root, flags, holds);

    const doc = readQueue(horde);

    // A queue holding nothing unmerged is a wave that CAN close — and a "stop" holds that too,
    // being the kind that holds everything. Without this, a mission whose last ticket merged just
    // before the client was asked would raise the close flag anyway, and --watch would exit its
    // loop on it, leaving the question standing with nobody left to relay the answer to.
    const emptied = doc.items.every((i) => i.state === 'merged');
    const closeHeld = emptied
      ? holds.everything.map((ask) => heldEntry(ask, { holds: 'close', note: holdNote(ask, 'the wave does not close') }))
      : [];
    const close = emptied && !closeHeld.length;
    const external = runner === 'external' ? externalStart(horde, cfg, [...spawn.out, ...landed.reviews], root) : [];

    return withProvenance({
      horde,
      runner,
      reconciled,
      working,
      landed: landed.results,
      held: [...landed.held, ...spawn.held, ...closeHeld],
      spawn: spawn.out.map((s) => ({
        ticket: s.ticket, model: s.model, brief: s.brief, stacked: s.stacked, worktree: s.worktree, branch: s.branch,
      })),
      review: landed.reviews.map((r) => ({
        ticket: r.ticket, model: r.model, name: r.name, brief: r.brief,
      })),
      askClient: openAsks(horde),
      landing: landingLoad(horde, doc.items),
      close,
      closeCommand: close ? closeCommand(horde) : null,
      external,
    }, info);
  } finally {
    lock.release();
  }
}

function render(out) {
  const lines = [];
  for (const r of out.reconciled) lines.push(`reconciled ${r.ticket} -> ${r.state} · ${r.note}`);
  for (const w of out.working || []) lines.push(`working ${w.ticket} · ${w.note}`);
  for (const l of out.landed) lines.push(`gate ${l.ticket}: ${l.action} · ${l.note}`);
  for (const h of out.held) lines.push(`held (${h.holds}): ${h.note}`);
  if (out.spawn.length) {
    lines.push(`spawn (${out.spawn.length}):`);
    for (const s of out.spawn) {
      lines.push(`  ${s.ticket} (${s.model}) — ${s.brief}`);
      if (s.stacked) lines.push(`  ${s.stacked}`);
    }
  } else {
    lines.push(out.held.some((h) => h.holds === 'dispatch' && !h.ticket)
      ? 'spawn: (held — see above)'
      : 'spawn: (nothing ready)');
  }
  if (out.review.length) {
    lines.push(`review (${out.review.length}):`);
    for (const r of out.review) lines.push(`  ${r.ticket} (${r.model}) — ${r.brief}`);
  }
  for (const a of out.askClient) lines.push(`ask client ${a.id} (${a.kind}): ${a.why}`);
  for (const e of out.external) lines.push(`started ${e.ticket} (${e.role}): ${e.started ? e.command : e.note}`);
  lines.push(landingLine(out.landing));
  const closeHeld = out.held.find((h) => h.holds === 'close');
  if (out.close) lines.push(`close: the queue holds nothing unmerged — ${out.closeCommand}`);
  else lines.push(closeHeld ? `close: held — ${closeHeld.note}` : 'close: not yet');
  lines.push(provenanceLine({ path: out.tree, branch: out.branch, sha: out.sha }));
  return lines.join('\n');
}

// ---- --watch ---------------------------------------------------------------------------------
//
// The loop, for a runner with nowhere else to live. Each pass acquires and releases the gate lock
// inside runOnce, so a signal between passes finds nothing held; a signal during one is handled
// after that pass's own `finally` has already let go. Interrupted, this exits 0 with the queue
// exactly as the last completed pass left it.
// A refused pass, written down: one line in the mission journal and one on stderr, so the run is
// visible both to whoever is watching and to whoever reads the journal afterwards.
function recordRefusal(horde, e, flags) {
  const message = e && e.message ? e.message : String(e);
  const line = `- ${nowIso()} tick refused: ${message.split('\n')[0]}`;
  console.error(`error: ${message}`);
  try {
    appendText(hordePath(horde, 'plan.md'), `${line}\n`);
  } catch {
    // The journal being unwritable is not a reason to stop either — stderr already carried it.
  }
  if (flags.json) console.log(JSON.stringify({ horde, refused: message, at: nowIso() }, null, 2));
}

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
  let pass = flags;
  for (;;) {
    let out = null;
    try {
      out = runOnce(horde, cfg, pass, runner);
    } catch (e) {
      // A refusal is not the end of the loop. One pass can be refused by something that is gone
      // by the next one — a lock another run is holding, a file being written as this read it —
      // and a steward that died on it would leave the queue to nobody. So it goes in the mission
      // journal, where the next reader finds it, and the loop waits out the interval and asks
      // again. But only a HordeError is a refusal in that sense — the deliberate, named kind
      // every `fail()` call raises. Anything else is a bug in the loop itself (a TypeError, a
      // null read, anything runOnce never meant to throw), and catching that here would retry it
      // forever instead of crashing loudly where whoever is watching can see it.
      if (!(e instanceof HordeError)) throw e;
      recordRefusal(horde, e, flags);
    }
    // --reclaim is the director's word about one moment, so it is said once: the first pass settles
    // those tickets, and a later pass reading it again would refuse them for no longer running.
    pass = { ...flags, reclaim: undefined };
    if (out) {
      if (flags.json) console.log(JSON.stringify(out, null, 2));
      else console.log(render(out));
    }
    if (stop || (out && out.close)) break;
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

  if (flags.watch) return watch(horde, cfg, flags, runner);
  const out = runOnce(horde, cfg, flags, runner);
  return emit(out, flags, () => render(out));
}

if (isMain(import.meta.url)) runMain(main);
