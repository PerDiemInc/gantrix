import { execFile } from 'node:child_process';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/** File tools only: Gantrix can't see or approve what Claude Code does inside one run. */
export const CLAUDE_CODE_SAFE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
/** God mode adds the shell and the web. */
export const CLAUDE_CODE_GOD_MODE_TOOLS = [
  ...CLAUDE_CODE_SAFE_TOOLS,
  'Bash',
  'WebFetch',
  'WebSearch',
];
// Never passed to the child: they'd let a prompt reach the Gantrix API or its data.
export const HIDDEN_ENV = [
  'GANTRIX_TOKEN',
  'DATABASE_URL',
  'REDIS_URL',
  'POSTGRES_PASSWORD',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
];

export interface ClaudeCodeOptions extends BaseChatModelParams {
  /** e.g. "sonnet" or a full model id; omitted → Claude Code's own default. */
  model?: string | null;
  /** The task workspace; Claude Code runs there and can't leave it without god mode. */
  workspace: string;
  approveAll: boolean;
  /** Defaults to CLAUDE_CODE_BIN or "claude" on PATH. */
  bin?: string;
  timeoutMs?: number;
}

interface ClaudeResult {
  type: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** `--output-format json` prints the run's events as an array (older versions: one object). */
export function parseResult(stdout: string): ClaudeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Claude Code printed something that isn't JSON: ${stdout.slice(0, 500)}`);
  }
  const events = (Array.isArray(parsed) ? parsed : [parsed]) as ClaudeResult[];
  const result = events.findLast((e) => e?.type === 'result');
  if (!result) throw new Error('Claude Code finished without a result.');
  return result;
}

const textOf = (m: BaseMessage) =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => (typeof p === 'object' && 'text' in p ? String(p.text) : '')).join('');

/** The step's messages as one prompt: system text separately, the rest as a transcript. */
export function toPrompt(messages: readonly BaseMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((m) => m.getType() === 'system')
    .map(textOf)
    .join('\n\n');
  const rest = messages.filter((m) => m.getType() !== 'system');
  if (rest.length === 1) return { system, prompt: textOf(rest[0] as BaseMessage) };
  const label: Record<string, string> = { human: 'Task', ai: 'Your earlier reply', tool: 'Tool' };
  return {
    system,
    prompt: rest.map((m) => `## ${label[m.getType()] ?? m.getType()}\n${textOf(m)}`).join('\n\n'),
  };
}

export function claudeArgs(o: {
  model?: string | null | undefined;
  approveAll: boolean;
  system: string;
  prompt: string;
}) {
  const tools = o.approveAll ? CLAUDE_CODE_GOD_MODE_TOOLS : CLAUDE_CODE_SAFE_TOOLS;
  const list = tools.join(',');
  return [
    '-p',
    o.prompt,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--strict-mcp-config', // no MCP servers from the user's config
    // Only these tools exist in the session, they run without asking, and anything else is
    // refused rather than left to the user's own permission mode (which may be "auto").
    '--tools',
    list,
    '--allowedTools',
    list,
    '--permission-mode',
    'dontAsk',
    ...(o.model ? ['--model', o.model] : []),
    ...(o.system ? ['--append-system-prompt', o.system] : []),
  ];
}

/**
 * Local Claude Code as an agent's model: every turn is one `claude -p` run in the task's
 * workspace. Claude Code does its own tool calls there; Gantrix sees the final reply.
 */
export class ClaudeCodeChatModel extends BaseChatModel {
  readonly #o: ClaudeCodeOptions;

  constructor(o: ClaudeCodeOptions) {
    super(o);
    this.#o = o;
  }

  _llmType() {
    return 'claude-code';
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _run?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { system, prompt } = toPrompt(messages);
    const env = { ...process.env };
    for (const k of HIDDEN_ENV) delete env[k];
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.#o.bin ?? process.env.CLAUDE_CODE_BIN ?? 'claude',
        claudeArgs({ model: this.#o.model, approveAll: this.#o.approveAll, system, prompt }),
        {
          cwd: this.#o.workspace,
          env,
          timeout: this.#o.timeoutMs ?? 30 * 60_000,
          maxBuffer: 32 * 1024 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (error, out, err) => {
          // claude exits non-zero on its own errors but still prints the JSON result.
          if (error && !out.trim()) {
            const why =
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'the claude command was not found. Install Claude Code or set CLAUDE_CODE_BIN.'
                : `${error.message}${err ? `\n${err.slice(0, 2000)}` : ''}`;
            reject(new Error(`Claude Code failed: ${why}`));
          } else resolve(out);
        },
      );
    });
    const r = parseResult(stdout);
    if (r.is_error) throw new Error(`Claude Code: ${r.result ?? 'unknown error'}`);
    const u = r.usage ?? {};
    // New tokens only. Each run re-reads tens of thousands of cached tokens, which would use
    // up the project's token budget without any new work.
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const output = u.output_tokens ?? 0;
    // Through the constructor, so the usage survives LangGraph's checkpoint (which saves the
    // constructor fields). The cast: AIMessage's generic usage type resolves to never under TS 7.
    const fields = {
      content: r.result ?? '',
      usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
      response_metadata: { num_turns: r.num_turns ?? 0, total_cost_usd: r.total_cost_usd ?? 0 },
    };
    const message = new AIMessage(fields as unknown as ConstructorParameters<typeof AIMessage>[0]);
    return { generations: [{ text: r.result ?? '', message }] };
  }
}
