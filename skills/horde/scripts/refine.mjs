#!/usr/bin/env node
// horde skill — refine.mjs
//
// The one phase of a mission that needs judgment, and the only one where anything is negotiated.
// Four steps, in this order:
//
//   cut      — the request is cut into territories: sets of WHOLE components, any level, each
//              small enough that one agent can hold it.
//   consult  — one consultant per territory, all at once, each seeing its own territory and
//              nothing else. They write the tickets and propose the law; nothing comes back as
//              prose.
//   review   — the architect rules on the whole plan at once. This is the only way a ticket
//              leaves "proposed", and so the only way anything becomes dispatchable.
//   frame    — what the client is shown, and the one place they say "go".
//
// Like `tick`, this tool never spawns anything: it prints the spawn lists and takes their results
// back off disk. That is what keeps the judgment where the judgment belongs — an agent decides,
// a file records it, and this tool holds every decision to the rules that can be checked
// mechanically.
//
// Every step is run twice, and says so. The first run prints the brief to hand out; the second
// reads back the file the brief asked for, checks it, and applies what it says. A step with
// nothing to read yet never guesses at an answer.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  hordePath, readJSON, readText, writeText, readConfig, fail, parseArgs, emit, isMain,
  resolveHorde, resolveTree, git, claimLease, assertLeaseAvailable, provenanceLine, withProvenance,
} from './_lib.mjs';
import {
  ygCommand, ygNode, ygContext, nodeExists, nodeBoundary, nodeRules, renderRules, listAllNodes,
  pathInBoundary, nodeDir, loadGraph,
} from './node.mjs';
import { buildPlan, renderPlan, titleOf } from './queue.mjs';
import {
  findTicket, allTickets, nodesOf, ticketEvidence,
} from './tk.mjs';
import {
  parseEvidenceRows, EVIDENCE_SECTION, catalogueCut, upsertCharterSection,
} from './wave.mjs';
import { detectEvidenceLayer, renderEvidenceJudgement, PROMISES_OFFER } from './horde.mjs';
import { disciplineSection, demoteHeadings } from './brief.mjs';

const STEPS = ['cut', 'consult', 'review', 'frame'];

// The five questions a consultant answers about its own territory, in this order. They are the
// whole of what a consultant is for: everything else in its brief is the context it needs to
// answer them.
const CONSULT_QUESTIONS = [
  'What must change in me?',
  'Is this a new module, or a change inside one that exists?',
  'Does this break single responsibility?',
  'What pattern do I want here, and is it already law?',
  'What contract do I need from a neighbour?',
];

const USAGE = `usage: refine.mjs [--step cut|consult|review|frame] [--horde h] [--team t] [--json]

steps (default: cut):
  cut
      run once, it prints a one-shot architect's brief: the mission card, how to read the graph,
      and what a territory is. The architect answers by writing territories.json.
      run again, it checks that file and takes a lease on every territory in it. Three rules are
      checked here rather than asked for: a territory is a set of WHOLE components (a component is
      never split — it is the graph's own unit), any level counts including a whole subtree root,
      and a territory fits under one size. One component belongs to at most one territory.
  consult
      prints one spawn per territory, all of them parallel, each carrying only its own
      territory's context and the five questions. The consultants write the tickets and propose
      the law themselves; nothing comes back here as prose.
  review
      run once, it writes the plan to a file and prints a one-shot architect's brief with the five
      questions the architect rules a plan by. The architect answers by writing review.json.
      run again, it applies that: a ticket passed goes to "queued", a ticket rejected stays
      "proposed" with the reason on its own log. This is the only way out of "proposed".
  frame
      with --json, the data a session renders to the client: what will change and where, what it
      will prove, and what the law gains. Three sections, no tool names, nothing about how any of
      it is run. The client's "go" is the only approval in the whole mission.

The size a territory is held to is config.territory.maxBytes (default 400000): the bytes of the
code its components map, plus the text of every rule that reaches those files, plus those
components' own logs. One number for the whole horde — the class a territory carries decides what
it costs, never what fits.

options: --json  --help`;

// ---- the files each step hands back ---------------------------------------------------------

function territoriesPath(horde) { return hordePath(horde, 'territories.json'); }
function reviewPath(horde) { return hordePath(horde, 'review.json'); }
function planPath(horde, team) { return hordePath(horde, `plan-${String(team).replace(/\//g, '-')}.md`); }

// A file an agent wrote by hand is read the same way everywhere here: missing is an ordinary
// answer (the step prints its brief instead), unparseable is a refusal naming the file — a
// half-written JSON is what an interrupted run leaves behind, and reading it as an empty document
// would silently lose everything the agent decided.
function readHandback(path, what) {
  if (!existsSync(path)) return null;
  try {
    return readJSON(path, null);
  } catch (e) {
    fail(
      `${path} will not parse as JSON, so ${what} cannot be read: ${e.message}\n`
      + 'A file half-written by an interrupted run is not an empty one. Fix the JSON, or delete the '
      + 'file and run this step again to get a fresh brief.',
    );
    return null;
  }
}

// ---- the cut ---------------------------------------------------------------------------------

// Everything the graph says about one territory's size, in the three parts the refusal reports
// separately — because which part is large says what to do about it. Code is a cut. Rules reaching
// the files is often a rule scoped too widely. A long log is history, and history does not have to
// travel with the work.
function territoryBytes(root, cfg, nodes) {
  const tracked = (git(['ls-files'], root) || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const codeFiles = [];
  const seenAspects = new Set();
  let code = 0;
  let aspects = 0;
  let logs = 0;

  for (const node of nodes) {
    const boundary = nodeBoundary(root, cfg, node);
    for (const rel of tracked) {
      if (codeFiles.includes(rel)) continue;
      if (!pathInBoundary(rel, boundary)) continue;
      codeFiles.push(rel);
      code += fileBytes(join(root, rel));
    }
    logs += fileBytes(join(nodeDir(root, node), 'log.md'));
    const ctx = ygContext(root, cfg, node);
    for (const a of (ctx.doc && Array.isArray(ctx.doc.aspects) ? ctx.doc.aspects : [])) {
      const id = a && a.id ? String(a.id) : null;
      // A rule that reaches two components of one territory is one rule, counted once: the
      // consultant reads it once too.
      if (!id || seenAspects.has(id)) continue;
      seenAspects.add(id);
      aspects += dirBytes(join(root, '.yggdrasil', 'aspects', id));
    }
  }
  return {
    code, aspects, logs, total: code + aspects + logs, files: codeFiles.length, rules: seenAspects.size,
  };
}

function fileBytes(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(full);
    else total += fileBytes(full);
  }
  return total;
}

// Why a name that is not a component is not a component. "The graph has no such thing" and "that
// is a piece of one" are different mistakes with different fixes, and only the second one means
// the architect tried to split a node.
function explainNotANode(root, cfg, name, allNodes) {
  const owner = allNodes.find((n) => String(name).startsWith(`${n}/`))
    || allNodes.find((n) => pathInBoundary(String(name), nodeBoundary(root, cfg, n)));
  if (owner) {
    return `"${name}" is part of the component "${owner}", not a component itself. A territory is a set of `
      + 'WHOLE components — the component is the graph\'s own unit, and half of one has no owner, no rules of '
      + `its own and no boundary to check against. Name "${owner}", or cut the graph first so the part you `
      + 'mean is a component in its own right.';
  }
  return `the graph has no component "${name}". Components this graph has: ${allNodes.join(', ') || '(none)'}.`;
}

// The cut, checked. Every rule is checked against the whole document before anything is claimed,
// so a cut that is wrong anywhere leaves no lease behind — the same ordering claimLease itself
// holds to, for the same reason.
function validateCut(horde, root, cfg, doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(`${territoriesPath(horde)} is not an object of territories — the shape is {"<territory>": {"nodes": ["<component>", …], "class": "<class>", "why": "<one sentence>"}}`);
  }
  const names = Object.keys(doc);
  if (names.length === 0) fail(`${territoriesPath(horde)} names no territory at all — a cut with nothing in it is not a cut`);

  const classes = Object.keys((cfg && cfg.classes) || {});
  const maxBytes = Number(cfg && cfg.territory && cfg.territory.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    fail('config.territory.maxBytes is not a positive number — the size a territory is held to has to be one: horde.mjs config set territory.maxBytes 400000');
  }
  const allNodes = listAllNodes(root);
  const claimedBy = new Map();
  const out = [];

  for (const name of names) {
    const spec = doc[name];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      fail(`territory "${name}" is not an object — each one is {"nodes": [...], "class": "<class>", "why": "<one sentence>"}`);
    }
    const nodes = Array.isArray(spec.nodes) ? spec.nodes.map((n) => String(n)) : null;
    if (nodes === null) fail(`territory "${name}" has no "nodes" list`);
    if (nodes.length === 0) {
      fail(`territory "${name}" is empty — a territory with no component in it names no work, no owner and no rules. Drop it, or say which components it holds.`);
    }
    if (!spec.class) fail(`territory "${name}" names no class — one of: ${classes.join(', ')}`);
    if (classes.length && !classes.includes(String(spec.class))) {
      fail(`territory "${name}" names class "${spec.class}", which this horde does not have. Classes: ${classes.join(', ')} (horde.mjs config get classes).`);
    }
    if (!spec.why || !String(spec.why).trim()) {
      fail(`territory "${name}" says no why — one sentence for why these components are one territory. It is what the client reads in the frame.`);
    }
    for (const node of nodes) {
      if (!nodeExists(root, cfg, node)) fail(`territory "${name}": ${explainNotANode(root, cfg, node, allNodes)}`);
      const already = claimedBy.get(node);
      if (already && already !== name) {
        fail(`the component "${node}" is in two territories at once: "${already}" and "${name}". One component belongs to at most one territory — two consultants deciding the inside of the same component is two answers and no owner.`);
      }
      claimedBy.set(node, name);
    }
    out.push({
      territory: name, nodes, class: String(spec.class), why: String(spec.why).trim(),
    });
  }

  for (const t of out) {
    t.bytes = territoryBytes(root, cfg, t.nodes);
    // Closed boundary: exactly the limit fits. The number is a limit, not a limit minus one.
    if (t.bytes.total > maxBytes) {
      fail(
        `territory "${t.territory}" is ${t.bytes.total} bytes against a limit of ${maxBytes} — `
        + `code ${t.bytes.code} (${t.bytes.files} file(s)), rules ${t.bytes.aspects} (${t.bytes.rules} rule(s)), `
        + `logs ${t.bytes.logs}.\n`
        + 'Nobody can hold that much and still have room to work, whatever class is sent to it. Cut it finer: '
        + `split "${t.territory}" into territories of whole components (${t.nodes.join(', ')}), or, where the code `
        + 'itself is the size, cut the graph first.',
      );
    }
  }
  return out;
}

function cutBrief(horde, root, cfg, info, charter) {
  const { display } = ygCommand(cfg);
  const classes = (cfg && cfg.classes) || {};
  const maxBytes = (cfg && cfg.territory && cfg.territory.maxBytes) || 400000;
  const grain = grainLine(cfg);
  return [
    `# Cut this mission into territories — horde \`${horde}\``,
    '',
    'You are the architect, for one answer. You are not writing tickets and you are not deciding what',
    'happens inside any area — you are deciding where the lines are, once, so that everything after this',
    'can happen in parallel without two agents meeting in the same file.',
    '',
    `Repository root: \`${info.path}\` — read-only. Read the graph before you cut anything:`,
    '',
    '```',
    `${display} tree`,
    `${display} structure`,
    `${display} node <path>          # for every component you are about to place`,
    `${display} impact --node <path> # who depends on it`,
    grain ? `${grain} map                # what this repository's own history says its shape is` : '# (no Grain CLI configured here — the repository\'s own history is not available for this)',
    '```',
    '',
    '## The mission',
    '',
    charter.trim(),
    '',
    '## What a territory is',
    '',
    '- A set of **whole components**. A component is the graph\'s own unit — it has one owner, one boundary',
    '  and its own rules — so half of one is not a thing anybody can be sent to work on. Name components,',
    '  never files, never directories.',
    '- **Any level.** The root of a whole subtree is a legal territory, and so is a single leaf. "The whole',
    '  of the back end" and "just the front-end pieces" are equally good cuts; which is right is a question',
    '  about this mission, not about the graph.',
    '- **One component sits in at most one territory.** Two consultants deciding the inside of the same',
    '  component is two answers and no owner.',
    `- **It fits.** A territory is at most ${maxBytes} bytes of code, rules and component logs together.`,
    '  Over that, this is refused with the count broken down, and you cut finer.',
    '',
    '## What you hand back',
    '',
    `Write \`${territoriesPath(horde)}\`:`,
    '',
    '```json',
    '{',
    '  "<territory>": {',
    '    "nodes": ["<component>", "<component>"],',
    `    "class": "${Object.keys(classes)[0] || 'sonnet'}",`,
    '    "why": "<one sentence: why these belong together>"',
    '  }',
    '}',
    '```',
    '',
    `Classes this horde has: ${Object.keys(classes).join(', ') || '(none configured)'}. The class says what the`,
    'territory costs to work, never how big it may be — a small area full of hard decisions is an expensive',
    'class on a small territory, and that is the right answer.',
    '',
    'The "why" is read by the client, in their own words, in the frame at the end. Write it for them.',
  ].join('\n');
}

function grainLine(cfg) {
  const raw = cfg && cfg.grainCommand;
  return raw ? String(raw).trim() : null;
}

// ---- Grain, where it is available -------------------------------------------------------------
//
// Grain is optional (config.grainCommand is null by default) and a brief that fell over without it
// would make an optional tool mandatory in practice. So every call reports one of three things —
// what it said, that there is no Grain here, or that the command did not run — and the brief
// carries whichever it got.
function grainAsk(cfg, root, args) {
  const raw = grainLine(cfg);
  if (!raw) return { available: false, why: 'no Grain CLI is configured for this repository' };
  const parts = raw.split(/\s+/).filter(Boolean);
  const display = `${raw} ${args.join(' ')}`;
  try {
    const out = execFileSync(parts[0], [...parts.slice(1), ...args], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
    return { available: true, display, text: String(out).trim() };
  } catch (e) {
    return {
      available: false,
      display,
      why: `\`${display}\` did not run (exit ${e.status === undefined ? '?' : e.status})`,
    };
  }
}

function grainSection(cfg, root, asks) {
  const lines = ['## What this repository has already done in places like this', ''];
  const missing = [];
  let any = false;
  for (const { label, args } of asks) {
    const res = grainAsk(cfg, root, args);
    if (res.available) {
      any = true;
      lines.push(`### ${label}`, '', '```', res.text || '(it answered nothing)', '```', '');
    } else {
      missing.push(`${label}${res.why ? ` — ${res.why}` : ''}`);
    }
  }
  if (missing.length) {
    lines.push(
      any ? '### Not in this brief' : '',
      any ? '' : '',
      'These were not answered, so this brief does not carry them. Judge without them, and say in your',
      'tickets where you were guessing:',
      '',
      ...missing.map((m) => `- ${m}`),
      '',
    );
  }
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// ---- the consultation --------------------------------------------------------------------------

// The charter, cut down to what one territory may see. The mission card names every component the
// mission touches and every evidence row it owes; a consultant that read the whole of it would be
// deciding other people's territories, which is exactly what this phase exists to stop. So: the
// goal, the non-goals and the constraints — which are about the mission, not about anybody's
// area — and the evidence rows that belong to this territory or to nobody yet.
function charterForTerritory(charter, nodes) {
  const text = String(charter || '');
  // The evidence judgement travels with them: a consultant deciding what a ticket proves has to
  // know what proof is in this repository, and it is the one section outside the mission's own
  // three that is about the whole mission rather than about somebody else's area.
  const wanted = ['Goal', 'Non-goals', 'Constraints', EVIDENCE_SECTION];
  const out = [];
  for (const heading of wanted) {
    const body = charterSection(text, heading);
    if (body) out.push(`## ${heading}`, '', body, '');
  }
  const rows = parseEvidenceRows(text).filter((r) => !r.node || nodes.includes(r.node));
  out.push('## What this mission must prove, here', '');
  if (rows.length === 0) {
    out.push('The mission card names no evidence row for this area yet. If the work you propose proves', 'something, say so on the ticket and the row can be added.', '');
  } else {
    out.push('| id | evidence | reproduced by |', '|---|---|---|');
    for (const r of rows) out.push(`| ${r.id} | ${r.evidence} | ${r.reproducedBy || '(nobody yet)'} |`);
    out.push('');
  }
  return out.join('\n').trim();
}

function charterSection(text, heading) {
  const idx = text.indexOf(`## ${heading}\n`);
  if (idx === -1) return null;
  const rest = text.slice(idx + `## ${heading}\n`.length);
  const next = rest.indexOf('\n## ');
  return (next === -1 ? rest : rest.slice(0, next)).trim() || null;
}

function consultBrief(horde, root, cfg, info, charter, territory) {
  const lines = [
    `# Your territory: ${territory.territory}`,
    '',
    `You decide the inside of this area and nothing outside it. Somebody else has already decided where`,
    `the lines are, and why this area is one: _${territory.why}_`,
    '',
    `Repository root: \`${info.path}\` — read-only from here. You write tickets and proposals, never code.`,
    '',
    charterForTerritory(charter, territory.nodes),
    '',
    '## What is in your territory',
    '',
  ];

  for (const node of territory.nodes) {
    const doc = ygNode(root, cfg, node);
    const boundary = nodeBoundary(root, cfg, node);
    const rules = nodeRules(root, cfg, node);
    const log = readText(join(nodeDir(root, node), 'log.md'));
    lines.push(
      `### ${node}`,
      '',
      (doc && doc.description) ? String(doc.description).trim() : '_(the graph records no description here)_',
      '',
      '**Files it owns:**',
      '',
      ...(boundary.length ? boundary.map((b) => `- \`${b}\``) : ['- _(it maps no files yet)_']),
      '',
      '**Rules in force on it:**',
      '',
      renderRules(rules, null),
      '',
      '**Its own log:**',
      '',
      log && log.trim() ? ['```', log.trim(), '```'].join('\n') : '_(nothing recorded yet)_',
      '',
    );
  }

  const intent = missionIntent(charter);
  lines.push(
    grainSection(cfg, root, [
      { label: `Where work like "${intent}" lives here`, args: ['where', intent] },
      { label: `How a change like "${intent}" has been made here before`, args: ['how', intent] },
      ...territory.nodes.map((n) => ({
        label: `What a new file under ${n} has had to come with`,
        args: ['obligation', obligationPath(root, cfg, n)],
      })),
    ]),
    '',
    ...evidenceLayerSection(),
    '',
    '## The five questions',
    '',
    'Answer these, in this order, about your territory alone:',
    '',
    ...CONSULT_QUESTIONS.map((q, i) => `${i + 1}. ${q}`),
    '',
    ...consultLawSection(),
    '## How you answer',
    '',
    'Not in prose. Nothing you write back in a message is read. You answer by writing two kinds of thing:',
    '',
    '**Tickets** — one per piece of work, each naming the files it touches, the ports it needs and',
    'delivers, and the evidence rows it earns:',
    '',
    '```',
    `node ${here()}/tk.mjs new <slug> --title "<t>" --node <component> --class <class> \\`,
    '    --files <path>[,path…] --consumes <component>/<port>@<v> --produces <component>/<port>@<v> \\',
    `    --evidence <E-id or "what a verifier reproduces"> --horde ${horde}`,
    `node ${here()}/queue.mjs add <NNN> --proposed --horde ${horde}`,
    `node ${here()}/tk.mjs edit <NNN> --depends <NNN>,<MMM> --by <your name> --horde ${horde}`,
    '```',
    '',
    'Every ticket you file is added with `--proposed`: it is in the queue, counted and visible, and',
    'nothing dispatches it until the whole plan has been ruled on. `tk.mjs edit --depends` is how a',
    'dependency is changed after the fact — the same path `tk.mjs new --depends` uses, so the circle check',
    'is the same one.',
    '',
    '**Law** — a rule to add, or a rule to raise, with the evidence for it. One sentence each, and the',
    'evidence is what you saw in this territory, not what would be nice:',
    '',
    '```',
    `node ${here()}/node.mjs propose rule "<the rule, and what in this territory is the evidence for it>" \\`,
    `    --node <component> --by <your name> --horde ${horde}`,
    '```',
    '',
    '## What you do not decide',
    '',
    'The boundary. Where this territory ends was decided before you were asked, and a component outside it',
    'is not yours to plan, re-cut or file tickets against. If the work genuinely does not fit inside this',
    'area, say so on a ticket as the contract you need from a neighbour — that is question five, and it is',
    'the whole of what you may say about anywhere else.',
  );
  return lines.join('\n');
}

// The consultant is held to the same checklist the architect rules the whole plan by — filing a
// ticket is framing a piece of work. Spliced in directly, rather than through brief.mjs's own
// ROLE_LAW table: the consultant is spawned straight off disk by this file, never rendered by
// brief.mjs, so it has no entry there to carry a discipline in.
function consultLawSection() {
  const file = join(here0(), '..', 'reference', 'discipline', 'framing.md');
  const text = readText(file);
  if (text === null) {
    fail(`the framing discipline is missing at ${file} — the consultant's own checklist lives there and this step will not invent it`);
  }
  const titleMatch = /^#\s+(.+)$/m.exec(text);
  const title = titleMatch ? titleMatch[1].trim() : 'Framing';
  const section = demoteHeadings(disciplineSection(text, 'Checklist', 'framing.md'));
  return [
    '## Law',
    '',
    'You are held to the same checklist the architect rules the whole plan by — filing a ticket is',
    'framing a piece of work, and nothing you write back is a good answer if it fails this reading:',
    '',
    `### ${title} — Checklist`,
    '',
    section,
    '',
  ];
}

// What a consultant is told about proof before it writes a single evidence row. The judgement
// itself is already in the charter above — this says how to read it, how to correct it, and the
// one case in which Horde is allowed to offer a solution of its own.
function evidenceLayerSection() {
  return [
    '## Recognising the evidence layer',
    '',
    'The charter above already says what proof is in this repository. It was judged once, by reading the',
    'repository, and it is what every evidence row you write refers back to. Read it before you name any',
    'evidence, and if it is wrong about your territory, say so on a ticket — a judgement in a file is',
    'correctable, which is the whole reason it is in the file.',
    '',
    'The signals it was made from, in the order they beat each other:',
    '',
    '- **A directory of promises** — markdown, one file per promise, each carrying a status field, and a',
    '  mirror in the tests: a test named for the promise it keeps. Where the graph has pairing rules',
    '  attaching the two, those rules are the law that keeps them honest.',
    '- **Test suites** — the build file names the command, and the file-name patterns say what a test in',
    '  this repository is called. This is the common case and it is enough.',
    '- **A scenario runner** — a runner plus its input files (feature files, fixtures, recorded',
    '  sessions). The inputs are the evidence; the runner is only how they are replayed.',
    '',
    'When a promises directory exists, it is **maintained by whoever works the ticket**, in that ticket,',
    'like any other file the ticket touches — there is no separate step and no separate owner. Its shape',
    'is the repository\'s own law to enforce, through the graph\'s rules, not something Horde checks.',
    '',
    'Say "no evidence layer found" only when there is genuinely nothing: no suite, no promises, no file',
    'named like a test. A suite under a build system this tool does not recognise is **not** nothing — it',
    'is an evidence layer nobody has told the tool about, and the answer there is to give the patterns by',
    'hand, not to add anything. Only on real emptiness is an offer made, and it is one sentence:',
    '',
    `> ${PROMISES_OFFER}`,
    '',
    'Nothing beyond that sentence. Horde is as good at proof as this repository lets it be, and it says so',
    'once.',
  ];
}

// The intent Grain is asked about: the mission's own title, which is the shortest true description
// of the change this repository is being asked for.
function missionIntent(charter) {
  const m = /^#\s+Mission\s+·\s+(.+)$/m.exec(String(charter || ''));
  return (m ? m[1] : 'this change').trim();
}

// `grain obligation` takes a path, not a component. A component's first mapping glob, cut at the
// first wildcard, is the directory that mapping is about; a component that maps nothing at all
// falls back to its own graph directory, which at least exists.
function obligationPath(root, cfg, node) {
  const boundary = nodeBoundary(root, cfg, node);
  for (const glob of boundary) {
    const cut = String(glob).split('*')[0].replace(/\/+$/, '');
    if (cut) return cut;
  }
  return `.yggdrasil/model/${node}`;
}

function here() {
  return '${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts';
}

// ---- the plan review ---------------------------------------------------------------------------

// The five questions an architect rules a plan by live once, in the architect's own role brief.
// They are quoted from there rather than copied here, so a change to what the architect is held to
// reaches this brief without a second copy going stale.
function architectPlanQuestions() {
  const file = join(here0(), '..', 'reference', 'roles', 'architect.md');
  const text = readText(file);
  if (text === null) fail(`the architect's own brief is missing at ${file} — the five questions a plan is ruled by live there, and this step will not invent them`);
  const start = text.indexOf('- **The plan.**');
  if (start === -1) {
    fail(`${file} no longer carries a "- **The plan.**" bullet, which is where the five questions a plan is ruled by live. Quote what is there now rather than letting this step invent them.`);
  }
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n- **');
  const block = (next === -1 ? rest : rest.slice(0, next));
  return `-${block}`.trimEnd();
}

function here0() {
  return new URL('.', import.meta.url).pathname;
}

function reviewBrief(horde, team, charter, planFile, planText) {
  return [
    `# Rule on this plan — horde \`${horde}\`, team \`${team}\``,
    '',
    'You are the architect, for one answer. Nobody else sees the whole of this; that is what you are for.',
    '',
    '## The mission',
    '',
    charter.trim(),
    '',
    '## The plan',
    '',
    `Written whole to \`${planFile}\` — read it there if you need it again. It is reproduced below in full,`,
    'never summarised, because a plan relayed as a summary has already lost the thing you are being asked',
    'to look at.',
    '',
    '```',
    planText.trim(),
    '```',
    '',
    '## What you are ruling on',
    '',
    architectPlanQuestions(),
    '',
    'You rule on the plan as a whole, on every graph proposal on file, and on every contract proposed. You',
    'do not rewrite the plan: what you find goes back as tickets to file, ports to correct, and proposals of',
    'your own.',
    '',
    '## What you hand back',
    '',
    `Write \`${reviewPath(horde)}\` — one entry per ticket you ruled on:`,
    '',
    '```json',
    '{',
    '  "001": { "verdict": "pass" },',
    '  "002": { "verdict": "reject", "why": "<one sentence, in the graph\'s terms>" }',
    '}',
    '```',
    '',
    'A ticket you pass becomes work. A ticket you reject stays a proposal, with your reason on its own log,',
    'and can be rewritten and put to you again. A ticket you do not rule on stays a proposal and is never',
    'dispatched — silence is not a pass.',
  ].join('\n');
}

// ---- the steps -----------------------------------------------------------------------------------

function stepCut(horde, flags) {
  const cfg = readConfig() || {};
  const info = resolveTree({ tree: flags.tree, horde: flags.horde });
  const charter = readText(hordePath(horde, 'charter.md')) || '(no charter on file)';
  const path = territoriesPath(horde);
  const doc = readHandback(path, 'the cut');

  if (doc === null) {
    const brief = cutBrief(horde, info.path, cfg, info, charter);
    emit(withProvenance({
      step: 'cut', horde, state: 'awaiting', file: path, brief,
    }, info), flags, () => `${brief}\n\n---\nHand the brief above to one architect. It writes ${path}; then run this same command again to check the cut and take the leases.\n${provenanceLine(info)}`);
    return;
  }

  const territories = validateCut(horde, info.path, cfg, doc);
  // Every territory is cleared before any is claimed: a cut that collides anywhere leaves no lease
  // behind, so the architect can fix the one line and hand the same file back.
  for (const t of territories) {
    try {
      assertLeaseAvailable(horde, t.territory, { kind: 'territory' });
    } catch (e) {
      fail(e.message);
    }
  }
  const leases = territories.map((t) => {
    try {
      return claimLease(horde, t.territory, { kind: 'territory' });
    } catch (e) {
      return fail(e.message);
    }
  });

  const evidence = writeEvidenceJudgement(horde, info.path, cfg);

  emit(withProvenance({
    step: 'cut',
    horde,
    state: 'accepted',
    file: path,
    maxBytes: cfg.territory.maxBytes,
    territories,
    leases: leases.map((l) => ({ territory: l.node, status: l.status })),
    evidenceLayer: evidence.layer,
  }, info), flags, () => [
    `cut accepted: ${territories.length} territor${territories.length === 1 ? 'y' : 'ies'} (limit ${cfg.territory.maxBytes} bytes each)`,
    ...territories.map((t) => `  ${t.territory}  [${t.class}]  ${t.nodes.join(', ')}  — ${t.bytes.total} bytes (code ${t.bytes.code} · rules ${t.bytes.aspects} · logs ${t.bytes.logs})`),
    `leases taken: ${leases.map((l) => `${l.node} (${l.status})`).join(', ')}`,
    `evidence layer: ${evidence.layer.kind} — written into "${EVIDENCE_SECTION}" in ${evidence.path}`,
    provenanceLine(info),
  ].join('\n'));
}

// ---- the evidence-layer judgement ----------------------------------------------------------
//
// Made once per mission, here, at the first moment a tool holds both the repository and the
// charter: the cut is accepted, no ticket exists yet, and every ticket that comes after refers its
// evidence rows back to this paragraph. Horde brings no idea of proof of its own — it names
// whatever this repository already has, and only offers a package when it can see nothing at all.
//
// Two things are checked before a byte is written. A charter whose catalogue is already cut in two
// by a heading standing inside "## Acceptance" is refused rather than written into: the rows below
// that heading are invisible to parseEvidenceRows and to tk.mjs's own copy of that read, so a
// mission that carried on would be working to a catalogue quietly shorter than the one the
// chairman agreed to. And a charter that cannot be written is a refusal naming the path — never a
// silent skip that leaves the judgement in nobody's head.
function writeEvidenceJudgement(horde, root, cfg) {
  const path = hordePath(horde, 'charter.md');
  const before = readText(path) || '';
  const cut = catalogueCut(before);
  if (cut) {
    fail(
      `${path}: the evidence catalogue is cut in two. This charter holds ${cut.present} catalogue row(s) `
      + `and only ${cut.read} of them are inside "## Acceptance" — "## ${cut.heading}" stands in the middle of the `
      + `table, and every row below it is invisible both here and to tk.mjs, which checks a ticket's `
      + `--evidence ids against this same table. Move that heading out of the catalogue's own section `
      + '(above "## Acceptance", or below the last row) and run this step again. Nothing was written.',
    );
  }
  const layer = detectEvidenceLayer(root, cfg);
  const text = upsertCharterSection(before, EVIDENCE_SECTION, renderEvidenceJudgement(layer), { before: '## Acceptance' });
  try {
    writeText(path, text);
  } catch (e) {
    fail(
      `${path} could not be written, so this mission's judgement of what counts as evidence here is `
      + `not on file: ${e.message}`,
    );
  }
  return { layer, path };
}

function requireTerritories(horde, root, cfg) {
  const path = territoriesPath(horde);
  const doc = readHandback(path, 'the cut');
  if (doc === null) {
    fail(`there is no cut yet: ${path} does not exist. "refine.mjs --step cut" is what makes it — run that first, hand its brief to an architect, then run it again to check what comes back.`);
  }
  return validateCut(horde, root, cfg, doc);
}

function stepConsult(horde, flags) {
  const cfg = readConfig() || {};
  const info = resolveTree({ tree: flags.tree, horde: flags.horde });
  const charter = readText(hordePath(horde, 'charter.md')) || '(no charter on file)';
  const territories = requireTerritories(horde, info.path, cfg);

  const spawns = territories.map((t) => ({
    territory: t.territory,
    class: t.class,
    brief: consultBrief(horde, info.path, cfg, info, charter, t),
  }));

  emit(withProvenance({ step: 'consult', horde, spawns }, info), flags, () => [
    `${spawns.length} consultant(s) — one per territory, all at once, in one message.`,
    '',
    ...spawns.flatMap((s) => [
      `## ${s.territory} — class ${s.class}`,
      '',
      s.brief,
      '',
      '---',
      '',
    ]),
    provenanceLine(info),
  ].join('\n'));
}

function stepReview(horde, flags) {
  const team = flags.team || 'trunk';
  const cfg = readConfig() || {};
  const info = resolveTree({ tree: flags.tree, horde: flags.horde });
  const charter = readText(hordePath(horde, 'charter.md')) || '(no charter on file)';
  const rulings = readHandback(reviewPath(horde), "the architect's ruling");

  if (rulings === null) {
    const plan = buildPlan(horde, team, cfg, { tree: info.path });
    if (plan.cycles.length && plan.cycles[0] && plan.cycles[0].length) {
      fail(
        `the tickets depend on each other in a circle: ${plan.cycles[0].join(' → ')}\n`
        + 'There is no plan to rule on while that stands — nothing in the circle can start, so no order over it '
        + 'means anything. One of those tickets is wrong about what it needs; drop that dependency '
        + '(tk.mjs edit --consumes, or the hand-written one) and run this step again.',
      );
    }
    const file = planPath(horde, team);
    const planText = renderPlan(plan);
    writeText(file, `${planText}\n${provenanceLine(info)}\n`);
    const brief = reviewBrief(horde, team, charter, file, planText);
    emit(withProvenance({
      step: 'review', horde, team, state: 'awaiting', plan: file, file: reviewPath(horde), brief,
    }, info), flags, () => `${brief}\n\n---\nHand the brief above to one architect. It writes ${reviewPath(horde)}; then run this same command again to apply what it ruled.\n${provenanceLine(info)}`);
    return;
  }

  if (typeof rulings !== 'object' || Array.isArray(rulings)) {
    fail(`${reviewPath(horde)} is not an object of rulings — the shape is {"<ticket>": {"verdict": "pass"|"reject", "why": "<one sentence>"}}`);
  }
  const applied = [];
  for (const [rawId, ruling] of Object.entries(rulings)) {
    const ticket = findTicket(horde, rawId);
    if (!ticket) fail(`${reviewPath(horde)} rules on "${rawId}", which is not a ticket of horde "${horde}"`);
    const verdict = ruling && ruling.verdict ? String(ruling.verdict) : null;
    if (verdict !== 'pass' && verdict !== 'reject') {
      fail(`${reviewPath(horde)}: ticket ${ticket.id} has verdict "${verdict === null ? '(none)' : verdict}" — it is "pass" or "reject", and nothing else`);
    }
    if (verdict === 'reject' && (!ruling.why || !String(ruling.why).trim())) {
      fail(`${reviewPath(horde)}: ticket ${ticket.id} is rejected with no reason. A rejection the writer cannot answer is a rejection they cannot fix — say why, in one sentence.`);
    }
    applied.push({ ticket: ticket.id, verdict, why: verdict === 'reject' ? String(ruling.why).trim() : null });
  }

  const results = applied.map((a) => applyRuling(horde, team, a));
  emit(withProvenance({
    step: 'review', horde, team, state: 'applied', rulings: results,
  }, info), flags, () => [
    `ruled: ${results.filter((r) => r.verdict === 'pass').length} passed, ${results.filter((r) => r.verdict === 'reject').length} rejected`,
    ...results.map((r) => `  ${r.ticket} -> ${r.status}${r.why ? ` — ${r.why}` : ''}`),
    provenanceLine(info),
  ].join('\n'));
}

// One ruling, applied through the tools that own the two states rather than by writing either file
// here: the ticket's own status, and the queue item that decides whether anything may pick it up.
function applyRuling(horde, team, { ticket, verdict, why }) {
  const scripts = new URL('.', import.meta.url).pathname;
  const node = process.execPath;
  const runTool = (tool, args) => {
    try {
      execFileSync(node, [join(scripts, tool), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      fail(`${tool} ${args.join(' ')} refused:\n${((e.stderr && e.stderr.toString()) || e.message).trim()}`);
    }
  };
  if (verdict === 'pass') {
    runTool('tk.mjs', ['status', ticket, 'queued', 'passed the architect\'s plan review', '--horde', horde]);
    runTool('queue.mjs', ['set', ticket, 'queued', '--team', team, '--horde', horde, '--json']);
    return {
      ticket, verdict, status: 'queued', why: null,
    };
  }
  runTool('tk.mjs', ['log', ticket, `rejected at the plan review: ${why}`, '--horde', horde, '--json']);
  return {
    ticket, verdict, status: 'proposed', why,
  };
}

// ---- the frame ------------------------------------------------------------------------------------

// Everything the client is told, and nothing else. Three sections, in the order somebody who did
// not ask for any of this would want them: what changes, what that proves, and what the place is
// left holding afterwards. No tool is named here, no file is named here, and nothing about how any
// of it runs — the client asked for an outcome, and the machinery is not theirs to carry.
function stepFrame(horde, flags) {
  const team = flags.team || 'trunk';
  const cfg = readConfig() || {};
  const info = resolveTree({ tree: flags.tree, horde: flags.horde });
  const charter = readText(hordePath(horde, 'charter.md')) || '';
  const territories = requireTerritories(horde, info.path, cfg);

  const leaf = (t) => String(t).split('/').pop();
  const tickets = allTickets(horde)
    .filter((t) => leaf(t.team) === leaf(team) && t.status !== 'dropped')
    .map((t) => ({
      id: t.id, title: titleOf(t.text), nodes: nodesOf(t.text), evidence: ticketEvidence(t.text), status: t.status,
    }));

  const areas = territories.map((t) => ({
    area: t.territory,
    why: t.why,
    parts: t.nodes,
    work: tickets
      .filter((tk) => tk.nodes.some((n) => t.nodes.includes(n)))
      .map((tk) => ({ ref: tk.id, what: tk.title })),
  }));

  const rows = parseEvidenceRows(charter).map((r) => {
    const takenBy = tickets.filter((tk) => tk.evidence.includes(r.id)).map((tk) => tk.id);
    return {
      id: r.id,
      proves: r.evidence,
      where: r.node || null,
      takenBy,
      taken: takenBy.length > 0,
    };
  });

  const proposals = loadGraph(horde).proposals
    .filter((p) => p.kind === 'rule' && p.status !== 'vetoed')
    .map((p) => ({ says: String(p.text).trim(), where: p.node || null }));

  const noEvidenceLayer = /no evidence layer found/i.test(charterSection(charter, EVIDENCE_SECTION) || '');
  const oneOfEach = areas.length === 1 && areas[0].work.length === 1;
  const shape = oneOfEach
    ? 'One area, one piece of work, one check before it counts as done.'
    : `${areas.length} areas, worked at the same time, each checked before it counts as done.`;

  const sections = [
    {
      title: 'What will change, and where',
      note: shape,
      areas,
    },
    {
      title: 'What it will prove',
      note: rows.some((r) => !r.taken)
        ? 'Everything below is something you can watch happen. The rows marked as not yet taken are promises nobody is building yet — say the word and they get picked up, or dropped.'
        : 'Everything below is something you can watch happen, and each one has somebody building it.',
      proofs: rows,
      untaken: rows.filter((r) => !r.taken).map((r) => r.id),
      // Said once, in the one place the client reads, and only when the charter's own judgement
      // says this repository has nothing to point at. Read off the charter rather than detected
      // again here, so a judgement a person corrected by hand is the one that stands.
      offer: noEvidenceLayer ? PROMISES_OFFER : null,
    },
    {
      title: 'What the rules gain',
      note: proposals.length
        ? 'Things this work would make into standing rules here, so the next change gets them for free.'
        : 'Nothing new is proposed as a standing rule by this work.',
      rules: proposals,
    },
  ];

  const frame = {
    mission: missionIntent(charter), shape, sections,
  };
  emit(frame, flags, () => [
    `# ${frame.mission}`,
    '',
    shape,
    '',
    ...sections.flatMap((s) => [
      `## ${s.title}`,
      '',
      s.note,
      '',
      ...(s.areas ? s.areas.flatMap((a) => [
        `**${a.area}** — ${a.why}`,
        ...a.parts.map((p) => `  - ${p}`),
        ...a.work.map((w) => `    · ${w.what}`),
        '',
      ]) : []),
      ...(s.proofs ? s.proofs.map((r) => `- ${r.id}: ${r.proves}${r.taken ? '' : '  — nobody is building this yet'}`) : []),
      ...(s.offer ? ['', s.offer] : []),
      ...(s.rules ? s.rules.map((r) => `- ${r.says}`) : []),
      '',
    ]),
    'Say the word and this starts. Nothing runs before you do.',
  ].join('\n'));
}

// ---- main -----------------------------------------------------------------------------------------

function main() {
  const { flags } = parseArgs(process.argv.slice(2), { flags: [] });
  if (flags.help) { console.log(USAGE); process.exit(0); }

  const step = flags.step === undefined ? 'cut' : String(flags.step);
  if (!STEPS.includes(step)) {
    fail(`unknown step: ${step} — refine runs in four, in this order: ${STEPS.join(', ')}`);
  }
  const horde = resolveHorde(flags);

  if (step === 'cut') return stepCut(horde, flags);
  if (step === 'consult') return stepConsult(horde, flags);
  if (step === 'review') return stepReview(horde, flags);
  return stepFrame(horde, flags);
}

if (isMain(import.meta.url)) main();
