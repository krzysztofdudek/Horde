import { type CommandTable } from './table.mjs';
export type FlagValue = boolean | string | number | string[];
export interface ParsedArgs {
    /** The command key, subcommand words included; undefined when the line names none (only flags, or nothing). */
    command: string | undefined;
    /** The words after the command, in order, as given. */
    words: string[];
    /** The words by argument name: a string, or a list for a variadic argument. A left-out optional argument is absent. */
    args: Record<string, string | string[]>;
    /** The flags given: true for a bool, the value, a number for a number flag, a list for a many flag given more than once (a single string when given once). */
    flags: Record<string, FlagValue>;
}
export interface ParseOptions {
    /** Refuse a line that leaves out a required argument. Default true. */
    checkRequired?: boolean;
}
/** Parses `argv` (without the node and script paths) against the table. Throws `UsageError`. */
export declare function parseArgs(table: CommandTable, argv: readonly string[], options?: ParseOptions): ParsedArgs;
