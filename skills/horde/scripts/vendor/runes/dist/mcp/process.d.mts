/**
 * Running a CLI as a child process that can be stopped with everything it started.
 *
 * On POSIX the child leads a process group of its own (`detached`), and stopping it kills the whole group with SIGKILL: a CLI that re-executes itself (a low-memory mode, a wrapper script) answers from a grandchild, and killing only the parent would leave that running. On Windows there are no process groups; `taskkill /PID <pid> /T /F` kills the tree by parentage. A child that runs detached is also not stopped by anything else when the server goes, so a server stops every running child before it exits.
 */
import { spawnSync } from 'node:child_process';
export interface RunOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Aborting it stops the child and its tree. */
    signal?: AbortSignal;
}
export interface RunOutcome {
    /** Exit code; 1 when the child could not start or ended by a signal. */
    code: number;
    stdout: string;
    stderr: string;
    /** The child was stopped through `signal`. */
    stopped: boolean;
    /** The signal that ended the child, when one did. */
    endedBy: string | null;
}
export interface KillOptions {
    platform?: NodeJS.Platform;
    /** The synchronous spawn used for taskkill; a test knob. */
    spawnSync?: typeof spawnSync;
}
/** Kills a process and everything it started, synchronously: its process group on POSIX, its tree through taskkill on Windows. Never throws. */
export declare function killTree(pid: number | undefined, options?: KillOptions): void;
/** Runs `command args` without a shell, collecting its output, until it ends or `signal` stops it with its tree. */
export declare function runProcess(command: string, args: readonly string[], options?: RunOptions): Promise<RunOutcome>;
