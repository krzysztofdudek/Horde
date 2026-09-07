#!/usr/bin/env node
// horde skill — blame.mjs
//
// Chain of custody for one line: git blame -> the commit that introduced it -> the ticket whose
// recorded branch tip (a Keys-line approval, a verify.mjs verdict block's Gate line, or the
// team journal's own "merged: NNN <sha>" bullet) contains that commit as an ancestor -> the
// ticket's author key, verifier key and class, owner approvals, the evidence it named and what
// became of it, and — when this repository carries a graph — the rule verdicts standing against
// the file's owning node. A line no ticket's recorded shas reach says so plainly: pre-horde code.
//
// Read-only: this tool writes nothing, so it needs none of the write-through-the-tools discipline
// the rest of the skill enforces. It searches every horde on the repository, live and archived
// (archiving moves a horde's directory but never rewrites its branches or tickets), because a
// line merged by a horde that has since closed still deserves its custody chain.
//
// Every candidate sha it gathers per ticket can, in principle, contain the blamed commit as an
// ancestor for a reason that has nothing to do with that ticket: trunk only ever moves forward, so
// a ticket that merged long after the line landed also has the line in its own branch tip's
// history. The ticket that actually introduced the line is the one whose recorded sha sits
// CLOSEST to it — `git rev-list --count <commit>..<sha>` is smallest — since any later ticket's
// recorded sha carries every commit merged in between as extra distance. Ties are not expected in
// practice (a line has one introducing ticket); when they occur, the first found by that measure
// wins, deterministically.

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  hordeRoot, hordePath, teamPath, listHordes, readConfig, readJSON, readText, git, fail,
  parseArgs, emit, isMain, repoRoot,
} from './_lib.mjs';
import {
  allTickets, parseKeys, nodesOf, parseField,
} from './tk.mjs';
import { parseEvidenceRows } from './wave.mjs';
import { fileRules } from './node.mjs';

const USAGE = `usage: blame.mjs <file>:<line> [--horde h] [--json]

git blame -> commit -> the ticket whose recorded branch tip contains that commit -> its keys,
approvals, evidence and the rule verdicts standing against the component the graph says owns the
file. Searches every horde on the repository, live and archived. --horde narrows the
search to one horde (and its own archived copies); a line no ticket owns reports so plainly.

options: --json  --help`;

// ---- git blame -------------------------------------------------------------

// One line's authorship, from `git blame --porcelain -L <n>,<n>`: the commit, its author and
// author-time, and the commit's own summary line — everything the porcelain header carries before
// the tab-indented source line, which this stops at rather than parsing.
function blameLine(root, relFile, line) {
  const out = git(['blame', '--porcelain', '-L', `${line},${line}`, '--', relFile], root);
  if (out === null) {
    fail(`git blame failed on ${relFile}:${line} — not a tracked file, or the line does not exist`);
  }
  const lines = out.split('\n');
  const sha = (lines[0] || '').split(' ')[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`git blame gave an unreadable result for ${relFile}:${line}`);
  let author = null;
  let authorTime = null;
  let summary = null;
  for (const l of lines.slice(1)) {
    if (l.startsWith('\t')) break;
    if (l.startsWith('author ')) author = l.slice(7);
    else if (l.startsWith('author-time ')) authorTime = l.slice(12);
    else if (l.startsWith('summary ')) summary = l.slice(8);
  }
  const uncommitted = /^0{40}$/.test(sha);
  return {
    sha,
    uncommitted,
    author,
    date: authorTime ? new Date(Number(authorTime) * 1000).toISOString().slice(0, 10) : null,
    summary,
  };
}

// ---- finding every horde, live and archived --------------------------------
//
// Archiving (horde.mjs archive) moves hordes/<name> to hordes/_archive/<name>-<date> and touches
// no branch — so a line a now-closed horde merged still has its custody chain on disk, and this
// treats an archived directory exactly like a live horde: hordePath/teamPath only ever join the
// name onto "hordes/", so "_archive/<name>-<date>" works as a horde id without either function
// needing to know the difference.

function archivedHordeIds() {
  const dir = join(hordeRoot(), 'hordes', '_archive');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `_archive/${d.name}`)
    .sort();
}

function allHordeIds(filter) {
  const ids = [...listHordes(), ...archivedHordeIds()];
  if (!filter) return ids;
  return ids.filter((id) => id === filter || id.startsWith(`_archive/${filter}-`));
}

// ---- candidate shas per ticket ----------------------------------------------
//
// Three places a ticket's own branch tip is recorded, per scripts/README.md's "keys are bound to
// the diff" section and wave.mjs's journal: a Keys-line node approval ("<name>@<sha>+<patch-id>"
// or "<name>@<sha>"), a verify.mjs verdict block's "**Gate:** ... at sha <sha>" line, and the
// team's own journal "merged: <ticket> <sha>" bullet queue.mjs writes at merge time. Any of the
// three names a commit that was, at some point, this ticket's own branch tip.

function shasFromApprovals(nodeApprovals) {
  const out = [];
  for (const v of Object.values(nodeApprovals)) {
    const m = /@([0-9a-f]{4,40})/.exec(String(v || ''));
    if (m) out.push(m[1]);
  }
  return out;
}

function shasFromLog(logText) {
  const out = [];
  for (const m of logText.matchAll(/\*\*Gate:\*\*[^\n]*?\bat sha ([0-9a-f]{4,40})\b/g)) out.push(m[1]);
  return out;
}

function journalPathFor(hordeId, team) {
  return (!team || team === 'trunk') ? hordePath(hordeId, 'plan.md') : teamPath(hordeId, team, 'plan.md');
}

function shasFromJournal(hordeId, ticket) {
  const text = readText(journalPathFor(hordeId, ticket.team)) || '';
  const out = [];
  const re = new RegExp(`^- \\S+ merged: ${ticket.id} (\\S+)$`, 'gm');
  for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

function candidateShas(hordeId, ticket) {
  const keys = parseKeys(ticket.text);
  const logText = readText(teamPath(hordeId, ticket.team, 'issues', ticket.dirName, 'log.md')) || '';
  return [
    ...shasFromApprovals(keys.nodeApprovals).map((sha) => ({ sha, source: 'keys' })),
    ...shasFromLog(logText).map((sha) => ({ sha, source: 'verdict' })),
    ...shasFromJournal(hordeId, ticket).map((sha) => ({ sha, source: 'journal' })),
  ];
}

function isAncestor(root, commit, sha) {
  return git(['merge-base', '--is-ancestor', commit, sha], root) !== null;
}

function distanceTo(root, commit, sha) {
  const out = git(['rev-list', '--count', `${commit}..${sha}`], root);
  return out === null ? Infinity : Number(out);
}

// The ticket whose recorded branch tip is the closest descendant of the blamed commit — see the
// file header for why "closest" (not merely "an ancestor of") is the right measure. Every horde
// (live or archived, narrowed by --horde) and every ticket in it is walked; this is a search, not
// an index, but a horde's ticket count keeps it cheap in practice.
function findOwningTicket(root, commit, hordeFilter) {
  let best = null;
  for (const hordeId of allHordeIds(hordeFilter)) {
    for (const ticket of allTickets(hordeId)) {
      for (const { sha, source } of candidateShas(hordeId, ticket)) {
        if (!isAncestor(root, commit, sha)) continue;
        const distance = distanceTo(root, commit, sha);
        if (!best || distance < best.distance) best = {
          hordeId, ticket, sha, source, distance,
        };
      }
    }
  }
  return best;
}

// ---- the ticket's own verdict table -----------------------------------------
//
// The most recent verdict block naming this ticket's own verifier key — usually simply the last
// block in the log, but a ticket that went through another round of changes after its verified
// round could have a later, unrelated block, so this looks back for the one the Keys line actually
// points at rather than trusting "last in the file" blindly.

function verdictBlocks(logText) {
  if (!logText) return [];
  return logText.split(/\n(?=## Verdict)/).map((b) => b.trim()).filter((b) => b.startsWith('## Verdict'));
}

function parseVerdictBlock(block) {
  const heading = /^## Verdict · \S+ · \d{4}-\d{2}-\d{2} · by (\S+) \(([^)]+)\)/.exec(block);
  const result = /\*\*Result:\*\*\s*(\S+)/.exec(block);
  const rows = [];
  const tableStart = block.indexOf('| item | command | saw |');
  if (tableStart !== -1) {
    for (const line of block.slice(tableStart).split('\n').slice(2)) {
      if (!line.trim().startsWith('|')) break;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length >= 3) rows.push({ item: cells[0], command: cells[1], saw: cells[2] });
    }
  }
  return {
    verifier: heading ? heading[1] : null,
    class: heading ? heading[2] : null,
    result: result ? result[1] : null,
    rows,
  };
}

function verifierVerdict(logText, verifierName) {
  const blocks = verdictBlocks(logText).map(parseVerdictBlock);
  if (verifierName && verifierName !== '—') {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].verifier === verifierName) return blocks[i];
  }
  return blocks.length ? blocks[blocks.length - 1] : null;
}

// The ticket's own "## Acceptance — evidence" checklist lines, in order — the same section
// verify.mjs's --item indices number and wave.mjs scans for catalogue ids.
function acceptanceLines(ticketText) {
  const idx = ticketText.indexOf('## Acceptance');
  if (idx === -1) return [];
  const rest = ticketText.slice(idx);
  const nextHeading = rest.indexOf('\n## ', 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const out = [];
  for (const line of section.split('\n')) {
    const m = /^- \[([ xX])\]\s*(.+)$/.exec(line.trim());
    if (m && m[2].trim() !== '…') out.push({ checked: m[1].trim() !== '', text: m[2].trim() });
  }
  return out;
}

// Evidence rows the ticket named and their state: each acceptance line, paired (by the same
// 1-based order verify.mjs's own --item contract uses) with what the ticket's verdict recorded
// for it, plus the charter catalogue ids the Evidence field cites and whether the charter shows
// them reproduced.
function evidenceRows(hordeId, ticket, logText) {
  const verdict = verifierVerdict(logText, parseKeys(ticket.text).verifier);
  const lines = acceptanceLines(ticket.text).map((l, i) => ({
    text: l.text,
    checked: l.checked,
    saw: verdict && verdict.rows[i] ? verdict.rows[i].saw : null,
    state: verdict ? verdict.result : 'not yet verified',
  }));
  const catalogueIds = (parseField(ticket.text, 'Evidence') || '')
    .split(',').map((s) => s.trim()).filter((s) => /^E\d+$/.test(s));
  const charterText = readText(hordePath(hordeId, 'charter.md')) || '';
  const catalogueRows = parseEvidenceRows(charterText);
  const catalogue = catalogueIds.map((id) => {
    const row = catalogueRows.find((r) => r.id === id);
    return {
      id,
      evidence: row ? row.evidence : '(not in the charter)',
      state: row && row.reproducedBy ? `reproduced — ${row.reproducedBy}` : 'not yet reproduced',
    };
  });
  return { lines, catalogue };
}

// ---- rule verdicts against the file's owning node ---------------------------
//
// Two questions, two sources, each the only one that can answer its own. WHICH component owns
// this file and WHICH rules reach it is `yg context --file <path> --json` — the graph's own
// resolution, which accounts for overlapping mappings, type coverage and every cascade channel a
// glob match here would get wrong. WHAT VERDICT stands against each of those rules is the lock:
// `yg check` has no --json and no per-file scope (verified against the installed CLI's own
// --help: check offers --aspect, --top, --summary, --details, none of them a file filter), and
// the context document carries which rules apply but never a verdict, so the honest source is the
// lock's own entries — the same content-addressed record `yg check` itself re-hashes against.

// The lock is a triad on disk (`yg knowledge read verification-and-lock`): two committed files
// split by aspect kind, plus a gitignored local cache for deterministic verdicts — any of the
// three may be absent when its own section is empty. Reading all three and merging by aspect id
// is the one union that works whichever files this repository actually has.
function readLockVerdicts(root) {
  const merged = {};
  for (const name of ['yg-lock.nondeterministic.json', '.yg-lock.deterministic.json']) {
    const doc = readJSON(join(root, '.yggdrasil', name), null);
    if (!doc || !doc.verdicts || typeof doc.verdicts !== 'object') continue;
    for (const [aspectId, units] of Object.entries(doc.verdicts)) {
      merged[aspectId] = { ...(merged[aspectId] || {}), ...units };
    }
  }
  return merged;
}

function ruleVerdictsForFile(root, cfg, relFile) {
  const rules = fileRules(root, cfg, relFile);
  if (!rules.available) {
    return { available: false, reason: `${rules.reason} — no rule verdicts for ${relFile}` };
  }
  const node = rules.node;
  if (!node) return { available: false, reason: `${relFile} is not mapped to any component — no rule verdicts` };
  const lock = readLockVerdicts(root);
  const nodeKey = `node:${node}`;
  const fileKey = `file:${relFile}`;
  const rows = rules.aspects.map((a) => {
    const units = lock[a.id] || {};
    const unit = Object.prototype.hasOwnProperty.call(units, fileKey) ? fileKey : nodeKey;
    const entry = units[unit] || null;
    return {
      aspect: a.id,
      status: a.status,
      verdict: entry ? entry.verdict : 'unverified',
      reason: entry && entry.verdict === 'refused' ? entry.reason : undefined,
    };
  });
  return {
    available: true, node, source: rules.source, rows,
  };
}

// ---- ticket detail -----------------------------------------------------------

function ticketTitle(text) {
  return (/^#\s*\S+\s*·\s*(.*)$/.exec((text.split('\n')[0] || '').trim()) || [])[1] || '';
}

function ticketDetail(hordeId, ticket) {
  const { text } = ticket;
  const keys = parseKeys(text);
  const logText = readText(teamPath(hordeId, ticket.team, 'issues', ticket.dirName, 'log.md')) || '';
  const verdict = verifierVerdict(logText, keys.verifier);
  const { lines, catalogue } = evidenceRows(hordeId, ticket, logText);
  return {
    horde: hordeId,
    team: ticket.team,
    id: ticket.id,
    title: ticketTitle(text),
    status: parseField(text, 'Status'),
    nodes: nodesOf(text),
    author: keys.author,
    verifier: { name: keys.verifier, class: verdict ? verdict.class : null },
    ownerApprovals: keys.nodeApprovals,
    evidence: lines,
    catalogueEvidence: catalogue,
  };
}

// ---- rendering ---------------------------------------------------------------

function renderCommit(c) {
  if (c.uncommitted) return 'commit: (uncommitted — this line is not yet part of any commit)';
  return `commit ${c.sha.slice(0, 12)} by ${c.author || '(unknown)'} on ${c.date || '?'} — ${c.summary || '(no summary)'}`;
}

function renderTicket(t) {
  const lines = [
    '',
    `${t.id} · ${t.title || '(untitled)'}`,
    `  horde: ${t.horde} · team: ${t.team} · status: ${t.status}`,
    `  node(s): ${t.nodes.join(', ') || '(none declared)'}`,
    `  author:   ${t.author}`,
    `  verifier: ${t.verifier.name}${t.verifier.class ? ` (${t.verifier.class})` : ''}`,
  ];
  const owners = Object.entries(t.ownerApprovals);
  lines.push('  owner approvals:');
  if (owners.length === 0) lines.push('    (none recorded)');
  else for (const [node, value] of owners) lines.push(`    ${node}: ${value}`);
  lines.push('  evidence:');
  if (t.evidence.length === 0 && t.catalogueEvidence.length === 0) {
    lines.push('    (none named)');
  } else {
    for (const e of t.evidence) {
      const box = e.checked ? 'x' : ' ';
      const saw = e.saw ? ` — saw: ${e.saw}` : '';
      lines.push(`    [${box}] ${e.text} — ${e.state}${saw}`);
    }
    for (const c of t.catalogueEvidence) lines.push(`    ${c.id}: ${c.evidence} — ${c.state}`);
  }
  return lines.join('\n');
}

function renderRules(rules) {
  if (!rules.available) return `\nrule verdicts: ${rules.reason}`;
  const lines = [`\nrule verdicts (node ${rules.node}, from: ${rules.source}):`];
  if (rules.rows.length === 0) lines.push('  (no rule reaches this node)');
  else for (const r of rules.rows) {
    lines.push(`  ${r.aspect} [${r.status}] — ${r.verdict}${r.reason ? `: ${r.reason}` : ''}`);
  }
  return lines.join('\n');
}

// ---- main --------------------------------------------------------------------

function parseTarget(raw) {
  const m = /^(.+):(\d+)$/.exec(String(raw || ''));
  if (!m) fail('blame requires <file>:<line>, e.g. src/app.mjs:42');
  return { file: m[1], line: Number(m[2]) };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); process.exit(0); }
  const { file, line } = parseTarget(positional[0]);

  const root = repoRoot();
  const relFile = relative(root, resolve(process.cwd(), file)).split('\\').join('/');
  if (relFile.startsWith('..')) fail(`${file} is outside the repository`);

  const commit = blameLine(root, relFile, line);
  const cfg = readConfig();
  const rules = ruleVerdictsForFile(root, cfg, relFile);

  let ticket = null;
  if (!commit.uncommitted) {
    const owning = findOwningTicket(root, commit.sha, flags.horde);
    if (owning) ticket = ticketDetail(owning.hordeId, owning.ticket);
  }

  const result = {
    file: relFile, line, commit, ticket, rules,
  };

  emit(result, flags, () => {
    const parts = [renderCommit(commit)];
    if (ticket) {
      parts.push(renderTicket(ticket));
    } else if (!commit.uncommitted) {
      parts.push(`\npre-horde: no ticket in this repository's horde state owns commit ${commit.sha.slice(0, 12)} — this line predates Horde, or was never merged through it.`);
    }
    parts.push(renderRules(rules));
    return parts.join('\n');
  });
}

if (isMain(import.meta.url)) main();
