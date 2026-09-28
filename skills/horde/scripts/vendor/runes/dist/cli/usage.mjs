/**
 * Reading a hand-written usage text against the command table. A usage text stays hand-written (it is prose a person reads); this is how a tool's tests, and MCP tool descriptions, hold it to the table.
 *
 * The command section starts after the first unindented line that matches `from` (default `commands:` or `usage:`) and ends at the next unindented, non-empty line. In it, a line indented by exactly `indent` spaces (default 2) starts an entry: its synopsis runs up to the first run of two or more spaces, and the rest of the line and every deeper-indented line after it is its description. An entry belongs to the longest command key (or alias) its synopsis starts with; several entries may belong to one command.
 */
import { resolveCommand } from './table.mjs';
/** Reads the command section of `usage` against the table. */
export function readUsage(usage, table, options = {}) {
    const { from = /^(commands|usage):/i, indent = 2 } = options;
    const all = usage.split(/\r?\n/);
    const start = all.findIndex((l) => from.test(l));
    const raw = {};
    const unknown = [];
    let cur = null;
    for (let i = start + 1; start >= 0 && i < all.length; i += 1) {
        const line = all[i];
        if (/^\S/.test(line))
            break;
        if (!line.trim())
            continue;
        const depth = line.length - line.trimStart().length;
        if (depth === indent) {
            const [syn = '', ...desc] = line.trim().split(/\s{2,}/);
            const hit = resolveCommand(table, syn.split(/\s+/));
            if (!hit) {
                unknown.push(syn);
                cur = null;
                continue;
            }
            cur = raw[hit.command] ??= { syn: [], desc: [] };
            cur.syn.push(syn);
            cur.desc.push(desc.join(' '));
            continue;
        }
        if (cur && depth > indent)
            cur.desc[cur.desc.length - 1] += ` ${line.trim()}`;
    }
    const blocks = {};
    for (const [k, b] of Object.entries(raw)) {
        const text = [...b.syn, ...b.desc].join(' ');
        blocks[k] = {
            synopsis: b.syn.join(' | '),
            description: b.desc.map((d) => d.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · '),
            flags: [...new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]))],
        };
    }
    return { blocks, unknown };
}
