#!/usr/bin/env node
// horde skill — status.mjs
//
// The session-start digest: every horde on this repository, one screen each. Reads across every
// other tool's state files directly (queue.json, roster.json, escalations.json, dissents.json,
// cost.json, cache/last-gate.json) rather than importing their tools, since it only ever reads —
// nothing here mutates state, so there's no journal-format contract to share.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  hordePath, teamPath, listHordes, readConfig, readJSON, readText, git, fail, parseArgs, emit, isMain,
} from './_lib.mjs';
import { currentWaveNumber } from './wave.mjs';
import { sumEntries, readCostLimit } from './cost.mjs';

const USAGE = `usage: status.mjs [--horde h] [--team t] [--json]

One screen: hordes on this repository, and for each: trunk sha and distance from base, teams and
their branch tips, ticket branches beyond their team tip (landed / unverified / unmerged),
stewards' last trace and liveness verdict, queue counts by state, open escalations and dissents,
the last recorded gate result, cost to date against the charter's limit.

--horde narrows to one horde, --team (within it) to one team.

options: --json  --help`;

function aheadBehind(base, branch) {
  if (!base) return { ahead: null, behind: null };
  const out = git(['rev-list', '--left-right', '--count', `${base}...${branch}`]);
  if (!out) return { ahead: null, behind: null };
  const [behind, ahead] = out.split(/\s+/).map(Number);
  return { ahead, behind };
}

function listTeamNames(horde) {
  const dir = hordePath(horde, 'teams');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
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
  const walk = (team) => {
    const q = readJSON(teamPath(horde, team, 'queue.json'), { items: [] });
    for (const it of (Array.isArray(q.items) ? q.items : [])) totals[it.state] = (totals[it.state] || 0) + 1;
    const subDir = teamPath(horde, team, 'teams');
    if (existsSync(subDir)) {
      for (const d of readdirSync(subDir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(`${team}/${d.name}`);
      }
    }
  };
  for (const t of listTeamNames(horde)) walk(t);
  return totals;
}

function stewardLiveness(entry, cfg) {
  if (!entry.lastTrace) return 'no-trace';
  const minutes = (Date.now() - new Date(entry.lastTrace).getTime()) / 60000;
  const threshold = (cfg && cfg.liveness && cfg.liveness.stewardMinutes) ?? 60;
  return minutes > threshold ? 'dead' : 'alive';
}

function hordeDigest(horde, cfg, teamFilter) {
  const trunkBranch = `${horde}/trunk`;
  const trunkSha = git(['rev-parse', '--short', trunkBranch]);
  const { ahead, behind } = aheadBehind(cfg && cfg.base, trunkBranch);

  let teamNames = listTeamNames(horde);
  if (teamFilter) teamNames = teamNames.filter((t) => t === teamFilter);
  const teams = teamNames.map((t) => teamDigest(horde, t));

  const roster = readJSON(hordePath(horde, 'roster.json'), { entries: [] });
  const stewards = (Array.isArray(roster.entries) ? roster.entries : [])
    .filter((e) => e.role === 'steward')
    .map((e) => ({ name: e.name, team: e.team || e.node, lastTrace: e.lastTrace || null, verdict: stewardLiveness(e, cfg) }));

  const escalations = readJSON(hordePath(horde, 'escalations.json'), { items: [] });
  const escItems = Array.isArray(escalations.items) ? escalations.items : [];
  const dissents = readJSON(hordePath(horde, 'dissents.json'), { items: [] });
  const disItems = Array.isArray(dissents.items) ? dissents.items : [];

  // Keyed by level: {commit, team, trunk}, each {sha, result, count, at} when premerge.mjs has
  // run at that level; absent levels simply aren't shown.
  const lastGate = readJSON(hordePath(horde, 'cache', 'last-gate.json'), {});

  const cost = readJSON(hordePath(horde, 'cost.json'), { runs: [] });
  const weights = (cfg && cfg.classes) || {};
  const { runs, weighted } = sumEntries(Array.isArray(cost.runs) ? cost.runs : [], weights);
  const limit = readCostLimit(horde);

  return {
    name: horde,
    base: (cfg && cfg.base) || null,
    trunk: { branch: trunkBranch, sha: trunkSha || null, ahead, behind },
    wave: currentWaveNumber(readText(hordePath(horde, 'plan.md'))) || null,
    teams,
    stewards,
    queue: { byState: queueTotals(horde), total: Object.values(queueTotals(horde)).reduce((a, b) => a + b, 0) },
    escalations: { open: escItems.filter((i) => i.state !== 'ruled').length, total: escItems.length },
    dissents: { open: disItems.filter((i) => i.state === 'open').length, total: disItems.length },
    lastGate,
    cost: { runs, weighted, limit, reached: limit !== null && weighted >= limit },
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
  if (h.stewards.length > 0) {
    console.log('  stewards:');
    for (const s of h.stewards) console.log(`    ${s.name} (${s.team})  last=${s.lastTrace || '-'}  ${s.verdict}`);
  }
  const qParts = Object.entries(h.queue.byState).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)';
  console.log(`  queue: total ${h.queue.total} — ${qParts}`);
  console.log(`  escalations: ${h.escalations.open} open / ${h.escalations.total} total`);
  console.log(`  dissents: ${h.dissents.open} open / ${h.dissents.total} total`);
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
