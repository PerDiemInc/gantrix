import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import type { Db } from '../../src/db/client.ts';
import { prTasks } from '../../src/integrations/pr-tasks.ts';

it('configures and plays the built-in PR scan without creating a task', async () => {
  const values = new Map<string, string>();
  const redis = {
    // The API handler is under test. Do not launch a polling worker.
    hgetall: async () => ({}),
    hget: async (_key: string, id: string) => values.get(id) ?? null,
    hset: async (_key: string, id: string, value: string) => values.set(id, value),
    zrevrange: async () => [],
  } as unknown as Redis;
  const app = Fastify();
  const bridge = prTasks(
    app,
    {} as Db,
    redis,
    {} as Pool,
    loadConfig({ DATABASE_URL: 'postgres://localhost/db', REDIS_URL: 'redis://localhost' }),
    'test-api-token',
  );
  const url = '/api/tasks/github-pr-scan/pr-scan';
  try {
    expect((await app.inject(url)).json()).toBeNull();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: {
            enabled: false,
            GITHUB_TOKEN: 'secret',
            GITHUB_PR_ORG: 'PerDiemInc',
            GITHUB_PR_REPOS: [],
            GITHUB_PR_MODEL: 'qwen3:8b',
            GITHUB_PR_INTERVAL_SECONDS: 300,
            SLACK_ALLOWED_USERS: [],
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: `${url}/state`, payload: { enabled: true } }))
        .statusCode,
    ).toBe(200);
    const settings = (await app.inject(url)).json();
    expect(settings.enabled).toBe(true);
    expect(settings.GITHUB_TOKEN).toBeUndefined();
    expect((await app.inject(`${url}/reports`)).json()).toEqual([]);
  } finally {
    await bridge.close();
    await app.close();
  }
});
