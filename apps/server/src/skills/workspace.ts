import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Marks a project whose steps each get their own folder (see step-workspace.ts). */
export const ISOLATED_MARKER = '.isolated-steps';

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

export async function createWorkspace(
  workspacesDir: string,
  taskId: string,
  isolated = false,
): Promise<string> {
  const dir = join(workspacesDir, taskId);
  await mkdir(dir, { recursive: true });
  // Same name as ISOLATED_WORKSPACE_MARKER (step-workspace.ts imports this module).
  if (isolated) await writeFile(join(dir, ISOLATED_MARKER), '1\n');
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

export interface WalkEntry {
  path: string; // relative, "/"-separated
  kind: 'file' | 'dir' | 'link';
}

/**
 * Lists a folder recursively without ever following symlinks (fs.readdir's recursive mode
 * does follow them). Skips entries named in `skip` and stops after `limit` entries.
 */
export async function walk(
  root: string,
  skip: ReadonlySet<string>,
  limit = Number.POSITIVE_INFINITY,
): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  const queue = [''];
  while (queue.length && out.length < limit) {
    const rel = queue.shift() ?? '';
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push({ path, kind: 'link' });
      else if (e.isDirectory()) {
        out.push({ path, kind: 'dir' });
        queue.push(path);
      } else if (e.isFile()) out.push({ path, kind: 'file' });
      if (out.length >= limit) break;
    }
  }
  return out;
}
