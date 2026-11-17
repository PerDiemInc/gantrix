import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const TICKS_QUEUE = 'gantrix-ticks';
export const WORK_QUEUE = 'gantrix-work';
export const SCHEDULES_QUEUE = 'gantrix-schedules';

/** A scheduled job firing: the worker starts a run of it. */
export interface ScheduleJob {
  jobId: string;
}

export interface TickJob {
  taskId: string;
}

export type WorkJob =
  | { kind: 'plan'; taskId: string; version: number }
  | { kind: 'step'; stepId: string; attempt: number }
  | { kind: 'goal'; taskId: string; planVersion: number };

// BullMQ drops a job whose id is already queued, so the plan/step/goal enqueues are safe to
// repeat. Custom ids can't contain ':'.
export function createQueues(connection: Redis) {
  const ticks = new Queue<TickJob>(TICKS_QUEUE, { connection });
  const schedules = new Queue<ScheduleJob>(SCHEDULES_QUEUE, {
    connection,
    defaultJobOptions: { removeOnComplete: { age: 86_400 }, removeOnFail: { age: 7 * 86_400 } },
  });
  const work = new Queue<WorkJob>(WORK_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3, // infrastructure errors (model server down, crash); judge failures retry elsewhere
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 7 * 86_400 },
    },
  });
  return {
    ticks,
    work,
    schedules,
    /** Makes the cron schedule match the job: set, changed, or removed when paused. */
    syncSchedule: async (job: {
      id: string;
      schedule: string | null;
      timezone: string;
      enabled: boolean;
    }) => {
      const id = `job_${job.id}`;
      if (!job.enabled || !job.schedule) {
        await schedules.removeJobScheduler(id);
        return;
      }
      await schedules.upsertJobScheduler(
        id,
        { pattern: job.schedule, tz: job.timezone },
        { name: 'run', data: { jobId: job.id } },
      );
    },
    nextRun: async (jobId: string): Promise<Date | null> => {
      const s = await schedules.getJobScheduler(`job_${jobId}`);
      return s?.next ? new Date(s.next) : null;
    },
    // Ticks are never deduplicated: one dropped while another runs could miss a change.
    tick: (taskId: string, delayMs = 0) =>
      ticks.add('tick', { taskId }, { delay: delayMs, removeOnComplete: true, removeOnFail: 1000 }),
    plan: (taskId: string, version: number) =>
      work.add('plan', { kind: 'plan', taskId, version }, { jobId: `plan_${taskId}_${version}` }),
    step: (stepId: string, attempt: number, resumeKey?: string) =>
      work.add(
        'step',
        { kind: 'step', stepId, attempt },
        { jobId: ['step', stepId, attempt, resumeKey].filter(Boolean).join('_') },
      ),
    goal: (taskId: string, planVersion: number) =>
      work.add(
        'goal',
        { kind: 'goal', taskId, planVersion },
        { jobId: `goal_${taskId}_${planVersion}` },
      ),
    close: async () => {
      await ticks.close();
      await work.close();
      await schedules.close();
    },
  };
}

export type Queues = ReturnType<typeof createQueues>;
