import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { HIDDEN_ENV, toPrompt } from './claude-code.ts';

export interface CodexOptions extends BaseChatModelParams {
  /** e.g. "gpt-5.6-sol"; omitted (or "default") → Codex's own default. */
  model?: string | null;
  /** The step's folder; Codex can only write here. */
  workspace: string;
  approveAll: boolean;
  /** Defaults to CODEX_BIN or "codex" on PATH. */
  bin?: string;
  timeoutMs?: number;
}

export interface CodexRun {
  text: string;
  /** New input tokens: the cached ones are the same context read again. */
  input: number;
  output: number;
  error: string | null;
}

/** `codex exec --json` prints one JSON event per line. The last agent message is the reply. */
export function parseEvents(stdout: string): CodexRun {
  const run: CodexRun = { text: '', input: 0, output: 0, error: null };
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let e: {
      type?: string;
      message?: string;
      error?: { message?: string };
      item?: { type?: string; text?: string };
      usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
      run.text = e.item.text;
    } else if (e.type === 'turn.completed' && e.usage) {
      run.input += Math.max(0, (e.usage.input_tokens ?? 0) - (e.usage.cached_input_tokens ?? 0));
      run.output += e.usage.output_tokens ?? 0;
    } else if (e.type === 'turn.failed') {
      run.error = e.error?.message ?? 'the turn failed';
    } else if (e.type === 'error') {
      run.error = e.message ?? 'unknown error';
    }
  }
  return run;
}

export function codexArgs(o: {
  model?: string | null | undefined;
  approveAll: boolean;
  workspace: string;
}) {
  return [
    'exec',
    '--json',
    '--ephemeral', // no session files
    '--skip-git-repo-check', // project folders aren't git repositories
    '--ignore-user-config', // no MCP servers or settings from the user's config; login still works
    '--ignore-rules',
    '--color',
    'never',
    // Codex's OS sandbox: it can write only in this folder, whatever the project's setting.
    '--sandbox',
    'workspace-write',
    '-C',
    o.workspace,
    // Asking-first projects stay offline; otherwise it can use the network, like Claude Code.
    ...(o.approveAll ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(o.model && o.model !== 'default' ? ['-m', o.model] : []),
    '-', // the prompt comes on stdin, so long steps can't hit the argument limit
  ];
}

/** The models Codex offers this account, from the list it keeps; empty if it hasn't run yet. */
export async function codexModels(): Promise<string[]> {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try {
    const cache = JSON.parse(await readFile(join(home, 'models_cache.json'), 'utf8')) as {
      models?: { slug?: string; visibility?: string }[];
    };
    return (cache.models ?? []).flatMap((m) => (m.slug && m.visibility === 'list' ? [m.slug] : []));
  } catch {
    return [];
  }
}

/**
 * Local ChatGPT as an agent's model: every turn is one `codex exec` run in the step's folder,
 * using the ChatGPT login on this machine. Codex does its own tool calls; Gantrix sees the reply.
 */
export class CodexChatModel extends BaseChatModel {
  readonly #o: CodexOptions;

  constructor(o: CodexOptions) {
    super(o);
    this.#o = o;
  }

  _llmType() {
    return 'codex';
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
      const child = execFile(
        this.#o.bin ?? process.env.CODEX_BIN ?? 'codex',
        codexArgs({
          model: this.#o.model,
          approveAll: this.#o.approveAll,
          workspace: this.#o.workspace,
        }),
        {
          cwd: this.#o.workspace,
          env,
          timeout: this.#o.timeoutMs ?? 30 * 60_000,
          maxBuffer: 64 * 1024 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (error, out, err) => {
          // codex exits non-zero on its own errors but still prints the events.
          if (error && !out.trim()) {
            const why =
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'the codex command was not found. Install the Codex CLI or set CODEX_BIN.'
                : `${error.message}${err ? `\n${err.slice(0, 2000)}` : ''}`;
            reject(new Error(`ChatGPT (Codex) failed: ${why}`));
          } else resolve(out);
        },
      );
      child.stdin?.on('error', () => {}); // it may exit before reading everything
      child.stdin?.end(system ? `${system}\n\n${prompt}` : prompt);
    });
    const r = parseEvents(stdout);
    if (r.error) throw new Error(`ChatGPT (Codex): ${r.error}`);
    if (!r.text) throw new Error('ChatGPT (Codex) finished without a reply.');
    // Through the constructor, so the usage survives LangGraph's checkpoint (see claude-code.ts).
    const fields = {
      content: r.text,
      usage_metadata: {
        input_tokens: r.input,
        output_tokens: r.output,
        total_tokens: r.input + r.output,
      },
    };
    const message = new AIMessage(fields as unknown as ConstructorParameters<typeof AIMessage>[0]);
    return { generations: [{ text: r.text, message }] };
  }
}
