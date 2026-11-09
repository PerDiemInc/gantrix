import { isTerminal } from '@gantrix/shared';
import { and, eq, sql } from 'drizzle-orm';
import { steps, tasks } from '../db/schema.ts';
import { emit } from '../events.ts';
import { resolveModelSpec } from '../models/connections.ts';
import { createChatModel } from '../models/provider.ts';
import { type EngineDeps, modelDefaults } from './deps.ts';
import { judgeGoal } from './judge.ts';
import { failTask, runPlanJob } from './planner.ts';
import type { WorkJob } from './queues.ts';
import { runStepJob, StepStopped, setStep } from './step-runner.ts';
import { latestGoalVerdict } from './supervisor.ts';

export function runWorkJob(deps: EngineDeps, job: WorkJob): Promise<void> {
  switch (job.kind) {
    case 'plan':
      return runPlanJob(deps, job);
    case 'step':
      return runStepJob(deps, job);
    case 'goal':
      return runGoalJob(deps, job);
  }
}

/** Called when a job has failed its last BullMQ attempt (model server down, a bug, …). */
export async function onWorkJobFailed(deps: EngineDeps, job: WorkJob, error: Error): Promise<void> {
  if (job.kind === 'step') {
    const step = await deps.db.query.steps.findFirst({ where: eq(steps.id, job.stepId) });
    if (!step || step.attempt !== job.attempt) return;
    await setStep(deps.db, step.taskId, step, 'failed', {
      error: error.message,
      finishedAt: new Date(),
    }).catch((e: unknown) => {
      if (!(e instanceof StepStopped)) throw e; // a stale job has nothing left to record
    });
    await deps.queues.tick(step.taskId);
    return;
  }
  const what = job.kind === 'plan' ? 'Planning' : 'Checking the goal';
  await failTask(deps, job.taskId, `${what} failed: ${error.message}`, 0);
}

async function runGoalJob(
  deps: EngineDeps,
  job: { taskId: string; planVersion: number },
): Promise<void> {
  const { db } = deps;
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, job.taskId) });
  if (!task || isTerminal(task.status)) return;
  if (await latestGoalVerdict(db, task.id, job.planVersion)) return; // repeated job
  const done = await db
    .select({ title: steps.title, output: steps.output })
    .from(steps)
    .where(and(eq(steps.taskId, task.id), eq(steps.status, 'succeeded')))
    .orderBy(steps.id);
  const judge = createChatModel(
    await resolveModelSpec(db, deps.config, null),
    'judge',
    modelDefaults(deps.config),
  );
  const verdict = await judgeGoal(judge, {
    goal: task.goal,
    results: done.map((s) => ({ title: s.title, output: s.output ?? '' })),
  });
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ tokensUsed: sql`${tasks.tokensUsed} + ${verdict.tokens}` })
      .where(eq(tasks.id, task.id));
    await emit(tx, task.id, {
      type: 'goal.judged',
      planVersion: job.planVersion,
      passed: verdict.passed,
      reason: verdict.reason,
    });
  });
  await deps.queues.tick(task.id);
}
