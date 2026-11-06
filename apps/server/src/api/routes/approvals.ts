import { APPROVAL_STATUSES } from '@gantrix/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approvals, steps, tasks } from '../../db/schema.ts';
import { decideApproval } from '../../engine/commands.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const ListApprovals = z.object({ status: z.enum(APPROVAL_STATUSES).default('pending') });
// ask_user questions are answered with approved: true and the answer; skipping = approved: false.
const Decide = z.object({
  approved: z.boolean(),
  answer: z.string().trim().min(1).max(4_000).optional(),
});

export function approvalRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  /** Approvals with enough context to decide: the task's goal and the step's title. */
  app.get('/api/approvals', async (request) => {
    const { status } = parse(ListApprovals, request.query);
    return db
      .select({
        id: approvals.id,
        taskId: approvals.taskId,
        stepId: approvals.stepId,
        tool: approvals.tool,
        args: approvals.args,
        status: approvals.status,
        answer: approvals.answer,
        createdAt: approvals.createdAt,
        decidedAt: approvals.decidedAt,
        goal: tasks.goal,
        stepTitle: steps.title,
      })
      .from(approvals)
      .innerJoin(tasks, eq(tasks.id, approvals.taskId))
      .innerJoin(steps, eq(steps.id, approvals.stepId))
      .where(eq(approvals.status, status))
      .orderBy(asc(approvals.createdAt));
  });

  app.post('/api/approvals/:id', async (request) => {
    const { id } = parse(IdParams, request.params);
    const { approved, answer } = parse(Decide, request.body);
    const result = await decideApproval(deps, id, approved, answer);
    if (result === 'not_found') throw notFound('Approval');
    if (result === 'already_decided')
      throw new HttpError(409, 'This approval was already decided.');
    return { id, approved };
  });
}
