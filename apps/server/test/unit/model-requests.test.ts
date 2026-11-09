import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { budgetBreach } from '../../src/budget.ts';
import { cliEnv } from '../../src/models/cli-env.ts';
import { createChatModel, structuredMethod } from '../../src/models/provider.ts';

const defaults = { defaultModel: 'qwen3:8b', ollamaBaseUrl: 'http://127.0.0.1:1' };

describe('Anthropic connections', () => {
  it('sends no temperature or forced tool choice, which current Claude models reject', async () => {
    let body: Record<string, unknown> = {};
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        body = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: '{"answer":"yes"}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const chat = createChatModel(
        {
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          headers: { 'x-api-key': 'k' },
        },
        'judge',
        defaults,
        0,
      );
      const structured = chat.withStructuredOutput(z.object({ answer: z.string() }), {
        name: 'verdict',
        ...structuredMethod(chat),
      });
      expect(await structured.invoke('Well?')).toEqual({ answer: 'yes' });
      expect(body.temperature).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
    } finally {
      server.close();
    }
  });
  it('leaves other providers on their own structured output', () => {
    expect(structuredMethod(createChatModel({ model: 'x' }, 'judge', defaults))).toEqual({});
  });
});

describe('the environment of a local agent CLI', () => {
  it('keeps what it needs and drops every secret, including ones Gantrix has never heard of', () => {
    const env = cliEnv({
      PATH: '/bin',
      HOME: '/h',
      LC_ALL: 'C',
      CODEX_HOME: '/c',
      GANTRIX_TOKEN: 'x',
      DATABASE_URL: 'x',
      SLACK_BOT_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      TOKENFLOW_API_KEY: 'x',
    });
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LC_ALL', 'PATH']);
  });
});

describe('the time limit', () => {
  const budget = { maxMinutes: 180, maxTokens: 1000, maxReplans: 5, maxStepAttempts: 3 };
  const now = new Date('2026-01-01T03:20:00Z');
  const startedAt = new Date('2026-01-01T00:00:00Z'); // 200 minutes ago
  it('stops a project that used it up', () => {
    expect(budgetBreach({ tokensUsed: 0, replans: 0, startedAt }, budget, now)?.limit).toBe('time');
  });
  it('does not count time the project sat stopped', () => {
    const pausedMs = 30 * 60_000;
    expect(
      budgetBreach({ tokensUsed: 0, replans: 0, startedAt, pausedMs }, budget, now),
    ).toBeNull();
  });
});
