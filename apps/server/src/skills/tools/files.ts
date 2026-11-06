import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { asToolResult, resolveInWorkspace, ToolError, walk } from '../workspace.ts';

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const pathArg = z.string().describe('path relative to the task workspace');

export function fileTools(workspace: string) {
  const readFileTool = tool(
    ({ path }) =>
      asToolResult(async () => {
        const file = await resolveInWorkspace(workspace, path);
        const info = await stat(file);
        if (!info.isFile()) throw new ToolError(`"${path}" is not a file.`);
        if (info.size > MAX_READ_BYTES) {
          throw new ToolError(`"${path}" is ${info.size} bytes; the limit is ${MAX_READ_BYTES}.`);
        }
        const data = await readFile(file);
        if (data.subarray(0, 8192).includes(0)) throw new ToolError(`"${path}" is a binary file.`);
        return data.toString('utf8');
      }),
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the task workspace.',
      schema: z.object({ path: pathArg }),
    },
  );

  const writeFileTool = tool(
    ({ path, content }) =>
      asToolResult(async () => {
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_WRITE_BYTES) {
          throw new ToolError(`Content is ${bytes} bytes; the limit is ${MAX_WRITE_BYTES}.`);
        }
        const file = await resolveInWorkspace(workspace, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, 'utf8');
        return `Wrote ${bytes} bytes to ${path}.`;
      }),
    {
      name: 'write_file',
      description:
        'Create or overwrite a UTF-8 text file in the task workspace. Folders are created.',
      schema: z.object({ path: pathArg, content: z.string() }),
    },
  );

  const listFilesTool = tool(
    ({ path }) =>
      asToolResult(async () => {
        const dir = await resolveInWorkspace(workspace, path ?? '.');
        // Symlinks are shown (name@) but never followed; they may point outside the workspace.
        const entries = await walk(dir, SKIP_DIRS, MAX_LIST_ENTRIES + 1);
        const lines = entries
          .slice(0, MAX_LIST_ENTRIES)
          .map((e) =>
            e.kind === 'link' ? `${e.path}@` : e.kind === 'dir' ? `${e.path}/` : e.path,
          );
        if (entries.length > MAX_LIST_ENTRIES)
          lines.push(`[stopped at ${MAX_LIST_ENTRIES} entries]`);
        return lines.length ? lines.sort().join('\n') : '(empty)';
      }),
    {
      name: 'list_files',
      description: 'List files under a folder of the task workspace (recursive).',
      schema: z.object({ path: pathArg.optional() }),
    },
  );

  return [readFileTool, writeFileTool, listFilesTool];
}
