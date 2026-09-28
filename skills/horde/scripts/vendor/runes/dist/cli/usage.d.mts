/**
 * Reading a hand-written usage text against the command table. A usage text stays hand-written (it is prose a person reads); this is how a tool's tests, and MCP tool descriptions, hold it to the table.
 *
 * The command section starts after the first unindented line that matches `from` (default `commands:` or `usage:`) and ends at the next unindented, non-empty line. In it, a line indented by exactly `indent` spaces (default 2) starts an entry: its synopsis runs up to the first run of two or more spaces, and the rest of the line and every deeper-indented line after it is its description. An entry belongs to the longest command key (or alias) its synopsis starts with; several entries may belong to one command.
 */
import { type CommandTable } from './table.mjs';
export interface UsageBlock {
    /** The synopses of the command's entries, joined with ` | `. */
    synopsis: string;
    /** The descriptions, whitespace collapsed, joined with ` · `. */
    description: string;
    /** Every `--flag` the entries mention. */
    flags: string[];
}
export interface UsageReading {
    /** Entries by command key. */
    blocks: Record<string, UsageBlock>;
    /** Entry synopses that name no command of the table. */
    unknown: string[];
}
export interface UsageOptions {
    from?: RegExp;
    indent?: number;
}
/** Reads the command section of `usage` against the table. */
export declare function readUsage(usage: string, table: CommandTable, options?: UsageOptions): UsageReading;
