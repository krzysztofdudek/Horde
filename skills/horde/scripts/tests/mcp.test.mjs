// The MCP server (mcp.mjs) stands on the family's one adapter, @chrisdudek/runes/mcp, vendored under
// vendor/runes/. These tests hold it to the CLI from three sides: the adapter's own parity check between the
// command table, the scripts' usage texts and the tools the running server lists (assertParity); the table
// against the flags each script's own code reads and the flags each usage synopsis names; and real calls
// over the server's stdio, in a real horde, compared with what the same command prints on the command line.
// The size of tools/list is measured against the family's budget: reported, a warning when over, never a
// failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertParity, parityProblems } from '../vendor/runes/dist/testkit/parity.mjs';
import { measureTools, formatToolsMeasure } from '../vendor/runes/dist/testkit/measure.mjs';
import { listToolsOverStdio, startMcpClient } from '../vendor/runes/dist/testkit/client.mjs';
import { COMMANDS, GLOBAL_FLAGS, SCRIPTS, scriptOf } from '../commands.mjs';
import * as mcp from '../mcp.mjs';
import { parseArgs } from '../_lib.mjs';
import { makeRepo, rmRepo, initHorde, run } from './helpers.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN = join(SCRIPTS_DIR, '..', '..', '..');
const SERVER = join(SCRIPTS_DIR, 'mcp.mjs');
const usages = await mcp.loadUsages();
const TOOL_OPTIONS = mcp.toolOptions(usages);
const listed = await listToolsOverStdio({ command: process.execPath, args: [SERVER] });

// Flags a script reads that are not the command line's: land.mjs's --result is what its own background run
// passes to itself; wave.mjs reads --by on evidence only to refuse it.
const NOT_A_FLAG = { land: ['result'], wave: ['by'] };
// handoff.mjs's retired commands only refuse; they are no tools.
const RETIRED = /^handoff (write|add-waiting|rm-waiting)\b/;

// Every script's usage text as one command section Runes' readUsage reads: each entry of a script's
// "commands:" (or brief's "roles:") section, and a one-command script's "usage:" lines, as an entry
// "  <script> <synopsis>", its continuation lines kept under it. A paragraph between entries (node.mjs's note
// on ids, queue.mjs's on --tree) ends the entry above it and is left out.
function parityUsage() {
  const out = ['commands:'];
  for (const script of SCRIPTS) {
    const lines = usages[script].split('\n');
    const section = lines.findIndex((l) => /^(commands|roles):/.test(l));
    if (section === -1) {
      for (const [i, line] of lines.entries()) {
        const m = new RegExp(`^(?:usage: +| +)${script}\\.mjs (.*)$`).exec(line);
        if (m) { out.push(`  ${script} ${m[1].trim()}`); continue; }
        if (i > 0 && /^ {7,}\[/.test(line) && out.at(-1).startsWith(`  ${script}`)) out.push(`    ${line.trim()}`);
        if (!line.trim()) break;
      }
      continue;
    }
    let open = false;
    for (const line of lines.slice(section + 1)) {
      if (/^options:/.test(line)) break;
      if (!line.trim()) continue;
      const depth = line.length - line.trimStart().length;
      if (depth === 0) { open = false; continue; }
      if (depth === 2) {
        const entry = `${script} ${line.trim()}`;
        open = !RETIRED.test(entry);
        if (open) out.push(`  ${entry}`);
        continue;
      }
      if (open) out.push(`    ${line.trim()}`);
    }
  }
  return out.join('\n');
}

// The synopsis of every entry, per command: the entry's first line up to its description, and the
// continuation lines that go on listing flags ("[--kind work|quality] …").
function synopses() {
  const text = parityUsage().split('\n').slice(1);
  const found = {};
  let cur = null;
  const commandOf = (syn) => Object.keys(COMMANDS).filter((c) => syn === c || syn.startsWith(`${c} `)).sort((a, b) => b.length - a.length)[0];
  for (const line of text) {
    if (line.startsWith('    ')) { if (cur && /^\[/.test(line.trim())) found[cur].push(line.trim()); continue; }
    const syn = line.trim().split(/\s{2,}/)[0];
    cur = commandOf(syn) ?? null;
    if (cur) (found[cur] ??= []).push(syn);
  }
  return found;
}

test('parity (Runes testkit): the table, every script\'s usage text and the tools the running server lists say the same thing', () => {
  // The usage side checks that every command has an entry and no entry names a command the table lacks. Its flag
  // check is off: an entry's prose names other scripts' flags; the tests below hold the flags instead.
  assertParity({ table: mcp.TABLE, usage: parityUsage(), usageFlags: false, tools: listed, toolOptions: TOOL_OPTIONS });
});

test('parity (Runes testkit): a tool that loses a field, or a command with no tool, is caught', () => {
  const lost = listed.map((t) => (t.name === 'horde_tk_new'
    ? { ...t, inputSchema: { ...t.inputSchema, properties: Object.fromEntries(Object.entries(t.inputSchema.properties).filter(([k]) => k !== 'title')) } }
    : t));
  assert.match(parityProblems({ table: mcp.TABLE, tools: lost, toolOptions: TOOL_OPTIONS }).join('\n'), /tool horde_tk_new lacks "title"/);
  const fewer = listed.filter((t) => t.name !== 'horde_queue_regate');
  assert.match(parityProblems({ table: mcp.TABLE, tools: fewer, toolOptions: TOOL_OPTIONS }).join('\n'), /command "queue regate" has no tool horde_queue_regate/);
  const unlisted = parityUsage().split('\n').filter((l) => !l.startsWith('  tk grep')).join('\n');
  assert.match(parityProblems({ table: mcp.TABLE, usage: unlisted, usageFlags: false }).join('\n'), /command "tk grep" is missing from the usage text/);
});

test('every script with a command line is in the table, and the server lists exactly the tools the table generates', () => {
  const noCommandLine = new Set(['_lib', 'audit', 'loop', 'vendor', 'runes', 'commands', 'mcp']);
  const scripts = readdirScripts().filter((s) => !noCommandLine.has(s));
  assert.deepEqual([...SCRIPTS].sort(), scripts.sort());
  assert.deepEqual(listed, JSON.parse(JSON.stringify(mcp.buildTools(usages))));
  assert.equal(listed.length, Object.keys(COMMANDS).length + 1);
});

function readdirScripts() {
  return readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4));
}

test('the table\'s flags are the flags each script reads, both ways, and every one is in the script\'s usage text', () => {
  const globals = new Set(Object.keys(GLOBAL_FLAGS));
  const problems = [];
  for (const script of SCRIPTS) {
    const src = readFileSync(join(SCRIPTS_DIR, `${script}.mjs`), 'utf8');
    const read = new Set([...src.matchAll(/\bflags(?:\.([A-Za-z_]\w*)|\[['"]([\w-]+)['"]\])/g)].map((m) => m[1] || m[2]));
    const table = new Set(Object.entries(COMMANDS).filter(([c]) => scriptOf(c) === script).flatMap(([, s]) => Object.keys(s.flags ?? {})));
    for (const f of read) if (!table.has(f) && !globals.has(f) && !(NOT_A_FLAG[script] ?? []).includes(f)) problems.push(`${script}.mjs reads --${f}, which no command of it in the table takes`);
    for (const f of table) if (!read.has(f)) problems.push(`the table gives ${script}.mjs --${f}, which ${script}.mjs never reads`);
    for (const f of table) if (!usages[script].includes(`--${f}`)) problems.push(`${script}.mjs's usage text never mentions --${f}`);
  }
  assert.deepEqual(problems, []);
});

test('every flag a usage synopsis names is a flag the table gives that command', () => {
  const problems = [];
  for (const [command, lines] of Object.entries(synopses())) {
    const takes = { ...GLOBAL_FLAGS, ...(COMMANDS[command].flags ?? {}) };
    for (const m of lines.join(' ').matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)) if (!Object.hasOwn(takes, m[1])) problems.push(`${command}: the usage names --${m[1]}`);
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(synopses()).sort(), Object.keys(COMMANDS).sort(), 'every command has a synopsis');
});

test('horde_help answers with every script\'s usage, the text its --help prints', async () => {
  const help = TOOL_OPTIONS.help;
  for (const script of SCRIPTS) {
    const printed = spawnSync(process.execPath, [join(SCRIPTS_DIR, `${script}.mjs`), '--help'], { encoding: 'utf8' }).stdout;
    assert.equal(printed, `${usages[script]}\n`, `${script}.mjs --help prints its USAGE`);
    assert.ok(help.includes(usages[script].trimEnd()), `horde_help carries ${script}.mjs's usage`);
  }
});

test('budget step 1: a tool description is one sentence after whether it writes; the full usage is horde_help', () => {
  for (const t of listed) {
    if (t.name === 'horde_help') continue;
    const body = t.description.replace(/^(WRITES\.|Read-only\.) /, '');
    assert.equal(body.split(/(?<=[.!?])\s+(?=[A-Z])/).length, 1, `${t.name}: "${body}"`);
    assert.ok(t.description.length <= 200, `${t.name}: ${t.description.length} characters`);
  }
});

test('tools/list is measured against the budget (8.5k tokens per server): reported, a warning when over, never a failure', (t) => {
  const m = measureTools(listed, { label: 'horde tools/list' });
  const line = formatToolsMeasure(m, 'horde tools/list');
  t.diagnostic(line);
  if (m.over) process.emitWarning(line, { code: 'RUNES_TOOLS_BUDGET' });
  if (m.over && process.env.GITHUB_ACTIONS) console.log(`::warning title=MCP tools/list budget::${line}`);
  assert.ok(m.tokens > 0 && m.perTool.length === listed.length);
});

test('a bare -- ends the flags: every word after it is an argument, even one that starts with --', () => {
  assert.deepEqual(parseArgs(['log', '--horde=h', '--', '12', '--not-a-flag']), { positional: ['log', '12', '--not-a-flag'], flags: { horde: 'h' } });
  assert.deepEqual(parseArgs(['list', '--open', '--']), { positional: ['list'], flags: { open: true } });
});

test('a call runs the script: the argv the adapter builds reaches the script with its file in place of its name', () => {
  assert.deepEqual(mcp.scriptArgv({ command: 'tk log', argv: ['tk', 'log', '--horde=m', '--', '1', 'x'] }), [join(SCRIPTS_DIR, 'tk.mjs'), 'log', '--horde=m', '--', '1', 'x']);
  assert.deepEqual(mcp.scriptArgv({ command: 'tick', argv: ['tick', '--json'] }), [join(SCRIPTS_DIR, 'tick.mjs'), '--json']);
  assert.equal(mcp.timeoutMs('land'), mcp.LONG_TIMEOUT_MS);
  assert.equal(mcp.timeoutMs('tk log'), mcp.TIMEOUT_MS);
});

test('the plugin starts the server by itself: .mcp.json and the portable mcp.json name the same guarded server', () => {
  const claude = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.horde;
  const portable = JSON.parse(readFileSync(join(PLUGIN, 'mcp.json'), 'utf8'));
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  const p = portable.mcpServers.horde;
  assert.equal(claude.command, 'node');
  assert.equal(p.command, 'node');
  assert.equal(p.type, 'stdio');
  assert.equal(claude.args[0], '-e');
  assert.equal(claude.args[1], p.args[1], 'the same guard');
  assert.equal(claude.args[2], '${CLAUDE_PLUGIN_ROOT}/skills/horde/scripts/mcp.mjs');
  assert.equal(p.args[2], '${PLUGIN_ROOT}/skills/horde/scripts/mcp.mjs');
  assert.ok(existsSync(join(PLUGIN, 'skills/horde/scripts/mcp.mjs')));
  // A plugin path the environment cannot reach (a host path inside a container): one stderr line, exit 0.
  const r = spawnSync(process.execPath, ['-e', claude.args[1], '/no/such/mcp.mjs'], { encoding: 'utf8' });
  assert.match(r.stderr, /^horde: \/no\/such\/mcp\.mjs is not reachable from this environment/);
  assert.equal(r.status, 0);
});

// ---- real calls over stdio, in a real horde ----------------------------------------------------------

async function server(cwd) {
  const c = startMcpClient({ command: process.execPath, args: [SERVER], cwd, timeoutMs: 120_000 });
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'horde-test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'horde');
  c.notify('notifications/initialized');
  return c;
}
const textOf = (r) => r.result.content.map((b) => b.text).join('\n');

test('over stdio: a tool call writes and reads the mission exactly as the CLI does, in the directory the server runs in', async () => {
  const dir = makeRepo();
  const c = await server(dir);
  try {
    initHorde(dir);
    const status = await c.call('horde_status', { json: true });
    assert.equal(status.result.isError, false, textOf(status));
    assert.deepEqual(JSON.parse(status.result.content[0].text), run('status.mjs', [], dir).json, 'the tool answers what the CLI prints');

    const filed = await c.call('horde_tk_new', { slug: 'first', title: 'First', node: ['root'], class: 'light', json: true });
    assert.equal(filed.result.isError, false, textOf(filed));
    const id = JSON.parse(filed.result.content[0].text).id;
    // An argument that starts with -- is an argument, never a flag.
    const logged = await c.call('horde_tk_log', { ticket: String(id), text: '--not-a-flag, just text' });
    assert.equal(logged.result.isError, false, textOf(logged));
    const shown = run('tk.mjs', ['show', String(id), '--log'], dir, { json: false });
    assert.match(shown.stdout, /--not-a-flag, just text/);

    // No stdin over MCP: the ticket body comes from the file "from" names.
    const body = join(dir, 'body.md');
    writeFileSync(body, '## What\n\nwritten through the MCP server\n');
    const edited = await c.call('horde_tk_edit', { ticket: String(id), by: 'director', from: body });
    assert.equal(edited.result.isError, false, textOf(edited));
    assert.match(run('tk.mjs', ['show', String(id)], dir, { json: false }).stdout, /written through the MCP server/);
    const bare = await c.call('horde_tk_edit', { ticket: String(id), by: 'director' });
    assert.equal(bare.result.isError, true);
    assert.match(textOf(bare), /--from/);
    const charter = join(dir, 'charter.md');
    writeFileSync(charter, `${run('horde.mjs', ['charter', 'show'], dir).json.charter}\nAmended through the MCP server.\n`);
    const amended = await c.call('horde_horde_charter_edit', { from: charter });
    assert.equal(amended.result.isError, false, textOf(amended));
    assert.match(run('horde.mjs', ['charter', 'show'], dir).json.charter, /Amended through the MCP server\./);
  } finally {
    await c.stop();
    rmRepo(dir);
  }
});

test('over stdio: a refusal is an error result with the script\'s own reason; input that does not fit is refused before anything runs', async () => {
  const dir = makeRepo();
  const c = await server(dir);
  try {
    initHorde(dir);
    const missing = await c.call('horde_tk_show', { ticket: '999' });
    assert.equal(missing.result.isError, true);
    assert.equal(textOf(missing), run('tk.mjs', ['show', '999'], dir, { json: false }).stderr.trim());
    const relative = await c.call('horde_horde_charter_edit', { from: 'charter.md' });
    assert.equal(relative.error.code, -32602);
    assert.match(relative.error.message, /"from" must be an absolute path/);
    const unknown = await c.call('horde_tick', { nope: true });
    assert.equal(unknown.error.code, -32602);
    const help = await c.call('horde_help', {});
    assert.equal(textOf(help), TOOL_OPTIONS.help);
  } finally {
    await c.stop();
    rmRepo(dir);
  }
});
