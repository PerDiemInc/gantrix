import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { tokensUsed } from '../models/provider.ts';

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
criterion; ignore style. You can't open files: rely on the output and the workspace file list.
If it fails, say exactly what is missing so the agent can fix it.`;

const GOAL_JUDGE = `You decide whether a goal has been achieved, based on the results of the steps
taken. If it hasn't, say what is still missing so a planner can add steps.`;

async function verdict(model: BaseChatModel, system: string, prompt: string): Promise<Verdict> {
  const judge = model.withStructuredOutput(VerdictSchema, { name: 'verdict', includeRaw: true });
  const { raw, parsed } = await judge.invoke([
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ]);
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
  input: { goal: string; results: readonly { title: string; output: string }[] },
): Promise<Verdict> {
  const results = input.results.map((r) => `### ${r.title}\n${clip(r.output)}`).join('\n\n');
  return verdict(model, GOAL_JUDGE, `Goal: ${input.goal}\n\nStep results:\n${results}`);
}
