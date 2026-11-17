import { TERMINAL_TASK_STATUSES } from '@gantrix/shared';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { agents, jobs, tasks } from '../db/schema.ts';
import { createTask } from './commands.ts';
import type { EngineDeps } from './deps.ts';

export type RunOutcome =
  | { started: true; taskId: string }
  | { started: false; reason: 'running' | 'gone' | 'agents' | 'empty'; detail: string };

/**
 * Starts one run of a job: a new project whose plan is the job's steps, in order.
 * A job doesn't overlap itself: while a run is still going, a new one isn't started.
 */
export async function startJobRun(deps: EngineDeps, jobId: string): Promise<RunOutcome> {
  const { db } = deps;
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  if (!job) return { started: false, reason: 'gone', detail: 'The job no longer exists.' };
  if (job.steps.length === 0) {
    return { started: false, reason: 'empty', detail: 'The job has no steps.' };
  }
  const active = await db.query.tasks.findFirst({
    columns: { id: true },
    where: and(eq(tasks.jobId, job.id), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])),
  });
  if (active) {
    return {
      started: false,
      reason: 'running',
      detail: 'The previous run of this job is still going.',
    };
  }
  const wanted = [...new Set(job.steps.map((s) => s.agentId))];
  const found = await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, wanted));
  if (found.length !== wanted.length) {
    return {
      started: false,
      reason: 'agents',
      detail: 'An agent used by this job was deleted. Edit the job and pick another.',
    };
  }
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const task = await createTask(deps, {
    goal: job.goal,
    name: `${job.name} · ${stamp}`,
    ...(job.description ? { description: job.description } : {}),
    slack: job.slack,
    ...(job.budget ? { budget: job.budget } : {}),
    ...(job.approveAll === null ? {} : { approveAll: job.approveAll }),
    job: { id: job.id, steps: job.steps },
  });
  return { started: true, taskId: task.id };
}
