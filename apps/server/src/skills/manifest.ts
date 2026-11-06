import type { McpServerConfig, SkillManifest } from '@gantrix/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { BUILTIN_TOOL_NAMES } from './tools/index.ts';

const MAX_INSTRUCTIONS_CHARS = 20_000;

// Unknown keys (e.g. Claude's "license" or "allowed-tools") are ignored.
const FrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'name must be lowercase letters, digits and dashes'),
  description: z.string().min(1),
  version: z.coerce
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'version must look like 1.2.3')
    .default('0.0.0'),
  tools: z.array(z.string()).default([]),
  'mcp-servers': z
    .record(
      z
        .string()
        .regex(/^[a-z0-9-]{1,32}$/, 'MCP server names are lowercase letters, digits and dashes'),
      z.object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).optional(),
        'timeout-seconds': z.number().int().min(1).max(7200).optional(),
      }),
    )
    .default({}),
  'auto-approve': z.array(z.string()).default([]),
});

export interface ParsedSkill {
  name: string;
  version: string;
  description: string;
  manifest: SkillManifest;
  instructions: string;
}

export function parseSkillFile(text: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter between --- lines.');
  const parsed = FrontmatterSchema.safeParse(parseYaml(match[1] ?? '') ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid SKILL.md frontmatter:\n${z.prettifyError(parsed.error)}`);
  }
  const fm = parsed.data;
  const unknown = fm.tools.filter((t) => !BUILTIN_TOOL_NAMES.includes(t));
  if (unknown.length) {
    throw new Error(
      `Unknown built-in tools: ${unknown.join(', ')}. Valid: ${BUILTIN_TOOL_NAMES.join(', ')}.`,
    );
  }
  const instructions = (match[2] ?? '').trim();
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error(
      `SKILL.md instructions are ${instructions.length} characters; the limit is ${MAX_INSTRUCTIONS_CHARS}.`,
    );
  }
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, s] of Object.entries(fm['mcp-servers'])) {
    mcpServers[name] = {
      command: s.command,
      args: s.args,
      ...(s.env ? { env: s.env } : {}),
      ...(s['timeout-seconds'] ? { timeoutSeconds: s['timeout-seconds'] } : {}),
    };
  }
  return {
    name: fm.name,
    version: fm.version,
    description: fm.description,
    instructions,
    manifest: { tools: fm.tools, mcpServers, autoApprove: fm['auto-approve'] },
  };
}
