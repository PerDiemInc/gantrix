import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  snapshotProjectInput,
  snapshotStepInput,
  stepWorkspace,
} from '../../src/skills/step-workspace.ts';
import { createWorkspace, pathExists, resolveInWorkspace } from '../../src/skills/workspace.ts';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gantrix-isolation-'));
  roots.push(root);
  return createWorkspace(root, 'project', true);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('step workspaces', () => {
  it('separates concurrent steps and rejects traversal through the file tool boundary', async () => {
    const task = await fixture();
    const a = await stepWorkspace(task, 'a');
    const b = await stepWorkspace(task, 'b');
    await writeFile(join(a, 'result.txt'), 'a');
    await writeFile(join(b, 'result.txt'), 'b');
    expect(await readFile(join(a, 'result.txt'), 'utf8')).toBe('a');
    expect(await stepWorkspace(task, 'a')).toBe(a);
    await expect(resolveInWorkspace(a, '../b/result.txt')).rejects.toThrow(/outside/);
    await expect(stepWorkspace(task, '../escape')).rejects.toThrow(/Invalid/);
  });
  it('keeps a nested folder called inputs, and still skips the top-level one', async () => {
    const task = await fixture();
    const a = await stepWorkspace(task, 'a');
    const b = await stepWorkspace(task, 'b');
    await mkdir(join(a, 'src', 'components', 'inputs'), { recursive: true });
    await writeFile(join(a, 'src', 'components', 'inputs', 'TextField.tsx'), 'export {}');
    await mkdir(join(a, 'inputs'));
    await writeFile(join(a, 'inputs', 'copy.txt'), 'a copy of someone else');
    await snapshotStepInput(task, b, 'a');
    expect(
      await pathExists(join(b, 'inputs', 'a', 'src', 'components', 'inputs', 'TextField.tsx')),
    ).toBe(true);
    expect(await pathExists(join(b, 'inputs', 'a', 'inputs'))).toBe(false);
  });
  it('leaves new projects on the shared folder unless isolation is asked for', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gantrix-shared-'));
    roots.push(root);
    const task = await createWorkspace(root, 'shared');
    expect(await stepWorkspace(task, 'a')).toBe(task);
  });
  it('snapshots dependency artifacts without links, recursive inputs, or mutable sharing', async () => {
    const task = await fixture();
    const a = await stepWorkspace(task, 'a');
    const b = await stepWorkspace(task, 'b');
    await mkdir(join(a, 'inputs'));
    await writeFile(join(a, 'inputs', 'old.txt'), 'old');
    await writeFile(join(a, 'result.txt'), 'original');
    await symlink('/etc/passwd', join(a, 'escape'));
    await snapshotStepInput(task, b, 'a');
    expect(await readFile(join(b, 'inputs/a/result.txt'), 'utf8')).toBe('original');
    expect(await pathExists(join(b, 'inputs/a/escape'))).toBe(false);
    expect(await pathExists(join(b, 'inputs/a/inputs'))).toBe(false);
    await writeFile(join(a, 'result.txt'), 'changed');
    await snapshotStepInput(task, b, 'a');
    expect(await readFile(join(b, 'inputs/a/result.txt'), 'utf8')).toBe('original');
  });
  it('refreshes inputs on a new consumer attempt but leaves approval resumes unchanged', async () => {
    const task = await fixture();
    const a = await stepWorkspace(task, 'a');
    const b = await stepWorkspace(task, 'b');
    await writeFile(join(a, 'result.txt'), 'first');
    await snapshotStepInput(task, b, 'a', 1);
    await writeFile(join(a, 'result.txt'), 'corrected');
    await snapshotStepInput(task, b, 'a', 1);
    expect(await readFile(join(b, 'inputs/a/result.txt'), 'utf8')).toBe('first');
    await snapshotStepInput(task, b, 'a', 2);
    expect(await readFile(join(b, 'inputs/a/result.txt'), 'utf8')).toBe('corrected');
    await writeFile(join(b, 'inputs/a/result.txt'), 'local edit');
    await snapshotStepInput(task, b, 'a', 2);
    expect(await readFile(join(b, 'inputs/a/result.txt'), 'utf8')).toBe('local edit');
  });
  it('makes project inputs available without copying other steps or recursively copying itself', async () => {
    const task = await fixture();
    await writeFile(join(task, 'brief.txt'), 'user input');
    const a = await stepWorkspace(task, 'a');
    await snapshotProjectInput(task, a);
    expect(await readFile(join(a, 'inputs/project/brief.txt'), 'utf8')).toBe('user input');
    expect(await pathExists(join(a, 'inputs/project/steps'))).toBe(false);
    expect(await pathExists(join(a, 'inputs/project/.isolated-steps'))).toBe(false);
  });
  it('preserves the shared directory for legacy projects and paused checkpoints', async () => {
    const task = await fixture();
    await rm(join(task, '.isolated-steps'));
    expect(await stepWorkspace(task, 'a')).toBe(task);
    await snapshotStepInput(task, task, 'a');
  });
});
