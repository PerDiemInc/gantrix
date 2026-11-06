import { readFile, stat } from 'node:fs/promises';
import type { Budget } from '@gantrix/shared';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approvals, events, plans, steps, tasks } from '../../db/schema.ts';
import { cancelTask, createTask } from '../../engine/commands.ts';
import { fileTools } from '../../skills/tools/files.ts';
import { resolveInWorkspace } from '../../skills/workspace.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const MAX_FILE_BYTES = 256 * 1024;

const CreateTask = z.object({
  goal: z.string().trim().min(1).max(4_000),
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
    .optional(),
  approveAll: z.boolean().optional(),
});
const ListTasks = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const EventsPage = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1_000).default(500),
});
const FileQuery = z.object({ path: z.string().min(1) });

export function taskRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  async function getTask(id: string) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    if (!task) throw notFound('Task');
    return task;
  }

  app.get('/api/tasks', async (request) => {
    const { limit } = parse(ListTasks, request.query);
    const rows = await db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit);
    const ids = rows.map((t) => t.id);
    const counts = ids.length
      ? await db
          .select({ taskId: steps.taskId, status: steps.status, n: sql<number>`count(*)::int` })
          .from(steps)
          .where(and(inArray(steps.taskId, ids), ne(steps.status, 'superseded')))
          .groupBy(steps.taskId, steps.status)
      : [];
    return rows.map((t) => ({
      ...t,
      stepCounts: Object.fromEntries(
        counts.filter((c) => c.taskId === t.id).map((c) => [c.status, c.n]),
      ),
    }));
  });

  app.post('/api/tasks', async (request, reply) => {
    const input = parse(CreateTask, request.body);
    // Drop absent fields so they can't override the defaults with undefined.
    const budget = Object.fromEntries(
      Object.entries(input.budget ?? {}).filter(([, v]) => v !== undefined),
    ) as Partial<Budget>;
    const task = await createTask(deps, {
      goal: input.goal,
      budget,
      ...(input.approveAll === undefined ? {} : { approveAll: input.approveAll }),
    });
    return reply.code(201).send(task);
  });

  /** Everything the task page needs: the task, every plan version, every step and approval. */
  app.get('/api/tasks/:id', async (request) => {
    const task = await getTask(parse(IdParams, request.params).id);
    const [planRows, stepRows, approvalRows] = await Promise.all([
      db.select().from(plans).where(eq(plans.taskId, task.id)).orderBy(asc(plans.version)),
      db.select().from(steps).where(eq(steps.taskId, task.id)).orderBy(asc(steps.id)),
      db.select().from(approvals).where(eq(approvals.taskId, task.id)).orderBy(asc(approvals.id)),
    ]);
    return { ...task, plans: planRows, steps: stepRows, approvals: approvalRows };
  });

  app.post('/api/tasks/:id/cancel', async (request) => {
    const task = await getTask(parse(IdParams, request.params).id);
    return { cancelled: await cancelTask(deps, task.id) };
  });

  app.get('/api/tasks/:id/events', async (request) => {
    const task = await getTask(parse(IdParams, request.params).id);
    const { after, limit } = parse(EventsPage, request.query);
    return db
      .select()
      .from(events)
      .where(and(eq(events.taskId, task.id), gt(events.id, after)))
      .orderBy(asc(events.id))
      .limit(limit);
  });

  app.get('/api/tasks/:id/files', async (request) => {
    const task = await getTask(parse(IdParams, request.params).id);
    const list = fileTools(task.workspacePath).find((t) => t.name === 'list_files');
    const listing = list ? String(await list.invoke({})) : '(empty)';
    return { files: listing === '(empty)' ? [] : listing.split('\n') };
  });

  app.get('/api/tasks/:id/files/content', async (request, reply) => {
    const task = await getTask(parse(IdParams, request.params).id);
    const { path } = parse(FileQuery, request.query);
    const file = await resolveInWorkspace(task.workspacePath, path).catch((error: Error) => {
      throw new HttpError(400, error.message);
    });
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw notFound('File');
    if (info.size > MAX_FILE_BYTES)
      throw new HttpError(413, `File is larger than ${MAX_FILE_BYTES} bytes.`);
    return reply.type('text/plain; charset=utf-8').send(await readFile(file, 'utf8'));
  });
}
