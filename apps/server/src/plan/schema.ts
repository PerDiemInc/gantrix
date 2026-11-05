import { z } from 'zod';

export const PlannedStepSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .describe('snake_case id, unique in the plan, e.g. "compare_frameworks"'),
  title: z.string().min(1).max(120).describe('short name shown on the Gantt chart'),
  agent: z.string().min(1).describe('name of the agent that does this step'),
  instructions: z.string().min(1).describe('what the agent must do'),
  acceptance: z
    .string()
    .min(1)
    .describe('a checkable criterion, e.g. "report.md exists and names exactly 3 frameworks"'),
  dependsOn: z
    .array(z.string())
    .describe('keys of steps that must finish first; empty if the step can start right away'),
});

export const PlanSchema = z.object({
  steps: z.array(PlannedStepSchema).min(1).max(50),
});

export type PlannedStep = z.infer<typeof PlannedStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
