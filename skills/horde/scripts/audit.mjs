// horde skill — audit.mjs
//
// Not a user-facing command — imported by wave.mjs close, which is the only thing that runs it.
//
// The law auditor. Nobody in this family guards the law from a seat of its own: there is no
// warden, no compliance role, nobody whose job is to notice that a rule has been running unread
// for a year. Closing a wave does it, because a close is the one moment in a mission that is
// already a reading of where things stand — and an audit nobody is paid to run is an audit that
// happens, where a seat created to run it is a seat that files reports nobody opens.
//
// Three sweeps, run at `wave.mjs close`:
//
//   review dates  every rule whose `review_by` has passed gets a ticket on the territory of a
//                 component it reaches, saying "renew or retire" and carrying the last thing the
//                 rule's own history said. The ticket ENDS in a `g-` proposal with a justification,
//                 never in an edit to the date: moving a review date is the client's alone (the
//                 same lowering-is-theirs rule `node.mjs demote` is held to), so a horde that
//                 renewed its own review dates would be marking its own homework.
//
//   advise items  every item in `yg advise --json` this horde has neither queued nor already been
//                 told to leave alone gets a ticket carrying Yggdrasil's own what/why/next
//                 verbatim. An item a recorded decision already hides comes back in the document's
//                 own `suppressed` list and is never re-raised — a dismissal is a decision, and
//                 re-filing it once a wave is how a horde teaches its chairman to stop reading.
//
//   grain advice  `grain advise --json` from the territories this mission leases, down the same
//                 path `queue.mjs quality` walks: `grain advise --json`, schema `grain-advice/1`,
//                 the lease filter. It REPORTS, and files nothing — `queue.mjs quality` is the one
//                 command that turns a Grain advisory into a ticket, and a second filer working
//                 off a second ledger would file every improvement twice. The close says how much
//                 is standing and names the command.
//
// What this deliberately does NOT do is run `yg advise import` to push Grain's advisories into the
// graph's own feed. Importing writes into the trunk's `.yggdrasil/`, and the trunk is written by the
// landing script and by nothing else — every other tool here refuses a graph write on it by name,
// and the trunk worktree is reset to the branch on the next command that resolves it, so the write
// would be discarded rather than landed. An import is therefore a change like any other: it belongs
// on a branch, in a ticket, through the gate. The close raises it; it does not smuggle it in.
//
// Plus one line the three sweeps are really for: the rules nothing has hit. A rule the horde has
// watched across closed waves with nothing new against it, and — when `yg aspects --health` can be
// read — Yggdrasil's own reading of that same silence, which is deliberately NOT "this rule is
// useless": a rule that is never violated may be deterring the very violations it would catch.
// Horde never coins a word for that. It prints Yggdrasil's, or it prints nothing.
//
// ---- what happens when one of the three cannot be read ----------------------------------------
//
// Every read here is degraded to a NOTE, never to a refusal, and the note says which read failed
// and why. The reasoning is the same for all three: a close is the wave's only record — what
// merged, what it cost, what the evidence catalogue stands at, what the mission has done to the
// law — and a wave that cannot be closed has no record at all. Holding that whole record hostage
// to a sweep that is a courtesy would trade something irreplaceable for something that will be
// true again at the next close. So a sweep that could not run says so, by name, in the report and
// in the close's own JSON, and the close goes on.
//
// The one thing never softened is a document that is not the document: an answer with the wrong
// schema, or no schema, is reported as a failed read naming what was actually seen, never parsed
// leniently for whatever can be salvaged. Half a truth from a graph is not a smaller answer than
// none, it is a wrong one — the same line law.mjs draws for the diff.
//
// Two notes on what is NOT degraded here. `yg aspects --json` is read once, on the trunk, by the
// law diff the close runs first (writeLawDiff hands its readings back), so a CLI that cannot
// answer the rule inventory has already stopped the close there, with the law diff's own message
// naming the release to upgrade to; this file never asks that question a second time. And a
// repository with no Grain CLI configured is not a failed read at all — it is the ordinary state
// of a repository that does not use Grain, reported as such, exactly as `queue.mjs quality`
// already reports it.

import { execFileSync } from 'node:child_process';
import {
  asArray, readTerritories, leaseHolderForNode, today, qualityPolicy, firstClass,
} from './_lib.mjs';
import {
  ygJson, ygCommand, readAuditLedger, recordAudit, readAspectLedger, listAllNodes,
} from './node.mjs';
import { createTicket, setTicketBody, findTicket } from './tk.mjs';
// queue.mjs imports wave.mjs, and wave.mjs imports this file — the same deliberate cycle wave.mjs
// already documents at its own import of buildPlan, and safe for the same reason: every binding
// crossing it is a hoisted function declaration and none of the three calls the others while a
// module is still being evaluated. The alternative is a second definition of what a queued item
// is, which is exactly the drift `newQueueItem` exists in one place to prevent.
import { loadQueue, saveQueue, newQueueItem } from './queue.mjs';

const ADVICE_SCHEMA = 'grain-advice/1';
const ADVISE_SCHEMA = 'yg-advise/1';

// How many closed waves of nothing at all make a rule worth a line in the report. Two, the same
// number the ladder's own advisory → enforced test counts — a rule that has been quiet for two
// closed waves is either doing its job invisibly or doing nothing, and that is the question the
// line exists to put to a reader.
export const QUIET_WAVES = 2;

// ---- reading, without ever stopping the close -------------------------------------------------

// One machine document, as a read that reports rather than throws. `{read: true, doc}` or
// `{read: false, why}` — the `why` is a sentence for the wave report, so it names the command and
// what it did instead of answering.
function readDoc(tree, cfg, args, schema) {
  const res = ygJson(tree, cfg, args, schema);
  const { display } = ygCommand(cfg);
  if (res.state === 'ok') return { read: true, doc: res.doc };
  if (res.state === 'no-cli') {
    return { read: false, why: `there is no Yggdrasil CLI at "${display}"` };
  }
  if (res.state === 'stale') {
    return { read: false, why: `\`${res.command}\` did not answer a ${schema} document — ${res.saw || 'it answered something else'}` };
  }
  if (res.state === 'absent') {
    return { read: false, why: `\`${res.command}\` says the graph has nothing to answer about` };
  }
  return { read: false, why: `\`${res.command}\` refused: ${(res.detail || `exit ${res.code}`).split('\n')[0]}` };
}

// `grain advise --json`, down the path `queue.mjs quality` walks — the same command, the same
// schema, the same refusal to read a document that is not the document. The one difference is what
// happens on a refusal: there the whole command IS the Grain read, so it stops; here it is one of
// several things a close reports, so it becomes a note.
function readGrainAdvice(root, cfg) {
  const raw = cfg && cfg.grainCommand;
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { configured: false };
  const display = parts.join(' ');
  let out;
  try {
    out = execFileSync(parts[0], [...parts.slice(1), 'advise', '--json'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
    return {
      configured: true,
      read: false,
      source: `${display} advise --json`,
      why: `\`${display} advise --json\` did not run (exit ${e.status === undefined ? '?' : e.status})${detail ? `: ${detail}` : ''}`,
    };
  }
  // Grain prints its progress on stderr and the document on stdout, so stdout is what is read —
  // from the first `{`, exactly as parseAdvice does, so a stray banner does not read as a refusal.
  const body = String(out || '').trim();
  const start = body.indexOf('{');
  let doc = null;
  if (start !== -1) {
    try { doc = JSON.parse(body.slice(start)); } catch { doc = null; }
  }
  if (!doc || doc.schema !== ADVICE_SCHEMA) {
    const saw = doc && doc.schema ? ` (it is a "${doc.schema}" one)` : '';
    return {
      configured: true,
      read: false,
      source: `${display} advise --json`,
      why: `\`${display} advise --json\` did not answer a ${ADVICE_SCHEMA} document${saw}`,
    };
  }
  return {
    configured: true, read: true, source: `${display} advise --json`, doc,
  };
}

// ---- yg aspects --health, and why it is parsed as a table -------------------------------------
//
// `--health` is refused alongside `--json` by Yggdrasil itself, on purpose: the machine document
// is the rule INVENTORY, and the health projection costs a whole verification pass, so folding one
// into the other would make one schema name mean two things. There is therefore no machine form of
// this reading to ask for, and the only honest options are to parse the table it does print or to
// go without the label. Going without would mean Horde inventing its own word for "a rule nothing
// has hit", which is the one thing this whole line exists NOT to do — the word belongs to the tool
// that measured it. So: parse the table, take only the two columns that are contract-fixed
// (`aspect` first, `signal` by header name), take the plain-words note verbatim when there is one,
// and treat anything that does not look like that table as an unreadable answer rather than a
// guess.

function runHealth(tree, cfg) {
  const { cmd, prefix, display } = ygCommand(cfg);
  try {
    return {
      read: true,
      text: execFileSync(cmd, [...prefix, 'aspects', '--health'], {
        cwd: tree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      }),
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { read: false, why: `there is no Yggdrasil CLI at "${display}"` };
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
    return { read: false, why: `\`${display} aspects --health\` refused (exit ${e.status === undefined ? '?' : e.status})${detail ? `: ${detail}` : ''}` };
  }
}

// {aspect -> {signal, reading}} off the rendered table. `signal` is the word in the signal column
// ('active', 'decorative?', 'quiet', or the em-dash for a rule with no recorded exposure);
// `reading` is the plain-words line Yggdrasil prints under the table for that rule, verbatim and
// unparaphrased. Null when the text is not that table at all.
export function parseHealth(text) {
  const lines = String(text || '').split('\n');
  const headerIdx = lines.findIndex((l) => /^aspect\s{2,}/.test(l) && /\bsignal\b/.test(l));
  if (headerIdx === -1) return null;
  const headers = lines[headerIdx].trim().split(/\s{2,}/);
  const signalCol = headers.indexOf('signal');
  if (headers[0] !== 'aspect' || signalCol === -1) return null;
  const out = new Map();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    const cells = line.trim().split(/\s{2,}/);
    if (cells.length <= signalCol) continue;
    out.set(cells[0], { signal: cells[signalCol], reading: null });
  }
  // "Signal detail (…):" then one indented "<aspect>: <plain words>" per rule that earned one.
  const detailIdx = lines.findIndex((l) => l.startsWith('Signal detail'));
  if (detailIdx !== -1) {
    for (let i = detailIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') break;
      const m = /^\s+(\S+):\s+(.*)$/.exec(lines[i]);
      if (!m) continue;
      const entry = out.get(m[1]);
      if (entry) entry.reading = m[2].trim();
    }
  }
  return out;
}

// ---- who owns a rule's finding ----------------------------------------------------------------

// The component this mission holds that the rule actually reaches, and the territory it sits in.
// Null when the rule reaches nothing of this mission's — which is not a failure: a rule can be
// entirely somebody else's, and filing its review on a territory that never sees it is how a
// ticket ends up with no owner who can answer it.
function ownerFor(horde, nodes) {
  const territories = readTerritories(horde);
  for (const node of [...nodes].sort()) {
    const holder = leaseHolderForNode(node);
    if (!holder || holder.horde !== horde) continue;
    const territory = Object.keys(territories).sort()
      .find((name) => asArray(territories[name].nodes).includes(node)) || null;
    return { node, territory, via: holder.via };
  }
  return null;
}

// The class a ticket on this territory is worked at — the territory's own, when the cut named one
// this horde has, otherwise the mission's first configured class (never a specific model name:
// see DEFAULT_CLASSES in _lib.mjs). A class the config does not know would be refused by
// createTicket, so it is never passed on.
function classFor(horde, cfg, territory) {
  const classes = Object.keys((cfg && cfg.classes) || {});
  const territories = readTerritories(horde);
  const declared = territory && territories[territory] ? territories[territory].class : null;
  if (declared && (classes.length === 0 || classes.includes(declared))) return declared;
  return firstClass(cfg);
}

// ---- the tickets ------------------------------------------------------------------------------

function reviewTicketBody(aspect, reviewBy, why, lastLog, territory) {
  return [
    '## What',
    '',
    `Renew or retire the rule \`${aspect}\`. Its review date (${reviewBy}) has passed, so the rule is in force`,
    'here and nobody has looked at whether it still earns its place.',
    '',
    '## Why',
    '',
    why || 'A review date is a standing request to re-examine whether a rule still earns its place. That date has '
      + 'passed, so the rule is running unreviewed.',
    '',
    'The last thing the rule\'s own history says:',
    '',
    lastLog ? `> ${lastLog.split('\n').join('\n> ')}` : '> (nothing has ever been recorded about this rule)',
    '',
    '## Scope',
    '',
    `The rule itself and its own log${territory ? `, from the territory "${territory}"` : ''}. No behaviour changes`,
    'here — this ticket is a judgement about a rule, not a change to code.',
    '',
    '## Acceptance — evidence',
    '',
    '- [ ] this ends in a `g-` proposal — `node.mjs propose rule "<renew, with the date asked for and why | retire,',
    '      and why>"` — carrying the justification, ruled on by the architect and put to the client',
    `- [ ] \`review_by\` in the rule's own file is UNCHANGED by this ticket`,
    '',
    '## Notes for the worker',
    '',
    'Moving a review date, waiving a rule and lowering one are the same move wearing three hats, and all three are',
    'the client\'s alone. A horde that renewed its own review dates would be marking its own homework: the whole',
    'value of the date is that somebody outside the work has to look again. So the answer to this ticket is a',
    'proposal with a reason in it — renew until when and why, or retire and why — and nothing else.',
    '',
    'This is not a matter of discipline: a branch that moves a review date is refused by the landing gate by',
    'name, and goes through only on an answer from the client. Editing the date here would spend the ticket',
    'and land nothing.',
    '',
    'Retiring is a real answer. A rule nothing has hit in a long time is either deterring the violations it would',
    'catch or has stopped meaning anything, and which of the two it is cannot be read off the count alone. Say',
    'which you think it is, and on what evidence.',
    '',
  ].join('\n');
}

function adviseTicketBody(item, territory) {
  return [
    '## What',
    '',
    String(item.what || '').trim() || 'The graph raised this about itself and nobody has answered it.',
    '',
    '## Why',
    '',
    String(item.why || '').trim(),
    '',
    'Read out of the graph\'s own attention feed (`yg advise`) at a wave close. Nobody asked for it: auditing the',
    'law is nobody\'s seat in this horde, so closing a wave does it.',
    '',
    '## Scope',
    '',
    `${territory ? `The territory "${territory}", and the graph objects this item names.` : 'The graph objects this item names.'}`
      + ' No behaviour changes here unless the item itself asks for one.',
    '',
    '## Acceptance — evidence',
    '',
    '- [ ] the feed no longer raises it: either the graph changed, or the client was asked and the decision is',
    '      recorded against it (`yg advise dismiss <id> --reason "…"` / `yg advise defer <id> --reason "…"`) — the',
    '      reason is a signature, so it is theirs to give, not the horde\'s',
    '',
    '## Notes for the worker',
    '',
    'What Yggdrasil says to do about it, in its own words:',
    '',
    `> ${String(item.next || '(the feed named no next step)').trim().split('\n').join('\n> ')}`,
    '',
    `Attention item id: \`${item.id}\``,
    '',
  ].join('\n');
}

function fileTicket(horde, cfg, team, {
  slug, title, nodes, territory, body,
}) {
  const created = createTicket(horde, {
    slug,
    title,
    nodes,
    cls: classFor(horde, cfg, territory),
    severity: 'low',
    kind: 'quality',
    team,
  });
  setTicketBody(horde, created.id, body, nodes[0]);
  const doc = loadQueue(horde, team);
  doc.items.push(newQueueItem(findTicket(horde, created.id)));
  saveQueue(horde, team, doc);
  return created.id;
}

// ---- the three sweeps -------------------------------------------------------------------------

// Every rule the trunk declares whose review date has passed, as {aspect, reviewBy, nodes}. The
// date comes from the rule inventory (a field, not a sentence); whether it has passed is decided
// here against the close's own day, because a date is only overdue relative to a clock and the
// close's is the one that matters.
export function overdueRules(trunkAspects, trunkReach, day) {
  const out = [];
  for (const [id, aspect] of [...trunkAspects].sort(([a], [b]) => a.localeCompare(b))) {
    const reviewBy = aspect && aspect.reviewBy ? String(aspect.reviewBy) : null;
    // No date is the ordinary state of a rule nobody has set one on, and never a finding. A date
    // that is not a date is Yggdrasil's own refusal to make, and it makes it — a present-but-
    // malformed `review_by` is rejected there rather than ignored — so reading one here as
    // "overdue" would be this tool answering a question the graph has already answered louder.
    if (!reviewBy || !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) continue;
    if (reviewBy >= day) continue;
    const entry = trunkReach.get(id);
    out.push({ aspect: id, reviewBy, nodes: entry ? [...entry.nodes] : [] });
  }
  return out;
}

function sweepReviewDates(horde, cfg, team, { trunkAspects, trunkReach, advise }) {
  const day = today();
  const overdue = overdueRules(trunkAspects, trunkReach, day);
  const already = new Set(readAuditLedger(horde).map((a) => a.key));
  const filed = [];
  const skipped = [];
  for (const rule of overdue) {
    const key = `review-by:${rule.aspect}`;
    if (already.has(key)) {
      skipped.push({ key, aspect: rule.aspect, why: 'already filed as a ticket' });
      continue;
    }
    const owner = ownerFor(horde, rule.nodes);
    if (!owner) {
      skipped.push({
        key,
        aspect: rule.aspect,
        why: rule.nodes.length === 0
          ? 'it reaches no component at all, so there is no territory to hand it to'
          : `it reaches no component this mission holds (${rule.nodes.sort().join(', ')})`,
      });
      continue;
    }
    // Yggdrasil raises the same finding in its own feed, in its own words. Take them when they are
    // there rather than writing a second sentence about the same fact.
    const nominated = advise.read
      ? asArray(advise.doc.items).find((it) => it && it.id === `overdue-review-by:${rule.aspect}`)
      : null;
    const ticket = fileTicket(horde, cfg, team, {
      slug: `law-review-${rule.aspect}`,
      title: `Renew or retire "${rule.aspect}" — its review date passed on ${rule.reviewBy}`,
      nodes: [owner.node],
      territory: owner.territory,
      body: reviewTicketBody(
        rule.aspect,
        rule.reviewBy,
        nominated ? String(nominated.why || '').trim() : null,
        lastLogLine(trunkAspects.get(rule.aspect)),
        owner.territory,
      ),
    });
    recordAudit(horde, {
      key, kind: 'review-by', aspect: rule.aspect, node: owner.node, territory: owner.territory, ticket,
    });
    already.add(key);
    filed.push({
      key, aspect: rule.aspect, reviewBy: rule.reviewBy, node: owner.node, territory: owner.territory, ticket,
    });
  }
  return { overdue: overdue.length, filed, skipped };
}

// What the rule inventory says the rule's history last recorded. The inventory carries WHEN the
// last entry was and whether it moved the rule's standing — not the entry's prose — so this is a
// sentence built out of the two facts it does carry, and it says plainly when there is nothing.
function lastLogLine(aspect) {
  const log = aspect && aspect.log;
  if (!log || !log.at) return null;
  const moved = log.statusChange
    ? `it was ${log.statusChange.from} and became ${log.statusChange.to}`
    : 'the entry recorded no change of standing';
  return `Last written to ${log.at} — ${moved}. Read it in full: \`yg aspects log read --aspect ${aspect.id} --json\`.`;
}

function sweepAdvise(horde, cfg, team, { advise, trunkReach, allNodes }) {
  if (!advise.read) return { read: false, why: advise.why, filed: [], skipped: [] };
  const already = new Set(readAuditLedger(horde).map((a) => a.key));
  const filed = [];
  const skipped = [];
  const items = asArray(advise.doc.items);
  for (const item of items) {
    if (!item || !item.id) continue;
    const key = `advise:${item.id}`;
    // A review date is the other sweep's finding, filed with the rule's own history beside it.
    // Raising it twice under two ids would be two tickets for one fact.
    if (String(item.id).startsWith('overdue-review-by:')) {
      skipped.push({ key, why: 'the review-date sweep files this one' });
      continue;
    }
    // A proposal another tool handed the graph is that tool's document to be filed from, by the
    // one command that reads it: `queue.mjs quality`, against its own ledger. Filing it here too
    // would put the same improvement on the queue twice under two different keys.
    if (String(item.id).startsWith('imported:')) {
      skipped.push({ key, why: 'an imported proposal is filed from the producer\'s own document by `queue.mjs quality`' });
      continue;
    }
    if (already.has(key)) {
      skipped.push({ key, why: 'already filed as a ticket' });
      continue;
    }
    const owner = ownerFor(horde, subjectNodes(item, trunkReach, allNodes));
    if (!owner) {
      skipped.push({ key, why: 'it names nothing this mission holds, so there is no territory to hand it to' });
      continue;
    }
    const ticket = fileTicket(horde, cfg, team, {
      slug: `law-advise-${String(item.id).replace(/[^A-Za-z0-9]+/g, '-')}`,
      title: String(item.what || item.id).trim().slice(0, 120),
      nodes: [owner.node],
      territory: owner.territory,
      body: adviseTicketBody(item, owner.territory),
    });
    recordAudit(horde, {
      key, kind: 'advise', item: item.id, node: owner.node, territory: owner.territory, ticket,
    });
    already.add(key);
    filed.push({
      key, item: item.id, node: owner.node, territory: owner.territory, ticket,
    });
  }
  return {
    read: true,
    items: items.length,
    // An item a recorded decision hides comes back in the feed's own `suppressed` list. It is
    // reported and never re-raised: somebody signed a reason for it, and that is a decision.
    decided: asArray(advise.doc.suppressed).length,
    filed,
    skipped,
  };
}

// The components an attention item is about. Its id is `<class>:<subject>` by Yggdrasil's own
// contract, and the subject is either a component id (the classes about a component) or a rule id
// (the classes about a rule) — a rule's components being what it reaches, which the law diff has
// already read off the trunk. Resolved against the graph, in that order, and never guessed at: a
// subject neither the model nor the reach map knows resolves to nothing, which the sweep reports
// as "names nothing this mission holds" rather than inventing an owner for it.
function subjectNodes(item, trunkReach, allNodes) {
  const raw = String(item.id || '');
  const at = raw.indexOf(':');
  if (at === -1) return [];
  const subject = raw.slice(at + 1);
  if (allNodes.has(subject)) return [subject];
  const reached = trunkReach.get(subject);
  if (reached) return [...reached.nodes];
  // A rule's own drill case reads as `<aspect>/<case>`.
  const viaCase = trunkReach.get(subject.split('/')[0]);
  if (viaCase) return [...viaCase.nodes];
  return [];
}

function sweepGrain(horde, cfg, trunkTree) {
  const res = readGrainAdvice(trunkTree, cfg);
  if (res.configured === false) return { configured: false };
  if (!res.read) return { configured: true, read: false, why: res.why };
  const items = asArray(res.doc.items);
  const mine = [];
  const elsewhere = [];
  for (const item of items) {
    const nodes = asArray(item && item.nodes).filter(Boolean);
    const owner = ownerFor(horde, nodes);
    if (owner) mine.push({ nodes, territory: owner.territory, node: owner.node });
    else elsewhere.push({ nodes });
  }
  const territories = [...new Set(mine.map((m) => m.territory).filter(Boolean))].sort();
  return {
    configured: true, read: true, source: res.source, items: items.length, mine: mine.length, elsewhere: elsewhere.length, territories,
  };
}

// ---- the rules nothing has hit ----------------------------------------------------------------

// How many closed waves in a row saw nothing new against a rule, from the horde's own ladder
// readings. Only the rules the horde watches have these (an enforced rule is not observed — it has
// already climbed), which is exactly why the health reading below is worth asking for: it is the
// only reading either tool has about a rule that is already at the top.
function quietWavesOf(entry) {
  const observations = asArray(entry && entry.observations);
  let n = 0;
  for (let i = observations.length - 1; i >= 0; i--) {
    const o = observations[i];
    if (Number(o.new) !== 0) break;
    n++;
  }
  return n;
}

export function quietRules(horde, health) {
  const ledger = readAspectLedger(horde);
  const byAspect = new Map(ledger.map((e) => [e.aspect, quietWavesOf(e)]));
  const names = new Set([...byAspect.keys(), ...(health ? health.keys() : [])]);
  const out = [];
  for (const aspect of [...names].sort()) {
    const waves = byAspect.has(aspect) ? byAspect.get(aspect) : null;
    const h = health ? health.get(aspect) || null : null;
    const decorative = !!(h && h.signal === 'decorative?');
    if (!decorative && !(waves !== null && waves >= QUIET_WAVES)) continue;
    out.push({
      aspect,
      quietWaves: waves,
      signal: h ? h.signal : null,
      reading: h ? h.reading : null,
    });
  }
  return out;
}

// ---- the block the wave report carries --------------------------------------------------------

function line(prefix, parts) {
  return `${prefix}${parts.filter(Boolean).join(' · ')}`;
}

export function auditBlock(result) {
  if (result.policy === 'only-the-work') {
    return 'This mission is set to only-the-work: the horde audited nothing of the law this wave, and it will not\n'
      + 'until the charter says otherwise.';
  }
  // Anything else that did not run says so rather than rendering four sweeps' worth of zeroes,
  // which would read as "the law is in order" about a law nobody looked at.
  if (!result.ran) {
    return `The law was not audited this wave — ${result.why}. Nothing was filed and nothing below was read.`;
  }
  const lines = [];

  const r = result.reviewDates;
  if (r.overdue === 0) {
    lines.push('Review dates: every rule on the trunk is inside its own review date.');
  } else {
    lines.push(`Review dates: ${r.overdue} rule(s) past the date somebody set to look at them again.`);
    for (const f of r.filed) {
      lines.push(`- **${f.aspect}** — due ${f.reviewBy}, ticket ${f.ticket} on ${f.territory ? `the territory "${f.territory}"` : f.node}. Renew or retire; the date itself is the client's to move.`);
    }
    for (const s of r.skipped) lines.push(`- ${s.aspect} — not filed: ${s.why}.`);
  }

  lines.push('');
  const a = result.advise;
  if (!a.read) {
    lines.push(`The graph's attention feed: not read — ${a.why}. Nothing was filed from it, and it will be read again at the next close.`);
  } else if (a.filed.length === 0) {
    lines.push(line('The graph\'s attention feed: ', [
      `${a.items} item(s) standing`,
      a.decided ? `${a.decided} already decided on and left alone` : null,
      'nothing new for this mission',
    ]));
  } else {
    lines.push(`The graph's attention feed: ${a.filed.length} item(s) nobody here had answered, now on the queue.`);
    for (const f of a.filed) lines.push(`- ${f.ticket} — ${f.item}, on ${f.territory ? `the territory "${f.territory}"` : f.node}.`);
  }

  lines.push('');
  const g = result.grain;
  if (g.configured === false) {
    lines.push('What the repository says about itself: no Grain CLI is configured here, so nothing was read.');
  } else if (!g.read) {
    lines.push(`What the repository says about itself: not read — ${g.why}.`);
  } else {
    lines.push(line('What the repository says about itself: ', [
      `${g.items} advisory(ies) from ${g.source}`,
      `${g.mine} on this mission's own territories${g.territories.length ? ` (${g.territories.join(', ')})` : ''}`,
      g.elsewhere ? `${g.elsewhere} elsewhere` : null,
    ]) + (g.mine ? ' — `queue.mjs quality` files them.' : '.'));
  }

  lines.push('');
  if (result.quiet.length === 0) {
    lines.push(`Rules nothing has hit: none — no rule has gone ${QUIET_WAVES} closed waves without something against it.`);
  } else {
    lines.push('Rules nothing has hit:');
    for (const q of result.quiet) {
      const parts = [];
      if (q.quietWaves !== null && q.quietWaves > 0) parts.push(`nothing new against it in ${q.quietWaves} closed wave(s)`);
      if (q.reading) parts.push(`Yggdrasil reads it: ${q.reading}`);
      else if (q.signal) parts.push(`Yggdrasil's signal for it: ${q.signal}`);
      lines.push(`- **${q.aspect}** — ${parts.join(' · ')}`);
    }
    if (!result.health.read) {
      lines.push('', `(\`yg aspects --health\` was not read — ${result.health.why} — so the counts above are the horde's own, with no reading from the graph beside them.)`);
    }
  }

  return lines.join('\n');
}

// ---- the audit itself -------------------------------------------------------------------------

// auditLaw(horde, cfg, {team, trunk}) — the three sweeps and the quiet-rule reading, run at a wave
// close. `trunk` is what writeLawDiff handed back: the tree it read, and the two readings it took
// there. Files tickets; never throws for anything the graph or Grain failed to answer.
export function auditLaw(horde, cfg, { team = 'trunk', trunk } = {}) {
  const policy = qualityPolicy(horde);
  if (policy === 'only-the-work' || !trunk) {
    return {
      policy: policy === 'only-the-work' ? 'only-the-work' : policy,
      ran: false,
      why: policy === 'only-the-work' ? 'the charter sets quality to only-the-work' : 'the law diff read no trunk tree',
      reviewDates: { overdue: 0, filed: [], skipped: [] },
      advise: { read: false, why: 'not read', filed: [], skipped: [] },
      grain: { configured: false },
      health: { read: false, why: 'not read' },
      quiet: [],
    };
  }

  const advise = readDoc(trunk.tree, cfg, ['advise', '--json'], ADVISE_SCHEMA);
  const allNodes = new Set(listAllNodes(trunk.tree));
  const reviewDates = sweepReviewDates(horde, cfg, team, {
    trunkAspects: trunk.aspects, trunkReach: trunk.reach, advise,
  });
  const adviseSweep = sweepAdvise(horde, cfg, team, { advise, trunkReach: trunk.reach, allNodes });
  const grain = sweepGrain(horde, cfg, trunk.tree);

  const healthRun = runHealth(trunk.tree, cfg);
  let health = { read: false, why: healthRun.why || 'not read' };
  let parsed = null;
  if (healthRun.read) {
    parsed = parseHealth(healthRun.text);
    health = parsed
      ? { read: true, why: null }
      : { read: false, why: `\`${ygCommand(cfg).display} aspects --health\` answered something that is not the health table` };
  }

  return {
    policy,
    ran: true,
    reviewDates,
    advise: adviseSweep,
    grain,
    health,
    quiet: quietRules(horde, parsed),
  };
}
