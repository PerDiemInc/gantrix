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

export const HTTP_METHODS = ['POST', 'PUT', 'PATCH', 'GET'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * How to call a custom HTTP model server. Templates use {{prompt}}, {{system}}, {{messages}}
 * and {{model}}; values are escaped for where they appear.
 */
export interface HttpRequestConfig {
  method: HttpMethod;
  /** Sent as Content-Type; the body template is escaped to match. */
  contentType: string;
  /** The body; ignored for GET (put {{prompt}} in the URL instead). */
  bodyTemplate: string;
  /** Where the reply text is in a JSON response, e.g. "choices.0.message.content"; empty → auto. */
  replyPath: string;
}

export const DEFAULT_HTTP_REQUEST: HttpRequestConfig = {
  method: 'POST',
  contentType: 'application/json',
  bodyTemplate: '{"model": "{{model}}", "prompt": "{{prompt}}"}',
  replyPath: '',
};

/** A model choice for one agent in one project: a saved connection (or null = Ollama) and model. */
export interface AgentModelChoice {
  connectionId: string | null;
  model: string | null;
}
