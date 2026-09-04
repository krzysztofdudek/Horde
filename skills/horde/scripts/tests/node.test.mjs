import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde,
} from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Writes a fixture yg-node.yaml at .yggdrasil/model/<node>/yg-node.yaml before horde.mjs init so
// horde.mjs's own auto-detection turns the horde's nodeSource to "yggdrasil".
function writeYggdrasilNode(dir, node, { mapping = [], relations = [] } = {}) {
  const path = join(dir, '.yggdrasil', 'model', node, 'yg-node.yaml');
  mkdirSync(join(dir, '.yggdrasil', 'model', node), { recursive: true });
  const lines = [`name: ${node}`, 'type: domain', `description: "fixture node ${node}"`, '', 'mapping:'];
  for (const m of mapping) lines.push(`  - ${m}`);
  lines.push('', 'relations:');
  for (const r of relations) lines.push(`  - target: ${r.target}\n    type: ${r.type}`);
  writeFileSync(path, lines.join('\n') + '\n');
}

test('node.mjs: manual mode — node lifecycle, contracts, proposals', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  await t.test('bind reports manual mode with no nodes yet', () => {
    const r = run('node.mjs', ['bind'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.mode, 'manual');
    assert.deepEqual(r.json.nodes, []);
  });

  await t.test('new creates the node\'s committed files', () => {
    const r = run('node.mjs', ['new', 'nodeA', '--boundary', 'src/a/**,src/shared/x.mjs'], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.boundary, ['src/a/**', 'src/shared/x.mjs']);
    const base = join(dir, 'architecture', 'nodes', 'nodeA');
    assert.ok(existsSync(join(base, 'node.json')));
    assert.ok(existsSync(join(base, 'charter.md')));
    assert.ok(existsSync(join(base, 'contracts.md')));
    assert.ok(existsSync(join(base, 'log.md')));
    const charter = readFileSync(join(base, 'charter.md'), 'utf8');
    assert.match(charter, /# Node · nodeA/);
    assert.doesNotMatch(charter, /\{\{/);
  });

  await t.test('new refuses an existing node', () => {
    const r = run('node.mjs', ['new', 'nodeA', '--boundary', 'x/**'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists/);
  });

  await t.test('bind now lists nodeA', () => {
    const r = run('node.mjs', ['bind'], dir);
    assert.deepEqual(r.json.nodes, ['nodeA']);
  });

  await t.test('show refuses an unknown node', () => {
    const r = run('node.mjs', ['show', 'nope'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such node/);
  });

  await t.test('show reports boundary, charter, contracts, log, stamp', () => {
    const r = run('node.mjs', ['show', 'nodeA'], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.boundary, ['src/a/**', 'src/shared/x.mjs']);
    assert.equal(r.json.stamp, 'unverified');
    assert.match(r.json.charter, /# Node · nodeA/);
  });

  await t.test('charter edit writes stdin content verbatim on an existing node', () => {
    const script = join(SCRIPTS_DIR, 'node.mjs');
    const out = execFileSync('node', [script, 'charter', 'edit', 'nodeA', '--json'], {
      cwd: dir, input: '# Node · nodeA\n\nedited by the owner\n', encoding: 'utf8',
    });
    JSON.parse(out);
    const charter = readFileSync(join(dir, 'architecture', 'nodes', 'nodeA', 'charter.md'), 'utf8');
    assert.match(charter, /edited by the owner/);
  });

  await t.test('log appends to log.md', () => {
    const r = run('node.mjs', ['log', 'nodeA', 'refreshed the charter'], dir);
    assert.equal(r.code, 0);
    const text = readFileSync(join(dir, 'architecture', 'nodes', 'nodeA', 'log.md'), 'utf8');
    assert.match(text, /refreshed the charter/);
  });

  await t.test('log refuses an unknown node', () => {
    const r = run('node.mjs', ['log', 'nope', 'x'], dir);
    assert.equal(r.code, 1);
  });

  await t.test('stamp records verifiedAt', () => {
    const r = run('node.mjs', ['stamp', 'nodeA', 'abc1234'], dir);
    assert.equal(r.code, 0);
    const show = run('node.mjs', ['show', 'nodeA'], dir);
    assert.match(show.json.stamp, /abc1234/);
  });

  await t.test('contract propose/approve/veto', () => {
    run('node.mjs', ['new', 'nodeB', '--boundary', 'src/b/**'], dir);

    const p1 = run('node.mjs', ['contract', 'propose', 'nodeA', 'nodeB', '--as', 'tests/contract-1.test.mjs', 'nodeA promises a stable event shape'], dir);
    assert.equal(p1.code, 0);
    assert.equal(p1.json.status, 'proposed');
    const id1 = p1.json.id;

    const pending = run('node.mjs', ['contracts', '--pending'], dir);
    assert.equal(pending.json.length, 1);
    assert.equal(pending.json[0].id, id1);

    const approved = run('node.mjs', ['contract', 'approve', id1, 'looks sound', '--by', 'architect'], dir);
    assert.equal(approved.code, 0);
    assert.equal(approved.json.status, 'approved');

    const contractsA = readFileSync(join(dir, 'architecture', 'nodes', 'nodeA', 'contracts.md'), 'utf8');
    assert.match(contractsA, /nodeB/);
    assert.match(contractsA, /approved/);
    const contractsB = readFileSync(join(dir, 'architecture', 'nodes', 'nodeB', 'contracts.md'), 'utf8');
    assert.match(contractsB, /nodeA/);

    const p2 = run('node.mjs', ['contract', 'propose', 'nodeA', 'nodeB', '--as', 'tests/contract-2.test.mjs', 'a second, disputed contract'], dir);
    const vetoed = run('node.mjs', ['contract', 'veto', p2.json.id, 'duplicates an existing contract', '--by', 'architect'], dir);
    assert.equal(vetoed.json.status, 'vetoed');

    const stillPending = run('node.mjs', ['contracts', '--pending'], dir);
    assert.equal(stillPending.json.length, 0);

    const reRule = run('node.mjs', ['contract', 'approve', id1, '--by', 'architect'], dir);
    assert.equal(reRule.code, 1);
    assert.match(reRule.stderr, /already/);
  });

  await t.test('graph-change proposals: propose, proposals --open, veto, approve + apply', () => {
    const p = run('node.mjs', ['propose', 'rule', 'never bypass the shared validator', '--by', 'owner1'], dir);
    assert.equal(p.code, 0);
    assert.equal(p.json.status, 'open');

    const open = run('node.mjs', ['proposals', '--open'], dir);
    assert.equal(open.json.length, 1);

    const vetoed = run('node.mjs', ['veto', p.json.id, 'not the right layer', '--by', 'architect'], dir);
    assert.equal(vetoed.json.status, 'vetoed');
    const openAfter = run('node.mjs', ['proposals', '--open'], dir);
    assert.equal(openAfter.json.length, 0);

    const p2 = run('node.mjs', ['propose', 'new-node', 'split nodeA\'s widget layer out', '--by', 'owner1'], dir);
    const applyTooEarly = run('node.mjs', ['apply', p2.json.id], dir);
    assert.equal(applyTooEarly.code, 1);
    assert.match(applyTooEarly.stderr, /not approved/);

    run('node.mjs', ['approve', p2.json.id, '--by', 'architect'], dir);
    const applied = run('node.mjs', ['apply', p2.json.id], dir);
    assert.equal(applied.code, 0);
    assert.equal(applied.json.applied, true);

    const reapply = run('node.mjs', ['apply', p2.json.id], dir);
    assert.equal(reapply.code, 1);
    assert.match(reapply.stderr, /already applied/);
  });

  await t.test('boundary set replaces, boundary add extends (deduplicated)', () => {
    const set = run('node.mjs', ['boundary', 'set', 'nodeA', '--boundary', 'src/a2/**'], dir);
    assert.equal(set.code, 0);
    assert.deepEqual(set.json.boundary, ['src/a2/**']);
    const afterSet = readFileSync(join(dir, 'architecture', 'nodes', 'nodeA', 'node.json'), 'utf8');
    assert.deepEqual(JSON.parse(afterSet).boundary, ['src/a2/**']);

    const add = run('node.mjs', ['boundary', 'add', 'nodeA', '--boundary', 'src/a3/**,src/a2/**'], dir);
    assert.equal(add.code, 0);
    assert.deepEqual(add.json.boundary, ['src/a2/**', 'src/a3/**']);

    const log = readFileSync(join(dir, 'architecture', 'nodes', 'nodeA', 'log.md'), 'utf8');
    assert.match(log, /boundary set to: src\/a2\/\*\*/);
    assert.match(log, /boundary extended with: src\/a3\/\*\*, src\/a2\/\*\*/);
  });

  await t.test('boundary set/add refuse an unknown node', () => {
    const r = run('node.mjs', ['boundary', 'set', 'nope', '--boundary', 'x/**'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such node/);
  });

  await t.test('propose move-boundary requires --node and --boundary', () => {
    const r = run('node.mjs', ['propose', 'move-boundary', 'widen nodeB', '--by', 'owner1'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires --node/);
  });

  await t.test('approve/veto (proposal and contract) --by traces that name in the roster when it is one', () => {
    const architect = run('roster.mjs', ['spawn', 'architect', '--class', 'opus'], dir);
    assert.equal(architect.code, 0, architect.stderr);
    const architectName = architect.json.name;

    const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
    const backdate = () => {
      const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
      const staleAt = new Date(Date.now() - 120 * 60000).toISOString();
      roster.entries.find((e) => e.name === architectName).lastTrace = staleAt;
      writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
      return staleAt;
    };

    let staleAt = backdate();
    const p = run('node.mjs', ['propose', 'rule', 'traced proposal', '--by', 'owner1'], dir);
    const ruled = run('node.mjs', ['approve', p.json.id, '--by', architectName], dir);
    assert.equal(ruled.code, 0, ruled.stderr);
    let after = run('roster.mjs', ['list'], dir).json.find((e) => e.name === architectName);
    assert.notEqual(after.lastTrace, staleAt);

    staleAt = backdate();
    const c = run('node.mjs', ['contract', 'propose', 'nodeA', 'nodeB', '--as', 'tests/traced.test.mjs', 'traced contract'], dir);
    const contractRuled = run('node.mjs', ['contract', 'approve', c.json.id, '--by', architectName], dir);
    assert.equal(contractRuled.code, 0, contractRuled.stderr);
    after = run('roster.mjs', ['list'], dir).json.find((e) => e.name === architectName);
    assert.notEqual(after.lastTrace, staleAt);
  });

  await t.test('apply on an approved move-boundary proposal actually rewrites the node\'s boundary', () => {
    const p = run('node.mjs', ['propose', 'move-boundary', 'nodeB should also cover src/b2', '--by', 'owner1', '--node', 'nodeB', '--boundary', 'src/b/**,src/b2/**'], dir);
    assert.equal(p.code, 0);
    assert.deepEqual(p.json.boundary, ['src/b/**', 'src/b2/**']);

    run('node.mjs', ['approve', p.json.id, '--by', 'architect'], dir);
    const applied = run('node.mjs', ['apply', p.json.id], dir);
    assert.equal(applied.code, 0);
    assert.equal(applied.json.applied, true);
    assert.deepEqual(applied.json.boundary, ['src/b/**', 'src/b2/**']);

    const show = run('node.mjs', ['show', 'nodeB'], dir);
    assert.deepEqual(show.json.boundary, ['src/b/**', 'src/b2/**']);
    const log = readFileSync(join(dir, 'architecture', 'nodes', 'nodeB', 'log.md'), 'utf8');
    assert.match(log, new RegExp(`boundary moved \\(proposal ${p.json.id}\\): src/b/\\*\\*, src/b2/\\*\\*`));
  });

  await t.test('map lists nodes an owner or a ticket names, with owner and open contract count', () => {
    const rosterPath = join(dir, '.horde', 'hordes', 'mission1', 'roster.json');
    writeFileSync(rosterPath, JSON.stringify({
      entries: [{ name: 'mission1-owner-nodeA-1', role: 'owner', node: 'nodeA', parent: null }],
    }, null, 2));

    const m = run('node.mjs', ['map'], dir);
    assert.equal(m.code, 0);
    const rowA = m.json.find((r) => r.node === 'nodeA');
    assert.ok(rowA);
    assert.equal(rowA.owner, 'mission1-owner-nodeA-1');
  });
});

test('node.mjs: manual mode — charter edit seeds from the template when the node is new and stdin is empty', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  initHorde(dir);

  const script = join(SCRIPTS_DIR, 'node.mjs');
  const out = execFileSync('node', [script, 'charter', 'edit', 'freshNode', '--json'], {
    cwd: dir, input: '', encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.ok(parsed.bytes > 0);
  const charter = readFileSync(join(dir, 'architecture', 'nodes', 'freshNode', 'charter.md'), 'utf8');
  assert.match(charter, /# Node · freshNode/);
  assert.ok(existsSync(join(dir, 'architecture', 'nodes', 'freshNode', 'node.json')));

  const overwrite = execFileSync('node', [script, 'charter', 'edit', 'freshNode', '--json'], {
    cwd: dir, input: '# Node · freshNode\n\ncustom content\n', encoding: 'utf8',
  });
  JSON.parse(overwrite);
  const charter2 = readFileSync(join(dir, 'architecture', 'nodes', 'freshNode', 'charter.md'), 'utf8');
  assert.match(charter2, /custom content/);

  let refused = null;
  try {
    execFileSync('node', [script, 'charter', 'edit', 'freshNode', '--json'], { cwd: dir, input: '', encoding: 'utf8' });
  } catch (e) {
    refused = e;
  }
  assert.ok(refused, 'empty stdin on an existing node should refuse');
  assert.match(refused.stderr.toString(), /requires content on stdin/);
});

test('node.mjs: Yggdrasil mode — read-only against a fixture .yggdrasil/model/', async (t) => {
  const dir = makeRepo();
  t.after(() => rmRepo(dir));
  writeYggdrasilNode(dir, 'core', { mapping: ['packages/core/'] });
  writeYggdrasilNode(dir, 'frontend', { mapping: ['apps/frontend/'], relations: [{ target: 'core', type: 'uses' }] });
  initHorde(dir); // auto-detects nodeSource: "yggdrasil" because .yggdrasil/ now exists

  await t.test('bind reads yggdrasil mode and lists both fixture nodes', () => {
    const r = run('node.mjs', ['bind'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.mode, 'yggdrasil');
    assert.deepEqual(r.json.nodes.sort(), ['core', 'frontend']);
  });

  await t.test('show reads boundary from mapping:, never writes anything', () => {
    const r = run('node.mjs', ['show', 'frontend'], dir);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.boundary, ['apps/frontend/']);
    assert.ok(!existsSync(join(dir, '.yggdrasil', 'model', 'frontend', 'node.json')));
  });

  await t.test('new prints filing guidance instead of writing a node', () => {
    const r = run('node.mjs', ['new', 'newNode', '--boundary', 'apps/new/**'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.written, false);
    assert.ok(!existsSync(join(dir, '.yggdrasil', 'model', 'newNode')));
  });

  await t.test('stamp prints guidance instead of writing anything', () => {
    const r = run('node.mjs', ['stamp', 'core', 'abc1234'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.written, false);
  });

  await t.test('boundary set/add print filing guidance instead of writing anything', () => {
    const r = run('node.mjs', ['boundary', 'set', 'core', '--boundary', 'packages/core2/**'], dir);
    assert.equal(r.code, 0);
    assert.equal(r.json.written, false);
    assert.ok(!existsSync(join(dir, '.yggdrasil', 'model', 'core', 'node.json')));
  });

  await t.test('apply on an approved move-boundary proposal names the node and boundary in its filing guidance', () => {
    const p = run('node.mjs', ['propose', 'move-boundary', 'widen core', '--by', 'owner1', '--node', 'core', '--boundary', 'packages/core/,packages/core2/'], dir);
    run('node.mjs', ['approve', p.json.id, '--by', 'architect'], dir);
    const applied = run('node.mjs', ['apply', p.json.id], dir, { json: false });
    assert.equal(applied.code, 0);
    assert.match(applied.stdout, /packages\/core\/, packages\/core2\//);
  });

  await t.test('apply on an approved proposal prints filing guidance and still closes the bookkeeping', () => {
    const p = run('node.mjs', ['propose', 'rename', 'rename frontend to frontend-web', '--by', 'owner1'], dir);
    run('node.mjs', ['approve', p.json.id, '--by', 'architect'], dir);
    const applied = run('node.mjs', ['apply', p.json.id], dir);
    assert.equal(applied.code, 0);
    assert.equal(applied.json.applied, true);
  });

  await t.test('contract propose/approve still uses the operational graph.json and writes contracts.md beside yg-node.yaml', () => {
    const p = run('node.mjs', ['contract', 'propose', 'core', 'frontend', '--as', 'tests/core-frontend.test.mjs', 'core exposes a stable shape frontend can render'], dir);
    run('node.mjs', ['contract', 'approve', p.json.id, '--by', 'architect'], dir);
    const contracts = readFileSync(join(dir, '.yggdrasil', 'model', 'core', 'contracts.md'), 'utf8');
    assert.match(contracts, /frontend/);
    assert.match(contracts, /approved/);
  });
});

