/**
 * The command table: every command a tool's CLI answers to, its arguments and its flags, in one place. The CLI parses from it (`parseArgs`), the MCP server builds one tool per command from it (`@chrisdudek/runes/mcp`), and the test kit holds the table, the usage text and the tools together in both directions, so the surfaces can never drift apart.
 *
 * An argument is written as its name, with `?` when it may be left out, `...` when it takes one or more words, and `...?` when it takes any number, none included. Required arguments come first, then optional ones; a variadic one is last.
 *
 * A flag is `bool` (bare), `value` (exactly one value), `many` (repeatable, one value each time), `number` (one value, a finite number) or `path` (one value, a file or directory the command resolves against its working directory). A command key may hold several words for a subcommand (`decide steer`).
 */
const WORD = /^[a-z][a-z0-9-]*$/;
const COMMAND_KEY = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/;
const ARG = /^([a-z][a-z0-9-]*)(\.\.\.)?(\?)?$/;
const KINDS = ['bool', 'value', 'many', 'number', 'path'];
/** An argument written in the table, read: `files...?` is { name: 'files', optional: true, variadic: true }. */
export function argSpec(written) {
    const m = ARG.exec(written);
    if (!m)
        throw new Error(`not an argument: "${written}" — a lower-case name, then optionally ... and ?`);
    return { name: m[1], variadic: m[2] !== undefined, optional: m[3] !== undefined };
}
/** Every flag a command accepts: the global flags, then its own. */
export function commandFlags(table, command) {
    return { ...(table.globalFlags ?? {}), ...(table.commands[command]?.flags ?? {}) };
}
/** The fields a command takes that name files resolved against the working directory: its `path` flags (global ones included) and what `paths` lists. */
export function pathFields(table, command) {
    const out = new Set(table.commands[command]?.paths ?? []);
    for (const [f, kind] of Object.entries(commandFlags(table, command)))
        if (kind === 'path')
            out.add(f);
    return out;
}
/** The commands the tool offers: every command not marked internal. */
export function publicCommands(table) {
    return Object.keys(table.commands).filter((c) => !table.commands[c]?.internal);
}
/** Every problem with a table; empty means it is well formed. */
export function tableProblems(table) {
    const p = [];
    if (typeof table?.tool !== 'string' || !WORD.test(table.tool))
        p.push(`tool: "${table?.tool}" is not a lower-case name`);
    const globals = table?.globalFlags ?? {};
    for (const [f, k] of Object.entries(globals)) {
        if (!WORD.test(f))
            p.push(`global flag --${f}: not a lower-case name`);
        if (!KINDS.includes(k))
            p.push(`global flag --${f}: unknown kind "${k}"`);
    }
    const commands = table?.commands ?? {};
    if (!Object.keys(commands).length)
        p.push('commands: none');
    for (const [cmd, spec] of Object.entries(commands)) {
        const at = `command "${cmd}"`;
        if (!COMMAND_KEY.test(cmd))
            p.push(`${at}: not lower-case words`);
        const names = new Set();
        let seenOptional = false;
        const args = spec.args ?? [];
        args.forEach((a, i) => {
            let s;
            try {
                s = argSpec(a);
            }
            catch (e) {
                p.push(`${at}: ${e.message}`);
                return;
            }
            if (names.has(s.name))
                p.push(`${at}: argument "${s.name}" twice`);
            names.add(s.name);
            if (s.variadic && i !== args.length - 1)
                p.push(`${at}: variadic argument "${s.name}" is not last`);
            if (!s.optional && !s.variadic && seenOptional)
                p.push(`${at}: required argument "${s.name}" after an optional one`);
            if (s.optional)
                seenOptional = true;
        });
        for (const [f, k] of Object.entries(spec.flags ?? {})) {
            if (!WORD.test(f))
                p.push(`${at}: flag --${f} is not a lower-case name`);
            if (!KINDS.includes(k))
                p.push(`${at}: flag --${f} has unknown kind "${k}"`);
            if (Object.hasOwn(globals, f) && globals[f] !== k)
                p.push(`${at}: flag --${f} is ${k} here but ${globals[f]} as a global flag`);
            if (names.has(f))
                p.push(`${at}: "${f}" is both an argument and a flag`);
        }
        for (const g of Object.keys(globals))
            if (names.has(g))
                p.push(`${at}: "${g}" is both an argument and a global flag`);
        const flags = commandFlags(table, cmd);
        for (const f of spec.paths ?? []) {
            if (!names.has(f) && !(Object.hasOwn(flags, f) && flags[f] !== 'bool' && flags[f] !== 'number'))
                p.push(`${at}: paths names "${f}", which is neither an argument nor a flag that takes a value`);
        }
        if (typeof spec.stdoutJson === 'string' && !Object.hasOwn(flags, spec.stdoutJson))
            p.push(`${at}: stdoutJson names --${spec.stdoutJson}, which it does not take`);
    }
    for (const [alias, target] of Object.entries(table?.aliases ?? {})) {
        if (!COMMAND_KEY.test(alias))
            p.push(`alias "${alias}": not lower-case words`);
        if (Object.hasOwn(commands, alias))
            p.push(`alias "${alias}": is also a command`);
        const exists = Object.hasOwn(commands, target) || Object.keys(commands).some((c) => c.startsWith(`${target} `));
        if (!exists)
            p.push(`alias "${alias}": names "${target}", which is no command and no command group`);
    }
    return p;
}
/** Checks a table and returns it unchanged; throws listing every problem. Call it once where the table is declared. */
export function defineTable(table) {
    const problems = tableProblems(table);
    if (problems.length)
        throw new Error(`the command table is malformed:\n  ${problems.join('\n  ')}`);
    return table;
}
/**
 * The command at the start of `words`: the longest command key (or alias, rewritten to what it names) the leading words spell. `consumed` is how many words it took. Null when none matches.
 */
export function resolveCommand(table, words) {
    const aliases = table.aliases ?? {};
    const max = Math.max(...Object.keys(table.commands).map((k) => k.split(' ').length), ...Object.keys(aliases).map((k) => k.split(' ').length));
    for (let n = Math.min(max, words.length); n >= 1; n -= 1) {
        const head = words.slice(0, n);
        if (head.some((w) => w.startsWith('-')))
            continue;
        const key = head.join(' ');
        if (Object.hasOwn(table.commands, key))
            return { command: key, consumed: n };
        if (Object.hasOwn(aliases, key)) {
            // An alias may name a whole command group (seed → decide): the rest of the words pick the subcommand.
            const target = aliases[key];
            const rest = resolveCommand({ ...table, aliases: {} }, [...target.split(' '), ...words.slice(n)]);
            if (rest)
                return { command: rest.command, consumed: n + rest.consumed - target.split(' ').length };
        }
    }
    return null;
}
