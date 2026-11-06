import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { asToolResult, resolveInWorkspace, ToolError } from '../workspace.ts';

export interface DeployOptions {
  /** Where deployed sites live, e.g. ~/.gantrix/sites. */
  sitesDir: string;
  /** The preview server's base URL, e.g. http://127.0.0.1:4702. */
  previewUrl: string;
}

/**
 * Publishes a folder of the task workspace as a static site on the local preview server.
 * The site gets its own name under the sites folder; publishing again replaces it.
 */
export function deploySiteTool(workspace: string, o: DeployOptions) {
  return tool(
    async ({ folder, name }) =>
      asToolResult(async () => {
        const source = await resolveInWorkspace(workspace, folder);
        const info = await stat(source).catch(() => null);
        if (!info?.isDirectory())
          throw new ToolError(`"${folder}" isn't a folder in the workspace.`);
        if (!(await stat(join(source, 'index.html')).catch(() => null))) {
          throw new ToolError(`"${folder}" has no index.html; write one first.`);
        }
        const target = join(o.sitesDir, name);
        await mkdir(o.sitesDir, { recursive: true });
        await rm(target, { recursive: true, force: true });
        // dereference: false keeps symlinks as links, and the preview server never follows them.
        await cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
        return `Deployed ${folder}/ to ${o.previewUrl}/${name}/`;
      }),
    {
      name: 'deploy_site',
      description:
        'Publish a folder of the workspace (with an index.html) as a website on the local preview server, and get its URL. Publishing the same name again replaces the site.',
      schema: z.object({
        folder: z.string().default('site').describe('workspace folder holding index.html'),
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes')
          .describe('the site name in its URL, e.g. bakery-site'),
      }),
    },
  );
}
