/**
 * @chrisdudek/runes/cli
 *
 * CLI scaffolding: the command table and its checks, `parseArgs` driven by it, the `<tool>-error/1` error document, the one-block `--json` rule, and reading a hand-written usage text against the table.
 */
export { RUNES_VERSION as version } from '../version.mjs';
/** The subpath this module is published under. */
export declare const subpath = "cli";
export { defineTable, tableProblems, argSpec, commandFlags, pathFields, publicCommands, resolveCommand, type CommandTable, type CommandSpec, type FlagKind, type ArgSpec } from './table.mjs';
export { parseArgs, type ParsedArgs, type ParseOptions, type FlagValue } from './parse.mjs';
export { CliError, UsageError, errorDocument, errorSchema, errorParts, formatError, commandArgv, type ErrorDocument, type CliErrorOptions } from './error.mjs';
export { renderResult, renderFailure, emit, jsonBlock, isSingleJsonBlock, type CommandResult, type Rendered, type FailureOptions, type Streams } from './output.mjs';
export { readUsage, type UsageBlock, type UsageReading, type UsageOptions } from './usage.mjs';
