/**
 * @chrisdudek/runes/cli
 *
 * The command table: `defineTable` and the shape it takes, the one source of a tool's CLI, its MCP tools and its parity tests. This index is the stable 1.x surface (docs/api.md), and it holds only what a family tool imports today. The parser, the `<tool>-error/1` document and the one-block `--json` rule stay internal modules that the MCP adapter and the test kit use; a later 1.x minor may export them when a tool adopts them.
 */
export { defineTable, type CommandTable, type CommandSpec, type FlagKind } from './table.mjs';
