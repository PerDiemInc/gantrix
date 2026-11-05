import { spawn } from 'node:child_process';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

/**
 * Runs a command in the task workspace. NOT sandboxed: it can reach anything your user can.
 * The approval policy always asks before it runs.
 */
export function shellTool(workspace: string) {
  return tool(
    ({ command }) =>
      new Promise<string>((resolve) => {
        const child = spawn('/bin/sh', ['-c', command], {
          cwd: workspace,
          // A minimal environment: no Gantrix token, database URL or other server secrets.
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace, LANG: 'en_US.UTF-8' },
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
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        }, TIMEOUT_MS);
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve(`Error: ${error.message}`);
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const status = timedOut
            ? `killed after ${TIMEOUT_MS / 1000}s`
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
