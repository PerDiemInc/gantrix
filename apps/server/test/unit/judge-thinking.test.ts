import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it } from 'vitest';
import { judgeStep } from '../../src/engine/judge.ts';

/** A stand-in for a ChatOllama whose model has no thinking mode. */
function fakeModel(think: boolean, errorText: string | null) {
  const calls: boolean[] = [];
  const model = {
    think,
    withStructuredOutput() {
      return {
        invoke: async () => {
          calls.push(model.think);
          if (model.think && errorText) throw new Error(errorText);
          return {
            raw: { usage_metadata: { total_tokens: 7 } },
            parsed: { passed: true, feedback: '' },
          };
        },
      };
    },
    _llmType: () => 'ollama',
  };
  return { model: model as unknown as BaseChatModel, calls, state: model };
}
const input = { title: 't', acceptance: 'a', output: 'o', workspaceFiles: '' };

describe('the judge on a model with no thinking mode', () => {
  it('retries without thinking and keeps it off afterwards', async () => {
    const f = fakeModel(true, 'registry.ollama.ai/x does not support thinking');
    expect(await judgeStep(f.model, input)).toMatchObject({ passed: true, tokens: 7 });
    expect(f.calls).toEqual([true, false]);
    await judgeStep(f.model, input);
    expect(f.calls).toEqual([true, false, false]);
    expect(f.state.think).toBe(false);
  });

  it('does not hide other errors', async () => {
    const f = fakeModel(true, 'fetch failed');
    await expect(judgeStep(f.model, input)).rejects.toThrow('fetch failed');
    expect(f.calls).toEqual([true]);
  });
});
