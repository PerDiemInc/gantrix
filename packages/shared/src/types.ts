export interface Budget {
  maxStepAttempts: number;
  maxReplans: number;
  maxTokens: number;
  maxMinutes: number;
  /**
   * Never stop on the token, time or replan limits: the project runs until its goal is met or
   * the user stops it. The limits above stay as what the meters show.
   */
  keepGoing?: boolean;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_VARS = 32;
export const MAX_ENV_VALUE_CHARS = 4_000;

/**
 * "NAME=value" lines, as typed into the project form, into variables for shell commands.
 * Blank lines and lines starting with # are skipped; "export " and matching quotes are dropped.
 */
export function parseEnvText(text: string): { vars: Record<string, string>; errors: string[] } {
  const vars: Record<string, string> = {};
  const errors: string[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const name = eq < 0 ? line : line.slice(0, eq).trim();
    if (eq < 0 || !ENV_NAME.test(name)) {
      errors.push(`Line ${i + 1}: write NAME=value (letters, digits and _ in the name).`);
      continue;
    }
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (value.length > MAX_ENV_VALUE_CHARS) {
      errors.push(`Line ${i + 1}: the value of ${name} is too long.`);
      continue;
    }
    vars[name] = value;
  }
  if (Object.keys(vars).length > MAX_ENV_VARS) errors.push(`At most ${MAX_ENV_VARS} variables.`);
  return { vars, errors };
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

/** The model used until one is chosen on the Agents page: a small, capable local model. */
export const DEFAULT_MODEL = 'qwen3:8b';

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

/** Coding agents that run on this machine with the user's own login. */
export const LOCAL_AGENTS = {
  claude: { label: 'Claude', provider: 'claude-code', connectionName: 'claude-local' },
  chatgpt: { label: 'ChatGPT', provider: 'codex', connectionName: 'chatgpt-local' },
} as const;
export type LocalAgentId = keyof typeof LOCAL_AGENTS;

export interface LocalAgentDto {
  id: LocalAgentId;
  label: string;
  provider: string;
  connectionName: string;
  installed: boolean;
  version: string | null;
}
