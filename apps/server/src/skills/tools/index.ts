import type { StructuredToolInterface } from '@langchain/core/tools';
import { ASK_USER, askUserTool } from './ask.ts';
import { DELEGATE } from './delegate.ts';
import { type DeployOptions, deploySiteTool } from './deploy.ts';
import { fileTools } from './files.ts';
import { type ShellOptions, shellTool } from './shell.ts';
import { type CheckUrl, type SiteCheck, VERIFY_URL, verifyUrlTool } from './verify.ts';
import { webFetchTool } from './web.ts';

export const BUILTIN_TOOL_NAMES: readonly string[] = [
  'read_file',
  'write_file',
  'list_files',
  'web_fetch',
  'shell',
  ASK_USER,
  'deploy_site',
  VERIFY_URL,
  // Built per step (it lists the other agents), not here: see delegateTool.
  DELEGATE,
];

/** The built-in tools named by an agent's skills, bound to one task workspace. */
export function builtinTools(
  names: ReadonlySet<string>,
  workspace: string,
  deploy?: DeployOptions,
  extra: {
    shell?: ShellOptions;
    /** How verify_url fetches, and where its result is recorded. */
    verify?: { check: CheckUrl; onChecked: (c: SiteCheck) => Promise<void> };
  } = {},
): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [
    ...fileTools(workspace),
    webFetchTool(),
    shellTool(workspace, extra.shell),
    askUserTool(),
    ...(deploy ? [deploySiteTool(workspace, deploy)] : []),
    ...(extra.verify ? [verifyUrlTool(extra.verify.check, extra.verify.onChecked)] : []),
  ];
  return all.filter((t) => names.has(t.name));
}
