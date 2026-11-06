import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { describe, expect, it } from 'vitest';
import { createChatModel, MAX_OUTPUT_TOKENS } from '../../src/models/provider.ts';

const defaults = { defaultModel: 'qwen3:8b', ollamaBaseUrl: 'http://127.0.0.1:11434' };

describe('createChatModel', () => {
  it('caps output per role so a looping model frees its slot', () => {
    const judge = createChatModel({ model: null, baseUrl: null }, 'judge', defaults);
    expect(judge).toBeInstanceOf(ChatOllama);
    expect((judge as ChatOllama).numPredict).toBe(MAX_OUTPUT_TOKENS.judge);
    const worker = createChatModel(
      { model: 'openai/llama', baseUrl: 'http://127.0.0.1:8000/v1' },
      'worker',
      defaults,
    );
    expect(worker).toBeInstanceOf(ChatOpenAI);
    expect((worker as ChatOpenAI).maxTokens).toBe(MAX_OUTPUT_TOKENS.worker);
  });
});
