/**
 * The error document. A command that answers in JSON and fails writes one document on stdout, `<tool>-error/1`, instead of its answer, so a caller reads a refusal by its code and never by its wording:
 *
 * ```json
 * { "schema": "grain-error/1", "code": "usage", "what": "unknown flag --x for where", "why": null, "next": { "command": ["grain", "help"], "text": "grain help" } }
 * ```
 *
 * `code` is a stable lower-case word the tool owns (`usage` for a command line the table refuses, `command-error` when nothing more specific is known). `what` says what failed, `why` why it matters or null, `next` the step to take or null: its `text` as written, its `command` as argv when the text is a command of this tool a caller can run as given, else null. Text mode prints the same three parts on stderr (`formatError`).
 */
export interface CliErrorOptions {
    why?: string | null;
    next?: string | null;
    /** The process exit code the CLI uses for this error. Default 1. */
    exitCode?: number;
}
/** A refusal the tool means: a code, what failed, and optionally why and the next step. */
export declare class CliError extends Error {
    readonly code: string;
    readonly what: string;
    readonly why: string | null;
    readonly next: string | null;
    readonly exitCode: number;
    constructor(code: string, what: string, options?: CliErrorOptions);
}
/** A command line the table refuses: an unknown command or flag, a missing or surplus argument, a malformed value. Code `usage`. */
export declare class UsageError extends CliError {
    constructor(what: string, options?: CliErrorOptions);
}
export interface ErrorDocument {
    schema: string;
    code: string;
    what: string;
    why: string | null;
    next: {
        command: string[] | null;
        text: string;
    } | null;
}
/** The schema name of a tool's error document. */
export declare const errorSchema: (tool: string) => string;
/** The parts of any thrown value: a CliError as it is, anything else as `command-error` with its message (or a lower-case `code` it carries). */
export declare function errorParts(err: unknown): {
    code: string;
    what: string;
    why: string | null;
    next: string | null;
    exitCode: number;
};
/**
 * A step's text as argv, when a reader can run it as given: it starts with one of `programs` and holds no placeholder (`<x>`), optional part (`[x]`), alternative (`a | b`), ellipsis or trailing explanation. Quotes group words and are dropped. A leading `Run: ` is ignored. Null otherwise.
 */
export declare function commandArgv(text: string | null | undefined, programs: readonly string[]): string[] | null;
/** The `<tool>-error/1` document for a thrown value. `programs` are the names `next.command` may start with; default the tool's name. */
export declare function errorDocument(tool: string, err: unknown, programs?: readonly string[]): ErrorDocument;
/** The error as text for stderr: `error[code]: what`, then `  why:  …` and `next: …` when they are known. */
export declare function formatError(err: unknown): string;
