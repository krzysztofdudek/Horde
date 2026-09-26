#!/usr/bin/env node
// horde skill — wave.mjs
//
// The wave journal: an append-only log of starts, notes, merges, what became of a merge afterwards,
// key transfers and closes. The mission's own wave cadence lives at hordes/<horde>/plan.md —
// matching the tree in reference/model.md, which lists plan.md once, at the horde root.
//
// The close is where the journal stops being a record and becomes a report: it reads its own
// bullets back — what the wave planned, what it merged and when, whose keys travelled — and
// states the figures a chairman judges a horde by. Everything it prints is derived from state
// some other tool wrote while doing its job; nothing here is entered by hand, which is the point:
// a KPI somebody types in is a KPI somebody can flatter.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  hordePath, teamPath, readText, writeText, appendText, readJSON, writeJSON, readConfig, today,
  nowIso, fail, parseArgs, emit, isMain, resolveHorde, renderTemplate, qualityPolicy, resolveTree,
  markdownSection, markdownTableCells, parseEvidenceRows, parseVerdictBlocks, diffSize, sizeRanks,
  noEvidenceLayerNote, EVIDENCE_CLASSES, git, runGateAt, GATE_RAN, GATE_ASSERTED,
  runMain,
} from './_lib.mjs';
// The charter section's heading lives with the readers of it, and is handed on from here because
// this is where everything else about the charter's shape is taken from.
export { EVIDENCE_SECTION } from './_lib.mjs';

// queue.mjs imports this file too (noteMerged). The cycle is deliberate and
// safe — every binding on both sides is a hoisted function declaration and neither module calls
// the other while it is still being evaluated. The alternative, a second derivation of the DAG
// here, is the thing worth avoiding: the parallelism a wave close reports as "planned" has to be
// the plan's own layers.
import { buildPlan } from './queue.mjs';
import { loadAsks } from './ask.mjs';
import { writeLawDiff } from './law.mjs';
import { auditLaw, auditBlock } from './audit.mjs';
import {
  ygQualityIndex, observeAspects, pendingPromotions, markPromotionsReported,
} from './node.mjs';
import { findTicket, ticketKind, parseField } from './tk.mjs';

const START_RE = /^# Wave (\S+) — start \d{4}-\d{2}-\d{2}$/;
const CLOSE_RE = /^# Wave (\S+) — close \d{4}-\d{2}-\d{2}$/;

const USAGE = `usage: wave.mjs <command> [options]

commands:
  start [n] [--team t] [--tree p] [--horde h]
      appends "# Wave <n> — start <date>"; n auto-increments from the last wave number in the
      journal when omitted. Records the plan's own layers and the parallelism they allow, so the
      close can report what the wave planned against what it achieved. The plan itself is built
      from the tree --tree names; without it, cwd, same as an ordinary read anywhere else in this
      tool set, not this horde's trunk just because a horde was resolvable. --horde h WRITTEN OUT
      (no --tree) is what changes that, exactly as queue.mjs plan/quality, tick.mjs, land.mjs and
      horde.mjs done already read it.
  note "<text>" [--team t] [--horde h]
      appends a dated bullet.
  merged <ticket> <sha> [--team t] [--horde h]
      appends a dated "merged: <ticket> <sha>" bullet. "queue.mjs set <ticket> merged --sha" does
      this itself, so this is only for a merge the queue never saw; it never records one twice.
  close [--gate green|red] [--sha <sha>] [--evidence E5[,E6]] [--team t] [--horde h]
      renders templates/wave-close.md — counts from the team's queue.json — and appends it.
      --gate green --sha runs the level's gate command (config.gates.trunk for the trunk team)
      at that commit — which must be on the trunk — here, before anything is written, and refuses the close when it does not
      pass; what it records in cache/last-gate.json is that run (kind "ran"), the only kind of
      entry "horde.mjs done" trusts. --gate red --sha is recorded as said (kind "asserted").
      --gate without --sha only names the gate in the report, and records nothing.
      --evidence names catalogue rows the wave gate itself proves — only with --gate green --sha,
      and never a "client testimony" or "artifact" row; they are filled with "wave <n> gate
      passed at <sha>".
      Also states, from the wave's own record: what came back after landing (merges reverted and
      tickets reopened, counted beside the merges and never folded into them), planned against
      achieved parallelism, the keys that carried over without a second reading, human decisions
      per merged ticket with its trend, and — where the nodes come from a graph — the quality
      index with its delta since the last wave. A quality index that fell is a line in this report naming what fell; it does
      not open anything of its own — provisional, pending the same "quality" ask-kind question
      019 left open.
      It also closes the loop on the quality ruling: it takes each watched rule's reading for
      this wave (what the two-wave test for enforcement counts), and prints one block naming
      every rule the horde raised this wave with the evidence that earned it, every improvement
      of its own it finished, and the sentence telling the chairman that undoing any of it is
      theirs to ask for. Under a charter set to only-the-work the block says none of it ran.
      It names, on its own and outside every figure it reports, each catalogue row the client has
      been shown a prototype for and accepted — what they saw, who accepted it and when. A row
      described by a prototype is a row somebody can now put into words, never a row somebody
      has delivered, so none of it counts toward the catalogue.
      And it audits the law, because nobody here does that from a seat of their own: a ticket per
      rule whose review date has passed ("renew or retire", ending in a proposal and never in an
      edit to the date), a ticket per item in "yg advise" nobody has queued or decided on (a
      promotion is reported for the ladder instead, and a lowering is put to the client as one
      ask; an item is filed again when its evidence changed and what was filed before is closed),
      what Grain says about this mission's own territories, and the rules nothing has hit — that last
      one in Yggdrasil's own words from "yg aspects --health", or not at all. Every read it
      cannot make is a note in the report; none of them stops the close.
  evidence <id> (--ask <id> | --artifact <path> | --run "<command>") [--horde h]
      fills one catalogue row's "reproduced by" cell — for a row no ticket verdict can fill — with
      something this tool checks, never with what is typed; which flag a row takes is its kind
      of proof (the charter's fifth column). "client testimony": --ask names an answered ask that
      names the row's id, and the cell records what the client said and when. "artifact":
      --artifact names a file that exists at the trunk tip, and the cell records the commit and the
      file's object id. Any other kind: --run names one of the commands the row itself states in
      backticks, this tool runs it at the trunk tip, and the cell is filled only when it passes,
      with the commit it passed on; a row that states no command cannot be filled this way until
      the charter names one. The wrong flag for the row, or --by, is refused. What each cell was
      proved by is recorded in hordes/<h>/evidence.json, and "horde.mjs done" checks every filled
      cell against it again.
      A row in the charter's evidence
      catalogue counts green when its "reproduced by" cell is filled, or (on a ticket logged
      before this migration) when a ticket merged this wave names the row's id in its own
      acceptance checklist and carries a "reproduced" verdict — in which case that verifier's
      name is written into the charter's cell (the one charter edit any tool here makes). Refuses
      when no wave is open.
  current [--team t] [--horde h]
      prints the open wave number, or "none".

options: --json  --help`;

function isTrunk(team) { return !team || team === 'trunk'; }

function journalPath(horde, team) {
  return isTrunk(team) ? hordePath(horde, 'plan.md') : teamPath(horde, team, 'plan.md');
}

// Exported so horde.mjs (list) and status.mjs (digest) can show the open wave without re-parsing
// the journal themselves.
export function currentWaveNumber(text) {
  if (!text) return null;
  let current = null;
  for (const line of text.split('\n')) {
    const sm = START_RE.exec(line);
    if (sm) { current = sm[1]; continue; }
    const cm = CLOSE_RE.exec(line);
    if (cm && cm[1] === current) current = null;
  }
  return current;
}

export function lastWaveNumber(text) {
  if (!text) return 0;
  let max = 0;
  for (const line of text.split('\n')) {
    const m = START_RE.exec(line) || CLOSE_RE.exec(line);
    if (m && /^\d+$/.test(m[1])) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function append(path, text) {
  const existing = readText(path) || '';
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  appendText(path, sep + text);
}

// The plan bullet a wave opens with — the layers `queue.mjs plan` derives from the tickets right
// now, the parallelism the widest startable layer allows within config.parallelism, and the
// instant the wave opened. All three are read back at the close: the first two to say what the
// wave planned against what it achieved, the third to attribute a ruling to the wave it was made
// in (an escalation carries a timestamp; a journal heading carries only a date).
const PLAN_RE = /^- \S+ plan: layers (\S+) · planned parallelism (\d+) · opened (\S+)$/;

function planAtStart(horde, team, flags) {
  const cfg = readConfig() || {};
  const cap = Number(cfg.parallelism) > 0 ? Math.trunc(Number(cfg.parallelism)) : 6;
  let sizes = [];
  try {
    // buildPlan's own internal resolveTree call (queue.mjs) falls through to its `horde` branch
    // whenever no `tree` is handed to it — this is the one buildPlan caller that used to pass
    // neither, so it always read the ALWAYS-resolved `horde` above (main()'s own resolveHorde
    // (flags), which defaults to the sole horde in a single-horde repository even with nothing
    // typed at all) instead of the raw flag — unlike buildPlan's other two callers (queue.mjs
    // cmdPlan, land.mjs missionSize), which each resolve their own tree first, the same
    // `flags.tree`/`flags.horde` pattern tick.mjs (041), land.mjs (109) and horde.mjs done (113)
    // already draw, and hand buildPlan the resolved path so its internal horde branch is never
    // actually reached. Resolving the same way here, and handing buildPlan the resolved path,
    // means a bare `wave.mjs start` stays on cwd (ask a-002: no --horde never means trunk) and
    // only --horde WRITTEN OUT reads this horde's own trunk instead — kept inside this same try so
    // a resolution failure degrades to "layers: none" exactly as a plan that cannot be built
    // already did before this fix (issue 114).
    const info = resolveTree({ tree: flags.tree, horde: flags.horde }, { cwd: process.cwd() });
    sizes = buildPlan(horde, team || 'trunk', cfg, { tree: info.path }).layers.map((l) => l.length);
  } catch {
    // A plan that cannot be built (a ticket in an unreadable shape, a circle of dependencies)
    // must not stop a wave from opening; the close then reports a planned parallelism of 0,
    // which is exactly what the journal knows.
    sizes = [];
  }
  return {
    sizes,
    layers: sizes.length ? sizes.join('/') : 'none',
    parallelism: Math.min(sizes[0] || 0, cap),
    opened: nowIso(),
  };
}

function cmdStart(horde, positional, flags) {
  const path = journalPath(horde, flags.team);
  const text = readText(path);
  const n = positional[0] || String(lastWaveNumber(text) + 1);
  append(path, `\n# Wave ${n} — start ${today()}\n`);
  const plan = planAtStart(horde, flags.team, flags);
  append(path, `- ${today()} plan: layers ${plan.layers} · planned parallelism ${plan.parallelism} · opened ${plan.opened}\n`);
  emit({ n, layers: plan.sizes, plannedParallelism: plan.parallelism, opened: plan.opened }, flags,
    () => `wave started: ${n} — layers ${plan.layers}, planned parallelism ${plan.parallelism}`);
}

function cmdNote(horde, positional, flags) {
  const text = positional[0];
  if (!text) fail('note requires "<text>"');
  append(journalPath(horde, flags.team), `- ${today()} ${text}\n`);
  emit({ note: text }, flags, () => 'note added');
}

// The journal bullet that says a ticket merged. Exported because a merge is one event and must
// cost one write: `queue.mjs set <t> merged` calls this itself, so the evidence catalogue — which
// reads the journal to find what this wave merged — turns green without the caller having to
// remember a second, independent command. Idempotent, so the older two-call habit still works and
// records the merge once.
export function noteMerged(horde, team, ticket, sha) {
  const path = journalPath(horde, team);
  const bullet = `merged: ${ticket} ${sha}`;
  const existing = readText(path) || '';
  if (existing.includes(bullet)) return { path, bullet, appended: false };
  append(path, `- ${today()} ${bullet}\n`);
  return { path, bullet, appended: true };
}

// What became of a ticket after it landed, in the journal that reports the wave. Two fates, and
// both mean the same thing from different directions: the evidence was not enough. "reverted"
// carries the commit that undid the merge; "reopened" carries the ticket filed to do again what
// this one was supposed to have finished. Exported for the same reason noteMerged is — land.mjs
// records the fate and calls this itself, so the close reads it without anybody having to remember
// a second command. Idempotent: one fate, carried by one thing, is one bullet however often it is
// recorded.
export function noteFate(horde, team, ticket, fate, by) {
  const path = journalPath(horde, team);
  const bullet = `${fate}: ${ticket} ${by}`;
  const existing = readText(path) || '';
  if (existing.includes(bullet)) return { path, bullet, appended: false };
  append(path, `- ${today()} ${bullet}\n`);
  return { path, bullet, appended: true };
}

// The keys this wave carried over without a second reading — summed from the bullets a
// pre-migration checklist left in the journal. Nothing writes a new one any more; kept for a
// wave whose journal still carries them from before this migration.
function waveKeysTransferred(spanText) {
  let total = 0;
  for (const line of spanText.split('\n')) {
    const m = /^- \S+ keys transferred: \S+ (\d+) at diff \S+$/.exec(line);
    if (m) total += Number(m[1]);
  }
  return total;
}

function cmdMerged(horde, positional, flags) {
  const [ticket, sha] = positional;
  if (!ticket || !sha) fail('merged requires <ticket> <sha>');
  const { appended } = noteMerged(horde, flags.team, ticket, sha);
  emit({ ticket, sha, appended }, flags, () => (appended
    ? `merged noted: ${ticket} ${sha}`
    : `merged already noted: ${ticket} ${sha} — the queue records it when the ticket is set merged`));
}

function cmdCurrent(horde, positional, flags) {
  const n = currentWaveNumber(readText(journalPath(horde, flags.team)));
  emit({ current: n }, flags, () => n || 'none');
}

// One wave's own span: the lines between its start marker and the next start/close marker (or
// the end of the file). Every per-wave reading below — what merged, what was audited, when the
// wave opened — is taken from this one extraction rather than each walking the journal itself.
function waveSpan(journalText, waveStartN) {
  const lines = [];
  let inWave = false;
  for (const line of (journalText || '').split('\n')) {
    const sm = START_RE.exec(line);
    if (sm) { inWave = sm[1] === String(waveStartN); continue; }
    if (CLOSE_RE.test(line)) { inWave = false; continue; }
    if (inWave) lines.push(line);
  }
  return lines.join('\n');
}

// Every "merged:" bullet of one wave, with the date and the landed sha it carries — the wave's
// merge timeline. The sha is what lets the close measure how big each merge actually was, so it
// is read here rather than looked up a second way somewhere else.
function waveMerges(spanText) {
  const out = [];
  for (const line of spanText.split('\n')) {
    const m = /^- (\S+) merged: (\S+) (\S+)/.exec(line);
    if (m) out.push({ date: m[1], ticket: m[2], sha: m[3] });
  }
  return out;
}

// Every fate bullet of one wave — what came back after landing, in the wave it came back in. Read
// the same way the merges are: off the journal's own span, so the close states a figure some other
// tool wrote while doing its job rather than one somebody typed into the report.
function waveFates(spanText) {
  const out = [];
  for (const line of spanText.split('\n')) {
    const m = /^- (\S+) (reverted|reopened): (\S+) (\S+)$/.exec(line);
    if (m) {
      out.push({
        date: m[1], fate: m[2], ticket: m[3], by: m[4],
      });
    }
  }
  return out;
}

// How big each of this wave's merges was, and where each sits among the others of the same wave.
// A merge commit's own change is what it brought in over the branch it merged into: `<sha>^1` to
// `<sha>`, which is the same three-dot diff every other reading in this tool set takes, since the
// first parent is an ancestor of the merge. A sha this repository cannot read (an old journal
// bullet, a branch long gone) measures as nothing and simply carries no position.
//
// Ranked against this wave's own merges and nothing else: the set is the comparison, and there is
// no size a merge is over. Reported and never acted on.
function waveChangeSizes(merges, cwd) {
  // One reading per ticket: a wave that recorded the same ticket twice is one merge to measure,
  // not two, and the later sha is the one that stands.
  const shaOf = new Map(merges.map((m) => [m.ticket, m.sha]));
  const ranks = sizeRanks([...shaOf].map(([ticket, sha]) => ({ id: ticket, size: diffSize(`${sha}^1`, sha, { cwd }) })));
  return [...ranks].map(([ticket, size]) => ({ ticket, ...size }))
    .sort((a, b) => a.rank - b.rank || a.ticket.localeCompare(b.ticket));
}

// Achieved parallelism, read off the merge timeline the journal actually holds: the most
// tickets this wave landed on any one day. A journal bullet is dated, not stamped to the
// second, so the day is the finest grain the record supports — and it is the grain that
// answers the question the planned figure asks, which is how many pieces of work were moving
// beside each other rather than one after another.
function achievedParallelism(merges) {
  const byDate = new Map();
  for (const m of merges) byDate.set(m.date, (byDate.get(m.date) || 0) + 1);
  return byDate.size === 0 ? 0 : Math.max(...byDate.values());
}

// A ticket's folder is "NNN-slug"; only NNN is known at the call site.
function findTicketDir(horde, team, ticket) {
  const issuesDir = teamPath(horde, team, 'issues');
  if (!existsSync(issuesDir)) return null;
  const match = readdirSync(issuesDir, { withFileTypes: true })
    .find((d) => d.isDirectory() && d.name.startsWith(`${ticket}-`));
  return match ? join(issuesDir, match.name) : null;
}

// The "## Acceptance" section of a ticket's issue.md — the checklist tk.mjs wrote from `--evidence`.
function acceptanceSection(issueText) {
  return markdownSection(issueText, '## Acceptance');
}

// Exported so horde.mjs's charter edit can hold a ruled escalation's own text to the same test it
// holds a ticket's acceptance checklist to: does this text actually name the row it's cited for.
export function mentionsEvidenceId(text, id) {
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

// Has wave 1 of the mission (the trunk-level journal — "trunk" IS the mission, see the header
// note above) ever started, open or since closed. Exported for horde.mjs's charter edit: a row
// drop is free before the mission's first wave, and needs a ruled escalation after it — a
// mission that never started a wave has nothing yet for a drop to cost.
export function wave1Started(journalText) {
  if (!journalText) return false;
  return journalText.split('\n').some((line) => {
    const sm = START_RE.exec(line);
    if (sm && sm[1] === '1') return true;
    const cm = CLOSE_RE.exec(line);
    return !!(cm && cm[1] === '1');
  });
}

// The latest pre-migration verdict block in a ticket's log.md — log.md is append-only, so the last
// block whose heading reads as one is the most recent verdict.
function latestVerdict(logText) {
  const blocks = parseVerdictBlocks(logText).filter((b) => b.verifier);
  if (!blocks.length) return null;
  const { verifier, result } = blocks[blocks.length - 1];
  return { verifier, result };
}

// ---- the charter's own shape, where a tool writes into it -------------------------------------
//
// The section naming what counts as evidence in THIS repository — refine writes it once per
// mission, a person reads it, and every catalogue row above is reproduced through what it names.
// Its heading and the readers of what it says live in _lib.mjs with every other reader of these
// documents. The one thing that must never happen to it is standing INSIDE the catalogue's section:
// parseEvidenceRows slices "## Acceptance" up to the next "## " heading, so a heading dropped into
// the middle of that table makes every row below it stop existing, silently and with nothing wrong
// to see in the file.

const CATALOGUE_HEADER = ['id', 'evidence', 'node', 'reproduced by'];
const CATALOGUE_HEADER_5 = [...CATALOGUE_HEADER, 'evidence class'];

// Every line anywhere in the charter that looks like a catalogue row — four cells (a charter
// written before the evidence-class column existed, issue 120) or five (one written since), at
// least one filled, and neither header variant nor the separator. The same filters
// parseEvidenceRows applies inside the section, applied to the whole document.
//
// One more exclusion a plain cell count cannot make on its own: the "Prototypes accepted" table
// below (see PROTOTYPE_SECTION) also carries five cells, and a prototype's own id is the same
// catalogue row id it was built to describe, so a five-cell prototype row is shaped exactly like a
// five-cell catalogue row that escaped the Acceptance section. It is excluded by standing outside
// the slice this function scans, not by anything about its cells — the one thing that actually
// tells the two tables apart is which section they stand in.
function catalogueRowsAnywhere(charterText) {
  const text = String(charterText || '');
  const scanned = withoutSection(text, PROTOTYPE_SECTION);
  return scanned.split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map(markdownTableCells)
    .filter((cells) => cells.length === 4 || cells.length === 5)
    .filter((cells) => !cells.every((c, i) => c.toLowerCase() === CATALOGUE_HEADER[i]))
    .filter((cells) => !(cells.length === 5 && cells.every((c, i) => c.toLowerCase() === CATALOGUE_HEADER_5[i])))
    .filter((cells) => !cells.every((c) => c === '' || /^-+$/.test(c)))
    .filter((cells) => cells.some((c) => c.length > 0));
}

// The whole document with one "## <heading>" section's own text cut out — the opposite of
// markdownSection, which returns only that text. Used above so a table that legitimately lives in
// its own later section is never scanned as if it might be catalogue rows an errant heading
// orphaned. `heading` is looked up by JS binding, not by textual order in this file — safe here
// because it is only ever read from inside a function body, called after the whole module (and
// every top-level const in it) has finished evaluating.
function withoutSection(text, heading) {
  const at = text.search(new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
  if (at === -1) return text;
  const rest = text.slice(at);
  const next = rest.indexOf('\n## ', 1);
  const end = next === -1 ? text.length : at + next + 1;
  return text.slice(0, at) + text.slice(end);
}

// Null when the charter's catalogue is whole; otherwise how many rows the document holds, how many
// the readers actually see, and the heading that cut it. A direct measure of the damage rather
// than a guess at which heading is allowed where: any heading standing in the catalogue's table
// hides the rows below it, whatever the heading is called.
export function catalogueCut(charterText) {
  const text = String(charterText || '');
  const acceptance = text.indexOf('## Acceptance');
  if (acceptance === -1) return null;
  const read = parseEvidenceRows(text).length;
  const present = catalogueRowsAnywhere(text).length;
  if (present <= read) return null;
  const rest = text.slice(acceptance);
  const next = rest.indexOf('\n## ', 1);
  const m = next === -1 ? null : /^## (.+)$/m.exec(rest.slice(next + 1));
  return {
    heading: m ? m[1].trim() : '(unknown)', read, present, lost: present - read,
  };
}

// Replaces one "## <heading>" section's body, or adds the whole section when the charter has
// none — a mission started before the section existed gains it rather than being refused. `before`
// names the heading text the new section is placed above; without it (or when that anchor is
// missing) the section goes at the end, which is always outside every machine-read section.
export function upsertCharterSection(charterText, heading, body, { before = null } = {}) {
  const text = String(charterText || '');
  const block = `## ${heading}\n\n${String(body).trim()}\n`;
  const at = text.search(new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
  if (at !== -1) {
    const rest = text.slice(at);
    const end = rest.indexOf('\n## ', 1);
    return end === -1 ? `${text.slice(0, at)}${block}` : `${text.slice(0, at)}${block}\n${rest.slice(end + 1)}`;
  }
  if (before) {
    const anchor = text.indexOf(before);
    if (anchor !== -1) return `${text.slice(0, anchor)}${block}\n${text.slice(anchor)}`;
  }
  return `${text.replace(/\s+$/, '')}\n\n${block}`;
}

// Writes a name into a row's "reproduced by" cell, matched by its id — the one edit any tool in
// this skill is allowed to make to the charter, since it's recording evidence the mission itself
// produced (a merged ticket's reproduced verdict), not a decision about the mission.
//
// cells[4] is that cell's own position whether or not a sixth, evidence-class cell follows it —
// the class column was added after "reproduced by", never before it — so this needs no change of
// its own for issue 120 beyond accepting the wider row: raw '|'.split of a five-cell row (one
// carrying an evidence-class cell) yields seven pieces rather than six. Nothing else this loop
// scans is seven pieces long and starts with a catalogue row's own id in cells[1] — except the
// "Prototypes accepted" table's own rows (see PROTOTYPE_SECTION), which are five cells too and,
// deliberately, carry that same id in their own first cell. This loop returns on its first match
// rather than scoping itself to "## Acceptance", and is still safe: a prototype's id always names
// a real catalogue row, that row always stands earlier in the document (the prototypes table
// lives in a section of its own at the end of the charter), so the real row is always found first.
function setReproducedBy(charterText, id, name) {
  const lines = charterText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|');
    // '' | id | evidence | node | reproduced by | '' (six pieces, four columns) or that same
    // shape with one more piece for a fifth, evidence-class column (seven pieces).
    if (cells.length !== 6 && cells.length !== 7) continue;
    if (cells[1].trim() !== id) continue;
    cells[4] = ` ${name} `;
    lines[i] = cells.join('|');
    return lines.join('\n');
  }
  return charterText;
}

// ---- what each filled cell rests on ----------------------------------------------------------
//
// A "reproduced by" cell is a claim; hordes/<horde>/evidence.json is what the claim was checked
// against when it was written, one record per row: the words written, and the proof — the ticket
// whose reproduced verdict it is, the gate run and the commit it passed at, the command run and the
// commit, the file and its object id at a commit, or the answered ask. Every tool that fills a cell
// writes both, together (stampRow). `horde.mjs done` checks each filled cell against its record
// again (verifyEvidence), and a cell with no record — typed into the charter by hand — proves
// nothing, whatever it says.
function proofsPath(horde) {
  return hordePath(horde, 'evidence.json');
}

export function readProofs(horde) {
  const doc = readJSON(proofsPath(horde), null);
  return doc && doc.rows && typeof doc.rows === 'object' ? doc.rows : {};
}

function stampRow(horde, charterText, id, by, proof) {
  const rows = readProofs(horde);
  rows[id] = { by, ...proof, at: nowIso() };
  writeJSON(proofsPath(horde), { rows });
  return setReproducedBy(charterText, id, by);
}

// The commands a row states itself, each written in backticks in its evidence cell. A row is
// reproduced by running one of them — never a command somebody chose at the moment of filling it.
export function rowCommands(row) {
  return [...String((row && row.evidence) || '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
}

function askNamesRow(ask, id) {
  return mentionsEvidenceId(`${ask.why || ''}\n${ask.answer || ''}`, id);
}

function reachableFrom(root, sha, branch) {
  if (!sha) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, branch], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Every filled cell checked against what was recorded when it was filled. One line per row that
// does not hold, naming why and the way to fill it again; empty when every filled cell holds.
export function verifyEvidence(horde, root) {
  const rows = parseEvidenceRows(readText(hordePath(horde, 'charter.md')) || '');
  const proofs = readProofs(horde);
  const trunk = `${horde}/trunk`;
  const tickets = allHordeTickets(horde);
  const out = [];
  for (const row of rows) {
    if (!row.reproducedBy) continue;
    const proof = proofs[row.id];
    const again = `fill it again: wave.mjs evidence ${row.id} ${evidenceWay(row.evidenceClass).flag}`;
    if (!proof) { out.push(`${row.id} says "${row.reproducedBy}", and nothing recorded proves it — a cell filled by hand is a claim, not a proof; ${again}`); continue; }
    if (proof.by !== row.reproducedBy) { out.push(`${row.id} says "${row.reproducedBy}", but what was proved is "${proof.by}" — the cell was changed by hand; ${again}`); continue; }
    if (proof.kind === 'ticket') {
      const t = tickets.find((x) => x.id === proof.ticket);
      const verdict = t ? latestVerdict(t.logText) : null;
      if (!verdict || verdict.result !== 'reproduced' || verdict.verifier !== proof.by) {
        out.push(`${row.id} rests on ticket ${proof.ticket}'s reproduced verdict by ${proof.by}, which its log no longer carries; ${again}`);
      }
    } else if (proof.kind === 'run' || proof.kind === 'gate') {
      if (!reachableFrom(root, proof.sha, trunk)) out.push(`${row.id} was proved at ${String(proof.sha).slice(0, 7)}, which is not on ${trunk}; ${again}`);
      else if (proof.kind === 'run' && !rowCommands(row).includes(proof.run)) out.push(`${row.id} was proved by \`${proof.run}\`, which the row no longer states; ${again}`);
    } else if (proof.kind === 'artifact') {
      const now = git(['rev-parse', '--verify', '--quiet', `${trunk}:${proof.artifact}`], root);
      if (now !== proof.object) out.push(`${row.id} rests on ${proof.artifact} as it was at ${String(proof.sha).slice(0, 7)}, and the trunk tip ${now ? 'carries a different file' : 'no longer carries it'}; ${again}`);
    } else if (proof.kind === 'ask') {
      const ask = loadAsks(horde).items.find((a) => a && a.id === proof.ask);
      if (!ask || ask.state !== 'answered' || !askNamesRow(ask, row.id)) out.push(`${row.id} rests on ask ${proof.ask}, which is no longer an answered ask naming the row; ${again}`);
    } else {
      out.push(`${row.id} rests on a record this tool does not know (${proof.kind}); ${again}`);
    }
  }
  return out;
}

// ---- the prototype artifact -------------------------------------------------------------------
//
// A prototype earns no verdict and never fills a "reproduced by" cell: what it is for is to be
// looked at, and the only thing that can say it worked is the person who asked for the thing.
// Their answer is written here instead, against the catalogue row the prototype was built to
// describe — the sha256 of what they were shown, who accepted it, and when — and it is what lets
// that row be turned into the tickets that build the real thing. Deliberately not the row's own
// cell: accepting a prototype says "yes, that is what I meant", never "and it is built", and a
// mission whose catalogue went green on prototypes would be reporting drawings as delivery.
//
// It lives in a section of its own at the end of the charter, and its table carries five columns
// rather than four — which is also what keeps it invisible to every reader of the catalogue:
// catalogueRowsAnywhere counts four-cell rows and skips these, so an accepted prototype can never
// be mistaken for a row somebody agreed to.

export const PROTOTYPE_SECTION = 'Prototypes accepted';

const PROTOTYPE_HEADER = ['id', 'prototype', 'sha256', 'accepted by', 'at'];

// Every accepted prototype on the charter, in the order they stand — {id, ticket, sha256,
// acceptedBy, at}. A charter with no such section has accepted none, which is an ordinary answer.
export function parsePrototypeArtifacts(charterText) {
  const text = String(charterText || '');
  const at = text.search(new RegExp(`^##\\s+${PROTOTYPE_SECTION}\\s*$`, 'm'));
  if (at === -1) return [];
  const rest = text.slice(at);
  const next = rest.indexOf('\n## ', 1);
  const section = next === -1 ? rest : rest.slice(0, next);
  return section.split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map(markdownTableCells)
    .filter((cells) => cells.length === PROTOTYPE_HEADER.length)
    .filter((cells) => !cells.every((c, i) => c.toLowerCase() === PROTOTYPE_HEADER[i]))
    .filter((cells) => !cells.every((c) => c === '' || /^-+$/.test(c)))
    .map(([id, ticket, sha256, acceptedBy, when]) => ({
      id, ticket, sha256, acceptedBy, at: when,
    }));
}

// The client's answer to one prototype, written onto the charter. Keyed by the catalogue row, so
// a second showing of the same row replaces the first rather than standing beside it: what the
// row is described by is whatever they last looked at and said yes to, never a pile of drafts.
export function recordPrototypeAcceptance(charterText, artifact) {
  const rows = parsePrototypeArtifacts(charterText).filter((r) => r.id !== artifact.id);
  rows.push({
    id: artifact.id,
    ticket: artifact.ticket,
    sha256: artifact.sha256,
    acceptedBy: artifact.acceptedBy,
    at: artifact.at,
  });
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const body = [
    'Rows described by something the client was shown and answered, rather than by a sentence. An',
    'accepted prototype is not the thing built — it is what the work on that row was written from.',
    '',
    `| ${PROTOTYPE_HEADER.join(' | ')} |`,
    `|${PROTOTYPE_HEADER.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.id} | ${r.ticket} | ${r.sha256} | ${r.acceptedBy} | ${r.at} |`),
  ].join('\n');
  return upsertCharterSection(charterText, PROTOTYPE_SECTION, body);
}

// A row is green when the charter already names who reproduced it, or — when it doesn't yet —
// when a ticket merged this wave both claims the row's id in its own acceptance checklist and
// carries a verifier's "reproduced" verdict; that verifier's name is then written into the
// charter so the row stays green without the director having to transcribe it by hand.
function computeEvidence(horde, team, mergedTickets) {
  const charterPath = hordePath(horde, 'charter.md');
  let charterText = readText(charterPath) || '';
  const rows = parseEvidenceRows(charterText);
  let green = 0;
  let changed = false;
  for (const row of rows) {
    if (row.reproducedBy) { green++; continue; }
    let verifier = null;
    let by = null;
    for (const ticket of mergedTickets) {
      const dir = findTicketDir(horde, team, ticket);
      if (!dir) continue;
      const issueText = readText(join(dir, 'issue.md')) || '';
      if (!mentionsEvidenceId(acceptanceSection(issueText), row.id)) continue;
      const verdict = latestVerdict(readText(join(dir, 'log.md')));
      if (verdict && verdict.result === 'reproduced') { verifier = verdict.verifier; by = ticket; break; }
    }
    if (verifier) {
      green++;
      charterText = stampRow(horde, charterText, row.id, verifier, { kind: 'ticket', ticket: by });
      changed = true;
    }
  }
  if (changed) writeText(charterPath, charterText);
  return { total: rows.length, green };
}

// ---- the catalogue's rows, broken down by what kind of proof each rests on --------------------
//
// Issue 024 gave a promise file an optional `class` naming the kind of proof that keeps it, from a
// fixed six-word list (EVIDENCE_CLASSES in _lib.mjs). Issue 120 gave a charter row the same word in
// a fifth cell of its own, closing 024's own third acceptance line: this is where a wave close
// finally counts the catalogue per class rather than only as one green/total figure.
//
// This is NOT the class a ticket is dispatched at — DEFAULT_CLASSES' light/standard/heavy/max cost
// ladder, which this command never reports at all (see the contrast noted beside both constants in
// _lib.mjs). It is what kind of proof the row itself rests on. Everywhere this reads out loud it
// says "evidence class" or "kind of proof", never a bare "class", on purpose.
//
// A row whose fifth cell is blank — including every row written before the column existed — sorts
// as 'unstated', which is an honest, ordinary answer and reads nothing like a problem. A row whose
// fifth cell holds text that is NOT one of the six words sorts as neither: it is kept out of every
// bucket and named on its own, because folding it into 'unstated' would hide a typo behind a word
// that means "nobody has said yet" when what actually happened is "somebody said something this
// list does not recognise" — a materially different fact the chairman should be able to see. This
// mirrors the strictness packages/promises/doc-shape/check.mjs already applies to a promise file's
// own `class:` field (refused outright when unrecognised) without going as far as that package
// does: a charter row is filled in by a person, not produced by a doc-shape rule that runs in CI,
// so this never refuses the close over it — it only ever says, in the report, exactly what it
// found.
function classifyEvidenceRows(rows) {
  const byClass = EVIDENCE_CLASSES.map((evidenceClass) => ({ evidenceClass, total: 0, green: 0 }));
  const unstated = { evidenceClass: 'unstated', total: 0, green: 0 };
  const byClassMap = new Map(byClass.map((b) => [b.evidenceClass, b]));
  const unrecognized = [];
  for (const row of rows) {
    const raw = row.evidenceClass;
    if (!raw) {
      unstated.total += 1;
      if (row.reproducedBy) unstated.green += 1;
    } else if (byClassMap.has(raw)) {
      const b = byClassMap.get(raw);
      b.total += 1;
      if (row.reproducedBy) b.green += 1;
    } else {
      unrecognized.push({ id: row.id, value: raw });
    }
  }
  return { byClass: [...byClass, unstated], unrecognized };
}

// The prose rendering of classifyEvidenceRows' own reading, for the wave-close journal entry — the
// structured version goes into cmdClose's own --json payload instead, so neither drifts from what
// the other counts.
function evidenceClassBlock({ byClass, unrecognized }) {
  const present = byClass.filter((b) => b.total > 0);
  if (present.length === 0 && unrecognized.length === 0) {
    return 'The catalogue holds no rows yet, so there is nothing here to break down.';
  }
  const lines = present.map((b) => `- **${b.evidenceClass}** — ${b.green}/${b.total} green`);
  if (unrecognized.length) {
    lines.push(
      `- **unrecognized** — ${unrecognized.length} row(s) whose fifth cell names none of the six kinds of proof `
      + `(${EVIDENCE_CLASSES.join(', ')}): ${unrecognized.map((u) => `${u.id} ("${u.value}")`).join(', ')}. `
      + 'Fix the cell or leave it blank.',
    );
  }
  return lines.join('\n');
}

// ---- mission-wide, all-time evidence coverage --------------------------------------
//
// computeEvidence above turns rows green for one wave close: one team, one wave's own merged
// tickets, mutating the charter as it finds a match. status.mjs's six-state digest and
// horde.mjs's done gate both need the same judgement stretched over the whole mission's history
// instead — this section is that shared reading, so neither reimplements "does a ticket's
// acceptance checklist name this row, and did its verifier reproduce it".

// Every non-dropped ticket of the horde, whatever its state — {id, team, text, status, logText}.
// Only "trunk" exists.
function allHordeTickets(horde) {
  const out = [];
  const team = 'trunk';
  const issuesDir = teamPath(horde, team, 'issues');
  if (!existsSync(issuesDir)) return out;
  for (const d of readdirSync(issuesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(issuesDir, d.name);
    const text = readText(join(dir, 'issue.md')) || '';
    const status = (/^\*\*Status:\*\*\s*(\S+)/m.exec(text) || [])[1] || '';
    if (status === 'dropped') continue;
    out.push({
      id: d.name.slice(0, 3), team, text, status, logText: readText(join(dir, 'log.md')) || '',
    });
  }
  return out;
}

// A ticket's own **Status:** rank toward a row it names — the strongest one wins when more than
// one ticket claims the same row. "merged" here does not yet mean the charter is stamped
// (queue.mjs's own merge refusal already requires a reproduced verdict to reach it, but
// computeEvidence's own charter write only happens at a wave close, or here); every other active
// state reads as "running" — in flight, neither filed-and-waiting nor done. Ranks a prototype
// ticket exactly like a work one; deriveRowState below decides first whether a prototype's rank
// is even the right thing to be reading.
const ROW_STATE_RANK = { proposed: 1, queued: 1, merged: 3 };

// The naming tickets' own best (highest-ranked) claim on a row — shared by deriveRowState's two
// branches below, since each needs the same ranking over a different subset of tickets.
function bestByRank(tickets) {
  let best = { rank: 0, ticket: null, verifier: null };
  for (const t of tickets) {
    const rank = ROW_STATE_RANK[t.status] ?? 2;
    if (rank <= best.rank) continue;
    const verdict = rank >= 3 ? latestVerdict(t.logText) : null;
    best = {
      rank, ticket: t.id, verifier: verdict && verdict.result === 'reproduced' ? verdict.verifier : null,
    };
  }
  return best;
}

// The state of one charter row against every ticket in the horde, without writing anything:
// 'reproduced' when the charter cell already names who reproduced it; otherwise the strongest
// state reached by a ticket whose own acceptance checklist names this row's id — 'merged' (a
// merged ticket already carrying a reproduced verdict, per queue.mjs's own merge refusal, but not
// yet written into the charter), 'running' (filed and in flight), 'queued' (filed, not started),
// 'prototyping' (every ticket naming the row is a prototype — see below), or 'no-ticket' (nothing
// claims it at all).
//
// A prototype (issue 026) names a row to be shown, not to be built: it earns no verdict, and its
// own **Status:** tracks how far the showing has got, never the row's real acceptance criteria.
// Folded into 'queued'/'running'/'merged' it would tell a reader real work is under way on the row
// when nobody has started it — the client may only just have been shown something, or not even
// that yet. So a real (work/quality) ticket always wins the row the instant one exists, exactly as
// before; only when every ticket naming the row is a prototype does it read as 'prototyping'
// rather than borrowing a state that means somebody is building the thing itself.
function deriveRowState(row, tickets) {
  if (row.reproducedBy) return { state: 'reproduced', ticket: null, verifier: null };
  const naming = tickets.filter((t) => mentionsEvidenceId(acceptanceSection(t.text), row.id));
  if (naming.length === 0) return { state: 'no-ticket', ticket: null, verifier: null };
  const real = naming.filter((t) => ticketKind(t.text) !== 'prototype');
  if (real.length === 0) return { state: 'prototyping', ticket: bestByRank(naming).ticket, verifier: null };
  const best = bestByRank(real);
  const state = best.rank >= 3 ? 'merged' : best.rank === 2 ? 'running' : 'queued';
  return { state, ticket: best.ticket, verifier: best.verifier };
}

// Read-only: every charter row with its mission-wide state — what status.mjs's evidence block
// shows. Exported so status.mjs never re-derives what "does a ticket prove this row" means.
export function evidenceCoverage(horde) {
  const charterText = readText(hordePath(horde, 'charter.md')) || '';
  const rows = parseEvidenceRows(charterText);
  const tickets = allHordeTickets(horde);
  return rows.map((row) => {
    const { state, ticket } = deriveRowState(row, tickets);
    return { ...row, state, ticket };
  });
}

// Mutating: promotes every row currently at 'merged' (a merged ticket already reproduced it, but
// the charter was never stamped — computeEvidence's own write only fires at that ticket's own
// wave's close) into the charter's "reproduced by" cell, mission-wide and regardless of wave or
// team. What horde.mjs done calls before judging whether every row is green, so the mission's
// final gate does not depend on the director having remembered to close a wave for it. Returns
// the coverage read back afterwards.
export function stampMissionEvidence(horde) {
  const charterPath = hordePath(horde, 'charter.md');
  let charterText = readText(charterPath) || '';
  const rows = parseEvidenceRows(charterText);
  const tickets = allHordeTickets(horde);
  let changed = false;
  for (const row of rows) {
    if (row.reproducedBy) continue;
    const { state, verifier, ticket } = deriveRowState(row, tickets);
    if (state === 'merged' && verifier) {
      charterText = stampRow(horde, charterText, row.id, verifier, { kind: 'ticket', ticket });
      changed = true;
    }
  }
  if (changed) writeText(charterPath, charterText);
  return evidenceCoverage(horde);
}

// A row is filled by something this tool can check, never by what somebody typed — the director is
// an agent too, and its word is a report, not evidence. What checks it is the row's kind of proof
// (the charter's fifth column):
//   client testimony  an answered ask (`--ask <id>`): what the client said, and when
//   artifact          a file that exists at the trunk tip (`--artifact <path>`), recorded with the
//                     commit and the file's own object id, so the cell names exactly what was there
//   anything else     a command this tool runs at the trunk tip (`--run "<command>"`), recorded only
//                     when it passes, with the commit it passed on
const TESTIMONY = 'client testimony';
const ARTIFACT = 'artifact';
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

function gateTimeoutOf(cfg) {
  const asked = Number(cfg && cfg.gateTimeoutMs);
  return Number.isFinite(asked) && asked > 0 ? asked : GATE_TIMEOUT_MS;
}

export function evidenceWay(evidenceClass) {
  const c = String(evidenceClass || '').trim().toLowerCase();
  if (c === TESTIMONY) return { flag: '--ask <id>', what: 'an answered ask' };
  if (c === ARTIFACT) return { flag: '--artifact <path>', what: 'a file that exists at the trunk tip' };
  return { flag: '--run "<command the row states>"', what: 'the command the row states, run by this tool at the trunk tip' };
}

// A table cell holds one line and no column separator.
function cellText(text) {
  return String(text).replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}

function cmdEvidence(horde, positional, flags) {
  const [id] = positional;
  if (!id) fail('evidence requires <id> and one of --ask <id>, --artifact <path> or --run "<command>"');
  const charterPath = hordePath(horde, 'charter.md');
  const charterText = readText(charterPath) || '';
  const row = parseEvidenceRows(charterText).find((r) => r.id === id);
  if (!row) fail(`evidence id ${id} is not in the charter's catalogue`);
  const kind = String(row.evidenceClass || '').trim().toLowerCase();
  const way = evidenceWay(kind);
  const given = ['ask', 'artifact', 'run'].filter((f) => flags[f] !== undefined && flags[f] !== true);
  const expected = kind === TESTIMONY ? 'ask' : kind === ARTIFACT ? 'artifact' : 'run';
  if (flags.by !== undefined && !given.length) {
    fail(`evidence ${id} is not filled by what is typed — "--by" names nobody's proof. `
      + `Row ${id} is ${kind ? `"${kind}"` : 'of no named kind'} evidence, so it is filled by ${way.what}: wave.mjs evidence ${id} ${way.flag}`);
  }
  if (given.length !== 1 || given[0] !== expected) {
    fail(`row ${id} is ${kind ? `"${kind}"` : 'of no named kind'} evidence, so it is filled by ${way.what} and nothing else: wave.mjs evidence ${id} ${way.flag}`);
  }

  let by;
  let detail;
  if (expected === 'ask') {
    const askId = String(flags.ask);
    const ask = loadAsks(horde).items.find((a) => a && a.id === askId);
    if (!ask) fail(`no ask ${askId} in this horde — client testimony is an answered ask: ask.mjs list`);
    if (ask.state !== 'answered') fail(`ask ${askId} is not answered yet — client testimony is what the client said, and they have not said it`);
    if (!askNamesRow(ask, id)) fail(`ask ${askId} does not name ${id} — testimony counts for the row it was asked about; ask the client about ${id} by its id`);
    by = `client testimony — ${ask.id}, answered ${String(ask.answeredAt || '').slice(0, 10)}: "${cellText(ask.answer || '').slice(0, 120)}"`;
    detail = { kind: 'ask', ask: ask.id, answeredAt: ask.answeredAt || null };
  } else {
    const root = resolveTree({}).path;
    const trunkBranch = `${horde}/trunk`;
    const trunkSha = git(['rev-parse', '--verify', '--quiet', trunkBranch], root);
    if (!trunkSha) fail(`no such branch: ${trunkBranch} — the row is checked at the trunk tip`);
    if (expected === 'artifact') {
      const path = String(flags.artifact).replace(/^\.\//, '');
      const blob = git(['rev-parse', '--verify', '--quiet', `${trunkSha}:${path}`], root);
      if (!blob) fail(`${path} does not exist at the trunk tip (${trunkSha.slice(0, 7)}) — an artifact row names a file the trunk carries`);
      by = `artifact ${cellText(path)} at ${trunkSha.slice(0, 7)} (object ${blob.slice(0, 12)})`;
      detail = { kind: 'artifact', artifact: path, sha: trunkSha, object: blob };
    } else {
      const cmd = String(flags.run).trim();
      const stated = rowCommands(row);
      if (!stated.length) {
        fail(`row ${id} states no command of its own, so nothing run now can be its proof. Name the command in the row's evidence, in backticks, with horde.mjs charter edit — the client reads the charter — and run it: wave.mjs evidence ${id} --run "<that command>"`);
      }
      if (!stated.includes(cmd)) {
        fail(`row ${id} is reproduced by the command it states — ${stated.map((c) => `\`${c}\``).join(' or ')} — and \`${cmd}\` is not it`);
      }
      const cfg = readConfig() || {};
      const ran = runGateAt(root, cmd, trunkSha, gateTimeoutOf(cfg));
      if (!ran.ok) {
        fail(`\`${cmd}\` ${ran.timedOut ? 'did not finish in time and was stopped' : 'failed'} at the trunk tip (${trunkSha.slice(0, 7)}) — row ${id} is filled only by a run that passes`);
      }
      by = `\`${cellText(cmd)}\` passed at ${trunkSha.slice(0, 7)}`;
      detail = { kind: 'run', run: cmd, sha: trunkSha };
    }
  }
  writeText(charterPath, stampRow(horde, charterText, id, by, detail));
  emit({ id, by, ...detail }, flags, () => `evidence ${id} reproduced by: ${by}`);
}

function previousGreen(journalText) {
  const re = /\*\*Evidence catalogue:\*\* (\d+)\/\d+ green/g;
  let last = null;
  let m;
  while ((m = re.exec(journalText)) !== null) last = Number(m[1]);
  return last ?? 0;
}

// ---- human decisions per merged ticket -------------------------------------------------------
//
// The learning KPI (ruling escalations-become-rules): how often a human had to answer a question
// for each ticket that landed. It is supposed to fall from wave to wave — a horde that needs the
// same number of answers per ticket in wave six as in wave one has learned nothing.
//
// A wave's decisions are the asks answered since the wave opened, which is why the start bullet
// stamps the instant. A journal written before that stamp existed falls back to subtracting what
// earlier closes already counted — the answer that is at worst coarse, never double-counted.

const DECISIONS_RE = /\*\*Decisions per merged ticket:\*\* (\S+) \((\d+) ruled \/ (\d+) merged\)/g;

function previousDecisions(journalText) {
  const out = [];
  DECISIONS_RE.lastIndex = 0;
  let m;
  while ((m = DECISIONS_RE.exec(journalText)) !== null) {
    out.push({ ratio: m[1], ruled: Number(m[2]), merged: Number(m[3]) });
  }
  return out;
}

function answeredAsks(horde) {
  return loadAsks(horde).items.filter((it) => it.state === 'answered');
}

function decisionsKpi(horde, journalText, openedAt, mergedThisWave) {
  const ruled = answeredAsks(horde);
  const earlier = previousDecisions(journalText);
  const thisWave = openedAt
    ? ruled.filter((it) => String(it.answeredAt || it.at || '') >= openedAt).length
    : Math.max(0, ruled.length - earlier.reduce((sum, e) => sum + e.ruled, 0));
  const ratio = mergedThisWave > 0 ? (thisWave / mergedThisWave).toFixed(2) : '—';
  const series = [...earlier.map((e) => e.ratio), ratio];
  const trend = series.length > 1 ? ` · trend ${series.slice(-5).join(' → ')}` : '';
  return {
    ruled: thisWave,
    merged: mergedThisWave,
    ratio,
    line: `${ratio} (${thisWave} ruled / ${mergedThisWave} merged)${trend}`,
  };
}

// ---- the quality index (ruling quality-always-authorised) ------------------------------------
//
// Five numbers read from the graph's own CLI at the tree this close is run on, printed with the
// delta from the wave before, plus a sixth (judges) shown for the record but never part of what
// "fell" means. The ruling says the index must not fall: raising enforcement is the horde's to do
// on its own, lowering it is the chairman's call — so a fall is not something this tool argues
// with, it is something it escalates.

// The trailing "· judges N" is optional in the pattern: a journal entry a close wrote before this
// figure existed has none, and that is a missing delta to fall back on, not a parse failure.
const QUALITY_RE = /\*\*Quality index:\*\* enforced (\d+) · advisory clean (\d+)\/(\d+) · baseline (\d+) · noise floor (\d+) · coverage (\d+)\/(\d+)(?: · judges (\d+))?/g;

function previousQuality(journalText) {
  QUALITY_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = QUALITY_RE.exec(journalText)) !== null) {
    last = {
      enforced: Number(m[1]),
      advisoryClean: Number(m[2]),
      advisoryTotal: Number(m[3]),
      baseline: Number(m[4]),
      noiseFloor: Number(m[5]),
      coveredFiles: Number(m[6]),
      totalFiles: Number(m[7]),
      judges: m[8] !== undefined ? Number(m[8]) : null,
    };
  }
  return last;
}

function coverageRatio(q) {
  return q && q.totalFiles ? q.coveredFiles / q.totalFiles : null;
}

function measureQuality(cfg) {
  const cwd = resolveTree({}).path;
  const idx = ygQualityIndex(cfg, cwd);
  if (!idx.available) {
    return { measured: false, why: `${idx.why} — install it, or point config.ygCommand at it` };
  }
  return { measured: true, ...idx };
}

// What fell, in the words a chairman reads. Empty when nothing fell — including every case where
// there is nothing to compare against yet.
function qualityDecline(now, prev) {
  if (!now.measured || !prev) return [];
  const out = [];
  if (now.enforced < prev.enforced) out.push(`enforced rules ${prev.enforced} → ${now.enforced}`);
  if (now.advisoryClean < prev.advisoryClean) {
    out.push(`advisory rules with nothing against them ${prev.advisoryClean} → ${now.advisoryClean}`);
  }
  if (now.baseline > prev.baseline) out.push(`blocking violations ${prev.baseline} → ${now.baseline}`);
  if (now.noiseFloor > prev.noiseFloor) out.push(`noise floor ${prev.noiseFloor} → ${now.noiseFloor}`);
  const a = coverageRatio(now);
  const b = coverageRatio(prev);
  if (a !== null && b !== null && a < b) {
    out.push(`coverage ${prev.coveredFiles}/${prev.totalFiles} → ${now.coveredFiles}/${now.totalFiles}`);
  }
  return out;
}

function qualityLine(now, prev) {
  if (!now.measured) return `not measured — ${now.why}`;
  const coverage = now.totalFiles === null ? '0/0' : `${now.coveredFiles}/${now.totalFiles}`;
  const base = `enforced ${now.enforced} · advisory clean ${now.advisoryClean}/${now.advisoryTotal}`
    + ` · baseline ${now.baseline} · noise floor ${now.noiseFloor} · coverage ${coverage} · judges ${now.judges}`;
  // Pairs with no verdict yet and open log cycles are the state of a cache and of the horde's own
  // process, not of the graph: said beside the index, never part of it or of what "fell" means.
  const unfilled = now.unfilled || now.logCyclesOpen
    ? ` — beside it, not counted: ${now.unfilled || 0} pair(s) with no verdict yet${now.unfilledScript ? ` (${now.unfilledScript} script, free to fill)` : ''}`
      + `${now.logCyclesOpen ? `, ${now.logCyclesOpen} log cycle(s) open` : ''}`
    : '';
  if (!prev) return `${base} (first reading)${unfilled}`;
  const sign = (d) => (d >= 0 ? `+${d}` : String(d));
  const deltas = [
    `enforced ${sign(now.enforced - prev.enforced)}`,
    `advisory clean ${sign(now.advisoryClean - prev.advisoryClean)}`,
    `baseline ${sign(now.baseline - prev.baseline)}`,
    `noise floor ${sign(now.noiseFloor - prev.noiseFloor)}`,
    `coverage ${sign((now.coveredFiles || 0) - prev.coveredFiles)}`,
  ];
  if (prev.judges !== null && prev.judges !== undefined) deltas.push(`judges ${sign(now.judges - prev.judges)}`);
  return `${base} (Δ ${deltas.join(' · ')})${unfilled}`;
}

// ---- what the horde raised on its own, and how the chairman undoes it -------------------------
//
// The other half of the quality ruling. The index line above says whether the graph got stronger;
// this block says WHAT the horde did to make it so, in the words of somebody who might want it
// undone: which rules were raised and on what evidence, which improvements it filed and finished,
// and the one sentence that says a lowering is theirs to ask for. It is the veto, and it only
// works if it is legible — so it names rules and components, never files or commands the chairman
// would have to be taught.

// A rule promoted out of advisory stops being counted among "advisory rules with nothing against
// them" — not because anything went wrong with it, but because it got stronger and now blocks. Read
// literally that is a smaller number, and the close would file a `quality` escalation telling the
// chairman the graph got weaker on the very wave the horde made it stricter. So a drop no larger
// than the number of rules raised out of advisory this wave is accounted for and dropped from the
// list; anything beyond it is a real fall and still goes up.
function withoutPromotionEffects(declined, promotions, now, prev) {
  const raised = promotions.filter((p) => p.from === 'advisory').length;
  if (raised === 0 || !prev || !now.measured) return declined;
  const drop = prev.advisoryClean - now.advisoryClean;
  if (drop <= 0 || drop > raised) return declined;
  return declined.filter((d) => !/^advisory rules with nothing against them/.test(d));
}

const RUNG_WORDS = {
  draft: 'inert',
  advisory: 'a warning',
  enforced: 'blocking',
};

function rungPhrase(from, to) {
  return `${RUNG_WORDS[from] || from} → ${RUNG_WORDS[to] || to}`;
}

// The quality tickets among this wave's merges, with what each was about.
function qualityMergesIn(horde, mergedTickets) {
  const out = [];
  for (const id of mergedTickets) {
    let found = null;
    try { found = findTicket(horde, id); } catch { found = null; }
    if (!found || ticketKind(found.text) !== 'quality') continue;
    const title = (/^#\s*\S+\s*·\s*(.*)$/.exec((found.text.split('\n')[0] || '').trim()) || [])[1] || '';
    out.push({ ticket: found.id, node: parseField(found.text, 'Node'), title });
  }
  return out;
}

// What the client has already been shown and answered, stated on its own. It stands apart from
// every figure above it on purpose: an accepted prototype is a row somebody can now describe, not
// a row somebody has delivered, and the two counted together would read as progress that nobody
// built.
function prototypeBlock(artifacts) {
  if (artifacts.length === 0) {
    return 'Nothing was built to be looked at this mission, so there is nothing here for you to have answered.';
  }
  return [
    'Promises you have already been shown something for, and said yes to. Each one is now described by',
    'what you looked at rather than by a sentence, and that is what the work on it was written from:',
    '',
    ...artifacts.map((a) => `- **${a.id}** — shown as ${a.ticket}, accepted by ${a.acceptedBy} on ${a.at}. What you saw: ${a.sha256}.`),
    '',
    'None of this counts toward the figures above. Being shown a thing is not having built it.',
  ].join('\n');
}

function qualityBlock({
  policy, promotions, qualityMerges, indexLine, observed, declined = [],
}) {
  const declineLine = declined.length
    ? `\n\nThe quality index fell this wave: ${declined.join('; ')} — nobody asked for this, and it is not the horde's `
      + 'to accept lower. If it should stand, that is your call to make, not this report\'s.'
    : '';
  if (policy === 'only-the-work') {
    return [
      'This mission is set to only-the-work: the horde raised no rule and filed no improvement of its own this',
      'wave, and it will not until the charter says otherwise.',
      '',
      `Quality index: ${indexLine}${declineLine}`,
    ].join('\n');
  }
  const lines = [];
  if (promotions.length === 0) {
    lines.push('Rules raised this wave: none — no rule had earned the next step yet.');
  } else {
    lines.push('Rules raised this wave, and what earned it:');
    for (const p of promotions) {
      lines.push(`- **${p.aspect}** — ${rungPhrase(p.from, p.to)}. ${p.evidence}`);
    }
  }
  if (observed.length) {
    lines.push('', `Rules being watched: ${observed.map((o) => `${o.aspect} (${o.new} new)`).join(' · ')}`);
  }
  lines.push('');
  if (qualityMerges.length === 0) {
    lines.push('Improvements finished this wave: none.');
  } else {
    lines.push('Improvements finished this wave (filed by the horde, worked after everything the mission asked for):');
    for (const q of qualityMerges) lines.push(`- ${q.ticket} · ${q.node} — ${q.title}`);
  }
  lines.push('', `Quality index: ${indexLine}${declineLine}`);
  lines.push(
    '',
    'Nothing above was asked for and nothing above was made weaker — a rule only ever moved up. If you want any',
    'of it undone, say so: lowering a rule, waiving one or moving its review date is yours alone, and the horde',
    'has no way to do it without you.',
  );
  return lines.join('\n');
}

function cmdClose(horde, positional, flags) {
  const team = flags.team || 'trunk';
  const path = journalPath(horde, flags.team);
  const journalText = readText(path) || '';
  const n = currentWaveNumber(journalText);
  if (!n) fail('no open wave to close');

  if (flags.gate !== undefined && flags.gate !== 'green' && flags.gate !== 'red') {
    fail('--gate must be "green" or "red"');
  }
  // cache/last-gate.json is keyed by level (commit, team, trunk); a team's own close cares
  // about its own merge gate, the trunk's about the trunk merge gate.
  const lastGate = readJSON(hordePath(horde, 'cache', 'last-gate.json'), null);
  const levelGate = lastGate && lastGate[team === 'trunk' ? 'trunk' : 'team'];
  const gate = flags.gate || (levelGate && levelGate.result) || 'unrecorded';
  const level = team === 'trunk' ? 'trunk' : 'team';
  const gateEvidence = flags.evidence ? String(flags.evidence).split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (gateEvidence.length && gate !== 'green') fail('--evidence names rows the wave gate proves; the gate is not green');
  if (gateEvidence.length && !(flags.gate === 'green' && flags.sha)) {
    fail('--evidence names rows the wave gate proves, and only a gate run here proves anything: --gate green --sha <sha> runs it');
  }
  const catalogue = parseEvidenceRows(readText(hordePath(horde, 'charter.md')) || '');
  for (const id of gateEvidence) {
    const row = catalogue.find((r) => r.id === id);
    if (!row) fail(`evidence id ${id} is not in the charter's catalogue`);
    const kind = String(row.evidenceClass || '').trim().toLowerCase();
    if (kind === TESTIMONY || kind === ARTIFACT) {
      fail(`row ${id} is "${kind}" evidence — a gate run does not prove it; it is filled by ${evidenceWay(kind).what}: wave.mjs evidence ${id} ${evidenceWay(kind).flag}`);
    }
  }
  // "--gate green --sha" is checked, not taken: the level's own gate command is run at that commit
  // here, and a close that says green over a gate that is not is refused before anything is
  // written. What it records is `kind: 'ran'`, the only kind `horde.mjs done` trusts. A red one is
  // recorded as said (`kind: 'asserted'`) — it can only hold the mission back, never let it through.
  let gateSha = flags.sha ? String(flags.sha) : null;
  if (flags.gate && flags.sha) {
    const cache = lastGate || {};
    if (flags.gate === 'green') {
      const cfgNow = readConfig() || {};
      const cmd = cfgNow.gates && cfgNow.gates[level];
      if (!cmd) {
        fail(`--gate green --sha is checked by running config.gates.${level} at that commit, and none is configured — set it: horde.mjs config set gates.${level} "<command>"`);
      }
      const here = resolveTree({}).path;
      const levelBranch = level === 'trunk' ? `${horde}/trunk` : null;
      const resolved = git(['rev-parse', '--verify', '--quiet', `${gateSha}^{commit}`], here);
      if (!resolved) fail(`--sha ${gateSha} names no commit in this repository — the gate is checked by running it there`);
      if (levelBranch && !reachableFrom(here, resolved, levelBranch)) {
        fail(`--sha ${gateSha} is not on ${levelBranch} — a wave's gate is the trunk's, run at a commit the trunk carries`);
      }
      const ran = runGateAt(here, cmd, resolved, gateTimeoutOf(cfgNow));
      if (!ran.sha) fail(`--sha ${gateSha} names no commit in this repository — the gate is checked by running it there`);
      if (!ran.ok) {
        fail(`the ${level} gate (${cmd}) ${ran.timedOut ? 'did not finish in time and was stopped' : 'is red'} at ${ran.sha.slice(0, 7)} — "--gate green" is checked by running it, and it did not pass; the wave is still open`);
      }
      gateSha = ran.sha;
      cache[level] = {
        result: 'green', sha: ran.sha, count: null, kind: GATE_RAN, at: nowIso(), by: `wave ${n} close`,
      };
    } else {
      cache[level] = {
        result: flags.gate, sha: gateSha, count: null, kind: GATE_ASSERTED, at: nowIso(), by: `wave ${n} close`,
      };
    }
    writeJSON(hordePath(horde, 'cache', 'last-gate.json'), cache);
  }
  if (gateEvidence.length) {
    const charterPath = hordePath(horde, 'charter.md');
    let charterText = readText(charterPath) || '';
    for (const id of gateEvidence) {
      charterText = stampRow(horde, charterText, id, `wave ${n} gate passed at ${gateSha.slice(0, 7)}`, { kind: 'gate', sha: gateSha });
    }
    writeText(charterPath, charterText);
  }

  const queue = readJSON(teamPath(horde, team, 'queue.json'), { items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];
  const merged = items.filter((i) => i.state === 'merged').length;
  const escalated = items.filter((i) => i.state === 'escalated').length;
  const dropped = items.filter((i) => i.state === 'dropped').length;
  const open = items.length - merged - escalated - dropped;

  const span = waveSpan(journalText, n);
  const merges = waveMerges(span);
  const mergedTickets = new Set(merges.map((m) => m.ticket));
  // What came back after landing. Counted beside the merges rather than folded into them: a wave
  // that merged six tickets and had two of them come back did not merge six.
  const fates = waveFates(span);
  const reverted = fates.filter((f) => f.fate === 'reverted');
  const reopened = fates.filter((f) => f.fate === 'reopened');
  const { total, green } = computeEvidence(horde, team, mergedTickets);
  const delta = green - previousGreen(journalText);
  // Said out loud at every close, not left to be worked out from rows that all happen to name a
  // film or a screenshot: a mission with nothing to run its proof against is a fact about the
  // mission, and a chairman reading "4/7 green" deserves to know what green rests on here.
  const noEvidenceLayer = noEvidenceLayerNote(horde);

  const planned = PLAN_RE.exec(span.split('\n').find((l) => PLAN_RE.test(l)) || '');
  const plannedParallelism = planned ? Number(planned[2]) : 0;
  const openedAt = planned ? planned[3] : null;
  const keysTransferred = waveKeysTransferred(span);

  const decisions = decisionsKpi(horde, journalText, openedAt, mergedTickets.size);

  const cfg = readConfig() || {};

  // The ladder's own reading for this wave, taken before the index is measured: the two-wave test
  // for enforcement counts CLOSED waves, so a wave close is the only thing that may record one,
  // and the free, keyless fill it runs first is what makes the index below a reading of the code
  // as it stands rather than of whatever was last looked at.
  const policy = qualityPolicy(horde);
  let observed = [];
  try {
    observed = observeAspects(horde, resolveTree({}).path, cfg, n).observed;
  } catch {
    // A graph that cannot be read right now still gets its close; the rules simply gain no
    // observation from a wave nobody could measure.
    observed = [];
  }
  const promotions = policy === 'only-the-work' ? [] : pendingPromotions(horde);

  const quality = measureQuality(cfg);
  const prevQuality = previousQuality(journalText);
  // A fallen quality index used to open a "quality" escalation; escalations are gone (019), and
  // "quality" is not one of ask.mjs's four kinds — inventing a fifth was explicitly out of scope,
  // so this is a rendering line only (see the delta already carried in qualityLine below and
  // named again here) until a later task decides whether it needs an ask kind of its own.
  // Provisional — flagged, not a settled design.
  const declined = withoutPromotionEffects(qualityDecline(quality, prevQuality), promotions, quality, prevQuality);

  const qualityMerges = qualityMergesIn(horde, mergedTickets);
  const indexLine = qualityLine(quality, prevQuality);

  // Read back after computeEvidence has had its say, so every reading of the charter below agrees
  // about what the same document holds.
  const charterAfterEvidence = readText(hordePath(horde, 'charter.md')) || '';
  const prototypes = parsePrototypeArtifacts(charterAfterEvidence);
  const evidenceByClass = classifyEvidenceRows(parseEvidenceRows(charterAfterEvidence));

  // How big this wave's merges turned out, each against the others of the same wave. The wave is
  // where a cut that was too wide shows up as a fact rather than as a feeling — so the close
  // records it, and stops there. Nothing is refused or reopened on account of it.
  const changeSizes = waveChangeSizes(merges, resolveTree({}).path);
  const changeSizeLine = changeSizes.length
    ? changeSizes.map((c) => `${c.ticket} ${c.lines}/${c.files} — ${c.rank} of ${c.of}`).join(' · ')
    : 'nothing measured';
  const biggestQuarterTickets = changeSizes.filter((c) => c.biggestQuarter).map((c) => c.ticket);

  // What this mission has done to the law, as a document: the graph on the branch the mission was
  // cut from against the graph on the trunk it has built. Written every close, at the wave's own
  // path, so a second close of the same wave replaces it rather than writing a second one. Whoever
  // renders it into sentences the client can veto reads it from there; this never renders prose.
  const law = writeLawDiff(horde, cfg, n);

  // The law audit: nobody in this family guards the law from a seat of its own, so closing a wave
  // does it. It reads the trunk readings the law diff has just taken (one reading of one commit,
  // not two), files what nobody has answered, and degrades every read it cannot make to a note
  // rather than holding the wave's whole record hostage to a sweep — see audit.mjs's own header.
  const audit = auditLaw(horde, cfg, { team, trunk: law.trunk });

  const vars = {
    n,
    date: today(),
    merged,
    escalated,
    open,
    gate,
    green,
    total,
    reverted: reverted.length,
    reopened: reopened.length,
    delta: delta >= 0 ? `+${delta}` : String(delta),
    // A paragraph of its own directly under the number it qualifies, and nothing at all when this
    // mission has an evidence layer — never a blank line left behind where the sentence would have
    // stood.
    evidenceLayerLine: noEvidenceLayer ? `\n\n${noEvidenceLayer}\n` : '',
    'n-1': String(Number(n) - 1),
    plannedParallelism,
    achievedParallelism: achievedParallelism(merges),
    keysTransferred,
    decisionsLine: decisions.line,
    changeSizeLine: `${changeSizeLine}${biggestQuarterTickets.length ? ` · biggest quarter: ${biggestQuarterTickets.join(', ')}` : ''}`,
    qualityLine: indexLine,
    qualityBlock: qualityBlock({
      policy, promotions, qualityMerges, indexLine, observed, declined,
    }),
    evidenceClassBlock: evidenceClassBlock(evidenceByClass),
    prototypeBlock: prototypeBlock(prototypes),
    auditBlock: auditBlock(audit),
  };

  let rendered;
  try {
    rendered = renderTemplate('wave-close', vars);
  } catch (e) {
    fail(e.message);
  }
  append(path, `\n${rendered}`);
  // Shown to the chairman now, so the next close does not list them again and none is ever missed
  // by falling between one wave's close and the next one's start.
  markPromotionsReported(horde, promotions);
  emit({
    n,
    merged,
    escalated,
    open,
    gate,
    green,
    total,
    delta,
    noEvidenceLayer,
    reverted: reverted.length,
    reopened: reopened.length,
    fates,
    plannedParallelism,
    achievedParallelism: vars.achievedParallelism,
    keysTransferred,
    decisions: { ruled: decisions.ruled, merged: decisions.merged, perMergedTicket: decisions.ratio },
    changeSizes,
    quality,
    qualityDeclined: declined,
    qualityPolicy: policy,
    promoted: promotions.map((p) => ({
      aspect: p.aspect, from: p.from, to: p.to, at: p.at, evidence: p.evidence,
    })),
    qualityMerged: qualityMerges,
    prototypes,
    evidenceByClass,
    aspectsObserved: observed,
    law: { path: law.path, added: law.doc.added.length, raised: law.doc.raised.length, attached: law.doc.attached.length },
    audit,
  }, flags, () => {
    const lines = [`wave ${n} closed — gate ${gate}, ${green}/${total} evidence green`];
    if (noEvidenceLayer) lines.push(noEvidenceLayer);
    const presentClasses = evidenceByClass.byClass.filter((b) => b.total > 0);
    if (presentClasses.length) {
      lines.push(`by kind of proof: ${presentClasses.map((b) => `${b.evidenceClass} ${b.green}/${b.total}`).join(', ')}`);
    }
    if (evidenceByClass.unrecognized.length) {
      lines.push(`${evidenceByClass.unrecognized.length} row(s) name a kind of proof nothing recognises: `
        + `${evidenceByClass.unrecognized.map((u) => `${u.id} ("${u.value}")`).join(', ')}`);
    }
    if (fates.length) {
      lines.push(`after landing: ${reverted.length} reverted, ${reopened.length} reopened — `
        + fates.map((f) => `${f.ticket} ${f.fate} (${f.by})`).join(', '));
    }
    if (changeSizes.length) {
      lines.push(`change size (lines/files, biggest first): ${changeSizeLine}`);
      if (biggestQuarterTickets.length) {
        lines.push(`biggest quarter of this wave: ${biggestQuarterTickets.join(', ')} — worth asking the architect whether work that size wants cutting smaller next time`);
      }
    }
    for (const p of promotions) lines.push(`rule raised: ${p.aspect} ${p.from} → ${p.to}`);
    if (qualityMerges.length) lines.push(`improvements finished: ${qualityMerges.map((q) => q.ticket).join(', ')}`);
    if (declined.length) {
      lines.push(`the quality index fell: ${declined.join('; ')} — nobody asked for this; it is the client's call, not the horde's, to let it stand`);
    }
    lines.push(
      `what this mission has done to the law so far — ${law.doc.added.length} rule(s) added, `
      + `${law.doc.raised.length} raised, ${law.doc.attached.length} newly attached: ${law.path}`,
    );
    const audited = [...audit.reviewDates.filed, ...audit.advise.filed];
    if (audited.length) {
      lines.push(`the law audit filed ${audited.length} ticket(s): ${audited.map((f) => f.ticket).join(', ')}`);
    }
    const askedClient = Array.isArray(audit.advise.asked) ? audit.advise.asked : [];
    if (askedClient.length) {
      lines.push(`the law audit put ${askedClient.length} question(s) to the client: ${askedClient.map((q) => q.ask).join(', ')}`);
    }
    for (const q of audit.quiet) {
      lines.push(`nothing has hit ${q.aspect}: ${q.reading || q.signal || `nothing new against it in ${q.quietWaves} closed wave(s)`}`);
    }
    return lines.join('\n');
  });
}

function main() {
  const { positional: allPositional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...positional] = allPositional;

  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (!cmd) fail('missing command (see --help)');

  const horde = resolveHorde(flags);

  switch (cmd) {
    case 'start': return cmdStart(horde, positional, flags);
    case 'note': return cmdNote(horde, positional, flags);
    case 'merged': return cmdMerged(horde, positional, flags);
    case 'close': return cmdClose(horde, positional, flags);
    case 'evidence': return cmdEvidence(horde, positional, flags);
    case 'current': return cmdCurrent(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) runMain(main);
