import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const DELEGATE = 'delegate';
/** Sub-tasks one step attempt may hand out, so a confused model can't fan out forever. */
export const MAX_DELEGATIONS_PER_STEP = 6;

export const DelegateArgs = z.object({
  agent: z.string().min(1).max(80).describe('the name of the agent to hand this to'),
  title: z.string().min(3).max(200).describe('a short title for the sub-task'),
  instructions: z
    .string()
    .min(10)
    .max(8_000)
    .describe('everything the agent needs: context, inputs, file paths, constraints'),
  acceptance: z
    .string()
    .min(3)
    .max(1_000)
    .describe('what must be true when it is done, checkable by a reviewer'),
});
export type DelegateRequest = z.infer<typeof DelegateArgs>;

/**
 * Hands a sub-task to another agent (a sub-agent) and waits for its result. Like ask_user,
 * the step agent never calls this function: it pauses the step, the engine runs the sub-task
 * as its own step, and the sub-agent's final reply comes back as the tool result.
 */
export function delegateTool(
  agents: { name: string; description: string | null }[],
  isolatedParentStepId?: string,
) {
  const list = agents.map((a) => `- ${a.name}: ${a.description || '(no description)'}`).join('\n');
  const workspace = isolatedParentStepId
    ? `It works in a separate workspace. A snapshot of your files is available to it at inputs/${isolatedParentStepId}/; tell it to read there and write its own outputs outside inputs/. Its completed files will be copied back to inputs/<child-step-id>/, with the exact path in the result.`
    : 'It works in the same workspace, so name the files it should read or write.';
  return tool(async () => 'The sub-agent has not finished yet.', {
    name: DELEGATE,
    description: `Hand a self-contained sub-task to a specialist agent and wait for its result. ${workspace} Give it everything it needs: it can't see your conversation. Available agents:\n${list}`,
    schema: DelegateArgs,
  });
}
