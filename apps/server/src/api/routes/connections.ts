import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONNECTION_PROVIDERS,
  type ConnectionProvider,
  DEFAULT_HTTP_REQUEST,
  HTTP_METHODS,
  isServiceProvider,
} from '@gantrix/shared';
import { HumanMessage } from '@langchain/core/messages';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents, connections } from '../../db/schema.ts';
import { modelDefaults } from '../../engine/deps.ts';
import { clearModelCatalog, modelCatalog } from '../../models/catalog.ts';
import {
  connectionSpec,
  effectiveUrl,
  isModelConnection,
  resolveHeaders,
  toConnectionDto,
} from '../../models/connections.ts';
import { callHttp, listPaths } from '../../models/http-request.ts';
import { detectLocalAgents } from '../../models/local-agents.ts';
import { createChatModel } from '../../models/provider.ts';
import { loadDefaultModel } from '../../settings.ts';
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
  provider: z.enum(CONNECTION_PROVIDERS),
  // http(s) URL (custom HTTP may contain {{model}} or {{prompt}}); for claude-code, the
  // path of the claude binary if it isn't on PATH.
  baseUrl: z
    .union([
      z.string().regex(/^https?:\/\/[^\s]+$/, 'an http(s) URL'),
      z.string().regex(/^\/[^\0]+$/),
    ])
    .nullable(),
  headers: Headers,
  // GitHub and Slack: non-secret settings. Which keys are allowed is checked per provider.
  settings: z.record(z.string().regex(/^[A-Za-z]{1,32}$/), z.string().max(2_000)),
  request: z
    .object({
      method: z.enum(HTTP_METHODS).default('POST'),
      contentType: z
        .string()
        .regex(/^[\w.+-]+\/[\w.+-]+(;\s*[\w-]+=[\w.-]+)*$/, 'a content type like application/json')
        .default('application/json'),
      bodyTemplate: z.string().max(20_000).default(DEFAULT_HTTP_REQUEST.bodyTemplate),
      replyPath: z
        .string()
        .max(200)
        .regex(/^[\w.-]*$/, 'a dotted path like choices.0.message.content')
        .default(''),
    })
    .nullable(),
});
const Create = Fields.partial({ baseUrl: true, headers: true, request: true, settings: true });
const Update = Fields.partial();
const TestBody = z.object({
  model: z.string().min(1).max(200),
  // Custom HTTP: what {{prompt}} is in the test call.
  prompt: z.string().min(1).max(2_000).default('Reply with the single word: OK'),
});

const pathsOf = (raw: string) => {
  try {
    return listPaths(JSON.parse(raw));
  } catch {
    return [];
  }
};

/** What each service connection holds: secret headers (saved or env:NAME) and plain settings. */
const SERVICES = {
  github: { required: ['Authorization'], optional: [], settings: ['org', 'repos'] },
  slack: {
    required: ['Bot-Token'],
    optional: ['App-Token'],
    settings: ['channel', 'allowedUsers'],
  },
} as const;

function checkService(
  provider: ConnectionProvider,
  headers: Record<string, string>,
  settings: Record<string, string>,
) {
  if (!isServiceProvider(provider)) return;
  const spec = SERVICES[provider];
  for (const name of spec.required) {
    if (!headers[name]) {
      throw new HttpError(400, `A ${provider} connection needs the ${name} value (or env:NAME).`);
    }
  }
  const allowedHeaders: readonly string[] = [...spec.required, ...spec.optional];
  for (const name of Object.keys(headers)) {
    if (!allowedHeaders.includes(name)) {
      throw new HttpError(400, `A ${provider} connection has no ${name} header.`);
    }
  }
  const allowedSettings: readonly string[] = spec.settings;
  for (const name of Object.keys(settings)) {
    if (!allowedSettings.includes(name)) {
      throw new HttpError(400, `A ${provider} connection has no ${name} setting.`);
    }
  }
  if (provider === 'slack') {
    const bot = headers['Bot-Token'];
    if (bot && !bot.startsWith('env:') && !bot.startsWith('xoxb-') && bot !== KEEP) {
      throw new HttpError(400, 'The Slack bot token starts with xoxb-.');
    }
    const app = headers['App-Token'];
    if (app && !app.startsWith('env:') && !app.startsWith('xapp-') && app !== KEEP) {
      throw new HttpError(400, 'The Slack app-level token starts with xapp-.');
    }
    const channel = settings.channel;
    if (channel && !/^[CGD][A-Z0-9]{8,}$/.test(channel)) {
      throw new HttpError(400, 'The Slack channel is an ID like C0123456789, not a name.');
    }
  }
}

/** Calls the service with the saved credentials, so a wrong token shows up before a job runs. */
async function testService(
  c: typeof connections.$inferSelect,
  ollamaUrl: string,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(15_000);
  try {
    const headers = resolveHeaders(c.headers);
    const base = effectiveUrl(c, ollamaUrl).replace(/\/+$/, '');
    if (c.provider === 'github') {
      const auth = { ...headers, accept: 'application/vnd.github+json', 'user-agent': 'gantrix' };
      const res = await fetch(`${base}/user`, { headers: auth, signal: timeout });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}.`);
      const who = (await res.json()) as { login?: string };
      const org = c.settings.org;
      if (org) {
        const o = await fetch(`${base}/orgs/${encodeURIComponent(org)}`, {
          headers: auth,
          signal: timeout,
        });
        if (!o.ok) throw new Error(`Signed in as ${who.login}, but ${org} answered ${o.status}.`);
      }
      return {
        ok: true,
        reply: `Signed in as ${who.login ?? 'unknown'}${org ? `; can see ${org}` : ''}.`,
        ms: Date.now() - started,
      };
    }
    const slack = async (method: string, token: string, body?: Record<string, string>) => {
      const res = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body ?? {}),
        signal: timeout,
      });
      return (await res.json()) as Record<string, string | boolean | undefined>;
    };
    const bot = headers['Bot-Token'] ?? '';
    const auth = await slack('auth.test', bot);
    if (!auth.ok) throw new Error(`Slack said: ${auth.error ?? 'auth failed'}.`);
    let note = `Bot ${auth.user} in ${auth.team}.`;
    if (c.settings.channel) {
      const info = await slack('conversations.info', bot, { channel: c.settings.channel });
      note += info.ok
        ? ' Channel found.'
        : ` Channel ${c.settings.channel}: ${info.error ?? 'not found'} (invite the bot to it).`;
    }
    const app = headers['App-Token'];
    if (app) {
      const sock = await slack('apps.connections.open', app);
      note += sock.ok ? ' Socket Mode works.' : ` App token: ${sock.error ?? 'rejected'}.`;
    }
    return { ok: true, reply: note, ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      ms: Date.now() - started,
    };
  }
}

/** A path is only a valid base URL for claude-code, where it names the binary. */
function checkUrl(provider: ConnectionProvider, baseUrl: string | null | undefined) {
  if (
    baseUrl &&
    provider !== 'claude-code' &&
    provider !== 'codex' &&
    !/^https?:\/\//.test(baseUrl)
  ) {
    throw new HttpError(400, 'baseUrl must be an http(s) URL.');
  }
  if (provider === 'http' && !baseUrl) {
    throw new HttpError(400, 'A custom HTTP connection needs its URL in baseUrl.');
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

  // Claude Code and the Codex CLI, if this machine has them (for "offload to").
  app.get('/api/local-agents', async () => detectLocalAgents());

  app.post('/api/connections', async (request, reply) => {
    const body = parse(Create, request.body);
    checkUrl(body.provider, body.baseUrl);
    if (Object.values(body.headers ?? {}).includes(KEEP)) {
      throw new HttpError(400, `"${KEEP}" isn't a header value; give the value or env:NAME.`);
    }
    checkService(body.provider, body.headers ?? {}, body.settings ?? {});
    const [row] = await db
      .insert(connections)
      .values({
        ...body,
        baseUrl: body.baseUrl ?? null,
        headers: body.headers ?? {},
        settings: isServiceProvider(body.provider) ? (body.settings ?? {}) : {},
        request: body.provider === 'http' ? (body.request ?? DEFAULT_HTTP_REQUEST) : null,
      })
      .returning();
    if (!row) throw new HttpError(500, 'Connection insert returned no row.');
    clearModelCatalog();
    return reply.code(201).send(dto(row));
  });

  app.patch('/api/connections/:id', async (request) => {
    const current = await get(parse(IdParams, request.params).id);
    const body = parse(Update, request.body);
    checkUrl(
      body.provider ?? current.provider,
      body.baseUrl === undefined ? current.baseUrl : body.baseUrl,
    );
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
    const provider = body.provider ?? current.provider;
    const settings = isServiceProvider(provider) ? (body.settings ?? current.settings) : {};
    checkService(provider, headers ?? current.headers, settings);
    const [row] = await db
      .update(connections)
      .set({
        ...body,
        ...(headers ? { headers } : {}),
        settings,
        // Request settings only mean something for custom HTTP.
        ...((body.provider ?? current.provider) === 'http'
          ? body.request !== undefined
            ? { request: body.request ?? DEFAULT_HTTP_REQUEST }
            : {}
          : { request: null }),
        updatedAt: new Date(),
      })
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
    // The default model's connection can't go while it is the default: nothing would use it.
    if ((await loadDefaultModel(db)).connectionId === id) {
      throw new HttpError(
        409,
        "This is the default model's connection; choose another default model first (Agents page).",
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
    if (!isModelConnection(c)) return testService(c, config.OLLAMA_BASE_URL);
    const { model, prompt } = parse(TestBody, request.body);
    const started = Date.now();
    // Custom HTTP: one real call with the template, showing the request and raw response, so
    // the body template and reply path can be checked.
    if (c.provider === 'http') {
      const spec = connectionSpec(c, model);
      const vars = {
        prompt,
        system: '',
        model,
        messages: [{ role: 'user' as const, content: prompt }],
      };
      try {
        const r = await callHttp(
          c.baseUrl ?? '',
          { ...DEFAULT_HTTP_REQUEST, ...c.request },
          spec.headers ?? {},
          vars,
          AbortSignal.timeout(30_000),
        );
        return {
          ok: true,
          reply: r.reply.slice(0, 500),
          ms: Date.now() - started,
          http: { ...r, paths: pathsOf(r.raw) },
        };
      } catch (error) {
        const result = (error as { result?: unknown }).result;
        return {
          ok: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          ms: Date.now() - started,
          ...(result ? { http: result } : {}),
        };
      }
    }
    // Claude Code needs a folder to work in; give it an empty one that is removed afterwards.
    const scratch =
      c.provider === 'claude-code' || c.provider === 'codex'
        ? await mkdtemp(join(tmpdir(), 'gantrix-test-'))
        : null;
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
