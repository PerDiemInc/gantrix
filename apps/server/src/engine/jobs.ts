import type { GantrixEvent } from '@gantrix/shared';
import { isTerminal } from '@gantrix/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { events, steps, tasks } from '../db/schema.ts';
import { emit } from '../events.ts';
import { resolveModelSpec } from '../models/connections.ts';
import { createChatModel } from '../models/provider.ts';
import { type CheckUrl, checkUrl, describeCheck, type SiteCheck } from '../skills/tools/verify.ts';
import { type EngineDeps, modelDefaults } from './deps.ts';
import { judgeGoal, type Verdict } from './judge.ts';
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
  // With the live check on, "deployed" is something Gantrix sees for itself, not something an
  // agent says: the URLs agents checked are fetched again now, and none answering ends it here.
  const live = task.liveCheck ? await recheckSites(db, task.id, deps.checkUrl ?? checkUrl) : null;
  const notLive = live ? liveFailure(live) : null;
  let verdict: Verdict;
  if (notLive) {
    verdict = { passed: false, reason: notLive, tokens: 0 };
  } else {
    const judge = createChatModel(
      await resolveModelSpec(db, deps.config, null),
      'judge',
      modelDefaults(deps.config),
    );
    verdict = await judgeGoal(judge, {
      goal: task.goal,
      results: done.map((s) => ({ title: s.title, output: s.output ?? '' })),
      ...(live ? { live: live.map(describeCheck) } : {}),
    });
  }
  await db.transaction(async (tx) => {
    for (const c of live ?? []) {
      await emit(tx, task.id, { type: 'site.checked', url: c.url, status: c.status, ok: c.ok });
    }
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

const MAX_LIVE_URLS = 5;

/** The URLs agents checked on this project (newest first), fetched again. */
async function recheckSites(db: Db, taskId: string, check: CheckUrl): Promise<SiteCheck[]> {
  const rows = await db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, 'site.checked')))
    .orderBy(desc(events.id))
    .limit(200);
  const urls = new Set<string>();
  for (const { payload } of rows) {
    const e = payload as Extract<GantrixEvent, { type: 'site.checked' }>;
    // Only what an agent reported; the engine's own re-checks carry no step.
    if (e.stepId && urls.size < MAX_LIVE_URLS) urls.add(e.url);
  }
  return Promise.all([...urls].map((url) => check(url)));
}

/** Why the project isn't live, for the planner; null when at least one URL answers. */
export function liveFailure(checks: readonly SiteCheck[]): string | null {
  if (!checks.length) {
    return 'The site is not deployed yet: no agent has checked a public URL with verify_url. Deploy it, then check its URL with verify_url.';
  }
  if (checks.some((c) => c.ok)) return null;
  const seen = checks
    .map((c) => `${c.url} (${c.status ? `HTTP ${c.status}` : c.detail})`)
    .join('; ');
  return `The deployed site does not answer: ${seen}. Find out why, fix the deployment, and check the URL again with verify_url.`;
}
