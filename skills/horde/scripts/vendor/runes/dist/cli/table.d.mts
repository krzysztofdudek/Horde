/**
 * The command table: every command a tool's CLI answers to, its arguments and its flags, in one place. The CLI parses from it (`parseArgs`), the MCP server builds one tool per command from it (`@chrisdudek/runes/mcp`), and the test kit holds the table, the usage text and the tools together in both directions, so the surfaces can never drift apart.
 *
 * An argument is written as its name, with `?` when it may be left out, `...` when it takes one or more words, and `...?` when it takes any number, none included. Required arguments come first, then optional ones; a variadic one is last.
 *
 * A flag is `bool` (bare), `value` (exactly one value), `many` (repeatable, one value each time), `number` (one value, a finite number) or `path` (one value, a file or directory the command resolves against its working directory). A command key may hold several words for a subcommand (`decide steer`).
 */
export type FlagKind = 'bool' | 'value' | 'many' | 'number' | 'path';
export interface CommandSpec {
    /** Arguments after the command words, in order: `name`, `name?`, `name...`, `name...?`. */
    args?: readonly string[];
    /** Flags this command accepts beyond the global ones. */
    flags?: Readonly<Record<string, FlagKind>>;
    /** One sentence: what the command does. The MCP tool's description starts with it. */
    summary?: string;
    /** The command writes something beyond a disposable cache. */
    writes?: boolean;
    /** The command can remove or overwrite what is there. */
    destructive?: boolean;
    /** Running the command twice with the same input has no further effect. Default: true for a command that does not write. */
    idempotent?: boolean;
    /** Arguments and `value`/`many` flags that name a file resolved against the working directory. A `path` flag is one already. Over MCP they must be absolute. */
    paths?: readonly string[];
    /** The command prints a JSON document on stdout without `--json`. A string names a flag whose presence turns that off (it writes the document to that file instead). */
    stdoutJson?: boolean | string;
    /** Run by hooks or developers only: parsed by the CLI, never offered as an MCP tool or listed in the usage text. */
    internal?: boolean;
}
export interface CommandTable {
    /** The tool's name: the error document is `<tool>-error/1`, MCP tools are `<tool>_<command>`. Lower case. */
    tool: string;
    /** Flags every command accepts, before or after the command words. */
    globalFlags?: Readonly<Record<string, FlagKind>>;
    commands: Readonly<Record<string, CommandSpec>>;
    /** Other names for commands: alias words to a command key. They get no tool of their own. */
    aliases?: Readonly<Record<string, string>>;
}
export interface ArgSpec {
    name: string;
    optional: boolean;
    variadic: boolean;
}
/** An argument written in the table, read: `files...?` is { name: 'files', optional: true, variadic: true }. */
export declare function argSpec(written: string): ArgSpec;
/** Every flag a command accepts: the global flags, then its own. */
export declare function commandFlags(table: CommandTable, command: string): Record<string, FlagKind>;
/** The fields a command takes that name files resolved against the working directory: its `path` flags (global ones included) and what `paths` lists. */
export declare function pathFields(table: CommandTable, command: string): Set<string>;
/** The commands the tool offers: every command not marked internal. */
export declare function publicCommands(table: CommandTable): string[];
/** Every problem with a table; empty means it is well formed. */
export declare function tableProblems(table: CommandTable): string[];
/** Checks a table and returns it unchanged; throws listing every problem. Call it once where the table is declared. */
export declare function defineTable<T extends CommandTable>(table: T): T;
/**
 * The command at the start of `words`: the longest command key (or alias, rewritten to what it names) the leading words spell. `consumed` is how many words it took. Null when none matches.
 */
export declare function resolveCommand(table: CommandTable, words: readonly string[]): {
    command: string;
    consumed: number;
} | null;
