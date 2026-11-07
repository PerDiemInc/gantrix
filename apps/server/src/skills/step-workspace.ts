import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathExists, resolveInWorkspace } from './workspace.ts';

/** Workspace separation prevents accidental file collisions, not arbitrary-code execution. */
export const ISOLATED_WORKSPACE_MARKER = '.isolated-steps';
const SNAPSHOT_ATTEMPT = '.gantrix-snapshot-attempt';
const SKIP = new Set([
  'inputs',
  'node_modules',
  '.git',
  ISOLATED_WORKSPACE_MARKER,
  SNAPSHOT_ATTEMPT,
]);

export async function stepWorkspace(taskWorkspace: string, stepId: string): Promise<string> {
  // Old projects keep their shared layout so paused checkpoints resume in the same cwd.
  if (!(await pathExists(join(taskWorkspace, ISOLATED_WORKSPACE_MARKER)))) return taskWorkspace;
  if (!/^[a-zA-Z0-9_-]+$/.test(stepId)) throw new Error('Invalid step workspace ID');
  const dir = await resolveInWorkspace(taskWorkspace, `steps/${stepId}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Copy a completed dependency once. No links to another agent's mutable files. */
export async function snapshotStepInput(
  taskWorkspace: string,
  destination: string,
  sourceId: string,
  consumerAttempt = 1,
): Promise<void> {
  if (destination === taskWorkspace) return;
  const source = await stepWorkspace(taskWorkspace, sourceId);
  if (source === destination) return;
  return snapshot(source, destination, sourceId, consumerAttempt);
}

/** Root-level user inputs remain available without mixing all agents' mutable outputs. */
export async function snapshotProjectInput(
  taskWorkspace: string,
  destination: string,
  consumerAttempt = 1,
): Promise<void> {
  if (destination === taskWorkspace) return;
  return snapshot(taskWorkspace, destination, 'project', consumerAttempt, true);
}

async function snapshot(
  source: string,
  destination: string,
  sourceId: string,
  consumerAttempt: number,
  project = false,
): Promise<void> {
  const inputs = await resolveInWorkspace(destination, 'inputs');
  await mkdir(inputs, { recursive: true });
  const target = await resolveInWorkspace(destination, `inputs/${sourceId}`);
  const marker = await resolveInWorkspace(destination, `inputs/${sourceId}/${SNAPSHOT_ATTEMPT}`);
  if ((await pathExists(marker)) && (await readFile(marker, 'utf8')) === String(consumerAttempt))
    return;
  // Refresh only on a new step attempt. Approval/crash resumes keep their exact inputs.
  const temp = await mkdtemp(join(inputs, '.snapshot-'));
  try {
    for (const entry of await readdir(source)) {
      if (SKIP.has(entry) || (project && entry === 'steps')) continue;
      await cp(join(source, entry), join(temp, entry), {
        recursive: true,
        filter: async (path) => {
          if (SKIP.has(basename(path))) return false;
          const info = await lstat(path);
          return info.isFile() || info.isDirectory(); // never follow symlinks or special files
        },
      });
    }
    await writeFile(join(temp, SNAPSHOT_ATTEMPT), String(consumerAttempt));
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
