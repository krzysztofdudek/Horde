/**
 * The error document. A command that answers in JSON and fails writes one document on stdout, `<tool>-error/1`, instead of its answer, so a caller reads a refusal by its code and never by its wording:
 *
 * ```json
 * { "schema": "grain-error/1", "code": "usage", "what": "unknown flag --x for where", "why": null, "next": { "command": ["grain", "help"], "text": "grain help" } }
 * ```
 *
 * `code` is a stable lower-case word the tool owns (`usage` for a command line the table refuses, `command-error` when nothing more specific is known). `what` says what failed, `why` why it matters or null, `next` the step to take or null: its `text` as written, its `command` as argv when the text is a command of this tool a caller can run as given, else null. Text mode prints the same three parts on stderr (`formatError`).
 */
/** A refusal the tool means: a code, what failed, and optionally why and the next step. */
export class CliError extends Error {
    code;
    what;
    why;
    next;
    exitCode;
    constructor(code, what, options = {}) {
        super(what);
        this.name = 'CliError';
        this.code = code;
        this.what = what;
        this.why = options.why ?? null;
        this.next = options.next ?? null;
        this.exitCode = options.exitCode ?? 1;
    }
}
/** A command line the table refuses: an unknown command or flag, a missing or surplus argument, a malformed value. Code `usage`. */
export class UsageError extends CliError {
    constructor(what, options = {}) {
        super('usage', what, options);
        this.name = 'UsageError';
    }
}
/** The schema name of a tool's error document. */
export const errorSchema = (tool) => `${tool}-error/1`;
const CODE = /^[a-z][a-z0-9-]*$/;
/** The parts of any thrown value: a CliError as it is, anything else as `command-error` with its message (or a lower-case `code` it carries). */
export function errorParts(err) {
    if (err instanceof CliError)
        return { code: err.code, what: err.what, why: err.why, next: err.next, exitCode: err.exitCode };
    const code = err?.code;
    const what = err instanceof Error ? err.message : String(err);
    return { code: typeof code === 'string' && CODE.test(code) ? code : 'command-error', what, why: null, next: null, exitCode: 1 };
}
/**
 * A step's text as argv, when a reader can run it as given: it starts with one of `programs` and holds no placeholder (`<x>`), optional part (`[x]`), alternative (`a | b`), ellipsis or trailing explanation. Quotes group words and are dropped. A leading `Run: ` is ignored. Null otherwise.
 */
export function commandArgv(text, programs) {
    if (typeof text !== 'string')
        return null;
    const t = text.trim().replace(/^Run:\s*/, '');
    if (!t || /[<>[\]|…—]|\.\.\./.test(t))
        return null;
    const argv = [];
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
    for (let m = re.exec(t); m; m = re.exec(t))
        argv.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3] ?? ''));
    return argv.length && programs.includes(argv[0]) ? argv : null;
}
/** The `<tool>-error/1` document for a thrown value. `programs` are the names `next.command` may start with; default the tool's name. */
export function errorDocument(tool, err, programs = [tool]) {
    const { code, what, why, next } = errorParts(err);
    return { schema: errorSchema(tool), code, what, why, next: next === null ? null : { command: commandArgv(next, programs), text: next.replace(/^Run:\s*/, '') } };
}
/** The error as text for stderr: `error[code]: what`, then `  why:  …` and `next: …` when they are known. */
export function formatError(err) {
    const { code, what, why, next } = errorParts(err);
    return [`error[${code}]: ${what}`, ...(why ? [`  why:  ${why}`] : []), ...(next ? [`next: ${next.replace(/^Run:\s*/, '')}`] : [])].join('\n');
}
