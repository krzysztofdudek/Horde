/**
 * Argument parsing driven by the command table. The rules:
 *
 * - The first word that is not a flag starts the command; the longest command key (or alias) its words spell is the command. Before it only global flags may come.
 * - `--name=value` or `--name value`. A flag that takes a value always takes the next word, whatever it starts with: `--ran "--help"` records `--help`. A `bool` flag takes no value.
 * - A bare `--` ends the flags: everything after it is an argument, so a note that starts with `--` goes there.
 * - A flag the command does not know is an error that names the ones it does, never silently dropped. A single-value flag given twice is an error; a `many` flag collects its values.
 * - Words beyond what the command reads are an error, not dropped: after a bare `--` that is where a flag written last would land, and a call that silently lost a flag could do the wrong thing.
 * - A required argument that is missing is an error, unless `checkRequired` is off.
 *
 * Every refusal is a `UsageError` (code `usage`).
 */
import { UsageError } from './error.mjs';
import { argSpec, commandFlags, resolveCommand } from './table.mjs';
const named = (t) => Object.keys(t).map((k) => `--${k}`).join(', ') || 'no flags';
function unknownCommand(table, word) {
    const group = Object.keys(table.commands).filter((k) => k.startsWith(`${word} `) && !table.commands[k]?.internal);
    return new UsageError(group.length ? `${word} needs a subcommand: ${group.join(', ')}` : `unknown command: ${word}`);
}
/** Parses `argv` (without the node and script paths) against the table. Throws `UsageError`. */
export function parseArgs(table, argv, options = {}) {
    const { checkRequired = true } = options;
    const words = [];
    const flags = {};
    let command;
    let rest = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (rest || !a.startsWith('--') || a === '--') {
            if (a === '--' && !rest) {
                rest = true;
                continue;
            }
            if (command === undefined) {
                const found = resolveCommand(table, argv.slice(i));
                if (!found)
                    throw unknownCommand(table, a);
                command = found.command;
                i += found.consumed - 1;
                continue;
            }
            words.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
        const inline = eq === -1 ? undefined : a.slice(eq + 1);
        const t = command === undefined ? { ...(table.globalFlags ?? {}) } : commandFlags(table, command);
        const kind = Object.hasOwn(t, name) ? t[name] : undefined;
        if (kind === undefined) {
            const where = command === undefined ? `before the command — only ${named(table.globalFlags ?? {})} may come before it` : `for ${command} — it takes ${named(t)}`;
            throw new UsageError(`unknown flag --${name} ${where}. A value that starts with -- goes after a bare --`);
        }
        if (kind === 'bool') {
            if (inline !== undefined)
                throw new UsageError(`--${name} takes no value`);
            flags[name] = true;
            continue;
        }
        let value = inline;
        if (value === undefined) {
            if (i + 1 >= argv.length)
                throw new UsageError(`--${name} needs a value`);
            value = argv[i + 1];
            i += 1;
        }
        if (kind === 'many') {
            const prev = flags[name];
            flags[name] = prev === undefined ? value : [].concat(prev, value);
            continue;
        }
        if (flags[name] !== undefined)
            throw new UsageError(`--${name} given twice — it takes one value`);
        if (kind === 'number') {
            const n = value.trim() === '' ? Number.NaN : Number(value);
            if (!Number.isFinite(n))
                throw new UsageError(`--${name} takes a number, not ${JSON.stringify(value)}`);
            flags[name] = n;
        }
        else
            flags[name] = value;
    }
    const args = {};
    if (command !== undefined) {
        const specs = (table.commands[command]?.args ?? []).map(argSpec);
        let k = 0;
        for (const s of specs) {
            if (s.variadic) {
                const taken = words.slice(k);
                k = words.length;
                if (!taken.length && !s.optional && checkRequired)
                    throw new UsageError(`${command} needs at least one <${s.name}>`);
                if (taken.length)
                    args[s.name] = taken;
                continue;
            }
            if (k < words.length) {
                args[s.name] = words[k];
                k += 1;
                continue;
            }
            if (!s.optional && checkRequired)
                throw new UsageError(`${command} needs <${s.name}>`);
        }
        const extra = words.slice(k);
        if (extra.length) {
            throw new UsageError(`${command} takes at most ${specs.length} argument${specs.length === 1 ? '' : 's'} — unexpected: ${extra.map((x) => JSON.stringify(x)).join(' ')}${rest ? ' (everything after a bare -- is an argument, so flags go before it)' : ''}`);
        }
    }
    return { command, words, args, flags };
}
