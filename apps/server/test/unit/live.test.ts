import { describe, expect, it } from 'vitest';
import type { connections } from '../../src/db/schema.ts';
import { describeModel, parseOllamaPs } from '../../src/live.ts';

type Connection = typeof connections.$inferSelect;

const config = {
  GANTRIX_DEFAULT_MODEL: 'qwen3:8b',
  GANTRIX_DEFAULT_CONNECTION: undefined,
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
};
const connection = (over: Partial<Connection>): Connection => ({
  id: 'c1',
  name: 'claude',
  provider: 'anthropic',
  baseUrl: null,
  headers: {},
  request: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});
const agent = { model: null, modelBaseUrl: null, connectionId: null };

describe('live view', () => {
  it('reads the loaded models from /api/ps, biggest first, and survives junk', () => {
    const models = parseOllamaPs({
      models: [
        { name: 'small:1b', size: 1_000, size_vram: 0, expires_at: '2026-11-16T10:00:00Z' },
        {
          name: 'qwen3:8b',
          size: 6_000,
          size_vram: 6_000,
          context_length: 16384,
          details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
        },
        { size: 5 },
        null,
      ],
    });
    expect(models.map((m) => m.name)).toEqual(['qwen3:8b', 'small:1b']);
    expect(models[0]).toMatchObject({
      vramBytes: 6_000,
      parameterSize: '8.2B',
      quantization: 'Q4_K_M',
      contextLength: 16384,
      expiresAt: null,
    });
    expect(parseOllamaPs(null)).toEqual([]);
    expect(parseOllamaPs({ models: 'nope' })).toEqual([]);
  });

  it('says which model an agent runs on and whether it stays on this machine', () => {
    expect(describeModel(config, [], null)).toEqual({
      model: 'qwen3:8b',
      provider: 'ollama',
      connection: null,
      isLocal: true,
    });
    expect(describeModel(config, [], { ...agent, model: 'ollama/gemma3:4b' })).toMatchObject({
      model: 'gemma3:4b',
      provider: 'ollama',
      isLocal: true,
    });
    expect(
      describeModel(config, [], {
        ...agent,
        model: 'openai/gpt',
        modelBaseUrl: 'https://llm.example.com/v1',
      }),
    ).toMatchObject({ model: 'gpt', provider: 'openai', isLocal: false });

    const rows = [
      connection({}),
      connection({ id: 'c2', name: 'claude-code', provider: 'claude-code' }),
      connection({
        id: 'c3',
        name: 'lmstudio',
        provider: 'openai',
        baseUrl: 'http://localhost:1234/v1',
      }),
    ];
    expect(
      describeModel(config, rows, { ...agent, connectionId: 'c1', model: 'claude-sonnet-5-5' }),
    ).toEqual({
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      connection: 'claude',
      isLocal: false,
    });
    // Claude Code runs here, but the prompts go to Anthropic.
    expect(describeModel(config, rows, { ...agent, connectionId: 'c2' })).toMatchObject({
      model: 'default',
      provider: 'claude-code',
      isLocal: false,
    });
    expect(
      describeModel(config, rows, { ...agent, connectionId: 'c3', model: 'local-model' }),
    ).toMatchObject({ connection: 'lmstudio', isLocal: true });
    // A deleted connection falls back to what is saved on the agent, without throwing.
    expect(describeModel(config, rows, { ...agent, connectionId: 'gone' }).model).toBe('qwen3:8b');
  });

  it('uses GANTRIX_DEFAULT_CONNECTION for the planner, judges and plain agents', () => {
    const rows = [
      connection({ name: 'gateway', provider: 'openai', baseUrl: 'https://gw.example.com/v1' }),
    ];
    expect(describeModel({ ...config, GANTRIX_DEFAULT_CONNECTION: 'gateway' }, rows, null)).toEqual(
      { model: 'qwen3:8b', provider: 'openai', connection: 'gateway', isLocal: false },
    );
  });
});
