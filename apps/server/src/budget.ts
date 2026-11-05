import type { Budget } from '@gantrix/shared';
import type { Config } from './config.ts';

export function defaultBudget(config: Config): Budget {
  return {
    maxStepAttempts: config.GANTRIX_MAX_STEP_ATTEMPTS,
    maxReplans: config.GANTRIX_MAX_REPLANS,
    maxTokens: config.GANTRIX_MAX_TOKENS,
    maxMinutes: config.GANTRIX_MAX_MINUTES,
  };
}

export function resolveBudget(overrides: Partial<Budget> | undefined, config: Config): Budget {
  return { ...defaultBudget(config), ...overrides };
}

export interface BudgetBreach {
  limit: 'tokens' | 'time';
  detail: string;
}

interface TaskUsage {
  tokensUsed: number;
  replans: number;
  startedAt: Date | null;
}

/** A limit that stops the whole task, or null while the task is within budget. */
export function budgetBreach(
  task: TaskUsage,
  budget: Budget,
  now = new Date(),
): BudgetBreach | null {
  if (task.tokensUsed >= budget.maxTokens) {
    return { limit: 'tokens', detail: `Used ${task.tokensUsed} of ${budget.maxTokens} tokens.` };
  }
  if (task.startedAt) {
    const minutes = (now.getTime() - task.startedAt.getTime()) / 60_000;
    if (minutes >= budget.maxMinutes) {
      return {
        limit: 'time',
        detail: `Ran ${Math.floor(minutes)} of ${budget.maxMinutes} minutes.`,
      };
    }
  }
  return null;
}

export const canReplan = (task: TaskUsage, budget: Budget): boolean =>
  task.replans < budget.maxReplans;

export const canRetry = (step: { attempt: number }, budget: Budget): boolean =>
  step.attempt < budget.maxStepAttempts;
