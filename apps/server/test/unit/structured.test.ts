import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJson, structured } from '../../src/models/structured.ts';

const S = z.object({ passed: z.boolean(), reason: z.string() });

/** A model whose structured output is switched off, as Inkling 2 Mini's is on Ollama. */
function noStructured(reply: string) {
  const plain: string[] = [];
  let tried = 0;
  const model = {
    withStructuredOutput: () => ({
      invoke: async () => {
        tried++;
        throw Object.assign(new Error('structured output is unavailable'), { status_code: 501 });
      },
    }),
    invoke: async (messages: { content: string }[]) => {
      plain.push(messages.at(-1)?.content ?? '');
      return { content: reply, usage_metadata: { total_tokens: 5 } };
    },
    _llmType: () => 'ollama',
  };
  return { model: model as unknown as BaseChatModel, plain, tried: () => tried };
}

describe('extractJson', () => {
  it('finds the object in plain, fenced and reasoned replies', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('<think>hmm {x}</think>\nSure: {"a":1} done')).toEqual({ a: 1 });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('structured output on a model that cannot do it', () => {
  it('asks for JSON in the prompt, checks it against the schema, and skips the failing call afterwards', async () => {
    const f = noStructured('Here you go:\n```json\n{"passed": true, "reason": "ok"}\n```');
    const r = await structured(f.model, S, 'verdict').invoke([{ role: 'user', content: 'judge' }]);
    expect(r.parsed).toEqual({ passed: true, reason: 'ok' });
    expect(f.plain[0]).toContain('JSON Schema');
    await structured(f.model, S, 'verdict').invoke([{ role: 'user', content: 'again' }]);
    expect(f.tried()).toBe(1);
  });

  it('rejects an answer that does not match the schema', async () => {
    const f = noStructured('{"passed": "maybe"}');
    await expect(
      structured(f.model, S, 'verdict').invoke([{ role: 'user', content: 'x' }]),
    ).rejects.toThrow();
  });

  it('does not hide other errors', async () => {
    const model = {
      withStructuredOutput: () => ({
        invoke: async () => Promise.reject(new Error('fetch failed')),
      }),
      _llmType: () => 'ollama',
    } as unknown as BaseChatModel;
    await expect(
      structured(model, S, 'v').invoke([{ role: 'user', content: 'x' }]),
    ).rejects.toThrow('fetch failed');
  });
});
