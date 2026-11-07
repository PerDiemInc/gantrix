import { randomUUIDv7 } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  type AgentModelChoice,
  type Budget,
  isTerminal,
  TERMINAL_TASK_STATUSES,
} from '@gantrix/shared';
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { resolveBudget } from '../budget.ts';
import { agents, approvals, steps, taskMessages, tasks } from '../db/schema.ts';
import { emit } from '../events.ts';
import { createWorkspace } from '../skills/workspace.ts';
import type { EngineDeps } from './deps.ts';
import { stepThreadId } from './threads.ts';

/** User actions shared by the API and the CLI. */

export async function createTask(
  deps: EngineDeps,
  input: {
    goal: string;
    description?: string;
    name?: string;
    slack?: boolean;
    budget?: Partial<Budget>;
    approveAll?: boolean;
    agentIds?: string[];
    agentModels?: Record<string, AgentModelChoice>;
  },
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
        agentIds: input.agentIds?.length ? input.agentIds : null,
        description: input.description?.trim() || null,
        name: input.name?.trim() || null,
        slack: input.slack ?? false,
        agentModels:
          input.agentModels && Object.keys(input.agentModels).length ? input.agentModels : null,
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

/**
 * More time or tokens for a project. A project that stopped because it ran out of budget
 * starts again: its unfinished tasks go back to waiting and a fresh supervisor picks it up
 * (the supervisor rebuilds its view from the database, so nothing is lost).
 */
export async function extendTask(
  deps: EngineDeps,
  taskId: string,
  add: { minutes?: number; tokens?: number; replans?: number },
): Promise<{ status: 'extended' | 'resumed' | 'finished'; budget: Budget }> {
  const task = await deps.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new Error('Task not found');
  const budget: Budget = {
    ...task.budget,
    maxMinutes: task.budget.maxMinutes + (add.minutes ?? 0),
    maxTokens: task.budget.maxTokens + (add.tokens ?? 0),
    maxReplans: task.budget.maxReplans + (add.replans ?? 0),
  };
  // Only a project stopped for attention (budget, replans) can go on; done is done.
  if (isTerminal(task.status) && task.status !== 'needs_attention') {
    return { status: 'finished', budget: task.budget };
  }
  const resume = task.status === 'needs_attention';
  await deps.db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        budget,
        ...(resume ? { status: 'running', finishedAt: null, error: null } : {}),
      })
      .where(eq(tasks.id, taskId));
    if (!resume) return;
    // Tasks that were stopped mid-way wait to run again (as a new attempt).
    const stopped = await tx
      .update(steps)
      .set({ status: 'pending', finishedAt: null })
      .where(
        and(
          eq(steps.taskId, taskId),
          inArray(steps.status, ['cancelled', 'queued', 'running', 'judging', 'awaiting_approval']),
        ),
      )
      .returning();
    await tx
      .update(approvals)
      .set({ status: 'denied', decidedAt: new Date() })
      .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'pending')));
    for (const s of stopped) {
      await emit(
        tx,
        taskId,
        { type: 'step.status', stepId: s.id, key: s.key, status: 'pending', attempt: s.attempt },
        s.id,
      );
    }
    const added = Boolean(add.minutes || add.tokens || add.replans);
    await emit(tx, taskId, {
      type: 'task.status',
      status: 'running',
      reason: added
        ? `Resumed with more budget: ${budget.maxMinutes} min, ${budget.maxTokens.toLocaleString()} tokens`
        : 'Resumed',
    });
  });
  if (resume) {
    // The old supervisor thread ended when the project stopped; start a new one.
    await deps.checkpointer.deleteThread(`task-${taskId}`);
  }
  await deps.queues.tick(taskId);
  return { status: resume ? 'resumed' : 'extended', budget };
}

const EDITABLE: ReadonlySet<string> = new Set([
  'pending',
  'queued',
  'failed',
  'succeeded',
  'cancelled',
]);
const BUSY: ReadonlySet<string> = new Set(['running', 'judging', 'awaiting_approval']);

export type EditStepResult =
  | { status: 'edited'; reopened: boolean }
  | { status: 'not_found' }
  | { status: 'busy' }
  | { status: 'project_closed' }
  | { status: 'bad_agent' };

/**
 * The user edits a task: its title, instructions, "done when" or who does it. With rerun,
 * a finished or failed task runs again (a new attempt); a finished or stopped project opens
 * again for it. A task that is running can't change until it stops: message its agent instead.
 */
export async function editStep(
  deps: EngineDeps,
  taskId: string,
  stepId: string,
  input: {
    title?: string;
    instructions?: string;
    acceptance?: string;
    agentId?: string;
    rerun?: boolean;
  },
): Promise<EditStepResult> {
  const task = await deps.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  const step = await deps.db.query.steps.findFirst({
    where: and(eq(steps.id, stepId), eq(steps.taskId, taskId)),
  });
  if (!task || !step || step.status === 'superseded') return { status: 'not_found' };
  if (BUSY.has(step.status)) return { status: 'busy' };
  if (task.status === 'cancelled') return { status: 'project_closed' };
  if (!EDITABLE.has(step.status)) return { status: 'busy' };
  if (input.agentId) {
    const agent = await deps.db.query.agents.findFirst({ where: eq(agents.id, input.agentId) });
    const inTeam = !task.agentIds?.length || task.agentIds.includes(input.agentId);
    if (!agent || !inTeam) return { status: 'bad_agent' };
  }
  const changes = {
    ...(input.title !== undefined && input.title !== step.title ? { title: input.title } : {}),
    ...(input.instructions !== undefined && input.instructions !== step.instructions
      ? { instructions: input.instructions }
      : {}),
    ...(input.acceptance !== undefined && input.acceptance !== step.acceptance
      ? { acceptance: input.acceptance }
      : {}),
    ...(input.agentId !== undefined && input.agentId !== step.agentId
      ? { agentId: input.agentId }
      : {}),
  };
  const rerun = Boolean(input.rerun) && step.status !== 'pending' && step.status !== 'queued';
  const reopen = rerun && isTerminal(task.status);
  await deps.db.transaction(async (tx) => {
    await tx
      .update(steps)
      .set({
        ...changes,
        ...(rerun ? { status: 'pending', finishedAt: null, error: null, judgeReason: null } : {}),
      })
      .where(eq(steps.id, step.id));
    if (reopen) {
      await tx
        .update(tasks)
        .set({ status: 'running', finishedAt: null, error: null, result: null })
        .where(eq(tasks.id, taskId));
      await emit(tx, taskId, {
        type: 'task.status',
        status: 'running',
        reason: `You reran ${step.key}`,
      });
    }
    await emit(
      tx,
      taskId,
      {
        type: 'step.edited',
        stepId: step.id,
        key: step.key,
        fields: Object.keys(changes).map((k) => (k === 'agentId' ? 'agent' : k)),
        rerun,
      },
      step.id,
    );
    if (rerun) {
      await emit(
        tx,
        taskId,
        {
          type: 'step.status',
          stepId: step.id,
          key: step.key,
          status: 'pending',
          attempt: step.attempt,
        },
        step.id,
      );
    }
  });
  // A finished project's supervisor thread has ended; start a fresh one (it reads the DB).
  if (reopen) await deps.checkpointer.deleteThread(`task-${taskId}`);
  await deps.queues.tick(taskId);
  return { status: 'edited', reopened: reopen };
}

/** Who may work on the project from now on; null = every agent. The next plan uses it. */
export async function setTeam(deps: EngineDeps, taskId: string, agentIds: string[] | null) {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ agentIds: agentIds?.length ? agentIds : null })
      .where(eq(tasks.id, taskId));
    await emit(tx, taskId, { type: 'task.team', agentIds: agentIds?.length ? agentIds : null });
  });
}

export const STOPPED_BY_USER = 'Stopped by you.';

/**
 * Pauses a project: nothing new starts, running tasks stop at their next model turn, and
 * it can go on later (resumeTask). Cancel, by contrast, ends it for good.
 */
export async function stopTask(deps: EngineDeps, taskId: string): Promise<boolean> {
  const stopped = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(tasks)
      .set({ status: 'needs_attention', finishedAt: new Date(), error: STOPPED_BY_USER })
      .where(and(eq(tasks.id, taskId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])))
      .returning({ id: tasks.id });
    if (row) {
      await emit(tx, taskId, {
        type: 'task.status',
        status: 'needs_attention',
        reason: STOPPED_BY_USER,
      });
    }
    return Boolean(row);
  });
  if (stopped) await deps.queues.tick(taskId);
  return stopped;
}

/** Picks a stopped project up where it left off, with the budget it has. */
export const resumeTask = (deps: EngineDeps, taskId: string) => extendTask(deps, taskId, {});

export type DeleteResult = 'deleted' | 'not_found' | 'busy';

/**
 * Deletes a finished or stopped project: its tasks, events, approvals, messages (cascade),
 * its LangGraph threads and its workspace folder. Deployed sites stay.
 */
export async function deleteTask(deps: EngineDeps, taskId: string): Promise<DeleteResult> {
  const task = await deps.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) return 'not_found';
  if (!isTerminal(task.status)) return 'busy';
  const all = await deps.db
    .select({ id: steps.id, attempt: steps.attempt, status: steps.status })
    .from(steps)
    .where(eq(steps.taskId, taskId));
  // A task still finishing its last model turn would write into a deleted project.
  if (all.some((s) => ['running', 'judging'].includes(s.status))) return 'busy';
  await deps.db.delete(tasks).where(eq(tasks.id, taskId));
  await deps.checkpointer.deleteThread(`task-${taskId}`);
  for (const s of all) {
    for (let attempt = 1; attempt <= s.attempt; attempt++) {
      await deps.checkpointer.deleteThread(stepThreadId(s.id, attempt));
    }
  }
  // Only a folder inside the workspaces directory, never anything else.
  // Workspace paths are stored with symlinks resolved (createWorkspace), so resolve the root too.
  const root = await realpath(deps.config.GANTRIX_WORKSPACES_DIR).catch(() => null);
  const folder = resolve(task.workspacePath);
  if (root && folder.startsWith(root + sep)) await rm(folder, { recursive: true, force: true });
  return 'deleted';
}

/** Renames a project or turns its Slack updates on or off. */
export async function updateTask(
  deps: EngineDeps,
  taskId: string,
  input: { name?: string | null | undefined; slack?: boolean | undefined },
): Promise<boolean> {
  const fields = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
  if (!fields.length) return true;
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(tasks)
      .set({
        ...(input.name !== undefined ? { name: input.name?.trim() || null } : {}),
        ...(input.slack !== undefined ? { slack: input.slack } : {}),
      })
      .where(eq(tasks.id, taskId))
      .returning({ id: tasks.id });
    if (row) await emit(tx, taskId, { type: 'task.updated', fields });
    return Boolean(row);
  });
}
