/**
 * An MCP server generated from a command table: a protocol adapter over a tool's CLI, never a second implementation. Two executors run a call:
 *
 * - **in process** (`inProcess(run)`): the call's argv is parsed by the table's `parseArgs` and handed to `run`, which calls the tool's own dispatch function and returns what the CLI would print (`{ value, text, notes, exitCode }`) or throws its refusal. Cheap, and right for a tool whose commands are quick. A **synchronous** `run` blocks the event loop while it runs: nothing else is read or answered until it returns, so `ping`, `tools/list`, a cancel and the timeout all wait for it, and a timeout can only fire after it has already finished. Only an **async** `run` that awaits and honours `ctx.signal` gets what the transport promises below (answers while it runs, a timeout or cancel that stops it). Either way a run cannot be killed: a timeout or a cancel drops its answer, and the next call waits for it to end.
 * - **spawn** (`spawnCli({ args: [bin] })`): the CLI itself runs as a child process; its stdout is the answer, its stderr the notes, a non-zero exit an error. The two surfaces are identical by construction, and a timeout or a cancel kills the CLI with its whole tree.
 *
 * Input transforms. `transformInput` rewrites a call's fields before they are checked and turned into argv (a path relative to a repository made absolute, a container path translated, a "bare name or absolute path" field validated by throwing `InvalidParams`); `transformArgv` rewrites the argv after. Both let a consumer keep its own path rules without forking the adapter.
 *
 * Result shape. With a JSON answer (`json: true`, or a command that prints JSON unasked) the content is exactly one text block, the document, so a client that concatenates blocks can parse it; every note (the CLI's stderr, what `prepare` says) goes into `_meta` under `<tool>/<key>`, never into a second block. A refusal in JSON mode is the `<tool>-error/1` document as that one block (with `errorDocuments: false`, the message text as that one block). Without JSON, the answer is the first text block and each note a block after it. A refusal or a non-zero exit comes back with `isError: true`. Input that does not fit a tool is a JSON-RPC -32602 error, and nothing runs.
 *
 * Transport (`serveStdio`): newline-delimited JSON-RPC 2.0 on stdin/stdout. Tool calls run one at a time, in order; `initialize`, `ping` and `tools/list` are answered at once, never queued behind a running call (a synchronous in-process run still blocks everything while it runs, see above). `notifications/cancelled` stops a running call (killing its process tree) or drops a queued one, and the cancelled request gets no answer. A cancel for any other id is ignored: one that arrives after its call was answered (a late cancel) does nothing, and a later request that reuses the id is answered as usual. Responses from the client are ignored. When stdin closes, or on SIGTERM, SIGINT or SIGHUP, every running call is stopped first; a signal then exits with 128 + its number.
 */
import { createInterface } from 'node:readline';
import { constants as osConstants } from 'node:os';
import { parseArgs, errorDocument, errorParts, isSingleJsonBlock } from '../cli/index.mjs';
import { buildTools, argvFor, answersJson, commandForTool, toolName, prefixOf, InvalidParams } from './tools.mjs';
import { runProcess } from './process.mjs';
export const PROTOCOL_VERSION = '2025-06-18';
/** The versions the server speaks: it uses nothing a later one added beyond tool annotations, which an older client ignores. A client asking for one of these gets it back; any other gets `PROTOCOL_VERSION`. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** Runs each call in this process through `run` (see the module note). */
export function inProcess(run) {
    return { kind: 'in-process', run };
}
/** Runs each call as `command ...args ...argv` (see the module note). */
export function spawnCli(options = {}) {
    return { kind: 'spawn', command: options.command ?? process.execPath, args: options.args ?? [], stderrLines: options.stderrLines ?? 40 };
}
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const text = (t) => ({ type: 'text', text: t });
const seconds = (ms) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);
/** A server over the table, answering one message at a time through `handle`; `serveStdio` puts it on stdin/stdout. */
export function createServer(options) {
    const { table, executor } = options;
    const tool = table.tool;
    const toolOptions = options.tools ?? {};
    const tools = buildTools(table, toolOptions);
    const helpName = toolOptions.help !== undefined ? toolName(prefixOf(table, toolOptions), 'help') : null;
    const versions = options.protocolVersions ?? PROTOCOL_VERSIONS;
    const errorDocs = options.errorDocuments ?? true;
    const inflight = new Set();
    const meta = (notes) => Object.fromEntries(Object.entries(notes).map(([k, v]) => [`${tool}/${k}`, v]));
    const timeoutOf = (command) => {
        const t = typeof options.timeoutMs === 'function' ? options.timeoutMs(command) : options.timeoutMs;
        return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;
    };
    function execute(ctx) {
        if (executor.kind === 'in-process') {
            return (async () => {
                try {
                    const parsed = parseArgs(table, ctx.argv);
                    return { kind: 'result', result: await executor.run({ ...ctx, parsed }) };
                }
                catch (error) {
                    return { kind: 'thrown', error };
                }
            })();
        }
        return runProcess(executor.command, [...executor.args, ...ctx.argv], { cwd: ctx.cwd, env: ctx.env, signal: ctx.signal })
            .then((r) => ({ kind: 'process', code: r.code, stdout: r.stdout, stderr: r.stderr, endedBy: r.stopped ? null : r.endedBy }));
    }
    function shape(ctx, o, notes) {
        const noteBlocks = Object.values(notes).map(text);
        if (o.kind === 'result') {
            const r = o.result;
            const isError = (r.exitCode ?? 0) !== 0;
            const own = r.notes && r.notes.length ? r.notes.join('\n') : null;
            if (ctx.json) {
                const m = { ...(own ? { notes: own } : {}), ...notes };
                return { content: [text(JSON.stringify(r.value ?? null, null, 2))], isError, ...(Object.keys(m).length ? { _meta: meta(m) } : {}) };
            }
            return { content: [text(String(r.text ?? '')), ...(own ? [text(own)] : []), ...noteBlocks], isError };
        }
        if (o.kind === 'thrown') {
            if (ctx.json) {
                const block = errorDocs ? JSON.stringify(errorDocument(tool, o.error), null, 2) : errorParts(o.error).what;
                return { content: [text(block)], isError: true, ...(Object.keys(notes).length ? { _meta: meta(notes) } : {}) };
            }
            return { content: [text(errorParts(o.error).what), ...noteBlocks], isError: true };
        }
        const lines = o.stderr.trim() ? o.stderr.trim().split(/\r?\n/) : [];
        const keep = executor.kind === 'spawn' ? executor.stderrLines : 40;
        const errLines = o.endedBy ? [...lines, `[${tool}] the CLI was stopped by ${o.endedBy}`] : lines;
        const err = errLines.length ? (errLines.length > keep ? [`(${errLines.length - keep} earlier lines of stderr left out)`, ...errLines.slice(-keep)] : errLines).join('\n') : null;
        const out = o.stdout.replace(/\r?\n$/, '');
        if (ctx.json && (o.code === 0 || isSingleJsonBlock(o.stdout))) {
            const m = { ...(err ? { stderr: err } : {}), ...notes };
            return { content: [text(out)], isError: o.code !== 0, ...(Object.keys(m).length ? { _meta: meta(m) } : {}) };
        }
        const content = [...(out ? [text(out)] : []), ...(err ? [text(err)] : [])];
        if (!content.length)
            content.push(text(o.code === 0 ? '' : `${tool} exited with ${o.code} and said nothing`));
        return { content: [...content, ...noteBlocks], isError: o.code !== 0 };
    }
    async function callTool(name, input, signal) {
        if (helpName !== null && name === helpName)
            return { content: [text(toolOptions.help)], isError: false };
        const command = commandForTool(table, name, toolOptions);
        if (command === null)
            throw new InvalidParams(`Unknown tool: ${String(name)}`);
        let fields = (input ?? {});
        if (options.transformInput) {
            if (typeof fields !== 'object' || Array.isArray(fields))
                throw new InvalidParams(`${String(name)}: arguments must be an object`);
            fields = await options.transformInput({ command, input: { ...fields } });
        }
        let argv = argvFor(table, command, fields, toolOptions);
        if (options.transformArgv)
            argv = await options.transformArgv({ command, argv: [...argv], input: fields });
        const prepared = (await options.prepare?.({ command, input: fields })) || {};
        const notes = prepared.notes ?? {};
        const ctrl = new AbortController();
        const onOuter = () => ctrl.abort('cancelled');
        if (signal?.aborted)
            ctrl.abort('cancelled');
        else
            signal?.addEventListener('abort', onOuter, { once: true });
        const ms = timeoutOf(command);
        const timer = setTimeout(() => ctrl.abort('timeout'), ms);
        const ctx = { command, argv, input: fields, json: answersJson(table, command, fields), signal: ctrl.signal, cwd: prepared.cwd, env: prepared.env, data: prepared.data };
        const work = execute(ctx);
        inflight.add(work);
        void work.finally(() => inflight.delete(work));
        const stopped = new Promise((r) => {
            if (ctrl.signal.aborted)
                r('stopped');
            else
                ctrl.signal.addEventListener('abort', () => r('stopped'), { once: true });
        });
        try {
            const o = await Promise.race([work, stopped]);
            // A spawned CLI answers once it is killed; wait for that, so the process is gone before the answer goes out.
            const settled = o === 'stopped' && executor.kind === 'spawn' ? await work : o;
            if (ctrl.signal.aborted) {
                if (ctrl.signal.reason === 'timeout') {
                    const hint = options.timeoutHint?.(command);
                    return { content: [text(`${tool} ${command} did not finish within ${seconds(ms)} and was stopped.${hint ? ` ${hint}` : ''}`)], isError: true };
                }
                return { content: [text(`${tool} ${command} was cancelled and stopped.`)], isError: true };
            }
            if (settled === 'stopped')
                throw new Error('unreachable');
            if (settled.kind === 'thrown' && settled.error instanceof InvalidParams)
                throw settled.error;
            return shape(ctx, settled, notes);
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onOuter);
        }
    }
    async function handle(msg, signal) {
        if (!msg || typeof msg !== 'object' || Array.isArray(msg))
            return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
        const hasId = Object.hasOwn(msg, 'id');
        // A response from the client (to a request this server never sends): nothing to answer.
        if (msg.method === undefined && hasId && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error')))
            return null;
        if (typeof msg.method !== 'string')
            return hasId ? { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32600, message: 'Invalid Request' } } : null;
        if (!hasId)
            return null; // a notification: nothing to answer
        const { id, method } = msg;
        const params = (msg.params ?? {});
        const ok = (result) => ({ jsonrpc: '2.0', id, result });
        const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
        if (method === 'initialize') {
            const asked = params.protocolVersion;
            return ok({
                protocolVersion: typeof asked === 'string' && versions.includes(asked) ? asked : versions[0] ?? PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: options.name ?? tool, version: options.version },
                ...(options.instructions ? { instructions: options.instructions } : {}),
            });
        }
        if (method === 'ping')
            return ok({});
        if (method === 'tools/list')
            return ok({ tools });
        if (method === 'tools/call') {
            try {
                const result = await callTool(params.name, params.arguments, signal);
                return signal?.aborted ? null : ok(result);
            }
            catch (e) {
                if (signal?.aborted)
                    return null;
                if (e instanceof InvalidParams)
                    return err(-32602, e.message);
                return err(-32603, e instanceof Error ? e.message : String(e));
            }
        }
        return err(-32601, `Method not found: ${method}`);
    }
    return { tools, handle, callTool, idle: async () => { while (inflight.size)
            await Promise.allSettled([...inflight]); } };
}
/** Serves the server on stdin/stdout (see the module note). */
export function serveStdio(server, options = {}) {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const exit = options.exit ?? ((code) => process.exit(code));
    const log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
    const send = (m) => { output.write(`${JSON.stringify(m)}\n`); };
    const key = (id) => JSON.stringify(id);
    const running = new Map(); // request id → the running call's controller
    const queued = new Map(); // request id → how many calls with it wait their turn
    const cancelled = new Set(); // ids of queued calls to drop when their turn comes
    let queue = Promise.resolve();
    async function answer(msg, call) {
        const ctrl = new AbortController();
        const k = key(msg.id);
        if (call)
            running.set(k, ctrl);
        let reply;
        try {
            reply = await server.handle(msg, ctrl.signal);
        }
        catch (e) {
            reply = { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
        }
        finally {
            if (call)
                running.delete(k);
        }
        if (reply && !ctrl.signal.aborted)
            send(reply);
    }
    const onLine = (line) => {
        const t = line.trim();
        if (!t)
            return;
        let msg;
        try {
            msg = JSON.parse(t);
        }
        catch {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }
        if (msg && typeof msg === 'object' && msg.method === 'notifications/cancelled') {
            const id = msg.params?.requestId;
            if (id === undefined)
                return;
            const ctrl = running.get(key(id));
            if (ctrl)
                ctrl.abort('cancelled');
            else if (queued.has(key(id)))
                cancelled.add(key(id));
            return;
        }
        const isCall = !!msg && typeof msg === 'object' && msg.method === 'tools/call' && Object.hasOwn(msg, 'id');
        if (!isCall) {
            answer(msg, false).catch((e) => log(`[mcp] ${e?.stack ?? e}`));
            return;
        }
        const k = key(msg.id);
        queued.set(k, (queued.get(k) ?? 0) + 1);
        queue = queue.then(async () => {
            const n = (queued.get(k) ?? 1) - 1;
            if (n)
                queued.set(k, n);
            else
                queued.delete(k);
            if (cancelled.delete(k))
                return; // cancelled while it waited its turn
            await answer(msg, true);
            await server.idle(); // an in-process run given up on still finishes before the next call starts
        }).catch((e) => log(`[mcp] ${e?.stack ?? e}`));
    };
    const stopAll = () => {
        for (const ctrl of running.values())
            ctrl.abort('cancelled');
        for (const k of queued.keys())
            cancelled.add(k);
    };
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => { try {
        onLine(line);
    }
    catch (e) {
        log(`[mcp] ${e?.stack ?? e}`);
    } });
    // The client is gone: stop whatever runs and leave, answering nothing more.
    rl.on('close', () => { stopAll(); output.write('', () => exit(0)); });
    const handlers = [];
    if (options.signals ?? true) {
        for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
            const h = () => { stopAll(); exit(128 + (osConstants.signals[sig] ?? 0)); };
            handlers.push([sig, h]);
            process.on(sig, h);
        }
        const uncaught = (e) => log(`[mcp] uncaught: ${e?.stack ?? e}`);
        handlers.push(['uncaughtException', uncaught], ['unhandledRejection', uncaught]);
        process.on('uncaughtException', uncaught);
        process.on('unhandledRejection', uncaught);
    }
    return {
        stopAll,
        close: () => { for (const [ev, h] of handlers)
            process.off(ev, h); rl.removeAllListeners('close'); rl.close(); },
    };
}
