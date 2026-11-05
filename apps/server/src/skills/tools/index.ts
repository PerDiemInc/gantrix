import type { StructuredToolInterface } from '@langchain/core/tools';
import { fileTools } from './files.ts';
import { shellTool } from './shell.ts';
import { webFetchTool } from './web.ts';

export const BUILTIN_TOOL_NAMES: readonly string[] = [
  'read_file',
  'write_file',
  'list_files',
  'web_fetch',
  'shell',
];

/** The built-in tools named by an agent's skills, bound to one task workspace. */
export function builtinTools(
  names: ReadonlySet<string>,
  workspace: string,
): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [
    ...fileTools(workspace),
    webFetchTool(),
    shellTool(workspace),
  ];
  return all.filter((t) => names.has(t.name));
}
