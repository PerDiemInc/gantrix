import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MediaError } from './types.ts';

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Resolves a workspace-relative path, following symlinks, or throws. The server's cwd is the task workspace. */
export async function inWorkspace(input: string, root = process.cwd()): Promise<string> {
  if (isAbsolute(input))
    throw new MediaError(`Use a path relative to the task workspace, not "${input}".`);
  const base = await realpath(root);
  const target = resolve(base, input);
  let existing = target;
  while (!(await exists(existing))) existing = dirname(existing);
  const real = join(await realpath(existing), relative(existing, target));
  if (real !== base && !real.startsWith(base + sep)) {
    throw new MediaError(`Path "${input}" is outside the task workspace.`);
  }
  return real;
}

/** An output path: inside the workspace, with the right extension, folders created. */
export async function outputPath(input: string, ext: '.png' | '.mp4'): Promise<string> {
  if (!input.toLowerCase().endsWith(ext)) throw new MediaError(`"${input}" must end in ${ext}.`);
  const path = await inWorkspace(input);
  await mkdir(dirname(path), { recursive: true });
  return path;
}

/** An existing input image inside the workspace. */
export async function inputImage(input: string): Promise<string> {
  const path = await inWorkspace(input);
  if (!(await exists(path)))
    throw new MediaError(`"${input}" doesn't exist in the task workspace.`);
  if (!/\.(png|jpe?g|webp)$/i.test(path))
    throw new MediaError(`"${input}" isn't a PNG, JPEG or WebP image.`);
  return path;
}
