import type { Readable, Writable } from 'node:stream';
import type { CommandTable } from '../cli/table.mjs';
import { type ParsedArgs } from '../cli/parse.mjs';
import { type CommandResult } from '../cli/output.mjs';
import { type McpTool, type ToolOptions } from './tools.mjs';
export declare const PROTOCOL_VERSION = "2025-06-18";
/** The versions the server speaks: it uses nothing a later one added beyond tool annotations, which an older client ignores. A client asking for one of these gets it back; any other gets `PROTOCOL_VERSION`. */
export declare const PROTOCOL_VERSIONS: readonly string[];
export interface CallContext {
    command: string;
    /** The argv the CLI would get (command words, flags, `--`, arguments). */
    argv: string[];
    /** The tool call's fields, as given. */
    input: Record<string, unknown>;
    /** Whether the answer is a JSON document. */
    json: boolean;
    /** Aborted on timeout or cancel. */
    signal: AbortSignal;
    cwd: string | undefined;
    env: NodeJS.ProcessEnv | undefined;
    /** What `prepare` handed on. */
    data: unknown;
}
export interface InProcessExecutor {
    kind: 'in-process';
    run: (ctx: CallContext & {
        parsed: ParsedArgs;
    }) => CommandResult | Promise<CommandResult>;
}
export interface SpawnExecutor {
    kind: 'spawn';
    /** The program. Default `process.execPath`. */
    command: string;
    /** Words before the call's argv, typically the CLI script. */
    args: readonly string[];
    /** How many of the last stderr lines to keep. Default 40. */
    stderrLines: number;
}
export type Executor = InProcessExecutor | SpawnExecutor;
/** Runs each call in this process through `run` (see the module note). */
export declare function inProcess(run: InProcessExecutor['run']): InProcessExecutor;
/** Runs each call as `command ...args ...argv` (see the module note). */
export declare function spawnCli(options?: {
    command?: string;
    args?: readonly string[];
    stderrLines?: number;
}): SpawnExecutor;
export interface PrepareResult {
    /** The directory a spawned CLI runs in. Default the server's. */
    cwd?: string;
    /** The environment a spawned CLI gets. Default the server's. */
    env?: NodeJS.ProcessEnv;
    /** Notes for the answer, by key: `_meta['<tool>/<key>']` in JSON mode, text blocks otherwise. Say here what the call reached when it did not name it. */
    notes?: Record<string, string>;
    /** Anything the in-process run needs (a resolved root, say): `ctx.data`. */
    data?: unknown;
}
export interface ServerOptions {
    table: CommandTable;
    /** Server name in `initialize`. Default the table's tool. */
    name?: string;
    version: string;
    executor: Executor;
    tools?: ToolOptions;
    /** How long one call may run, in ms. Default 10 minutes. */
    timeoutMs?: number | ((command: string) => number);
    /** A sentence added to the timeout answer: how to allow longer. */
    timeoutHint?: (command: string) => string;
    /** Rewrites a call's fields before they are checked against the tool and turned into argv; may throw `InvalidParams`. The tool's schema is unchanged: a field the consumer resolves itself (a repository-relative path, say) is declared without `paths` and made absolute here. */
    transformInput?: (call: {
        command: string;
        input: Record<string, unknown>;
    }) => Record<string, unknown> | Promise<Record<string, unknown>>;
    /** Rewrites the argv built from the checked fields, before it runs; may throw `InvalidParams`. */
    transformArgv?: (call: {
        command: string;
        argv: string[];
        input: Record<string, unknown>;
    }) => string[] | Promise<string[]>;
    /** Runs before each call, after its fields are checked; may throw `InvalidParams`. */
    prepare?: (call: {
        command: string;
        input: Record<string, unknown>;
    }) => PrepareResult | void | Promise<PrepareResult | void>;
    protocolVersions?: readonly string[];
    /** `instructions` in the `initialize` answer. */
    instructions?: string;
    /** A refusal in JSON mode answers with the `<tool>-error/1` document. Default true; false answers with the message text. Either way it is the one block, notes in `_meta`. */
    errorDocuments?: boolean;
    /**
     * How many tool calls `serveStdio` runs at once. Default one at a time, in order. `total` bounds all calls together, `perCommand` the calls of one command: a number for every command, or a function of the command (a CLI that serialises its own writes behind a lock can still say 1 for a command that must not overlap with itself). Each limit is a whole number from 1 up, or `Infinity`; a function's answer that is not counts as 1. Above one at a time the executor must be spawn: an in-process run cannot be stopped, so a timeout or a cancel would leave it running beside the next call, and `createServer` refuses the combination.
     */
    concurrency?: {
        total?: number;
        perCommand?: number | ((command: string) => number);
    };
}
/** How `serveStdio` schedules tool calls: `total` calls at once, and per tool the key it shares a limit under and that limit. */
export interface Concurrency {
    total: number;
    perTool(name: unknown): {
        key: string;
        limit: number;
    };
}
export interface ToolResult {
    content: {
        type: 'text';
        text: string;
    }[];
    isError: boolean;
    _meta?: Record<string, string>;
}
export type JsonRpcMessage = {
    jsonrpc?: string;
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
};
export type JsonRpcReply = {
    jsonrpc: '2.0';
    id: unknown;
    result?: unknown;
    error?: {
        code: number;
        message: string;
    };
};
export interface McpServer {
    tools: McpTool[];
    /** The answer to one message, or null for a notification or a client response. A cancelled call answers null. */
    handle(msg: JsonRpcMessage, signal?: AbortSignal): Promise<JsonRpcReply | null>;
    /** One tool call. Throws `InvalidParams` for input that does not fit. */
    callTool(name: unknown, input: unknown, signal?: AbortSignal): Promise<ToolResult>;
    /** Resolves when no call's work is still running (an in-process run a timeout gave up on, say). */
    idle(): Promise<void>;
    /** How many calls may run at once; absent, one at a time. */
    concurrency?: Concurrency;
}
/** A server over the table, answering one message at a time through `handle`; `serveStdio` puts it on stdin/stdout. */
export declare function createServer(options: ServerOptions): McpServer;
export interface StdioOptions {
    input?: Readable;
    output?: Writable;
    /** Handle SIGTERM, SIGINT and SIGHUP, and log uncaught errors instead of dying. Default true. */
    signals?: boolean;
    /** Called to leave. Default `process.exit`. */
    exit?: (code: number) => void;
    /** Diagnostics. Default stderr. */
    log?: (line: string) => void;
}
export interface StdioHandle {
    /** Stops every running call (killing spawned trees) and drops the queued ones. */
    stopAll(): void;
    /** Removes the signal handlers and stops reading. */
    close(): void;
}
/** Serves the server on stdin/stdout (see the module note). */
export declare function serveStdio(server: McpServer, options?: StdioOptions): StdioHandle;
