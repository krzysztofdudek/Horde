/**
 * @chrisdudek/runes/cli
 *
 * CLI scaffolding: the command table and its checks, `parseArgs` driven by it, the `<tool>-error/1` error document, the one-block `--json` rule, and reading a hand-written usage text against the table.
 */
export { RUNES_VERSION as version } from '../version.mjs';
/** The subpath this module is published under. */
export const subpath = 'cli';
export { defineTable, tableProblems, argSpec, commandFlags, pathFields, publicCommands, resolveCommand } from './table.mjs';
export { parseArgs } from './parse.mjs';
export { CliError, UsageError, errorDocument, errorSchema, errorParts, formatError, commandArgv } from './error.mjs';
export { renderResult, renderFailure, emit, jsonBlock, isSingleJsonBlock } from './output.mjs';
export { readUsage } from './usage.mjs';
