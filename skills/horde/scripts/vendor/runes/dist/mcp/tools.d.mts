import { type CommandSpec, type CommandTable, type FlagKind } from '../cli/table.mjs';
/** A JSON-RPC "invalid params" refusal (-32602): the call's input does not fit the tool. */
export declare class InvalidParams extends Error {
    readonly rpcCode = -32602;
    constructor(message: string);
}
/** Throws `InvalidParams` with `message` unless `cond` holds. */
export declare function requireParam(cond: unknown, message: string): asserts cond;
export interface McpTool {
    name: string;
    description: string;
    /** The fields: one per argument and per flag. The schema is closed in practice rather than by `additionalProperties: false`: the server refuses a field it does not list with a -32602 error naming the fields it takes, so the keyword would cost every tool its bytes in `tools/list` to say what the refusal already says. */
    inputSchema: {
        type: 'object';
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
    };
    /**
     * The MCP tool annotations, written only where they differ from the specification's defaults (`readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true), so an absent hint means its default. A read-only tool says `readOnlyHint: true` and nothing about destruction or idempotence, which the specification gives meaning only for a tool that writes; a tool that writes says `destructiveHint: false` unless the table marks it destructive and `idempotentHint: true` when the table marks it idempotent. Every tool says `openWorldHint: false`: it works on local files, not an open world.
     */
    annotations: {
        readOnlyHint?: true;
        destructiveHint?: false;
        idempotentHint?: true;
        openWorldHint: false;
    };
}
export interface ToolOptions {
    /** Tool name prefix. Default `<tool>_`. */
    prefix?: string;
    /** A tool's description. Default: `WRITES.` or `Read-only.`, then the command's summary. */
    describe?: (command: string, spec: CommandSpec) => string;
    /** Text added to one field's description. */
    fieldNote?: (command: string, field: string) => string | undefined;
    /** Global flags no tool offers. Default `['help']`: a tool has no use for the CLI's help flag. */
    omitFlags?: readonly string[];
    /** When given, a `<prefix>help` tool answering with this text (the usage), so short tool descriptions can leave the details to it. */
    help?: string;
}
/** A tool's name for a command. */
export declare function toolName(prefix: string, command: string): string;
export declare const prefixOf: (table: CommandTable, options?: ToolOptions) => string;
/** The fields a command's tool takes, by kind: its arguments, then its flags and the global flags not omitted. */
export declare function toolFlags(table: CommandTable, command: string, options?: ToolOptions): Record<string, FlagKind>;
/** The command a tool name stands for, or null (the help tool included). */
export declare function commandForTool(table: CommandTable, name: unknown, options?: ToolOptions): string | null;
/** The tools for every public command of the table, and the help tool when `help` is given. */
export declare function buildTools(table: CommandTable, options?: ToolOptions): McpTool[];
/**
 * A tool call back into the argv the CLI would be given: the command words, every flag inline (`--name=value`, so a value that starts with `--` is never read as a flag), then a bare `--` and the arguments in order. Every field is checked first; a misfit throws `InvalidParams` naming the field.
 */
export declare function argvFor(table: CommandTable, command: string, input: unknown, options?: ToolOptions): string[];
/** Whether a call answers with a JSON document: `json: true` on a command with a `--json` flag, or a command that prints JSON unasked (unless the flag its `stdoutJson` names is given). */
export declare function answersJson(table: CommandTable, command: string, input: unknown): boolean;
