#!/usr/bin/env node
// horde skill — status.mjs
//
// The session-start digest: every horde on this repository, one screen each. Reads across every
// other tool's state files directly (queue.json, asks.json, cost.json,
// cache/last-gate.json) rather than importing their tools, since it only ever reads — nothing
// here mutates state, so there's no journal-format contract to share.

import {
  hordePath, teamPath, listHordes, readConfig, readJSON, readText, git, fail, parseArgs, emit, isMain,
  readLeases,
} from './_lib.mjs';
import { currentWaveNumber, evidenceCoverage } from './wave.mjs';
import { sumEntries, readCostLimit } from './cost.mjs';
import { missionNodes } from './node.mjs';

const USAGE = `usage: status.mjs [--horde h] [--team t] [--json]

One screen: hordes on this repository, and for each: trunk sha and distance from base, its branch
tip, ticket branches beyond it (landed / unverified / unmerged), queue counts by state, open
asks, the last recorded gate result, cost to date against the charter's limit, and any
lease another live horde holds on a node this one touches (node-lease-across-hordes).

--horde narrows to one horde, --team (within it) to one team.

options: --json  --help`;

function aheadBehind(base, branch) {
  if (!base) return { ahead: null, behind: null };
  const out = git(['rev-list', '--left-right', '--count', `${base}...${branch}`]);
  if (!out) return { ahead: null, behind: null };
  const [behind, ahead] = out.split(/\s+/).map(Number);
  return { ahead, behind };
}

function branchCategory(state) {
  if (state === 'landed') return 'landed';
  if (state === 'verified' || state === 'changes') return 'unverified';
  if (state === 'waiting') return 'waiting';
  return 'unmerged';
}

function teamDigest(horde, team) {
  const branch = `${horde}/${team}`;
  const tip = git(['rev-parse', '--short', branch]);
  const queue = readJSON(teamPath(horde, team, 'queue.json'), { items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];
  const byState = {};
  for (const it of items) byState[it.state] = (byState[it.state] || 0) + 1;
  const ticketBranches = items
    .filter((it) => it.branch && it.state !== 'merged' && it.state !== 'dropped')
    .map((it) => {
      const sha = git(['rev-parse', '--short', it.branch]);
      const aheadOut = tip && sha ? git(['rev-list', '--count', `${branch}..${it.branch}`]) : null;
      return {
        ticket: it.ticket, branch: it.branch, sha: sha || '-',
        ahead: aheadOut === null ? null : Number(aheadOut),
        state: it.state, category: branchCategory(it.state),
      };
    });
  return { name: team, branch, tip: tip || '-', byState, ticketBranches };
}

function queueTotals(horde) {
  const totals = {};
  const q = readJSON(teamPath(horde, 'trunk', 'queue.json'), { items: [] });
  for (const it of (Array.isArray(q.items) ? q.items : [])) totals[it.state] = (totals[it.state] || 0) + 1;
  return totals;
}

function hordeDigest(horde, cfg, teamFilter) {
  const trunkBranch = `${horde}/trunk`;
  const trunkSha = git(['rev-parse', '--short', trunkBranch]);
  const { ahead, behind } = aheadBehind(cfg && cfg.base, trunkBranch);

  const teamNames = (!teamFilter || teamFilter === 'trunk') ? ['trunk'] : [];
  const teams = teamNames.map((t) => teamDigest(horde, t));

  const asks = readJSON(hordePath(horde, 'asks.json'), { items: [] });
  const askItems = Array.isArray(asks.items) ? asks.items : [];

  // Keyed by level: {commit, team, trunk}, each {sha, result, count, at} when land.mjs has
  // run at that level; absent levels simply aren't shown.
  const lastGate = readJSON(hordePath(horde, 'cache', 'last-gate.json'), {});

  const cost = readJSON(hordePath(horde, 'cost.json'), { runs: [] });
  const weights = (cfg && cfg.classes) || {};
  const { runs, weighted } = sumEntries(Array.isArray(cost.runs) ? cost.runs : [], weights);
  const limit = readCostLimit(horde);

  // node-lease-across-hordes: leases another live horde holds on a node THIS horde touches — the
  // exact overlap node.mjs bind would refuse if this horde tried to claim it. Read fresh every
  // call, straight off the one file every horde on the repository shares.
  const touchedNodes = missionNodes(horde);
  const { leases } = readLeases();
  const foreignLeases = touchedNodes
    .filter((node) => leases[node] && leases[node].horde !== horde)
    .map((node) => ({ node, horde: leases[node].horde, since: leases[node].since }));

  // Every charter row, one of five states: no-ticket / queued / running / merged / reproduced —
  // wave.mjs's own reading, shared with horde.mjs done's gate, of "does a ticket prove this row
  // and how far has it gotten" (see wave.mjs's evidenceCoverage for what each state means).
  const evidenceRows = evidenceCoverage(horde);
  const evidenceByState = {};
  for (const r of evidenceRows) evidenceByState[r.state] = (evidenceByState[r.state] || 0) + 1;

  return {
    name: horde,
    base: (cfg && cfg.base) || null,
    trunk: { branch: trunkBranch, sha: trunkSha || null, ahead, behind },
    wave: currentWaveNumber(readText(hordePath(horde, 'plan.md'))) || null,
    teams,
    queue: { byState: queueTotals(horde), total: Object.values(queueTotals(horde)).reduce((a, b) => a + b, 0) },
    asks: { open: askItems.filter((i) => i.state !== 'answered').length, total: askItems.length },
    lastGate,
    cost: { runs, weighted, limit, reached: limit !== null && weighted >= limit },
    leases: { foreign: foreignLeases },
    evidence: { total: evidenceRows.length, byState: evidenceByState, rows: evidenceRows },
  };
}

function printHorde(h) {
  const ab = h.trunk.ahead === null ? '' : ` (+${h.trunk.ahead}/-${h.trunk.behind} vs ${h.base})`;
  console.log(`${h.name}  trunk=${h.trunk.sha || '-'}${ab}  wave=${h.wave || '-'}`);
  for (const t of h.teams) {
    console.log(`  team ${t.name}  ${t.branch}@${t.tip}`);
    if (t.ticketBranches.length === 0) {
      console.log('    tickets: (none beyond team tip)');
    } else {
      for (const tb of t.ticketBranches) {
        console.log(`    ${tb.branch}@${tb.sha}  +${tb.ahead ?? '?'}  ${tb.category} (${tb.state})`);
      }
    }
  }
  const qParts = Object.entries(h.queue.byState).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)';
  console.log(`  queue: total ${h.queue.total} — ${qParts}`);
  console.log(`  asks: ${h.asks.open} open / ${h.asks.total} total`);
  const gateLevels = ['commit', 'team', 'trunk'].filter((lvl) => h.lastGate[lvl]);
  if (gateLevels.length === 0) {
    console.log('  last gate: (none recorded)');
  } else {
    for (const lvl of gateLevels) {
      const g = h.lastGate[lvl];
      console.log(`  last gate (${lvl}): ${g.result} · sha ${g.sha} · count ${g.count} · at ${g.at}`);
    }
  }
  const limitText = h.cost.limit === null ? 'no limit' : `limit ${h.cost.limit}${h.cost.reached ? ' — REACHED' : ''}`;
  console.log(`  cost: ${h.cost.runs} runs · weighted ${h.cost.weighted} · ${limitText}`);
  if (h.leases.foreign.length > 0) {
    console.log('  leases held by other hordes on nodes this one touches:');
    for (const l of h.leases.foreign) console.log(`    ${l.node} -> ${l.horde} (since ${l.since})`);
  }
  if (h.evidence.total === 0) {
    console.log('  evidence: (no rows in the charter yet)');
  } else {
    const order = ['no-ticket', 'queued', 'running', 'merged', 'reproduced'];
    const summary = order.filter((s) => h.evidence.byState[s]).map((s) => `${s}=${h.evidence.byState[s]}`).join(' ');
    console.log(`  evidence: ${h.evidence.rows.filter((r) => r.state === 'reproduced').length}/${h.evidence.total} reproduced — ${summary}`);
    for (const row of h.evidence.rows) {
      const ticketNote = row.ticket ? ` (ticket ${row.ticket})` : '';
      const byNote = row.reproducedBy ? ` — reproduced by ${row.reproducedBy}` : '';
      console.log(`    ${row.id} [${row.state}] ${row.evidence || '(no description)'}${row.node ? ` — ${row.node}` : ''}${ticketNote}${byNote}`);
    }
  }
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); process.exit(0); }

  let names = listHordes();
  if (flags.horde) {
    if (!names.includes(flags.horde)) fail(`no such horde: ${flags.horde}`);
    names = [flags.horde];
  }

  if (names.length === 0) {
    emit({ hordes: [] }, flags, () => 'no horde');
    return;
  }

  const cfg = readConfig();
  const hordes = names.map((h) => hordeDigest(h, cfg, flags.team || null));
  if (flags.json) {
    console.log(JSON.stringify({ hordes }, null, 2));
  } else {
    hordes.forEach(printHorde);
  }
}

if (isMain(import.meta.url)) main();
