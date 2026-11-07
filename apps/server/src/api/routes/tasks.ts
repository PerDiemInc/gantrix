import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Budget, StepConversationDto, StreamEvent, TaskListItem } from '@gantrix/shared';
import type { BaseMessage } from '@langchain/core/messages';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents, approvals, events, plans, steps, taskMessages, tasks } from '../../db/schema.ts';
import {
  cancelTask,
  createTask,
  editStep,
  extendTask,
  sendMessage,
  setTeam,
} from '../../engine/commands.ts';
import { stepThreadId } from '../../engine/threads.ts';
import { fileTools } from '../../skills/tools/files.ts';
import { resolveInWorkspace } from '../../skills/workspace.ts';
import { toConversation } from '../conversation.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const MAX_FILE_BYTES = 256 * 1024;
// Images for previews come as base64 JSON; they're bigger than text files.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

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
  agentIds: z.array(z.uuid()).max(32).optional(),
});
const ListTasks = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const EventsPage = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1_000).default(500),
});
const FileQuery = z.object({
  path: z.string().min(1),
  encoding: z.enum(['text', 'base64']).default('text'),
});
const StepParams = z.object({ id: z.uuid(), stepId: z.uuid() });
const EditStep = z
  .object({
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(8_000),
    acceptance: z.string().trim().min(1).max(2_000),
    agentId: z.uuid(),
    rerun: z.boolean(),
  })
  .partial();
const Team = z.object({ agentIds: z.array(z.uuid()).max(32).nullable() });
const Extend = z
  .object({
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    tokens: z.number().int().min(1_000).max(10_000_000).optional(),
    replans: z.number().int().min(1).max(20).optional(),
  })
  .refine((e) => e.minutes || e.tokens || e.replans, 'Give minutes, tokens or replans to add.');
const MessageBody = z.object({
  text: z.string().trim().min(1).max(4_000),
  stepId: z.uuid().optional(),
});

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
    const [current, pending, latest] = ids.length
      ? await Promise.all([
          db
            .select({
              id: steps.id,
              taskId: steps.taskId,
              key: steps.key,
              title: steps.title,
              agentId: steps.agentId,
              status: steps.status,
            })
            .from(steps)
            .where(and(inArray(steps.taskId, ids), ne(steps.status, 'superseded')))
            .orderBy(asc(steps.id)),
          db
            .select({ taskId: approvals.taskId, n: sql<number>`count(*)::int` })
            .from(approvals)
            .where(and(inArray(approvals.taskId, ids), eq(approvals.status, 'pending')))
            .groupBy(approvals.taskId),
          // The newest event per project; uses events_task_id_idx (task_id, id).
          db
            .selectDistinctOn([events.taskId])
            .from(events)
            .where(inArray(events.taskId, ids))
            .orderBy(events.taskId, desc(events.id)),
        ])
      : [[], [], []];
    const ACTIVE = new Set(['running', 'judging', 'awaiting_approval', 'queued']);
    const stateOf = (statuses: string[]): TaskListItem['team'][number]['state'] => {
      if (statuses.some((s) => s === 'running' || s === 'judging')) return 'working';
      if (statuses.includes('awaiting_approval')) return 'waiting';
      if (statuses.includes('queued')) return 'queued';
      if (statuses.length && statuses.every((s) => s === 'succeeded')) return 'done';
      return 'idle';
    };
    return rows.map((t): TaskListItem => {
      const mine = current.filter((s) => s.taskId === t.id);
      const agentIds = [...new Set(mine.flatMap((s) => (s.agentId ? [s.agentId] : [])))];
      const ev = latest.find((e) => e.taskId === t.id);
      return {
        ...t,
        createdAt: t.createdAt.toISOString(),
        startedAt: t.startedAt?.toISOString() ?? null,
        finishedAt: t.finishedAt?.toISOString() ?? null,
        stepCounts: Object.fromEntries(
          counts.filter((c) => c.taskId === t.id).map((c) => [c.status, c.n]),
        ),
        team: agentIds.map((agentId) => ({
          agentId,
          state: stateOf(mine.filter((s) => s.agentId === agentId).map((s) => s.status)),
        })),
        active: mine.filter((s) => ACTIVE.has(s.status)).map(({ taskId: _, ...s }) => s),
        pendingApprovals: pending.find((p) => p.taskId === t.id)?.n ?? 0,
        lastEvent: ev
          ? ({
              ...ev.payload,
              id: ev.id,
              taskId: ev.taskId,
              at: ev.createdAt.toISOString(),
            } as StreamEvent)
          : null,
      };
    });
  });

  app.post('/api/tasks', async (request, reply) => {
    const input = parse(CreateTask, request.body);
    if (input.agentIds?.length) {
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(inArray(agents.id, input.agentIds));
      if (found.length !== new Set(input.agentIds).size) {
        throw new HttpError(400, 'Some of the chosen agents do not exist.');
      }
    }
    // Drop absent fields so they can't override the defaults with undefined.
    const budget = Object.fromEntries(
      Object.entries(input.budget ?? {}).filter(([, v]) => v !== undefined),
    ) as Partial<Budget>;
    const task = await createTask(deps, {
      goal: input.goal,
      budget,
      ...(input.approveAll === undefined ? {} : { approveAll: input.approveAll }),
      ...(input.agentIds?.length ? { agentIds: input.agentIds } : {}),
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

  // More time, tokens or replans; a project that stopped on its budget starts again.
  app.post('/api/tasks/:id/extend', async (request) => {
    const task = await getTask(parse(IdParams, request.params).id);
    const add = parse(Extend, request.body);
    const r = await extendTask(deps, task.id, {
      ...(add.minutes ? { minutes: add.minutes } : {}),
      ...(add.tokens ? { tokens: add.tokens } : {}),
      ...(add.replans ? { replans: add.replans } : {}),
    });
    if (r.status === 'finished') {
      throw new HttpError(409, 'This project has finished; start a new one to keep going.');
    }
    return r;
  });

  // The user edits a task (and can run it again); see editStep for the rules.
  app.patch('/api/tasks/:id/steps/:stepId', async (request) => {
    const { id, stepId } = parse(StepParams, request.params);
    const body = parse(EditStep, request.body);
    const r = await editStep(deps, id, stepId, {
      ...(body.title ? { title: body.title } : {}),
      ...(body.instructions ? { instructions: body.instructions } : {}),
      ...(body.acceptance ? { acceptance: body.acceptance } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
      ...(body.rerun ? { rerun: true } : {}),
    });
    if (r.status === 'not_found') throw notFound('Task');
    if (r.status === 'busy') {
      throw new HttpError(
        409,
        "This task is in progress; send its agent a message instead, or wait until it's done.",
      );
    }
    if (r.status === 'project_closed') throw new HttpError(409, 'This project was cancelled.');
    if (r.status === 'bad_agent') {
      throw new HttpError(
        400,
        "That agent isn't on this project's team. Add it to the team first.",
      );
    }
    return r;
  });

  // Who may work on the project from now on (null = every agent).
  app.put('/api/tasks/:id/team', async (request) => {
    const task = await getTask(parse(IdParams, request.params).id);
    const { agentIds } = parse(Team, request.body);
    if (agentIds?.length) {
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      if (found.length !== new Set(agentIds).size)
        throw new HttpError(400, 'Some agents do not exist.');
    }
    await setTeam(deps, task.id, agentIds);
    return { agentIds: agentIds?.length ? agentIds : null };
  });

  app.post('/api/tasks/:id/cancel', async (request) => {
    const task = await getTask(parse(IdParams, request.params).id);
    return { cancelled: await cancelTask(deps, task.id) };
  });

  app.get('/api/tasks/:id/steps/:stepId/conversation', async (request) => {
    const { id, stepId } = parse(StepParams, request.params);
    // Scoped by task as well as step, so a step id from another task is a 404.
    const step = await db.query.steps.findFirst({
      where: and(eq(steps.id, stepId), eq(steps.taskId, id)),
    });
    if (!step) throw notFound('Step');
    const attempts: StepConversationDto['attempts'] = [];
    for (let attempt = 1; attempt <= step.attempt; attempt++) {
      const tuple = await deps.checkpointer.getTuple({
        configurable: { thread_id: stepThreadId(step.id, attempt), checkpoint_ns: '' },
      });
      const messages = (tuple?.checkpoint.channel_values.messages ?? []) as BaseMessage[];
      if (messages.length) attempts.push({ attempt, messages: toConversation(messages) });
    }
    const dto: StepConversationDto = {
      stepId: step.id,
      key: step.key,
      title: step.title,
      attempts,
    };
    return dto;
  });

  app.get('/api/tasks/:id/messages', async (request) => {
    const task = await getTask(parse(IdParams, request.params).id);
    return db
      .select()
      .from(taskMessages)
      .where(eq(taskMessages.taskId, task.id))
      .orderBy(asc(taskMessages.createdAt));
  });

  app.post('/api/tasks/:id/messages', async (request, reply) => {
    const task = await getTask(parse(IdParams, request.params).id);
    const body = parse(MessageBody, request.body);
    const r = await sendMessage(deps, task.id, {
      text: body.text,
      ...(body.stepId ? { stepId: body.stepId } : {}),
    });
    if (r.status === 'task_finished')
      throw new HttpError(409, 'The task has finished; start a new one.');
    if (r.status === 'no_step') throw notFound('Step');
    if (r.status === 'step_finished') {
      throw new HttpError(409, 'That step has finished; send the note to the whole team instead.');
    }
    return reply.code(201).send({ id: r.id });
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
    const { path, encoding } = parse(FileQuery, request.query);
    const file = await resolveInWorkspace(task.workspacePath, path).catch((error: Error) => {
      throw new HttpError(400, error.message);
    });
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw notFound('File');
    if (encoding === 'base64') {
      const mime = IMAGE_TYPES[extname(file).toLowerCase()];
      if (!mime) throw new HttpError(415, 'Only images can be fetched as base64.');
      if (info.size > MAX_IMAGE_BYTES) {
        throw new HttpError(413, `Image is larger than ${MAX_IMAGE_BYTES} bytes.`);
      }
      return { mime, base64: (await readFile(file)).toString('base64') };
    }
    if (info.size > MAX_FILE_BYTES)
      throw new HttpError(413, `File is larger than ${MAX_FILE_BYTES} bytes.`);
    return reply.type('text/plain; charset=utf-8').send(await readFile(file, 'utf8'));
  });
}
