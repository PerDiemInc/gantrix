import { type GantrixEvent, isTerminal, type StepStatus, type TaskStatus } from '@gantrix/shared';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { budgetBreach, canReplan } from '../budget.ts';
import type { Db } from '../db/client.ts';
import { agents, events, plans, steps, taskMessages, tasks } from '../db/schema.ts';
import { emit } from '../events.ts';
import { readySteps } from '../plan/dag.ts';
import { enqueueStep } from './commands.ts';
import type { EngineDeps } from './deps.ts';

const IN_FLIGHT: ReadonlySet<StepStatus> = new Set([
  'queued',
  'running',
  'judging',
  'awaiting_approval',
]);

type Outcome = 'wait' | 'finish';
type Task = typeof tasks.$inferSelect;
type Step = typeof steps.$inferSelect;

const SupervisorState = Annotation.Root({
  taskId: Annotation<string>(),
  outcome: Annotation<Outcome>(),
});

/**
 * One durable loop per task (LangGraph thread "task-<id>"): check the database, act, then sleep
 * until the next tick. The check reads current state, not the event that caused the tick, so
 * lost or repeated ticks are harmless and a crash heals on the next one. It never calls a model.
 */
export function buildSupervisor(deps: EngineDeps) {
  return new StateGraph(SupervisorState)
    .addNode('reconcile', async (s) => ({ outcome: await reconcile(deps, s.taskId) }))
    .addNode('wait', () => {
      interrupt('waiting for the next tick');
      return {};
    })
    .addEdge(START, 'reconcile')
    .addConditionalEdges('reconcile', (s) => (s.outcome === 'finish' ? END : 'wait'), ['wait', END])
    .addEdge('wait', 'reconcile')
    .compile({ checkpointer: deps.checkpointer });
}

export type Supervisor = ReturnType<typeof buildSupervisor>;

export async function tick(supervisor: Supervisor, taskId: string): Promise<void> {
  const config = { configurable: { thread_id: `task-${taskId}` } };
  const snapshot = await supervisor.getState(config);
  if (!snapshot.values.taskId) await supervisor.invoke({ taskId }, config);
  else if (snapshot.next.length) await supervisor.invoke(new Command({ resume: true }), config);
  // Otherwise the task already finished.
}

async function reconcile(deps: EngineDeps, taskId: string): Promise<Outcome> {
  const { db, queues } = deps;
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) return 'finish';
  if (isTerminal(task.status)) {
    await closeOpenSteps(deps, taskId);
    return 'finish';
  }

  const breach = budgetBreach(task, task.budget);
  if (breach) {
    await finish(deps, taskId, 'needs_attention', { error: breach.detail }, [
      { type: 'budget.exceeded', ...breach },
    ]);
    return 'finish';
  }

  const version = await latestPlanVersion(db, taskId);
  if (task.status === 'planning') {
    await queues.plan(taskId, version + 1);
    return 'wait';
  }

  const current = await db
    .select()
    .from(steps)
    .where(and(eq(steps.taskId, taskId), ne(steps.status, 'superseded')))
    .orderBy(steps.id); // uuidv7: plan order

  const orphans = current.filter((s) => s.status === 'pending' && !s.agentId);
  if (orphans.length) await failSteps(deps, taskId, orphans, 'Its agent was deleted.');

  const inFlight = current.filter((s) => IN_FLIGHT.has(s.status));

  // A note to the whole team changes the plan: let running steps finish, then replan with it.
  // It doesn't count against the replan budget, because the user asked for it.
  const teamNotes = await db
    .select({ id: taskMessages.id })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        isNull(taskMessages.stepId),
        isNull(taskMessages.planVersion),
      ),
    );
  if (teamNotes.length) {
    if (inFlight.length) {
      const onlyApprovals = inFlight.every((s) => s.status === 'awaiting_approval');
      await setTaskStatus(deps, task, onlyApprovals ? 'awaiting_approval' : 'running');
      return 'wait';
    }
    await db
      .update(taskMessages)
      .set({ planVersion: version + 1 })
      .where(
        inArray(
          taskMessages.id,
          teamNotes.map((n) => n.id),
        ),
      );
    await setTaskStatus(deps, task, 'planning', 'The user added a note');
    await queues.plan(taskId, version + 1);
    return 'wait';
  }

  if (current.some((s) => s.status === 'failed')) {
    if (inFlight.length) return 'wait'; // let running steps and open approvals finish first
    const failed = current.filter((s) => s.status === 'failed').map((s) => s.title);
    return replanOrStop(deps, task, version, `Steps failed: ${failed.join(', ')}`);
  }

  if (current.length && current.every((s) => s.status === 'succeeded')) {
    const verdict = await latestGoalVerdict(db, taskId, version);
    if (!verdict) {
      await queues.goal(taskId, version);
      return 'wait';
    }
    if (verdict.passed) {
      await finish(deps, taskId, 'succeeded', { result: resultOf(current) });
      return 'finish';
    }
    return replanOrStop(deps, task, version, `Goal not met: ${verdict.reason}`);
  }

  // Heal a crash between marking a step queued and enqueueing its job.
  for (const s of current) if (s.status === 'queued') await enqueueStep(deps, s.id, s.attempt);

  const limits = await agentLimits(db, current);
  const ready = new Set(readySteps(current, limits));
  const toQueue = current.filter((s) => ready.has(s.key));
  if (toQueue.length) {
    await db.transaction(async (tx) => {
      for (const s of toQueue) {
        const attempt = s.attempt + 1;
        await tx
          .update(steps)
          .set({ status: 'queued', attempt, queuedAt: new Date() })
          .where(eq(steps.id, s.id));
        await emit(
          tx,
          taskId,
          { type: 'step.status', stepId: s.id, key: s.key, status: 'queued', attempt },
          s.id,
        );
      }
    });
    for (const s of toQueue) await enqueueStep(deps, s.id, s.attempt + 1);
  } else if (!inFlight.length) {
    // Nothing can start and nothing is running, so the pending steps are blocked forever.
    const blocked = current.filter((s) => s.status === 'pending');
    if (blocked.length) {
      await failSteps(deps, taskId, blocked, 'Blocked: a step it depends on can never finish.');
      await queues.tick(taskId);
    }
    return 'wait';
  }

  // "Awaiting approval" when the only thing left to do is the user's decision.
  const waitingOnUser =
    !toQueue.length &&
    inFlight.length > 0 &&
    inFlight.every((s) => s.status === 'awaiting_approval');
  await setTaskStatus(deps, task, waitingOnUser ? 'awaiting_approval' : 'running');
  return 'wait';
}

async function replanOrStop(
  deps: EngineDeps,
  task: Task,
  version: number,
  why: string,
): Promise<Outcome> {
  if (!canReplan(task, task.budget)) {
    await finish(deps, task.id, 'needs_attention', { error: `${why}. No replans left.` }, [
      {
        type: 'budget.exceeded',
        limit: 'replans',
        detail: `Used ${task.replans} of ${task.budget.maxReplans} replans.`,
      },
    ]);
    return 'finish';
  }
  await setTaskStatus(deps, task, 'planning', why);
  await deps.queues.plan(task.id, version + 1);
  return 'wait';
}

async function finish(
  deps: EngineDeps,
  taskId: string,
  status: TaskStatus,
  fields: { result?: string; error?: string },
  extra: GantrixEvent[] = [],
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status,
        finishedAt: new Date(),
        result: fields.result ?? null,
        error: fields.error ?? null,
      })
      .where(eq(tasks.id, taskId));
    for (const event of extra) await emit(tx, taskId, event);
    await emit(tx, taskId, {
      type: 'task.status',
      status,
      ...(fields.error ? { reason: fields.error } : {}),
    });
  });
  await closeOpenSteps(deps, taskId);
}

/** Cancels steps that haven't started. Running steps stop at their next model turn. */
async function closeOpenSteps(deps: EngineDeps, taskId: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const closed = await tx
      .update(steps)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(steps.taskId, taskId), inArray(steps.status, ['pending', 'queued'])))
      .returning();
    for (const s of closed) {
      await emit(
        tx,
        taskId,
        { type: 'step.status', stepId: s.id, key: s.key, status: 'cancelled', attempt: s.attempt },
        s.id,
      );
    }
  });
}

async function setTaskStatus(
  deps: EngineDeps,
  task: Task,
  status: TaskStatus,
  reason?: string,
): Promise<void> {
  if (task.status === status) return;
  await deps.db.transaction(async (tx) => {
    await tx.update(tasks).set({ status }).where(eq(tasks.id, task.id));
    await emit(tx, task.id, { type: 'task.status', status, ...(reason ? { reason } : {}) });
  });
}

async function failSteps(
  deps: EngineDeps,
  taskId: string,
  list: Step[],
  reason: string,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    for (const s of list) {
      await tx
        .update(steps)
        .set({ status: 'failed', error: reason, finishedAt: new Date() })
        .where(eq(steps.id, s.id));
      await emit(
        tx,
        taskId,
        { type: 'step.status', stepId: s.id, key: s.key, status: 'failed', attempt: s.attempt },
        s.id,
      );
      s.status = 'failed';
    }
  });
}

async function latestPlanVersion(db: Db, taskId: string): Promise<number> {
  const [row] = await db
    .select({ version: plans.version })
    .from(plans)
    .where(eq(plans.taskId, taskId))
    .orderBy(desc(plans.version))
    .limit(1);
  return row?.version ?? 0;
}

export async function latestGoalVerdict(
  db: Db,
  taskId: string,
  planVersion: number,
): Promise<{ passed: boolean; reason: string } | null> {
  const [row] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, 'goal.judged')))
    .orderBy(desc(events.id))
    .limit(1);
  const event = row?.payload as Extract<GantrixEvent, { type: 'goal.judged' }> | undefined;
  return event && event.planVersion === planVersion ? event : null;
}

async function agentLimits(db: Db, current: Step[]): Promise<Map<string, number>> {
  const ids = [...new Set(current.flatMap((s) => (s.agentId ? [s.agentId] : [])))];
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: agents.id, max: agents.maxConcurrency })
    .from(agents)
    .where(inArray(agents.id, ids));
  return new Map(rows.map((r) => [r.id, r.max]));
}

/** The outputs of the final steps: the ones no other step depends on. */
function resultOf(current: Step[]): string {
  const used = new Set(current.flatMap((s) => s.dependsOn));
  return current
    .filter((s) => !used.has(s.key))
    .map((s) => `### ${s.title}\n${s.output ?? ''}`)
    .join('\n\n');
}

/** Notes the user sent to the whole team that a given plan version reads. */
export async function teamNotesFor(db: Db, taskId: string, version: number): Promise<string[]> {
  const rows = await db
    .select({ text: taskMessages.text })
    .from(taskMessages)
    .where(and(eq(taskMessages.taskId, taskId), eq(taskMessages.planVersion, version)))
    .orderBy(asc(taskMessages.createdAt));
  return rows.map((r) => r.text);
}
