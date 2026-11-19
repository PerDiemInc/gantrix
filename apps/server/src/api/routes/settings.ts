import {
  DEFAULT_MODEL,
  type DefaultModelDto,
  interpretSlackTest,
  type OllamaCheckDto,
  type OllamaDetectDto,
  type RuntimeSettingsDto,
  type SlackSettingsTestDto,
  type TaskDefaultsDto,
} from '@gantrix/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RUNTIME_DEFAULTS } from '../../config.ts';
import { connections } from '../../db/schema.ts';
import { describeModel } from '../../live.ts';
import { isModelConnection, needsModel } from '../../models/connections.ts';
import { ensureOllama, probeOllama } from '../../models/ollama-runtime.ts';
import {
  applyStoredSettings,
  loadDefaultModel,
  loadSettings,
  type StoredSettings,
  saveDefaultModel,
  saveSettingsGroup,
  settingsFromRows,
} from '../../settings.ts';
import { SlackApi } from '../../slack/api.ts';
import { HttpError, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const DefaultModel = z.object({
  connectionId: z.uuid().nullable(),
  // An empty box means the built-in model.
  model: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((m) => m || null),
});

const BUILT_IN_TASK_DEFAULTS: TaskDefaultsDto = settingsFromRows(new Map()).taskDefaults;

/** A URL for Ollama or the dashboard: http(s), without a trailing slash, nothing sensitive in it. */
const WebUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'an http:// or https:// address, without a password in it')
  .transform((v) => v.replace(/\/+$/, ''));

const OllamaBody = z.object({ baseUrl: WebUrl });
const OllamaCheckBody = z.object({ baseUrl: WebUrl.optional() });
const TaskDefaultsBody = z.object({
  maxMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  maxTokens: z.number().int().min(1_000).max(10_000_000),
  maxReplans: z.number().int().min(0).max(20),
  maxStepAttempts: z.number().int().min(1).max(10),
  askFirst: z.boolean(),
  isolatedSteps: z.boolean(),
  llmConcurrency: z.number().int().min(1).max(16),
});
// A token: a new value replaces it, null removes it, leaving it out keeps what is saved.
const SlackBody = z.object({
  botToken: z
    .string()
    .trim()
    .startsWith('xoxb-', 'The bot token starts with xoxb-.')
    .nullable()
    .optional(),
  appToken: z
    .string()
    .trim()
    .startsWith('xapp-', 'The app-level token starts with xapp-.')
    .nullable()
    .optional(),
  channelId: z
    .string()
    .trim()
    .regex(/^[CG][A-Z0-9]{6,}$/, 'The channel is an ID like C0123456789, not a name.')
    .nullable(),
  allowedUsers: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[UW][A-Z0-9]{6,}$/, 'Member IDs look like U01ABCDE2F.'),
    )
    .max(50),
  dashboardUrl: WebUrl,
});

export function settingsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db, config } = deps;
  /** The default model as saved, and what it works out to now. */
  async function current(): Promise<DefaultModelDto> {
    const [rows, saved] = await Promise.all([db.select().from(connections), loadDefaultModel(db)]);
    const use = describeModel(config, rows, null, saved);
    return {
      ...saved,
      effective: {
        model: use.model,
        provider: use.provider,
        connection: use.connection,
        isLocal: use.isLocal,
      },
      builtIn: DEFAULT_MODEL,
    };
  }

  app.get('/api/settings/default-model', current);

  // What the planner, the judges and every agent without its own model run on.
  app.put('/api/settings/default-model', async (request) => {
    const { connectionId, model } = parse(DefaultModel, request.body);
    if (connectionId) {
      const c = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
      if (!c) throw new HttpError(400, 'That connection does not exist.');
      if (!isModelConnection(c)) {
        throw new HttpError(
          400,
          `Connection "${c.name}" is a ${c.provider} connection, not a model.`,
        );
      }
      if (c.provider === 'claude-code' || c.provider === 'codex' || c.provider === 'http') {
        throw new HttpError(
          400,
          `The default model can't be on "${c.name}" (${c.provider}): the planner and judges need an Ollama, OpenAI or Anthropic model.`,
        );
      }
      if (needsModel(c.provider) && !model) {
        throw new HttpError(400, `Connection "${c.name}" needs a model: choose one.`);
      }
    }
    await saveDefaultModel(db, { connectionId, model });
    return current();
  });

  /** The settings as saved. Secrets are only reported as set or not. */
  const describe = (s: StoredSettings): RuntimeSettingsDto => ({
    ollama: { baseUrl: s.ollama.baseUrl, builtIn: RUNTIME_DEFAULTS.OLLAMA_BASE_URL },
    taskDefaults: s.taskDefaults,
    taskDefaultsBuiltIn: BUILT_IN_TASK_DEFAULTS,
    slack: {
      botTokenSet: Boolean(s.slack.botToken),
      appTokenSet: Boolean(s.slack.appToken),
      channelId: s.slack.channelId,
      allowedUsers: s.slack.allowedUsers,
      dashboardUrl: s.slack.dashboardUrl,
      dashboardUrlBuiltIn: RUNTIME_DEFAULTS.GANTRIX_DASHBOARD_URL,
      posts: Boolean(s.slack.botToken && s.slack.channelId),
      listens: Boolean(s.slack.botToken && s.slack.channelId && s.slack.appToken),
    },
  });
  const currentSettings = async () => describe(await loadSettings(db));
  /** Saved: put it on this process's config now, and tell what has to restart. */
  const applied = async () => {
    await applyStoredSettings(db, config);
    return currentSettings();
  };

  app.get('/api/settings/runtime', currentSettings);

  // Where the local Ollama is.
  app.put('/api/settings/ollama', async (request) => {
    const { baseUrl } = parse(OllamaBody, request.body);
    await saveSettingsGroup(db, 'ollama', { baseUrl });
    return applied();
  });

  // Is there an Ollama at this address? If it is on this machine and not running, start it.
  app.post('/api/settings/ollama/check', async (request): Promise<OllamaCheckDto> => {
    const { baseUrl } = parse(OllamaCheckBody, request.body);
    const status = await (deps.ensureOllama ?? ensureOllama)(baseUrl ?? config.OLLAMA_BASE_URL);
    return status.ok
      ? { ok: true, started: status.started, models: status.models, message: null }
      : { ok: false, started: false, models: [], message: status.message };
  });

  // Look for an Ollama: the saved address, OLLAMA_HOST, and the usual places. If none answers,
  // start one on this machine.
  app.post('/api/settings/ollama/detect', async (): Promise<OllamaDetectDto> => {
    const fromEnv = process.env.OLLAMA_HOST?.trim();
    const norm = (v: string) => {
      const withScheme = /^https?:\/\//.test(v) ? v : `http://${v}`;
      const url = new URL(withScheme);
      if (!url.port) url.port = '11434';
      return url.origin;
    };
    const raw = [
      config.OLLAMA_BASE_URL,
      ...(fromEnv ? [fromEnv] : []),
      'http://127.0.0.1:11434',
      'http://localhost:11434',
      'http://[::1]:11434',
      'http://host.docker.internal:11434',
    ];
    const tried = [
      ...new Set(
        raw.flatMap((v) => {
          try {
            return [norm(v)];
          } catch {
            return [];
          }
        }),
      ),
    ];
    const answers = await Promise.all(tried.map((u) => probeOllama(u)));
    const at = answers.findIndex((m) => m);
    if (at >= 0) {
      return {
        baseUrl: tried[at] ?? null,
        started: false,
        models: answers[at] ?? [],
        tried,
        message: null,
      };
    }
    const status = await (deps.ensureOllama ?? ensureOllama)('http://127.0.0.1:11434');
    return status.ok
      ? {
          baseUrl: 'http://127.0.0.1:11434',
          started: status.started,
          models: status.models,
          tried,
          message: null,
        }
      : { baseUrl: null, started: false, models: [], tried, message: status.message };
  });

  // What a new project starts with.
  app.put('/api/settings/task-defaults', async (request) => {
    await saveSettingsGroup(db, 'task_defaults', { ...parse(TaskDefaultsBody, request.body) });
    return applied();
  });

  // Slack for projects: a thread per project, and replies that steer it.
  app.put('/api/settings/slack', async (request) => {
    const body = parse(SlackBody, request.body);
    const saved = (await loadSettings(db)).slack;
    const botToken = body.botToken === undefined ? saved.botToken : body.botToken;
    const appToken = body.appToken === undefined ? saved.appToken : body.appToken;
    if (botToken && !body.channelId) {
      throw new HttpError(400, 'Choose the channel projects post to (its ID, like C0123456789).');
    }
    if (body.channelId && !botToken) {
      throw new HttpError(400, 'A channel needs a bot token to post with.');
    }
    if (appToken && !botToken) {
      throw new HttpError(400, 'The app-level token needs the bot token too.');
    }
    if (appToken && !body.allowedUsers.length) {
      throw new HttpError(
        400,
        'Replies in Slack steer projects, so name who may: add at least one member ID.',
      );
    }
    await saveSettingsGroup(db, 'slack', {
      botToken,
      appToken,
      channelId: body.channelId,
      allowedUsers: body.allowedUsers,
      dashboardUrl: body.dashboardUrl,
    });
    const after = await applied();
    // The bridge holds the tokens it started with, so it restarts on the new ones.
    await deps.onSlackSettings?.();
    return after;
  });

  // Can the saved tokens reach Slack, and can the bot see the channel?
  app.post('/api/settings/slack/test', async (): Promise<SlackSettingsTestDto> => {
    const { botToken, appToken, channelId } = (await loadSettings(db)).slack;
    if (!botToken) throw new HttpError(400, 'No bot token is saved yet.');
    const asked = async <T extends object>(
      token: string,
      method: string,
      body: Record<string, unknown> = {},
    ) => {
      try {
        return {
          ok: true as const,
          data: await new SlackApi(token, config.SLACK_API_URL).call<T>(method, body, 0),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false as const, code: /failed: (\w+)/.exec(message)?.[1], message };
      }
    };
    const auth = await asked<{ user?: string; team?: string }>(botToken, 'auth.test');
    if (!auth.ok) {
      const outcome = interpretSlackTest({
        ok: false,
        error: auth.code ? `Slack said: ${auth.code}.` : auth.message,
      });
      return { ...outcome, channel: null };
    }
    let reply = `Bot ${auth.data.user ?? 'unknown'} in ${auth.data.team ?? 'unknown'}.`;
    if (appToken) {
      const socket = await asked(appToken, 'apps.connections.open');
      reply += socket.ok ? ' Socket Mode works.' : ` App token: ${socket.code ?? 'rejected'}.`;
    } else {
      reply += ' Socket Mode works.'; // replies are off without an app token; not a fault
    }
    const outcome = interpretSlackTest({ ok: true, reply });
    let channel: SlackSettingsTestDto['channel'] = null;
    if (channelId) {
      channel = (await asked(botToken, 'conversations.info', { channel: channelId })).ok
        ? 'found'
        : 'invite';
    }
    return { ...outcome, channel };
  });
}
