/**
 * A minimal MCP client over a server's real stdio, for tests: requests correlated by id, notifications, raw lines, and every message the server sent kept in order.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree } from '../mcp/index.mjs';
/** Starts a server and connects to its stdio. */
export function startMcpClient(options) {
    // Its own process group on POSIX, so stop() can kill the server together with whatever it started.
    const child = spawn(options.command, options.args ?? [], { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const pending = new Map();
    const seen = [];
    let err = '';
    let next = 1;
    child.stderr?.on('data', (d) => { err += d; });
    createInterface({ input: child.stdout }).on('line', (line) => {
        let m;
        try {
            m = JSON.parse(line);
        }
        catch {
            seen.push({ raw: line });
            return;
        }
        seen.push(m);
        const k = JSON.stringify(m?.id);
        const done = pending.get(k);
        if (done) {
            pending.delete(k);
            done(m);
        }
    });
    const raw = (line) => { child.stdin?.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`); };
    const request = (method, params, id = next++) => new Promise((res, rej) => {
        const t = setTimeout(() => { pending.delete(JSON.stringify(id)); rej(new Error(`no answer to ${method} (id ${JSON.stringify(id)}) — stderr so far:\n${err}`)); }, options.timeoutMs ?? 60_000);
        pending.set(JSON.stringify(id), (m) => { clearTimeout(t); res(m); });
        raw({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    return {
        child, request, raw, seen, exited,
        call: (name, args = {}, id) => request('tools/call', { name, arguments: args }, id),
        notify: (method, params) => raw({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
        stderr: () => err,
        stop: async (graceMs = 2_000) => {
            const done = () => child.exitCode !== null || child.signalCode !== null;
            try {
                child.stdin?.end();
            }
            catch { /* closed */ }
            if (!done())
                await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs))]);
            // Even a server that left: a child it started may still run in its group.
            killTree(child.pid);
            if (!done())
                await exited;
        },
    };
}
/** Starts a server, initializes it, lists its tools and stops it. */
export async function listToolsOverStdio(options) {
    const c = startMcpClient(options);
    try {
        await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'runes-testkit', version: '0' } });
        c.notify('notifications/initialized');
        const r = await c.request('tools/list');
        if (!Array.isArray(r.result?.tools))
            throw new Error(`tools/list answered without tools: ${JSON.stringify(r)}`);
        return r.result.tools;
    }
    finally {
        await c.stop();
    }
}
