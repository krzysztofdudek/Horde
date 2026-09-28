#!/usr/bin/env node
// horde skill — mcp.mjs: every command of every script, as an MCP tool. A protocol adapter, not a
// second implementation.
//
// Built on the family's one MCP adapter, @chrisdudek/runes/mcp, vendored under vendor/runes/ (pinned in
// vendor/runes.pin.json and checked by runes.mjs). The command table (commands.mjs) becomes one Runes
// command table, TABLE, and the adapter generates the tools from it: one tool per command,
// horde_<script>_<command> (horde_tk_log, horde_node_contract_propose, horde_tk_review_close), or
// horde_<script> for a script with no subcommand (horde_tick, horde_land); one field per argument and per
// flag under the flag's own name; and horde_help, answering with every script's usage text, the same text
// its --help prints. A tool's description is one sentence after whether it writes; the full usage is what
// horde_help answers.
//
// A call is turned back into the argv the CLI would get (the adapter's argvFor: the command words, every
// flag inline as --name=value, then a bare -- and the arguments) and run by the script itself, as a child
// process (the adapter's spawn executor), in the directory the host started this server in — the
// session's own checkout, where the director runs the scripts. Its stdout is the answer (the JSON --json
// prints, with json: true), its stderr a second block, and a non-zero exit comes back with isError: true.
// Running the scripts rather than their functions in this process keeps the two surfaces identical by
// construction: every lock, every refusal and every exit code is the script's own. The transport, the
// timeout, cancellation and stopping a script's whole process tree are the adapter's.
//
// Two things a call cannot do the way a terminal does. A path field is absolute (the server does not run
// in the caller's directory; a command that reads a tree takes "tree"). And there is no stdin: the two
// commands that read their text from it, horde charter edit and tk edit, take it from the file "from"
// names instead — the same flag on the command line.
//
// Wire format: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio transport); stderr is for
// diagnostics. No dependencies beyond the vendored copy, Node 22+.
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMANDS, GLOBAL_FLAGS, SCRIPTS, LONG_RUNNING, scriptOf } from './commands.mjs';
import { defineTable } from './vendor/runes/dist/cli/index.mjs';
import {
  buildTools as generateTools, createServer, serveStdio, spawnCli, toolName as toolNameOf,
} from './vendor/runes/dist/mcp/index.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const TOOL_PREFIX = 'horde_';
export const toolName = (command) => toolNameOf(TOOL_PREFIX, command);

export const TABLE = defineTable({ tool: 'horde', globalFlags: GLOBAL_FLAGS, commands: COMMANDS });

// The script file a command runs.
export const scriptPath = (command) => join(HERE, `${scriptOf(command)}.mjs`);

// Every script's usage text, as its --help prints it: each script exports the USAGE its --help prints.
export async function loadUsages() {
  const usages = {};
  for (const script of SCRIPTS) usages[script] = (await import(pathToFileURL(join(HERE, `${script}.mjs`)).href)).USAGE;
  return usages;
}

export const INSTRUCTIONS = 'Every Horde command is a tool: horde_<script>_<command>, or horde_<script> for a script with no subcommand, with its arguments and flags as fields. A description is one sentence; horde_help answers with every script\'s full usage.';

const MINUTE = 60_000;
export const LONG_TIMEOUT_MS = 60 * MINUTE;
export const TIMEOUT_MS = 10 * MINUTE;
export const timeoutMs = (command) => (LONG_RUNNING.has(command) ? LONG_TIMEOUT_MS : TIMEOUT_MS);
function timeoutHint(command) {
  if (command === 'tick') return 'With watch it runs until the queue empties: run tick.mjs --watch from a terminal instead, or call horde_tick without watch.';
  return `Run node scripts/${scriptOf(command)}.mjs from a terminal for a run longer than that.`;
}

// horde_help: how a tool maps onto a script, then each script's own usage text.
export function helpText(usages) {
  const head = [
    'Every command of every Horde script is an MCP tool: `node scripts/<script>.mjs <command> …` is horde_<script>_<command> (a space or a dash joins with _), and a script with no subcommand is horde_<script>. Each argument is the field its usage names; each flag is the field of the same name without the dashes. Every tool also takes json and horde.',
    'The server runs each command as its script, in the directory the host started it in (the session\'s checkout). A path field is absolute; a command that reads a tree takes "tree". There is no stdin: horde_horde_charter_edit and horde_tk_edit read their text from the file "from" names. land, tick, horde done and init, wave close and evidence, drill check, run and record, node promote, queue quality and retro may run for up to an hour; every other command for ten minutes.',
  ].join('\n\n');
  const sections = SCRIPTS.map((s) => `===== ${s}.mjs — ${Object.keys(COMMANDS).filter((c) => scriptOf(c) === s).map(toolName).join(', ')}\n\n${usages[s].trimEnd()}`);
  return `${head}\n\n${sections.join('\n\n')}\n`;
}

function describe(_command, spec) {
  return `${spec.writes ? 'WRITES.' : 'Read-only.'} ${spec.summary}`;
}
// The options the tools are generated with; the parity test builds its reference from the same options.
export function toolOptions(usages) {
  return { prefix: TOOL_PREFIX, describe, help: helpText(usages) };
}

export function buildTools(usages) { return generateTools(TABLE, toolOptions(usages)); }

// The argv the adapter built, turned into the script's own: the script's file in place of its name.
export function scriptArgv({ command, argv }) { return [scriptPath(command), ...argv.slice(1)]; }

function version() {
  // The plugin's manifest, when the skill runs from a plugin install; a drop-in copy has none.
  try { return JSON.parse(readFileSync(new URL('../../../plugin.json', import.meta.url), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

export function makeServer(usages) {
  return createServer({
    table: TABLE,
    version: version(),
    executor: spawnCli({ command: process.execPath, args: [] }),
    tools: toolOptions(usages),
    timeoutMs,
    timeoutHint,
    transformArgv: scriptArgv,
    instructions: INSTRUCTIONS,
    // The scripts have no error document: a refusal is its one stderr line.
    errorDocuments: false,
  });
}

// Run as the server only when this file is the script the process was started with — compared as real
// paths, without case on Windows: a plugin root reached through a symbolic link, or spelled in another
// case, would otherwise leave the server silent and the client waiting on it.
export function isEntry(argv1, self = fileURLToPath(import.meta.url), platform = process.platform) {
  if (!argv1) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const [a, b] = [real(argv1), real(self)];
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isEntry(process.argv[1])) {
  const server = makeServer(await loadUsages());
  serveStdio(server, { log: (line) => console.error(line.replace('[mcp]', '[horde-mcp]')) });
}
