/**
 * MCP tools generated from the command table: one tool per public command, `<prefix><command>` (a subcommand or a dash joins with `_`: `grain_decide_steer`), one field per argument and per flag under the flag's own name, and the annotations from the table. A call is turned back into the argv the CLI would get, so the CLI's own parser reads it exactly as it reads a command line.
 */
import { isAbsolute } from 'node:path';
import { argSpec, commandFlags, pathFields, publicCommands } from '../cli/index.mjs';
/** A JSON-RPC "invalid params" refusal (-32602): the call's input does not fit the tool. */
export class InvalidParams extends Error {
    rpcCode = -32602;
    constructor(message) { super(message); this.name = 'InvalidParams'; }
}
/** Throws `InvalidParams` with `message` unless `cond` holds. */
export function requireParam(cond, message) {
    if (!cond)
        throw new InvalidParams(message);
}
const ABS = ' An absolute path: the server does not run in your working directory.';
const DEFAULT_OMIT = ['help'];
/** A tool's name for a command. */
export function toolName(prefix, command) {
    return prefix + command.replace(/[ -]/g, '_');
}
export const prefixOf = (table, options = {}) => options.prefix ?? `${table.tool}_`;
/** The fields a command's tool takes, by kind: its arguments, then its flags and the global flags not omitted. */
export function toolFlags(table, command, options = {}) {
    const omit = new Set(options.omitFlags ?? DEFAULT_OMIT);
    return Object.fromEntries(Object.entries(commandFlags(table, command)).filter(([f]) => !omit.has(f)));
}
/** The command a tool name stands for, or null (the help tool included). */
export function commandForTool(table, name, options = {}) {
    if (typeof name !== 'string')
        return null;
    const prefix = prefixOf(table, options);
    return publicCommands(table).find((c) => toolName(prefix, c) === name) ?? null;
}
function flagSchema(name, kind) {
    switch (kind) {
        case 'bool': return { type: 'boolean', description: `--${name}` };
        case 'many': return { type: 'array', items: { type: 'string' }, description: `--${name}, repeatable: one item per value (a single string is one item).` };
        case 'number': return { type: ['number', 'string'], description: `--${name} <number>` };
        case 'path': return { type: 'string', description: `--${name} <path>.${ABS}` };
        default: return { type: 'string', description: `--${name} <value>` };
    }
}
function defaultDescription(_command, spec) {
    return [spec.writes ? 'WRITES.' : 'Read-only.', spec.summary ?? ''].filter(Boolean).join(' ');
}
/** The tools for every public command of the table, and the help tool when `help` is given. */
export function buildTools(table, options = {}) {
    const prefix = prefixOf(table, options);
    const describe = options.describe ?? defaultDescription;
    const tools = [];
    for (const command of publicCommands(table)) {
        const spec = table.commands[command];
        const paths = pathFields(table, command);
        const properties = {};
        const required = [];
        (spec.args ?? []).map(argSpec).forEach((a, i) => {
            properties[a.name] = a.variadic
                ? { type: 'array', items: { type: 'string' }, ...(a.optional ? {} : { minItems: 1 }), description: `Arguments ${i + 1} and on, one per item.` }
                : { type: 'string', description: `Argument ${i + 1}${a.optional ? ' (optional)' : ''}.` };
            if (!a.optional)
                required.push(a.name);
        });
        for (const [f, kind] of Object.entries(toolFlags(table, command, options))) {
            properties[f] = flagSchema(f, kind);
            if (f === 'json' && kind === 'bool')
                properties[f].description = 'Answer with the JSON document --json prints.';
        }
        for (const [f, schema] of Object.entries(properties)) {
            if (paths.has(f) && !String(schema.description).includes(ABS))
                schema.description = `${schema.description}${ABS}`;
            const note = options.fieldNote?.(command, f);
            if (note)
                schema.description = `${schema.description} ${note}`;
        }
        tools.push({
            name: toolName(prefix, command),
            description: describe(command, spec),
            inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
            annotations: { readOnlyHint: !spec.writes, destructiveHint: !!spec.destructive, idempotentHint: spec.idempotent ?? !spec.writes, openWorldHint: false },
        });
    }
    if (options.help !== undefined) {
        tools.push({
            name: toolName(prefix, 'help'),
            description: 'Read-only. The CLI usage text: every command, flag and rule the tools are generated from.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        });
    }
    return tools;
}
const scalar = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
/**
 * A tool call back into the argv the CLI would be given: the command words, every flag inline (`--name=value`, so a value that starts with `--` is never read as a flag), then a bare `--` and the arguments in order. Every field is checked first; a misfit throws `InvalidParams` naming the field.
 */
export function argvFor(table, command, input, options = {}) {
    const tool = toolName(prefixOf(table, options), command);
    const given = input ?? {};
    requireParam(typeof given === 'object' && !Array.isArray(given), `${tool}: arguments must be an object`);
    const fields = given;
    const spec = table.commands[command];
    const args = (spec.args ?? []).map(argSpec);
    const flags = toolFlags(table, command, options);
    const paths = pathFields(table, command);
    const known = [...args.map((a) => a.name), ...Object.keys(flags)];
    for (const k of Object.keys(fields))
        requireParam(known.includes(k), `${tool}: unknown field "${k}" — it takes ${known.join(', ') || 'no fields'}`);
    const absolute = (f, v) => {
        if (paths.has(f))
            requireParam(v.trim() !== '' && isAbsolute(v), `${tool}: "${f}" must be an absolute path (got ${JSON.stringify(v)}) — the server does not run in your working directory`);
    };
    const argv = command.split(' ');
    for (const [f, kind] of Object.entries(flags)) {
        const v = fields[f];
        if (v === undefined || v === null)
            continue;
        if (kind === 'bool') {
            requireParam(typeof v === 'boolean', `${tool}: "${f}" must be true or false`);
            if (v)
                argv.push(`--${f}`);
        }
        else if (kind === 'many') {
            const list = [].concat(v);
            requireParam(list.every(scalar), `${tool}: "${f}" must be a string or a list of strings`);
            for (const x of list) {
                absolute(f, String(x));
                argv.push(`--${f}=${x}`);
            }
        }
        else if (kind === 'number') {
            requireParam((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))), `${tool}: "${f}" must be a number`);
            argv.push(`--${f}=${v}`);
        }
        else {
            requireParam(scalar(v), `${tool}: "${f}" must be a string`);
            absolute(f, String(v));
            argv.push(`--${f}=${v}`);
        }
    }
    const words = [];
    let gap = null;
    for (const a of args) {
        const v = fields[a.name];
        if (v === undefined || v === null) {
            requireParam(a.optional, `${tool}: "${a.name}" is required`);
            gap = gap ?? a.name;
            continue;
        }
        requireParam(gap === null, `${tool}: "${a.name}" is given but "${gap}" before it is not — the arguments are read in order`);
        const list = a.variadic ? [].concat(v) : [v];
        requireParam(list.every(scalar), `${tool}: "${a.name}" must be ${a.variadic ? 'a list of strings' : 'a string'}`);
        requireParam(a.optional || list.length > 0, `${tool}: "${a.name}" needs at least one item`);
        for (const x of list) {
            absolute(a.name, String(x));
            words.push(String(x));
        }
    }
    if (words.length)
        argv.push('--', ...words);
    return argv;
}
/** Whether a call answers with a JSON document: `json: true` on a command with a `--json` flag, or a command that prints JSON unasked (unless the flag its `stdoutJson` names is given). */
export function answersJson(table, command, input) {
    const spec = table.commands[command];
    if (!spec)
        return false;
    const fields = (input ?? {});
    if (commandFlags(table, command).json === 'bool' && fields.json === true)
        return true;
    if (spec.stdoutJson === true)
        return true;
    return typeof spec.stdoutJson === 'string' && (fields[spec.stdoutJson] === undefined || fields[spec.stdoutJson] === null);
}
