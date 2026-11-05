import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** An error the model caused and can fix; returned to it as text instead of failing the step. */
export class ToolError extends Error {
  override name = 'ToolError';
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function createWorkspace(workspacesDir: string, taskId: string): Promise<string> {
  const dir = join(workspacesDir, taskId);
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

/** Resolves a path inside the task workspace, following symlinks, or throws. */
export async function resolveInWorkspace(workspace: string, input: string): Promise<string> {
  const root = await realpath(workspace);
  const target = resolve(root, input);
  let existing = target; // the deepest part of the path that exists, so a symlink can't lead out
  while (!(await pathExists(existing))) existing = dirname(existing);
  const real = join(await realpath(existing), relative(existing, target));
  if (real !== root && !real.startsWith(root + sep)) {
    throw new ToolError(`Path "${input}" is outside the task workspace.`);
  }
  return real;
}

/** Runs a tool body and turns any failure into text the model can read and react to. */
export async function asToolResult(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
