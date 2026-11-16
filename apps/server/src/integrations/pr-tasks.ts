import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { z } from 'zod';
import { IdParams, notFound, parse } from '../api/http.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { tasks } from '../db/schema.ts';
import { type SlackEvent, SocketMode } from '../slack/socket.ts';
import { PrBridge } from './pr-bridge.ts';
import { openSettings, PrSettingsSchema, sealSettings, secretFields } from './pr-settings.ts';

const settingsKey = 'gantrix:pr-task-settings';

export function prTasks(
  app: FastifyInstance,
  db: Db,
  redis: Redis,
  pool: Pool,
  config: Config,
  token: string,
) {
  const jobs = new Map<string, { bridge: PrBridge; saved: string; appToken: string | undefined }>();
  const sockets = new Map<string, SocketMode>();
  const sharedSlack =
    config.SLACK_BOT_TOKEN && config.SLACK_CHANNEL_ID ? config.SLACK_APP_TOKEN : undefined;

  async function dispatch(appToken: string | undefined, event: SlackEvent) {
    const text = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!appToken || !text) return false;
    for (const job of jobs.values()) {
      if (job.appToken === appToken && (await job.bridge.handleSlack(event, text))) return true;
    }
    return false;
  }

  async function sync() {
    const saved = await redis.hgetall(settingsKey);
    const ids = Object.keys(saved);
    const existing = ids.length
      ? await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids))
      : [];
    const alive = new Set(existing.map(({ id }) => id));
    for (const id of ids) {
      if (!alive.has(id)) await redis.hdel(settingsKey, id);
    }
    for (const [id, job] of jobs) {
      if (alive.has(id) && saved[id] === job.saved) continue;
      jobs.delete(id);
      await job.bridge.close();
    }
    for (const { id } of existing) {
      const record = saved[id];
      if (!record || jobs.has(id)) continue;
      try {
        const settings = openSettings(id, token, record);
        if (!settings.enabled) continue;
        const bridge = new PrBridge(
          { ...settings, OLLAMA_BASE_URL: config.OLLAMA_BASE_URL },
          redis,
          pool,
          id,
        );
        jobs.set(id, { bridge, saved: record, appToken: settings.SLACK_APP_TOKEN });
        bridge.start();
      } catch {
        console.error(`Could not load PR settings for task ${id}.`);
      }
    }
    const active = new Set([...jobs.values()].map((job) => job.appToken));
    for (const [appToken, socket] of sockets) {
      if (active.has(appToken)) continue;
      socket.close();
      sockets.delete(appToken);
    }
    for (const appToken of active) {
      if (!appToken || appToken === sharedSlack || sockets.has(appToken)) continue;
      const socket = new SocketMode(appToken, config.SLACK_API_URL, async (event) => {
        await dispatch(appToken, event);
      });
      sockets.set(appToken, socket);
      socket.start();
    }
  }

  let pending: Promise<void> | undefined;
  const refresh = () => {
    pending ??= sync()
      .catch(() => console.error('Could not refresh task PR schedules.'))
      .finally(() => {
        pending = undefined;
      });
  };

  const route = '/api/tasks/:id/pr-scan';
  async function taskId(params: unknown) {
    const { id } = parse(IdParams, params);
    const exists = await db.query.tasks.findFirst({
      columns: { id: true },
      where: eq(tasks.id, id),
    });
    if (!exists) throw notFound('Task');
    return id;
  }

  async function get(id: string) {
    const saved = await redis.hget(settingsKey, id);
    return saved ? openSettings(id, token, saved) : undefined;
  }

  app.get(route, async (request, reply) => {
    const value = await get(await taskId(request.params));
    reply.header('Cache-Control', 'no-store');
    if (!value) return null;
    const fields = { ...value };
    for (const field of secretFields) Reflect.deleteProperty(fields, field);
    return { ...fields, savedSecrets: secretFields.filter((field) => Boolean(value[field])) };
  });
  app.put(route, async (request) => {
    const id = await taskId(request.params);
    const fields = parse(z.record(z.string(), z.unknown()), request.body);
    const previous = await get(id);
    const merged = { ...fields };
    for (const field of secretFields) {
      if (!(field in merged) && previous?.[field])
        Object.assign(merged, { [field]: previous[field] });
    }
    const settings = parse(PrSettingsSchema, merged);
    await redis.hset(settingsKey, id, sealSettings(id, token, settings));
    refresh();
    return { ok: true };
  });
  app.delete(route, async (request) => {
    await redis.hdel(settingsKey, await taskId(request.params));
    refresh();
    return { ok: true };
  });

  const timer = setInterval(refresh, 5000);
  refresh();
  return {
    handleSlack: (event: SlackEvent) => dispatch(sharedSlack, event),
    async close() {
      clearInterval(timer);
      await pending;
      for (const socket of sockets.values()) socket.close();
      await Promise.all([...jobs.values()].map((job) => job.bridge.close()));
    },
  };
}
