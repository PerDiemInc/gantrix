import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { tokensUsed } from '../models/provider.ts';
import { structured } from '../models/structured.ts';

const VerdictSchema = z.object({
  passed: z.boolean(),
  reason: z.string().describe('one or two sentences; if it failed, exactly what is missing'),
});

export interface Verdict {
  passed: boolean;
  reason: string;
  tokens: number;
}

const MAX_OUTPUT_CHARS = 12_000;
const clip = (text: string) =>
  text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : text;

const STEP_JUDGE = `You check an AI agent's work. Decide only whether the output meets the acceptance
criterion; ignore style. Rely on the output, the workspace file list and the contents of the
files the step wrote.
If it fails, say exactly what is missing so the agent can fix it.`;

const GOAL_JUDGE = `You decide whether a goal has been achieved, based on the results of the steps
taken. If it hasn't, say what is still missing so a planner can add steps.`;

/** Ollama refuses `think` for a model that has no thinking mode. */
const NO_THINKING = /does not support thinking/i;

async function verdict(model: BaseChatModel, system: string, prompt: string): Promise<Verdict> {
  const judge = structured(model, VerdictSchema, 'verdict');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];
  let result: Awaited<ReturnType<typeof judge.invoke>>;
  try {
    result = await judge.invoke(messages);
  } catch (error) {
    // A model without a thinking mode (some local models) judges without it, now and from here on.
    const m = model as { think?: boolean };
    if (!m.think || !NO_THINKING.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
    m.think = false;
    result = await judge.invoke(messages);
  }
  const { raw, parsed } = result;
  return { ...parsed, tokens: tokensUsed(raw as Parameters<typeof tokensUsed>[0]) };
}

/** `model` must be created with the 'judge' role (thinking on). */
export function judgeStep(
  model: BaseChatModel,
  input: { title: string; acceptance: string; output: string; workspaceFiles: string },
): Promise<Verdict> {
  return verdict(
    model,
    STEP_JUDGE,
    `Step: ${input.title}
Acceptance criterion: ${input.acceptance}

Workspace files:
${input.workspaceFiles || '(none)'}

Agent output:
${clip(input.output) || '(empty)'}`,
  );
}

export function judgeGoal(
  model: BaseChatModel,
  input: {
    goal: string;
    results: readonly { title: string; output: string }[];
    /** What Gantrix itself got from the deployed URLs just now. */
    live?: readonly string[];
  },
): Promise<Verdict> {
  const results = input.results.map((r) => `### ${r.title}\n${clip(r.output)}`).join('\n\n');
  const live = input.live?.length
    ? `\n\nThe deployed site, fetched just now (trust this over what the steps say):\n${input.live.join('\n\n')}`
    : '';
  return verdict(model, GOAL_JUDGE, `Goal: ${input.goal}\n\nStep results:\n${results}${live}`);
}
