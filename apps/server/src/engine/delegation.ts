import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { agents, approvals, delegations, steps, tasks } from '../db/schema.ts';
import { type DbExecutor, emit } from '../events.ts';
import { ISOLATED_WORKSPACE_MARKER } from '../skills/step-workspace.ts';
import { DelegateArgs, MAX_DELEGATIONS_PER_STEP } from '../skills/tools/delegate.ts';
import { pathExists } from '../skills/workspace.ts';
import type { EngineDeps } from './deps.ts';

type Step = typeof steps.$inferSelect;
type Task = typeof tasks.$inferSelect;

const RESULT_CHARS = 6_000;
const CHILD_DONE = new Set(['succeeded', 'failed', 'cancelled', 'superseded']);

const clip = (s: string | null | undefined, n: number) =>
  !s ? '' : s.length > n ? `${s.slice(0, n)}\n[truncated]` : s;

/**
 * Starts the sub-tasks a step asked for with delegate: one child step per request, assigned to
 * the named agent, in the same plan. A request that can't run (unknown agent, itself, too many)
 * is answered at once with the reason. Idempotent per (step, interrupt).
 */
export async function startDelegations(
  tx: DbExecutor,
  task: Task,
  step: Step,
  requests: { interruptId: string; args: unknown }[],
): Promise<void> {
  for (const r of requests) {
    const [row] = await tx
      .insert(delegations)
      .values({ taskId: task.id, stepId: step.id, interruptId: r.interruptId })
      .onConflictDoNothing()
      .returning();
    if (!row) continue; // already started (a resumed crash)
    const refuse = async (answer: string) => {
      await tx
        .update(delegations)
        .set({ status: 'done', answer, finishedAt: new Date() })
        .where(eq(delegations.id, row.id));
    };
    const parsed = DelegateArgs.safeParse(r.args);
    if (!parsed.success) {
      await refuse(
        `Error: delegate needs agent, title, instructions and acceptance. ${parsed.error.message}`,
      );
      continue;
    }
    const args = parsed.data;
    const all = await tx.select({ id: agents.id, name: agents.name }).from(agents);
    const target = all.find((a) => a.name.toLowerCase() === args.agent.trim().toLowerCase());
    if (!target) {
      await refuse(
        `Error: there is no agent named "${args.agent}". Agents: ${all.map((a) => a.name).join(', ')}.`,
      );
      continue;
    }
    if (target.id === step.agentId) {
      await refuse("Error: you can't delegate to yourself. Do the work, or pick another agent.");
      continue;
    }
    const used = await tx.$count(delegations, eq(delegations.stepId, step.id));
    if (used > MAX_DELEGATIONS_PER_STEP) {
      await refuse(
        `Error: a task can hand out at most ${MAX_DELEGATIONS_PER_STEP} sub-tasks. Finish with what you have.`,
      );
      continue;
    }
    const slug = target.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const [child] = await tx
      .insert(steps)
      .values({
        taskId: task.id,
        planVersion: step.planVersion,
        key: `${step.key}.${slug}-${used}`,
        title: args.title,
        instructions: args.instructions,
        acceptance: args.acceptance,
        agentId: target.id,
        dependsOn: [],
        parentStepId: step.id,
      })
      .returning();
    if (!child) throw new Error('Sub-task insert returned no row');
    await tx.update(delegations).set({ childStepId: child.id }).where(eq(delegations.id, row.id));
    await emit(
      tx,
      task.id,
      {
        type: 'delegation.started',
        stepId: step.id,
        childStepId: child.id,
        agent: target.name,
        title: args.title,
      },
      step.id,
    );
    await emit(
      tx,
      task.id,
      { type: 'step.status', stepId: child.id, key: child.key, status: 'pending', attempt: 0 },
      child.id,
    );
  }
}

/** Whether a step still waits on the user or on a sub-agent. */
export async function stillWaiting(
  tx: DbExecutor,
  stepId: string,
): Promise<'user' | 'agent' | null> {
  const ask = await tx.query.approvals.findFirst({
    where: and(eq(approvals.stepId, stepId), eq(approvals.status, 'pending')),
  });
  if (ask) return 'user';
  const sub = await tx.query.delegations.findFirst({
    where: and(eq(delegations.stepId, stepId), eq(delegations.status, 'running')),
  });
  return sub ? 'agent' : null;
}

/** Queues a paused step to resume once nothing it waits on is open. Returns it if queued. */
export async function resumeIfReady(tx: DbExecutor, taskId: string, stepId: string) {
  if (await stillWaiting(tx, stepId)) return undefined;
  const [step] = await tx
    .update(steps)
    .set({ status: 'queued' })
    .where(and(eq(steps.id, stepId), inArray(steps.status, ['awaiting_approval', 'delegating'])))
    .returning();
  if (step) {
    await emit(
      tx,
      taskId,
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
  return step;
}

/**
 * Hands finished sub-tasks back: the child's result (or why it failed) becomes the delegate
 * tool's result, and the parent resumes when nothing else is open. Returns steps to enqueue.
 */
export async function finishDelegations(deps: EngineDeps, taskId: string): Promise<Step[]> {
  const open = await deps.db
    .select({
      id: delegations.id,
      stepId: delegations.stepId,
      childStepId: delegations.childStepId,
      child: steps,
      agent: agents.name,
    })
    .from(delegations)
    .leftJoin(steps, eq(steps.id, delegations.childStepId))
    .leftJoin(agents, eq(agents.id, steps.agentId))
    .where(and(eq(delegations.taskId, taskId), eq(delegations.status, 'running')));
  const task = await deps.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  const isolated =
    !!task && (await pathExists(join(task.workspacePath, ISOLATED_WORKSPACE_MARKER)));
  const resumed: Step[] = [];
  for (const d of open) {
    const c = d.child;
    if (c && !CHILD_DONE.has(c.status)) continue;
    const agent = d.agent ?? 'The sub-agent';
    const ok = c?.status === 'succeeded';
    const answer = ok
      ? `${agent} finished "${c.title}". ${isolated ? `Files from child step ${c.id} are available in inputs/${c.id}/ in your workspace. Prefix any relative paths in its reply with that directory. ` : ''}Its result:\n${clip(c.output, RESULT_CHARS)}`
      : `${agent} couldn't finish "${c?.title ?? 'the sub-task'}"${c ? ` (${c.status})` : ''}: ${clip(c?.error ?? c?.judgeReason ?? 'no reason given', 1_000)}. Decide whether to try again differently, do it yourself, or report the problem.`;
    const step = await deps.db.transaction(async (tx) => {
      const [done] = await tx
        .update(delegations)
        .set({ status: 'done', answer, finishedAt: new Date() })
        .where(and(eq(delegations.id, d.id), eq(delegations.status, 'running')))
        .returning();
      if (!done) return undefined; // another tick got there first
      await emit(
        tx,
        taskId,
        {
          type: 'delegation.finished',
          stepId: d.stepId,
          childStepId: d.childStepId ?? '',
          agent,
          ok,
        },
        d.stepId,
      );
      return resumeIfReady(tx, taskId, d.stepId);
    });
    if (step) resumed.push(step);
  }
  return resumed;
}
