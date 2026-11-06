import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const ASK_USER = 'ask_user';

export const AskUserArgs = z.object({
  question: z.string().min(3).max(1_000).describe('one clear question for the user'),
  options: z
    .array(z.string().min(1).max(200))
    .max(6)
    .optional()
    .describe('up to 6 short answers the user can pick; they can still write their own'),
  why: z.string().max(500).optional().describe('one line on why you need to know'),
});

/**
 * Asks the user and waits for the answer. The step agent never calls this function: it
 * pauses the step (like an approval) and returns the user's answer as the tool result.
 * It always waits, whatever the project's approval setting.
 */
export function askUserTool() {
  return tool(async () => 'The user has not answered yet.', {
    name: ASK_USER,
    description:
      'Ask the user a question and wait for the answer. Use it when you need a decision or facts only the user has: the goal, the audience, a choice between options. Ask at most a few questions, each one at a time.',
    schema: AskUserArgs,
  });
}
