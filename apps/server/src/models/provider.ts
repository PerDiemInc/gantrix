import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { UsageMetadata } from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';

export type ModelRole = 'planner' | 'worker' | 'judge';

/** From the agent row; null means use the defaults. */
export interface ModelSpec {
  model: string | null;
  baseUrl: string | null;
}

export interface ModelDefaults {
  defaultModel: string;
  ollamaBaseUrl: string;
}

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

/**
 * "qwen3:8b" or "ollama/qwen3:8b" → Ollama.
 * "openai/<model>" → any OpenAI-compatible server (vLLM, llama.cpp, LM Studio); needs the agent's base URL.
 */
export function createChatModel(
  spec: ModelSpec,
  role: ModelRole,
  defaults: ModelDefaults,
): BaseChatModel {
  const name = spec.model ?? defaults.defaultModel;
  if (name.startsWith('openai/')) {
    if (!spec.baseUrl) {
      throw new Error(`Model "${name}" needs a base URL for its OpenAI-compatible server.`);
    }
    return new ChatOpenAI({
      model: name.slice('openai/'.length),
      temperature: TEMPERATURE[role],
      maxTokens: MAX_OUTPUT_TOKENS[role],
      apiKey: 'not-needed', // local servers ignore it; keyed servers aren't supported in v1
      configuration: { baseURL: spec.baseUrl },
    });
  }
  return new ChatOllama({
    model: name.replace(/^ollama\//, ''),
    baseUrl: spec.baseUrl ?? defaults.ollamaBaseUrl,
    temperature: TEMPERATURE[role],
    think: THINK[role],
    numCtx: 16_384,
    numPredict: MAX_OUTPUT_TOKENS[role],
    keepAlive: '10m',
  });
}

// Structural type: AIMessage's generic usage_metadata resolves to `never` under TS 7.
export const tokensUsed = (message: { usage_metadata?: UsageMetadata | undefined }): number =>
  message.usage_metadata?.total_tokens ?? 0;
