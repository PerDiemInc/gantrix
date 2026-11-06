export interface Budget {
  maxStepAttempts: number;
  maxReplans: number;
  maxTokens: number;
  maxMinutes: number;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Longest a single tool call may take. Default 120. */
  timeoutSeconds?: number;
}

/** Parsed from a skill's SKILL.md frontmatter. The skill's code stays in its folder on disk. */
export interface SkillManifest {
  /** Built-in tools the skill may use, e.g. "read_file". */
  tools: string[];
  /** MCP servers the skill starts, keyed by server name. */
  mcpServers: Record<string, McpServerConfig>;
  /** Tool names that run without asking for approval. */
  autoApprove: string[];
}
