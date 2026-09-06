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

import {
  readConfig, readText, writeText, appendText, today, fail, parseArgs, emit, isMain, resolveHorde,
  renderTemplate, asArray,
} from './_lib.mjs';
import {
  findTicket, parseField, parseKeys, setVerifierKey,
} from './tk.mjs';
import { trace as traceRoster, rosterEntry } from './roster.mjs';

const VERDICTS = ['reproduced', 'not-reproduced', 'stale', 'out-of-scope'];

const USAGE = `usage: verify.mjs <command> [options]

commands:
  record <ticket> --verdict <${VERDICTS.join('|')}> --by <name>
      --item "<n>|<command>|<saw>" [--item "<n2>|<command>|<saw>" …]
      [--ran "<…>" --saw "<…>"] [--gate green|red --sha <sha>]
      --revert failed|passed|not-run|no-new-tests [--horde h]
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
      line from the verdict.
  show <ticket> [--horde h]
      the ticket's recorded verdicts, most recent last.

options: --json  --help`;

function teamBranchName(horde, team) {
  return team === 'trunk' ? `${horde}/trunk` : `${horde}/${String(team).split('/').pop()}`;
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

function cmdRecord(horde, positional, flags) {
  const idRaw = positional[0];
  if (!idRaw) fail('record requires <ticket>');
  if (!VERDICTS.includes(flags.verdict)) fail(`--verdict is required, one of: ${VERDICTS.join('|')}`);
  if (!flags.by) fail('record requires --by <name>');
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

  const ticket = findTicket(horde, idRaw);
  if (!ticket) fail(`no such ticket: ${idRaw}`);
  const keys = parseKeys(ticket.text);
  if (flags.by === keys.author) fail("the verifier cannot be the ticket's author");

  const items = resolveItems(acceptanceItems(ticket.text), flags);

  const cfg = readConfig();
  const gateCommand = (cfg && cfg.gates && cfg.gates.team) || '(not configured)';
  const isRepro = flags.verdict === 'reproduced';

  const vars = {
    ticketId: ticket.id,
    date: today(),
    verifier: flags.by,
    class: (rosterEntry(horde, flags.by) || {}).class || parseField(ticket.text, 'Class') || '-',
    reproduced: flags.verdict,
    teamBranch: teamBranchName(horde, ticket.team),
    yes: isRepro ? 'yes' : `no: ${flags.verdict}`,
    'failed as expected': flags.revert === 'failed' ? 'failed as expected'
      : flags.revert === 'passed' ? 'passed (proves nothing)'
        : flags.revert === 'no-new-tests' ? 'none — this change adds no test; its evidence is the items above'
          : 'not run',

    gateCommand,
    green: flags.gate === 'green' ? `green at sha ${flags.sha}` : flags.gate === 'red' ? `red at sha ${flags.sha}` : 'not run',
    node: parseField(ticket.text, 'Node') || '-',
    untouched: 'untouched',
  };

  const rows = items.map((it) => `| ${escapeCell(it.text)} | ${escapeCell(it.command)} | ${escapeCell(it.saw)} |`);
  if (flags.ran) rows.push(`| other | ${escapeCell(flags.ran)} | ${escapeCell(flags.saw)} |`);
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

  emit(
    { ticket: ticket.id, verdict: flags.verdict, by: flags.by },
    flags,
    () => `verdict recorded for ${ticket.id}: ${flags.verdict}${isRepro ? ' — verifier key set' : ''}`,
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
