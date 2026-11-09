import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'inputs']);
const MAX_ENTRIES = 5_000;
export type FileSnapshot = Map<string, string>;

/** Every file under a folder with its size and time, to see later what a run changed. */
export async function snapshotFiles(root: string): Promise<FileSnapshot> {
  const files: FileSnapshot = new Map();
  const queue = [''];
  while (queue.length && files.size < MAX_ENTRIES) {
    const dir = queue.shift() ?? '';
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) queue.push(path);
      } else if (e.isFile()) {
        const info = await stat(join(root, path)).catch(() => null);
        if (info) files.set(path, `${info.size}:${info.mtimeMs}`);
      }
    }
  }
  return files;
}

/** Files that are new or different since the snapshot. */
export async function changedFiles(root: string, before: FileSnapshot): Promise<string[]> {
  const after = await snapshotFiles(root);
  return [...after].filter(([path, sig]) => before.get(path) !== sig).map(([path]) => path);
}
