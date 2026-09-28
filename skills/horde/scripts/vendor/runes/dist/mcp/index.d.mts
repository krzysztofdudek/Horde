/**
 * @chrisdudek/runes/mcp
 *
 * An MCP stdio server generated from a command table, with an in-process executor (the tool's dispatch function) and a spawn executor (the tool's CLI as a child process, killed with its tree on timeout, cancel or shutdown).
 */
export { RUNES_VERSION as version } from '../version.mjs';
/** The subpath this module is published under. */
export declare const subpath = "mcp";
export { buildTools, argvFor, answersJson, commandForTool, toolName, toolFlags, prefixOf, InvalidParams, requireParam, type McpTool, type ToolOptions } from './tools.mjs';
export { createServer, serveStdio, inProcess, spawnCli, PROTOCOL_VERSION, PROTOCOL_VERSIONS, type ServerOptions, type McpServer, type Executor, type InProcessExecutor, type SpawnExecutor, type CallContext, type PrepareResult, type ToolResult, type StdioOptions, type StdioHandle, type JsonRpcMessage, type JsonRpcReply, } from './server.mjs';
export { runProcess, killTree, type RunOptions, type RunOutcome, type KillOptions } from './process.mjs';
