import type { StepStatus } from '@gantrix/shared';
import type { Plan } from './schema.ts';

export interface PlanContext {
  agentNames: ReadonlySet<string>;
  /** Keys of steps that already succeeded in earlier plan versions; new steps may depend on them. */
  doneKeys: ReadonlySet<string>;
}

/** Every problem in the plan, worded so the planner can fix it on a retry. Empty means valid. */
export function validatePlan(plan: Plan, ctx: PlanContext): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const s of plan.steps) {
    if (keys.has(s.key)) errors.push(`Step key "${s.key}" is used more than once.`);
    if (ctx.doneKeys.has(s.key)) {
      errors.push(`Step key "${s.key}" belongs to a finished step; choose a new key.`);
    }
    if (!ctx.agentNames.has(s.agent)) {
      errors.push(
        `Step "${s.key}" uses unknown agent "${s.agent}". Available: ${[...ctx.agentNames].join(', ')}.`,
      );
    }
    keys.add(s.key);
  }
  for (const s of plan.steps) {
    for (const d of s.dependsOn) {
      if (d === s.key) errors.push(`Step "${s.key}" depends on itself.`);
      else if (!keys.has(d) && !ctx.doneKeys.has(d)) {
        errors.push(`Step "${s.key}" depends on unknown step "${d}".`);
      }
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(plan.steps);
    if (cycle) errors.push(`Steps depend on each other in a cycle: ${cycle.join(' → ')}.`);
  }
  return errors;
}

function findCycle(
  steps: readonly { key: string; dependsOn: readonly string[] }[],
): string[] | null {
  const deps = new Map(steps.map((s) => [s.key, s.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (key: string): string[] | null => {
    if (!deps.has(key) || state.get(key) === 'done') return null; // finished steps can't be in a cycle
    if (state.get(key) === 'visiting') return [...path.slice(path.indexOf(key)), key];
    state.set(key, 'visiting');
    path.push(key);
    for (const d of deps.get(key) ?? []) {
      const cycle = visit(d);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(key, 'done');
    return null;
  };
  for (const s of steps) {
    const cycle = visit(s.key);
    if (cycle) return cycle;
  }
  return null;
}

export interface SchedulableStep {
  key: string;
  status: StepStatus;
  dependsOn: readonly string[];
  agentId: string | null;
}

// Waiting for approval doesn't use the model, so it doesn't count against an agent's limit.
const BUSY: ReadonlySet<StepStatus> = new Set(['queued', 'running', 'judging']);

/**
 * Pending steps whose dependencies all succeeded, within each agent's concurrency limit.
 * Plan order breaks ties. Steps whose agent was deleted (agentId null) are never ready;
 * the supervisor fails them.
 */
export function readySteps(
  steps: readonly SchedulableStep[],
  agentLimits: ReadonlyMap<string, number>,
): string[] {
  const succeeded = new Set(steps.filter((s) => s.status === 'succeeded').map((s) => s.key));
  const busy = new Map<string, number>();
  for (const s of steps) {
    if (s.agentId && BUSY.has(s.status)) busy.set(s.agentId, (busy.get(s.agentId) ?? 0) + 1);
  }
  const ready: string[] = [];
  for (const s of steps) {
    if (s.status !== 'pending' || !s.agentId || !s.dependsOn.every((d) => succeeded.has(d))) {
      continue;
    }
    const used = busy.get(s.agentId) ?? 0;
    if (used >= (agentLimits.get(s.agentId) ?? 1)) continue;
    busy.set(s.agentId, used + 1);
    ready.push(s.key);
  }
  return ready;
}
