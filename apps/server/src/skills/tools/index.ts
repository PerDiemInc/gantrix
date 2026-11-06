import type { StructuredToolInterface } from '@langchain/core/tools';
import { ASK_USER, askUserTool } from './ask.ts';
import { type DeployOptions, deploySiteTool } from './deploy.ts';
import { fileTools } from './files.ts';
import { shellTool } from './shell.ts';
import { webFetchTool } from './web.ts';

export const BUILTIN_TOOL_NAMES: readonly string[] = [
  'read_file',
  'write_file',
  'list_files',
  'web_fetch',
  'shell',
  ASK_USER,
  'deploy_site',
];

/** The built-in tools named by an agent's skills, bound to one task workspace. */
export function builtinTools(
  names: ReadonlySet<string>,
  workspace: string,
  deploy?: DeployOptions,
): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [
    ...fileTools(workspace),
    webFetchTool(),
    shellTool(workspace),
    askUserTool(),
    ...(deploy ? [deploySiteTool(workspace, deploy)] : []),
  ];
  return all.filter((t) => names.has(t.name));
}
