#!/usr/bin/env node
// horde skill — verify.mjs
//
// The second key: an independent reproduction of a ticket's acceptance evidence, recorded as a
// verdict block in the ticket's own log so the record travels with the ticket rather than living
// in a side file a steward could miss. Only a "reproduced" verdict sets the verifier key — the
// same per-ticket second-signature the author key already provides — because every other verdict
// means the work is not ready to merge up. Refuses a verifier who is also the ticket's author,
// the same check-and-balance tk.mjs's own review command enforces.
//
// One --item per acceptance line, not one reproduction row for the whole ticket, because an
// acceptance checklist with an item nobody ran is not actually reproduced — the record command
// forces the count to match rather than trusting a verifier's summary of "I checked it all".

import { execFileSync } from 'node:child_process';
import {
  readConfig, readText, writeText, appendText, today, fail, parseArgs, emit, isMain, resolveHorde,
  renderTemplate, asArray, readJSON, teamPath, patchIdOf, hordePath, repoRoot, nowIso,
  parentBranchOf,
} from './_lib.mjs';
import {
  findTicket, parseField, parseKeys, setVerifierKey, changesRoundInfo, transitionStatus,
} from './tk.mjs';
import { trace as traceRoster, rosterEntry } from './roster.mjs';
import { graphIsLaw, ygCommand } from './node.mjs';

const VERDICTS = ['reproduced', 'not-reproduced', 'stale', 'out-of-scope', 'flaky'];

const USAGE = `usage: verify.mjs <command> [options]

commands:
  record <ticket> --verdict <${VERDICTS.join('|')}> --by <name>
      --item "<n>|<command>|<saw>" [--item "<n2>|<command>|<saw>" …]
      [--ran "<…>" --saw "<…>"] [--gate green|red --sha <sha>] [--branch <branch>]
      --revert failed|passed|not-run|no-new-tests
      [--runs <n> --results <r1,r2,…> --test "<what was run repeatedly>"] [--horde h]
      appends a verdict block to the ticket's log; sets the verifier key when the verdict is
      "reproduced". <n> is the 1-based line number of the ticket's own "## Acceptance —
      evidence" checklist ("- [ ]"/"- [x]" lines) — one --item is required per acceptance line,
      no more, no fewer; refuses and lists the missing or out-of-range indices otherwise.
      --ran/--saw are optional and add one extra "other" row to the table, for something checked
      beyond the acceptance list. Refuses --by equal to the ticket's author, and --gate without
      --sha (a gate result premerge.mjs can't tie to a commit is not one it can accept). A
      "reproduced" verdict requires --gate (the gate result is part of reproduction) and refuses
      --gate red (a red gate cannot be reproduced — record not-reproduced instead). --revert is
      what the verifier saw when the new tests ran on the revert base: "reproduced" requires
      --revert failed (a revert test that was not run, or passed, is not a reproduction), or
      --revert no-new-tests for a change that adds none — a refactor, a rename, a configuration
      change — which would otherwise be impossible to verify at all; the tool never fills that
      line from the verdict. The verdict also records what the diff itself was at record time
      (the ticket's branch against its team branch, read from the queue item or named with
      --branch): the merge checklist accepts the verdict later as long as that diff is
      unchanged, whatever else has landed on the team branch since.
      --runs/--results is a check run more than once (rerun before recording a first failure,
      never escalate on it) — --results must list exactly --runs result(s); when they disagree
      the verdict is forced to "flaky" regardless of --verdict, --test names what flaked in the
      block, the ticket goes to "changes" ("flaky: <what>") counting one round of config.fixRounds
      the same as any other, and the flake is filed as an incident: through this repository's
      Yggdrasil CLI (config.ygCommand) when its graph is the law, else a journal note. A flaky
      verdict needs none of --item/--gate/--revert.
  show <ticket> [--horde h]
      the ticket's recorded verdicts, most recent last.

options: --json  --help`;

function teamBranchName(horde, team) {
  return team === 'trunk' ? `${horde}/trunk` : `${horde}/${String(team).split('/').pop()}`;
}

// The ticket's queue item — read straight off queue.json rather than through queue.mjs, the same
// way tk.mjs reads it and for the same reason (queue.mjs imports tk.mjs, and a two-way import
// would be a cycle). null when the ticket was never queued.
function ticketItem(horde, ticket) {
  const queue = readJSON(teamPath(horde, ticket.team, 'queue.json'), { items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];
  return items.find((i) => String(i.ticket) === ticket.id) || null;
}

// The branch this ticket's work is measured against: its team's, or — while the ticket was
// started from a dependency that has not merged yet — that dependency's. The same answer the
// merge checklist gets, from the same function, because a verdict bound against one branch and
// checked against another would die on a catch-up that changed nothing.
function ticketParentBranch(horde, ticket) {
  const item = ticketItem(horde, ticket);
  return item
    ? parentBranchOf(horde, ticket.team, item).branch
    : teamBranchName(horde, ticket.team);
}

// What this verdict actually judged: the identity of the ticket's diff against its parent branch
// at record time. The sha stays on the Gate line as the tree the gate ran on; this is the binding
// — the merge checklist honours the verdict for as long as the diff is this one, so a branch that
// only catches up keeps its verdict instead of paying for a second verification.
// null (the line then says so) when there is no branch to read, or nothing to identify.
function verdictPatchId(horde, cfg, ticket, flags) {
  const item = ticketItem(horde, ticket);
  const branch = flags.branch || (item && item.branch) || null;
  if (!branch) return null;
  return patchIdOf(branch, ticketParentBranch(horde, ticket), { context: cfg && cfg.keyContext });
}

// The ticket's own "## Acceptance — evidence" checklist, in order — the same section tk.mjs
// writes one "- [ ] …" line into per --evidence value at `new`, and the same section wave.mjs
// scans (as free text, not line-by-line) for a catalogue id. Read independently here rather than
// imported, since this only needs the checklist lines' text, not the id-matching wave.mjs does.
// templates/ticket.md's own unfilled placeholder line ("- [ ] …", literally the ellipsis) is
// excluded: it is not something a verifier can reproduce, so a ticket whose author never wrote a
// real acceptance line asks for no --item at all rather than one nobody can supply.
function acceptanceItems(ticketText) {
  const idx = ticketText.indexOf('## Acceptance');
  if (idx === -1) return [];
  const rest = ticketText.slice(idx);
  const nextHeading = rest.indexOf('\n## ', 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const items = [];
  for (const line of section.split('\n')) {
    const m = /^- \[[ xX]\]\s*(.+)$/.exec(line.trim());
    if (m && m[1].trim() !== '…') items.push(m[1].trim());
  }
  return items;
}

// Parses "--item <n>|<command>|<saw>" into {n, command, saw}; <saw> may itself contain "|", so
// only the first two separators are structural.
function parseItemFlag(raw) {
  const parts = String(raw).split('|');
  if (parts.length < 3) fail(`--item must be "<n>|<command>|<saw>": ${raw}`);
  const n = parseInt(parts[0].trim(), 10);
  if (!Number.isInteger(n) || n < 1) fail(`--item's <n> must be a positive integer: ${raw}`);
  const command = parts[1].trim();
  const saw = parts.slice(2).join('|').trim();
  return { n, command, saw };
}

// Every acceptance line needs exactly one --item, no more, no fewer — a verdict is refused
// rather than recorded with gaps, since a merge that trusts this key trusts every line was
// actually reproduced.
function resolveItems(acceptance, flags) {
  const raw = asArray(flags.item).map(parseItemFlag);
  const total = acceptance.length;

  const seen = new Map();
  const dupes = [];
  for (const it of raw) {
    if (seen.has(it.n)) dupes.push(it.n);
    seen.set(it.n, it);
  }
  if (dupes.length) fail(`--item given more than once for index: ${[...new Set(dupes)].join(', ')}`);

  const outOfRange = raw.filter((it) => it.n > total).map((it) => it.n);
  if (outOfRange.length) {
    fail(`--item index out of range (ticket has ${total} acceptance line(s)): ${outOfRange.join(', ')}`);
  }

  const missing = [];
  for (let n = 1; n <= total; n++) if (!seen.has(n)) missing.push(n);
  if (missing.length) fail(`missing --item for acceptance line(s): ${missing.join(', ')}`);

  return raw.slice().sort((a, b) => a.n - b.n).map((it) => ({ ...it, text: acceptance[it.n - 1] }));
}

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// --results, split, compared against --runs — differing entries mean the check flaked; a single
// entry (or --runs omitted) can never show a flake, so this returns null in that case.
function parseFlakeFlags(flags) {
  if (flags.runs === undefined && flags.results === undefined) return null;
  if (flags.runs === undefined || flags.results === undefined) {
    fail('--runs and --results are given together, or not at all');
  }
  const runs = parseInt(flags.runs, 10);
  if (!Number.isInteger(runs) || runs < 2) fail('--runs must be an integer of 2 or more — one run cannot show a flake');
  const results = String(flags.results).split(',').map((s) => s.trim()).filter(Boolean);
  if (results.length !== runs) fail(`--results must list exactly --runs (${runs}) result(s), got ${results.length}: ${flags.results}`);
  if (new Set(results).size <= 1) return null; // ran more than once, agreed every time — not a flake
  if (!flags.test) fail('a flaky result (the --results disagree) requires --test "<what was run repeatedly>" so the verdict names it');
  return { runs, results, test: flags.test };
}

// The flake becomes an incident: through this repository's own Yggdrasil CLI (config.ygCommand
// names how to invoke it; the exact subcommand — "incident add --tag <cause> --reason <text>" —
// comes from that CLI's own --help, never assumed) when its graph is the law, else a journal note
// beside the horde's other journals. Filing failing never blocks the changes transition it rides
// with — a flake that could not be filed anywhere is still a flake.
function recordFlakeIncident(horde, cfg, ticket, flake) {
  const reason = `flaky test on ticket ${ticket.id}: ${flake.test} — runs: ${flake.results.join(', ')}`;
  if (graphIsLaw(cfg)) {
    const { cmd, prefix, display } = ygCommand(cfg);
    try {
      execFileSync(cmd, [...prefix, 'incident', 'add', '--tag', 'not-enforcement', '--reason', reason], {
        cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { recorded: true, via: `${display} incident add`, reason };
    } catch (e) {
      const detail = ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || '') || e.message;
      return { recorded: false, via: `${display} incident add`, reason: `could not record: ${detail.trim()}` };
    }
  }
  appendText(hordePath(horde, 'incidents.md'), `- ${nowIso()} ticket ${ticket.id} — ${reason}\n`);
  return { recorded: true, via: 'journal note (hordes/<horde>/incidents.md)', reason };
}

function cmdRecord(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('record requires <ticket>');
  if (!flags.by) fail('record requires --by <name>');

  // A flake is discovered from the results, not declared with --verdict — two disagreeing runs
  // override whatever --verdict said (or wasn't given at all), and skip every requirement below
  // that only makes sense for a single, decisive run.
  const flake = parseFlakeFlags(flags);

  if (!flake) {
    if (!VERDICTS.includes(flags.verdict)) fail(`--verdict is required, one of: ${VERDICTS.join('|')}`);
    if ((flags.ran && !flags.saw) || (!flags.ran && flags.saw)) fail('--ran and --saw are given together, or not at all');
    if (flags.gate !== undefined && flags.gate !== 'green' && flags.gate !== 'red') fail('--gate must be "green" or "red"');
    if (flags.gate !== undefined && !flags.sha) fail('--gate requires --sha <sha> — premerge.mjs only accepts a gate result tied to a commit');
    // A red gate is not a reproduction, no matter what the rest of the checklist showed — and a
    // "reproduced" verdict with no --gate at all leaves premerge.mjs's own gate check unable to
    // trust it either, so the gate result is required as part of reproduction, not an add-on.
    // "no-new-tests" is the one other way a reproduced verdict is honest: a refactor, a rename or a
    // configuration change adds no test to run on the revert base, and without this such a ticket
    // could never be verified at all. It is a claim about the change, and premerge's own revert
    // check reads the diff independently — a ticket that did add a test is still held to it there.
    const REVERTS = ['failed', 'passed', 'not-run', 'no-new-tests'];
    if (flags.revert !== undefined && !REVERTS.includes(flags.revert)) fail(`--revert must be one of ${REVERTS.join('|')}`);
    if (flags.verdict === 'reproduced' && flags.revert !== 'failed' && flags.revert !== 'no-new-tests') {
      fail('a "reproduced" verdict requires --revert failed — the new tests were run on the revert base and failed there; a revert test that was not run or passed is not a reproduction (record not-reproduced). A ticket that adds no test at all — a refactor, a rename, a configuration change — records --revert no-new-tests instead');
    }
    if (flags.verdict === 'reproduced' && flags.gate === undefined) {
      fail('--verdict reproduced requires --gate green|red --sha <sha> — the gate result is part of reproduction');
    }
    if (flags.verdict === 'reproduced' && flags.gate === 'red') {
      fail('a red gate cannot be reproduced — record --verdict not-reproduced instead');
    }
  }

  const ticket = findTicket(horde, idRaw);
  if (!ticket) fail(`no such ticket: ${idRaw}`);
  const keys = parseKeys(ticket.text);
  if (flags.by === keys.author) fail("the verifier cannot be the ticket's author");

  const items = flake ? [] : resolveItems(acceptanceItems(ticket.text), flags);

  const cfg = readConfig();
  const gateCommand = (cfg && cfg.gates && cfg.gates.team) || '(not configured)';
  const verdict = flake ? 'flaky' : flags.verdict;
  const isRepro = verdict === 'reproduced';
  const patchId = verdictPatchId(horde, cfg, ticket, flags);

  const vars = {
    ticketId: ticket.id,
    date: today(),
    verifier: flags.by,
    class: (rosterEntry(horde, flags.by) || {}).class || parseField(ticket.text, 'Class') || '-',
    reproduced: verdict,
    parentBranch: ticketParentBranch(horde, ticket),
    yes: isRepro ? 'yes' : `no: ${verdict}`,
    flake: flake ? `${flake.test} — runs: ${flake.results.join(', ')} (${flake.runs} runs)` : undefined,
    'failed as expected': flags.revert === 'failed' ? 'failed as expected'
      : flags.revert === 'passed' ? 'passed (proves nothing)'
        : flags.revert === 'no-new-tests' ? 'none — this change adds no test; its evidence is the items above'
          : 'not run',

    gateCommand,
    green: flags.gate === 'green' ? `green at sha ${flags.sha}` : flags.gate === 'red' ? `red at sha ${flags.sha}` : 'not run',
    ...(patchId ? { patchId } : {}),
    node: parseField(ticket.text, 'Node') || '-',
    untouched: 'untouched',
  };

  const rows = items.map((it) => `| ${escapeCell(it.text)} | ${escapeCell(it.command)} | ${escapeCell(it.saw)} |`);
  if (flags.ran) rows.push(`| other | ${escapeCell(flags.ran)} | ${escapeCell(flags.saw)} |`);
  if (flake) rows.push(`| flake | ${escapeCell(flake.test)} | ${escapeCell(flake.results.join(' then '))} |`);
  vars.rows = rows.join('\n');

  let block;
  try {
    block = renderTemplate('verdict', vars);
  } catch (e) {
    fail(e.message);
  }

  const existing = readText(ticket.logPath) || '';
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  appendText(ticket.logPath, `${sep}\n${block}\n`);

  if (isRepro) writeText(ticket.issuePath, setVerifierKey(ticket.text, flags.by));
  traceRoster(horde, flags.by);

  let flakeOutcome = null;
  if (flake) {
    const roundInfo = changesRoundInfo(horde, ticket);
    if (roundInfo.refused) {
      fail(`the flaky verdict for ${ticket.id} was recorded in its log, but ${roundInfo.message}`);
    }
    transitionStatus(ticket, 'changes', `flaky: ${flake.test}`, roundInfo);
    flakeOutcome = recordFlakeIncident(horde, cfg, ticket, flake);
  }

  emit(
    {
      ticket: ticket.id,
      verdict,
      by: flags.by,
      diff: patchId,
      ...(flake ? { flake, incident: flakeOutcome } : {}),
    },
    flags,
    () => `verdict recorded for ${ticket.id}: ${verdict}${isRepro ? ' — verifier key set' : ''}`
      + `${patchId ? `, bound to diff ${patchId.slice(0, 7)}` : ''}`
      + (flake
        ? ` — ticket sent to changes; incident ${flakeOutcome.recorded ? `recorded (${flakeOutcome.via})` : `not recorded: ${flakeOutcome.reason}`}`
        : ''),
  );
}

function parseVerdicts(logText) {
  if (!logText) return [];
  return logText.split(/\n(?=## Verdict)/).map((b) => b.trim()).filter((b) => b.startsWith('## Verdict'));
}

function cmdShow(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('show requires <ticket>');
  const ticket = findTicket(horde, idRaw);
  if (!ticket) fail(`no such ticket: ${idRaw}`);
  const verdicts = parseVerdicts(readText(ticket.logPath) || '');
  emit({ ticket: ticket.id, verdicts }, flags, () => (verdicts.length ? verdicts.join('\n\n') : '(no verdicts recorded)'));
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'record': return cmdRecord(horde, positional, flags);
    case 'show': return cmdShow(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
