import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { resolveModelSpec } from '../models/connections.ts';
import { createChatModel } from '../models/provider.ts';
import { type EngineDeps, modelDefaults } from './deps.ts';

export const GoalSchema = z.object({
  objective: z.string().min(3).describe('one sentence: what the project achieves'),
  keyResults: z
    .array(z.string().min(3))
    .min(2)
    .max(5)
    .describe('measurable outcomes that show the objective is met'),
});
export type SuggestedGoal = z.infer<typeof GoalSchema>;

const SYSTEM = `You turn a project description into an OKR for a team of AI agents.
Write one objective: a single sentence about the outcome, not the activity.
Write 3 or 4 key results. Each one is measurable and checkable when the project ends: a file
or page that exists, a number, a yes/no fact. Prefer concrete deliverables the agents can
produce, like "product/brief.md lists the audience and the four pages". No vague words such as
"improve", "optimize" or "high quality" without a measure. Use the user's own words and names.`;

/** An OKR drafted by the default model (the planner's) from what the user wrote. */
export async function suggestGoal(deps: EngineDeps, description: string): Promise<SuggestedGoal> {
  const model = createChatModel(
    await resolveModelSpec(deps.db, deps.config, null),
    'planner',
    modelDefaults(deps.config),
    0,
  ).withStructuredOutput(GoalSchema, { name: 'okr' });
  return model.invoke(
    [new SystemMessage(SYSTEM), new HumanMessage(`Project description:\n${description}`)],
    {
      signal: AbortSignal.timeout(90_000),
    },
  );
}
