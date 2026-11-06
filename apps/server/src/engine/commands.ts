import { randomUUIDv7 } from 'node:crypto';
import { type Budget, isTerminal, TERMINAL_TASK_STATUSES } from '@gantrix/shared';
import { and, eq, ne, notInArray } from 'drizzle-orm';
import { resolveBudget } from '../budget.ts';
import { approvals, steps, taskMessages, tasks } from '../db/schema.ts';
import { emit } from '../events.ts';
import { createWorkspace } from '../skills/workspace.ts';
import type { EngineDeps } from './deps.ts';

/** User actions shared by the API and the CLI. */

export async function createTask(
  deps: EngineDeps,
  input: { goal: string; budget?: Partial<Budget>; approveAll?: boolean },
) {
  const id = randomUUIDv7();
  const workspacePath = await createWorkspace(deps.config.GANTRIX_WORKSPACES_DIR, id);
  const budget = resolveBudget(input.budget, deps.config);
  const task = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({
        id,
        goal: input.goal,
        budget,
        workspacePath,
        approveAll: input.approveAll ?? deps.config.GANTRIX_APPROVE_ALL,
      })
      .returning();
    await emit(tx, id, { type: 'task.status', status: 'planning' });
    return row;
  });
  if (!task) throw new Error('Task insert returned no row');
  await deps.queues.tick(id);
  return task;
}

export async function cancelTask(deps: EngineDeps, taskId: string): Promise<boolean> {
  const cancelled = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(tasks)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(tasks.id, taskId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])))
      .returning({ id: tasks.id });
    if (row) await emit(tx, taskId, { type: 'task.status', status: 'cancelled' });
    return Boolean(row);
  });
  if (cancelled) await deps.queues.tick(taskId);
  return cancelled;
}

export type DecisionResult = 'decided' | 'not_found' | 'already_decided';

export async function decideApproval(
  deps: EngineDeps,
  approvalId: string,
  approved: boolean,
  /** ask_user: the user's answer. */
  answer?: string,
): Promise<DecisionResult> {
  const outcome = await deps.db.transaction(async (tx) => {
    const [approval] = await tx
      .update(approvals)
      .set({
        status: approved ? 'approved' : 'denied',
        decidedAt: new Date(),
        ...(answer ? { answer } : {}),
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
      .returning();
    if (!approval) {
      const exists = await tx.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
      return { result: exists ? ('already_decided' as const) : ('not_found' as const) };
    }
    await emit(
      tx,
      approval.taskId,
      { type: 'approval.decided', approvalId, approved, ...(answer ? { answer } : {}) },
      approval.stepId,
    );
    const open = await tx.query.approvals.findFirst({
      where: and(eq(approvals.stepId, approval.stepId), eq(approvals.status, 'pending')),
    });
    if (open) return { result: 'decided' as const, taskId: approval.taskId };
    // All of this step's approvals are decided: queue it to resume.
    const [step] = await tx
      .update(steps)
      .set({ status: 'queued' })
      .where(and(eq(steps.id, approval.stepId), eq(steps.status, 'awaiting_approval')))
      .returning();
    if (step) {
      await emit(
        tx,
        approval.taskId,
        {
          type: 'step.status',
          stepId: step.id,
          key: step.key,
          status: 'queued',
          attempt: step.attempt,
        },
        step.id,
      );
    }
    return { result: 'decided' as const, taskId: approval.taskId, step };
  });
  if (outcome.result === 'decided') {
    if (outcome.step) await enqueueStep(deps, outcome.step.id, outcome.step.attempt);
    await deps.queues.tick(outcome.taskId);
  }
  return outcome.result;
}

/**
 * Queues a step job. The job id counts the step's decided approvals, so a resume after an
 * approval gets a new id while a repeated enqueue (e.g. the supervisor healing) gets the same one.
 */
export async function enqueueStep(
  deps: EngineDeps,
  stepId: string,
  attempt: number,
): Promise<void> {
  const decided = await deps.db.$count(
    approvals,
    and(eq(approvals.stepId, stepId), ne(approvals.status, 'pending')),
  );
  await deps.queues.step(stepId, attempt, decided ? `r${decided}` : undefined);
}

const FINISHED_STEP = new Set(['succeeded', 'failed', 'superseded']);

/**
 * A note from the user. To one step: that agent gets it before its next model turn. To the
 * whole team: the planner reads it, after the running steps finish, and replans.
 */
export async function sendMessage(
  deps: EngineDeps,
  taskId: string,
  input: { text: string; stepId?: string },
): Promise<
  | { status: 'sent'; id: string }
  | { status: 'task_finished' }
  | { status: 'no_step' }
  | { status: 'step_finished' }
> {
  const task = await deps.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task || isTerminal(task.status)) return { status: 'task_finished' };
  if (input.stepId) {
    const step = await deps.db.query.steps.findFirst({
      where: and(eq(steps.id, input.stepId), eq(steps.taskId, taskId)),
    });
    if (!step) return { status: 'no_step' };
    if (FINISHED_STEP.has(step.status)) return { status: 'step_finished' };
  }
  const id = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(taskMessages)
      .values({ taskId, text: input.text, ...(input.stepId ? { stepId: input.stepId } : {}) })
      .returning({ id: taskMessages.id });
    if (!row) throw new Error('Message insert returned no row');
    await emit(
      tx,
      taskId,
      {
        type: 'user.message',
        messageId: row.id,
        text: input.text,
        ...(input.stepId ? { stepId: input.stepId } : {}),
      },
      input.stepId,
    );
    return row.id;
  });
  if (!input.stepId) await deps.queues.tick(taskId);
  return { status: 'sent', id };
}
