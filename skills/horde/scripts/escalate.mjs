#!/usr/bin/env node
// horde skill — escalate.mjs
//
// What is left once ask.mjs (019) folded escalation and dissent into the one channel to the
// client: the second trigger for legislation (the first is the consultant at refine.mjs, the
// third is legislate.mjs after a wave close). The same answer given three times over one
// territory is a rule nobody wrote down — so this groups the ANSWERED asks by (kind, territory)
// and hands a group past the threshold to whoever works that territory as a rule proposal.
//
// No state of its own: it reads hordes/<horde>/asks.json (ask.mjs) and only ever proposes, never
// files — filing a rule is the territory's own agent's move, through node.mjs promote or a new
// aspect, in its own branch.

import {
  readConfig, fail, parseArgs, emit, isMain, resolveHorde,
} from './_lib.mjs';
import { loadAsks } from './ask.mjs';
import { ygCommand } from './node.mjs';

const USAGE = `usage: escalate.mjs recurring [--min <n>] [--horde h]

the answered asks grouped by kind and by territory; a group of <n> (default 3) or more is an
answer this horde keeps giving the client by hand, so it prints the rule proposal: the answers as
evidence, one line of rule text, and — where the group has a territory — the steps that file it:
create the rule in the graph, then record why in its own log. It prints those steps rather than
running them — the agent that works that territory files the rule, in its own branch, and raises
it on evidence with node.mjs promote.

options: --json  --help`;

const NO_TERRITORY = '(no territory)';

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

// The command that files the proposal. Where the group has a territory, this IS proposing a rule
// — the answer nobody should have to give a fourth time — and once it exists, its own reasoning
// belongs in its own log, not the node's: through config.ygCommand, so a checkout running a local
// build gets its own binary named. A group with no territory has nowhere in the graph to go, and
// the horde's own decision record is the honest target.
function fileItCommand(cfg, territory, rule) {
  const quoted = rule.replace(/"/g, '\\"');
  if (territory !== NO_TERRITORY) {
    return `file the rule (.yggdrasil/aspects/<id>/yg-aspect.yaml, attached to ${territory}'s node), then `
      + `${ygCommand(cfg).display} aspects log add --aspect <id> --reason "${quoted}" — its own log is `
      + 'where the reasoning belongs, not the node\'s';
  }
  return `decide.mjs add <slug> "${quoted}"`;
}

function cmdRecurring(horde, positional, flags) {
  const min = flags.min === undefined ? 3 : Number(flags.min);
  if (!Number.isFinite(min) || min < 2) fail('--min must be a whole number of at least 2');
  const cfg = readConfig() || {};
  const answered = loadAsks(horde).items.filter((it) => it.state === 'answered');

  const byKey = new Map();
  for (const it of answered) {
    const territory = it.territory || NO_TERRITORY;
    const key = `${it.kind} ${territory}`;
    if (!byKey.has(key)) byKey.set(key, { kind: it.kind, territory, asks: [] });
    byKey.get(key).asks.push({
      id: it.id, at: it.answeredAt || it.at, ticket: it.ticket || null, answer: firstLine(it.answer),
    });
  }

  const groups = [...byKey.values()]
    .filter((g) => g.asks.length >= min)
    .map((g) => {
      const ordered = [...g.asks].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const latest = ordered[ordered.length - 1];
      const where = g.territory === NO_TERRITORY ? 'this horde' : g.territory;
      const rule = `${g.kind} on ${where}: answered the same way ${ordered.length} times `
        + `(${ordered.map((e) => `ask-${e.id}`).join(', ')}) — ${latest.answer}`;
      return {
        kind: g.kind,
        territory: g.territory,
        count: ordered.length,
        asks: ordered,
        rule,
        command: fileItCommand(cfg, g.territory, rule),
      };
    })
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.territory.localeCompare(b.territory));

  emit({ min, groups }, flags, () => {
    if (groups.length === 0) return `no answer has recurred ${min} times yet — nothing to propose as a rule`;
    const lines = [];
    for (const g of groups) {
      lines.push(`${g.kind} · territory ${g.territory} — ${g.count} answers`);
      lines.push('  evidence:');
      for (const e of g.asks) {
        lines.push(`    ask-${e.id} · ${String(e.at).slice(0, 10)} · ticket ${e.ticket || '-'} — ${e.answer}`);
      }
      lines.push(`  rule: ${g.rule}`);
      lines.push(`  file it: ${g.command}`);
      lines.push('');
    }
    lines.push(
      'The agent that works that territory does the filing, in its own branch, and raises the rule on its own '
      + 'evidence with node.mjs promote. This tool proposes; it never files, and nobody needs a signature '
      + 'to write a rule down — only to take one away.',
    );
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
    case 'recurring': return cmdRecurring(horde, positional, flags);
    default: fail(`unknown command: ${cmd} (see --help)`);
  }
}

if (isMain(import.meta.url)) main();
