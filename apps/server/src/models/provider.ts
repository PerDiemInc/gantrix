import type { ModelProvider } from '@gantrix/shared';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { UsageMetadata } from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';

export type ModelRole = 'planner' | 'worker' | 'judge';

/** From the agent row and its connection; null means use the defaults. */
export interface ModelSpec {
  model: string | null;
  baseUrl: string | null;
  /** Set when the agent (or GANTRIX_DEFAULT_CONNECTION) uses a saved connection. */
  provider?: ModelProvider;
  /** Already resolved: "env:NAME" values are replaced by the worker's environment. */
  headers?: Record<string, string>;
}

export interface ModelDefaults {
  defaultModel: string;
  ollamaBaseUrl: string;
}

export const DEFAULT_URLS: Record<Exclude<ModelProvider, 'ollama'>, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

// The judge thinks first: in the 2026-11-05 spike qwen3:8b judged 5/5 with thinking vs 4/5 without.
const THINK: Record<ModelRole, boolean> = { planner: false, worker: false, judge: true };
const TEMPERATURE: Record<ModelRole, number> = { planner: 0, worker: 0.2, judge: 0 };
// Output cap per call, thinking included. Without one, a small model that loops (seen
// 2026-11-06: a qwen3:8b judge past 8,700 tokens) holds a model slot until the context fills
// and every other task waits behind it.
export const MAX_OUTPUT_TOKENS: Record<ModelRole, number> = {
  planner: 4_096,
  worker: 8_192,
  judge: 4_096,
};

/** Auth headers become each SDK's own key settings; the rest are sent as they are. */
export function splitAuth(headers: Record<string, string> = {}) {
  let bearer: string | undefined;
  let apiKey: string | undefined;
  const rest: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const m = /^bearer\s+(.+)$/i.exec(value.trim());
    if (lower === 'authorization' && m?.[1]) bearer = m[1];
    else if (lower === 'x-api-key') apiKey = value;
    else rest[name] = value;
  }
  return { bearer, apiKey, rest };
}

/**
 * With a provider (from a saved connection): that provider, at its URL or the default one.
 * Without one, the model name decides: "qwen3:8b" or "ollama/qwen3:8b" → Ollama;
 * "openai/<model>" → an OpenAI-compatible server at the agent's base URL.
 */
export function createChatModel(
  spec: ModelSpec,
  role: ModelRole,
  defaults: ModelDefaults,
  /** LangChain retries 6 times by default; a connection test wants the first error. */
  maxRetries?: number,
): BaseChatModel {
  const retries = maxRetries === undefined ? {} : { maxRetries };
  const name = spec.model ?? defaults.defaultModel;
  const provider: ModelProvider =
    spec.provider ?? (name.startsWith('openai/') ? 'openai' : 'ollama');
  const model = spec.provider ? name : name.replace(/^(openai|ollama)\//, '');
  const { bearer, apiKey, rest } = splitAuth(spec.headers);

  if (provider === 'openai') {
    if (!spec.provider && !spec.baseUrl) {
      throw new Error(`Model "${name}" needs a base URL for its OpenAI-compatible server.`);
    }
    return new ChatOpenAI({
      ...retries,
      model,
      temperature: TEMPERATURE[role],
      maxTokens: MAX_OUTPUT_TOKENS[role],
      // Local servers ignore the key; the cloud API falls back to OPENAI_API_KEY.
      apiKey: bearer ?? apiKey ?? process.env.OPENAI_API_KEY ?? 'not-needed',
      configuration: {
        baseURL: spec.baseUrl ?? DEFAULT_URLS.openai,
        ...(Object.keys(rest).length ? { defaultHeaders: rest } : {}),
      },
    });
  }
  if (provider === 'anthropic') {
    return new ChatAnthropic({
      ...retries,
      model,
      temperature: TEMPERATURE[role],
      maxTokens: MAX_OUTPUT_TOKENS[role],
      anthropicApiUrl: spec.baseUrl ?? DEFAULT_URLS.anthropic,
      // Without a header the SDK reads ANTHROPIC_API_KEY from the worker's environment.
      ...(apiKey ? { apiKey } : {}),
      clientOptions: {
        ...(bearer ? { authToken: bearer } : {}),
        ...(Object.keys(rest).length ? { defaultHeaders: rest } : {}),
      },
    });
  }
  return new ChatOllama({
    ...retries,
    model,
    baseUrl: spec.baseUrl ?? defaults.ollamaBaseUrl,
    temperature: TEMPERATURE[role],
    think: THINK[role],
    numCtx: 16_384,
    numPredict: MAX_OUTPUT_TOKENS[role],
    keepAlive: '10m',
    ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
  });
}

// Structural type: AIMessage's generic usage_metadata resolves to `never` under TS 7.
export const tokensUsed = (message: { usage_metadata?: UsageMetadata | undefined }): number =>
  message.usage_metadata?.total_tokens ?? 0;
