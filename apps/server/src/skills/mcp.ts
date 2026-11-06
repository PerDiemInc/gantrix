import type { McpServerConfig } from '@gantrix/shared';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

const DEFAULT_TOOL_TIMEOUT_S = 120;

export interface McpSession {
  tools: StructuredToolInterface[];
  close(): Promise<void>;
}

/** One MCP session per step: started when the step begins, closed when it ends. */
export async function openMcpTools(
  servers: Record<string, McpServerConfig>,
  workspace: string,
): Promise<McpSession> {
  if (Object.keys(servers).length === 0) return { tools: [], close: async () => {} };
  const client = new MultiServerMCPClient({
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, s]) => [
        name,
        {
          transport: 'stdio' as const,
          command: s.command,
          args: s.args,
          cwd: workspace,
          // Only what the skill declares, never the Gantrix server's own secrets.
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...s.env },
          defaultToolTimeout: (s.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_S) * 1000,
        },
      ]),
    ),
    prefixToolNameWithServerName: true,
    onConnectionError: 'throw',
    defaultToolTimeout: DEFAULT_TOOL_TIMEOUT_S * 1000,
  });
  try {
    return { tools: await client.getTools(), close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}
