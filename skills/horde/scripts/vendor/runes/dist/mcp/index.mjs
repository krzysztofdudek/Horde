/**
 * @chrisdudek/runes/mcp
 *
 * An MCP stdio server generated from a command table, run by the spawn executor (the tool's CLI as a child process, killed with its tree on timeout, cancel or shutdown), and the pieces a consumer with its own message handler reuses. This index is the stable 1.x surface (docs/api.md), and it holds only what a family tool imports today. The in-process executor (`inProcess`, with `InProcessExecutor`, `CallContext` and `Executor`) stays an internal module: no family tool runs one (Jarl dispatches in process through its own handler), and its `run` answers with the CLI's internal result and error types; a later 1.x minor may export them together when a tool adopts it.
 */
export { buildTools, argvFor, answersJson, commandForTool, toolName, InvalidParams } from './tools.mjs';
export { createServer, serveStdio, spawnCli, PROTOCOL_VERSION, PROTOCOL_VERSIONS, } from './server.mjs';
export { killTree } from './process.mjs';
