import type { Budget, JobDto } from '@gantrix/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents, jobs, tasks } from '../../db/schema.ts';
import { startJobRun } from '../../engine/job-runs.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const Step = z.object({
  title: z.string().trim().min(1).max(120),
  agentId: z.uuid(),
  instructions: z.string().trim().min(1).max(8_000),
  acceptance: z.string().trim().max(2_000).default(''),
});

const Fields = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/, 'a short name: letters, digits, spaces, . _ -'),
  description: z.string().trim().max(8_000).nullable(),
  goal: z.string().trim().min(1).max(4_000),
  steps: z.array(Step).min(1).max(30),
  // 5 or 6 cron fields, e.g. "0 9 * * *" for every day at 09:00.
  schedule: z
    .string()
    .trim()
    .regex(/^\S+(\s+\S+){4,5}$/, 'a cron pattern like "0 9 * * *"')
    .nullable(),
  timezone: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  budget: z
    .object({
      maxStepAttempts: z.number().int().min(1).max(10),
      maxReplans: z.number().int().min(0).max(20),
      maxTokens: z.number().int().min(1_000).max(10_000_000),
      maxMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60),
    })
    .partial()
    .nullable(),
  approveAll: z.boolean().nullable(),
  slack: z.boolean(),
});
const Create = Fields.partial({
  description: true,
  schedule: true,
  timezone: true,
  enabled: true,
  budget: true,
  approveAll: true,
  slack: true,
});
const Update = Fields.partial();

const validTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Drops absent fields so they can't override the defaults with undefined. */
const cleanBudget = (b: z.infer<typeof Fields>['budget'] | undefined): Partial<Budget> | null =>
  b
    ? (Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as Partial<Budget>)
    : null;

export function jobRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db, queues } = deps;
  async function dto(row: typeof jobs.$inferSelect): Promise<JobDto> {
    const [last] = await db
      .select({ id: tasks.id, status: tasks.status, createdAt: tasks.createdAt })
      .from(tasks)
      .where(eq(tasks.jobId, row.id))
      .orderBy(desc(tasks.createdAt))
      .limit(1);
    const next =
      row.enabled && row.schedule ? await queues.nextRun(row.id).catch(() => null) : null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      goal: row.goal,
      steps: row.steps,
      schedule: row.schedule,
      timezone: row.timezone,
      enabled: row.enabled,
      budget: row.budget,
      approveAll: row.approveAll,
      slack: row.slack,
      nextRunAt: next?.toISOString() ?? null,
      lastRun: last ? { ...last, createdAt: last.createdAt.toISOString() } : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  async function get(id: string) {
    const row = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
    if (!row) throw notFound('Job');
    return row;
  }
  async function requireAgents(agentIds: string[]) {
    const wanted = [...new Set(agentIds)];
    const found = await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, wanted));
    if (found.length !== wanted.length)
      throw new HttpError(400, 'A step uses an agent that does not exist.');
  }
  /** Applies the cron schedule; an invalid pattern fails here, before the change is kept. */
  async function applySchedule(row: typeof jobs.$inferSelect) {
    try {
      await queues.syncSchedule(row);
    } catch (error) {
      throw new HttpError(
        400,
        `The schedule isn't valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  app.get('/api/jobs', async () => {
    const rows = await db.select().from(jobs).orderBy(jobs.name);
    return Promise.all(rows.map(dto));
  });

  app.get('/api/jobs/:id', async (request) => dto(await get(parse(IdParams, request.params).id)));

  // The runs of a job are ordinary projects, newest first.
  app.get('/api/jobs/:id/runs', async (request) => {
    const { id } = parse(IdParams, request.params);
    await get(id);
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.jobId, id))
      .orderBy(desc(tasks.createdAt))
      .limit(50);
  });

  app.post('/api/jobs', async (request, reply) => {
    const { budget, ...body } = parse(Create, request.body);
    const timezone = body.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!validTimezone(timezone)) throw new HttpError(400, `Unknown time zone ${timezone}.`);
    await requireAgents(body.steps.map((s) => s.agentId));
    const [row] = await db
      .insert(jobs)
      .values({
        ...body,
        timezone,
        description: body.description ?? null,
        schedule: body.schedule ?? null,
        budget: cleanBudget(budget),
        approveAll: body.approveAll ?? null,
      })
      .returning();
    if (!row) throw new HttpError(500, 'Job insert returned no row.');
    try {
      await applySchedule(row);
    } catch (error) {
      await db.delete(jobs).where(eq(jobs.id, row.id));
      throw error;
    }
    return reply.code(201).send(await dto(row));
  });

  app.patch('/api/jobs/:id', async (request) => {
    const current = await get(parse(IdParams, request.params).id);
    const { budget, ...body } = parse(Update, request.body);
    if (body.timezone && !validTimezone(body.timezone)) {
      throw new HttpError(400, `Unknown time zone ${body.timezone}.`);
    }
    if (body.steps) await requireAgents(body.steps.map((s) => s.agentId));
    const [row] = await db
      .update(jobs)
      .set({
        ...body,
        ...(budget !== undefined ? { budget: cleanBudget(budget) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, current.id))
      .returning();
    if (!row) throw notFound('Job');
    try {
      await applySchedule(row);
    } catch (error) {
      await db.update(jobs).set(current).where(eq(jobs.id, current.id));
      throw error;
    }
    return dto(row);
  });

  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const [row] = await db.delete(jobs).where(eq(jobs.id, id)).returning({ id: jobs.id });
    if (!row) throw notFound('Job');
    await queues.syncSchedule({ id, schedule: null, timezone: 'UTC', enabled: false });
    return reply.code(204).send();
  });

  // Run now: the same as a schedule firing, but it says why when it can't start.
  app.post('/api/jobs/:id/run', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await get(id);
    const result = await startJobRun(deps, id);
    if (!result.started) throw new HttpError(409, result.detail);
    return reply.code(201).send({ taskId: result.taskId });
  });
}
