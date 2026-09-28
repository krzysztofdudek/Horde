export interface CommandResult {
    /** What `--json` prints. */
    value?: unknown;
    /** What the command prints in text mode. */
    text?: string;
    /** Notes for stderr, one per entry. */
    notes?: readonly string[];
    /** Exit code; default 0. A command whose answer is a failed check (not a refusal) sets it. */
    exitCode?: number;
}
export interface Rendered {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/** The JSON text of one document, as every family tool prints it: two-space indent and a final newline. */
export declare function jsonBlock(value: unknown): string;
/** A command's answer: the JSON document or the text on stdout, the notes on stderr. */
export declare function renderResult(result: CommandResult, options: {
    json: boolean;
}): Rendered;
export interface FailureOptions {
    json: boolean;
    /** Names `next.command` may start with in the error document. Default the tool's name. */
    programs?: readonly string[];
    /** How the error reads on stderr. Default `formatError` (`error[code]: what`, why, next). */
    format?: (err: unknown) => string;
}
/** A refusal: the text on stderr always, and in JSON mode the `<tool>-error/1` document as the one block on stdout. */
export declare function renderFailure(tool: string, err: unknown, options: FailureOptions): Rendered;
/** Whether `stdout` is exactly one JSON document and nothing else (surrounding whitespace aside). */
export declare function isSingleJsonBlock(stdout: string): boolean;
export interface Streams {
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
}
/** Writes what was rendered and returns its exit code; the caller sets `process.exitCode` or exits. */
export declare function emit(rendered: Rendered, streams?: Streams): number;
