import { spawn } from 'node:child_process';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const SHELL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

/**
 * Runs a command in the task workspace. NOT sandboxed: it can reach anything your user can.
 * The approval policy always asks before it runs.
 */
export interface ShellOptions {
  /** The project's variables (e.g. AWS_PROFILE), added to the minimal environment. */
  env?: Record<string, string>;
  /** Longest a command may run; the agent's time limit, or two minutes. */
  timeoutMs?: number;
  /** Aborted when the step stops or times out: the command is killed with it. */
  signal?: AbortSignal;
}

export function shellTool(workspace: string, options: ShellOptions = {}) {
  const timeoutMs = options.timeoutMs ?? SHELL_TIMEOUT_MS;
  return tool(
    ({ command }) =>
      new Promise<string>((resolve) => {
        const child = spawn('/bin/sh', ['-c', command], {
          cwd: workspace,
          // A minimal environment: no Gantrix token, database URL or other server secrets.
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: workspace,
            LANG: 'en_US.UTF-8',
            ...options.env,
          },
          detached: true, // own process group, so the timeout also kills anything it started
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const collect = (data: Buffer) => {
          if (output.length <= MAX_OUTPUT_CHARS) output += data.toString('utf8');
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        let timedOut = false;
        const kill = () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutMs);
        if (options.signal?.aborted) kill();
        options.signal?.addEventListener('abort', kill, { once: true });
        const settle = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', kill);
        };
        child.on('error', (error) => {
          settle();
          resolve(`Error: ${error.message}`);
        });
        child.on('close', (code, signal) => {
          settle();
          const status = timedOut
            ? `killed after ${Math.round(timeoutMs / 1000)}s`
            : `exit ${code ?? signal ?? 'unknown'}`;
          const clipped =
            output.length > MAX_OUTPUT_CHARS
              ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
              : output;
          resolve(`${status}\n${clipped}`);
        });
      }),
    {
      name: 'shell',
      description:
        'Run a shell command in the task workspace. Returns the exit status and combined output.',
      schema: z.object({ command: z.string().min(1) }),
    },
  );
}
