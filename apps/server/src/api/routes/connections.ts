import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_PROVIDERS, type ModelProvider } from '@gantrix/shared';
import { HumanMessage } from '@langchain/core/messages';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents, connections } from '../../db/schema.ts';
import { modelDefaults } from '../../engine/deps.ts';
import { clearModelCatalog, modelCatalog } from '../../models/catalog.ts';
import { connectionSpec, toConnectionDto } from '../../models/connections.ts';
import { createChatModel } from '../../models/provider.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

/** Sent back in place of a saved value: an update that keeps it says "hidden" again. */
const KEEP = 'hidden';

const Headers = z
  .record(
    z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'header names are letters, digits and dashes'),
    z
      .string()
      .min(1)
      .max(4_096)
      .regex(/^[^\r\n]*$/, 'header values are one line'),
  )
  .refine((h) => Object.keys(h).length <= 16, 'at most 16 headers');

const Fields = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'name must be lowercase letters, digits and dashes'),
  provider: z.enum(MODEL_PROVIDERS),
  // For claude-code: the path of the claude binary, if it isn't on PATH.
  baseUrl: z.union([z.url({ protocol: /^https?$/ }), z.string().regex(/^\/[^\0]+$/)]).nullable(),
  headers: Headers,
});
const Create = Fields.partial({ baseUrl: true, headers: true });
const Update = Fields.partial();
const TestBody = z.object({ model: z.string().min(1).max(200) });

/** A path is only a valid base URL for claude-code, where it names the binary. */
function checkUrl(provider: ModelProvider, baseUrl: string | null | undefined) {
  if (baseUrl && provider !== 'claude-code' && !/^https?:\/\//.test(baseUrl)) {
    throw new HttpError(400, 'baseUrl must be an http(s) URL.');
  }
}

export function connectionRoutes(app: FastifyInstance, { db, config }: ApiDeps): void {
  const dto = (c: typeof connections.$inferSelect) => toConnectionDto(c, config.OLLAMA_BASE_URL);
  async function get(id: string) {
    const c = await db.query.connections.findFirst({ where: eq(connections.id, id) });
    if (!c) throw notFound('Connection');
    return c;
  }

  // For the agent form: the models each place offers. ?fresh=1 skips the one-minute cache.
  app.get('/api/models', async (request) => {
    const { fresh } = parse(z.object({ fresh: z.stringbool().optional() }), request.query);
    const rows = await db.select().from(connections).orderBy(asc(connections.name));
    return modelCatalog(rows, config.OLLAMA_BASE_URL, fresh ?? false);
  });

  app.get('/api/connections', async () =>
    (await db.select().from(connections).orderBy(asc(connections.name))).map(dto),
  );

  app.get('/api/connections/:id', async (request) =>
    dto(await get(parse(IdParams, request.params).id)),
  );

  app.post('/api/connections', async (request, reply) => {
    const body = parse(Create, request.body);
    checkUrl(body.provider, body.baseUrl);
    if (Object.values(body.headers ?? {}).includes(KEEP)) {
      throw new HttpError(400, `"${KEEP}" isn't a header value; give the value or env:NAME.`);
    }
    const [row] = await db
      .insert(connections)
      .values({ ...body, baseUrl: body.baseUrl ?? null, headers: body.headers ?? {} })
      .returning();
    if (!row) throw new HttpError(500, 'Connection insert returned no row.');
    clearModelCatalog();
    return reply.code(201).send(dto(row));
  });

  app.patch('/api/connections/:id', async (request) => {
    const current = await get(parse(IdParams, request.params).id);
    const body = parse(Update, request.body);
    checkUrl(body.provider ?? current.provider, body.baseUrl);
    // Headers are replaced as a set; "hidden" keeps the saved value of that header.
    const headers = body.headers
      ? Object.fromEntries(
          Object.entries(body.headers).map(([k, v]) => {
            if (v !== KEEP) return [k, v];
            const saved = current.headers[k];
            if (saved === undefined) throw new HttpError(400, `Header ${k} has no saved value.`);
            return [k, saved];
          }),
        )
      : undefined;
    const [row] = await db
      .update(connections)
      .set({ ...body, ...(headers ? { headers } : {}), updatedAt: new Date() })
      .where(eq(connections.id, current.id))
      .returning();
    if (!row) throw notFound('Connection');
    clearModelCatalog();
    return dto(row);
  });

  app.delete('/api/connections/:id', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const users = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.connectionId, id));
    if (users.length) {
      throw new HttpError(
        409,
        `Connection is used by ${users.map((u) => u.name).join(', ')}; move them to another connection first.`,
      );
    }
    const [row] = await db
      .delete(connections)
      .where(eq(connections.id, id))
      .returning({ id: connections.id });
    if (!row) throw notFound('Connection');
    clearModelCatalog();
    return reply.code(204).send();
  });

  // Sends one short prompt, so you know the URL, key and model name work before a task runs.
  app.post('/api/connections/:id/test', async (request) => {
    const c = await get(parse(IdParams, request.params).id);
    const { model } = parse(TestBody, request.body);
    const started = Date.now();
    // Claude Code needs a folder to work in; give it an empty one that is removed afterwards.
    const scratch =
      c.provider === 'claude-code' ? await mkdtemp(join(tmpdir(), 'gantrix-test-')) : null;
    try {
      const chat = createChatModel(
        { ...connectionSpec(c, model), ...(scratch ? { workspace: scratch } : {}) },
        scratch ? 'worker' : 'planner',
        modelDefaults(config),
        0,
      );
      const reply = await chat.invoke([new HumanMessage('Reply with the single word: OK')], {
        signal: AbortSignal.timeout(scratch ? 120_000 : 30_000),
      });
      const text =
        typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content);
      return { ok: true, reply: text.trim().slice(0, 200), ms: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        ms: Date.now() - started,
      };
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  });
}
