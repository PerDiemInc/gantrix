import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { interpretSlackTest } from '@gantrix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { type Engine, startEngine } from './harness.ts';

let e: Engine;
let app: ReturnType<typeof buildServer>;
let hub: EventHub;
const token = 't'.repeat(32);
const auth = { authorization: `Bearer ${token}` };

beforeAll(async () => {
  e = await startEngine();
  hub = new EventHub(e.db, e.config.DATABASE_URL);
  await hub.start();
  app = buildServer({ ...e.deps, hub }, token, false);
});
afterAll(async () => {
  await app?.close();
  await hub?.close();
  await e?.close();
});
beforeEach(async () => {
  await e.reset();
});

const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: auth, payload });
const patch = (url: string, payload: object) =>
  app.inject({ method: 'PATCH', url, headers: auth, payload });

describe('github and slack connections', () => {
  it('saves them without returning secrets, and keeps them out of the model list', async () => {
    const gh = await post('/api/connections', {
      name: 'gh',
      provider: 'github',
      headers: { Authorization: 'Bearer ghp_secret' },
      settings: { org: 'PerDiemInc' },
    });
    expect(gh.statusCode).toBe(201);
    expect(gh.json()).toMatchObject({
      provider: 'github',
      effectiveUrl: 'https://api.github.com',
      isLocal: false,
      headers: { Authorization: 'hidden' },
      settings: { org: 'PerDiemInc' },
    });
    expect(gh.body).not.toContain('ghp_secret');

    const slack = await post('/api/connections', {
      name: 'team-slack',
      provider: 'slack',
      headers: { 'Bot-Token': 'xoxb-1', 'App-Token': 'env:SLACK_APP_TOKEN' },
      settings: { channel: 'C0123456789' },
    });
    expect(slack.statusCode).toBe(201);

    const models = (await app.inject({ url: '/api/models', headers: auth })).json() as {
      name: string;
    }[];
    expect(models.map((m) => m.name)).toEqual(['Ollama (default)']);
  });

  it('rejects missing or malformed credentials and settings', async () => {
    const bad = (body: object) => post('/api/connections', { name: 'x', ...body });
    expect((await bad({ provider: 'github', headers: {} })).statusCode).toBe(400);
    expect(
      (await bad({ provider: 'slack', headers: { 'Bot-Token': 'xapp-wrong' } })).statusCode,
    ).toBe(400);
    expect(
      (
        await bad({
          provider: 'slack',
          headers: { 'Bot-Token': 'xoxb-1' },
          settings: { channel: '#general' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await bad({
          provider: 'github',
          headers: { Authorization: 'Bearer a' },
          settings: { channel: 'C0123456789' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("can't be used as an agent's model connection", async () => {
    const gh = (
      await post('/api/connections', {
        name: 'gh',
        provider: 'github',
        headers: { Authorization: 'Bearer ghp_x' },
      })
    ).json() as { id: string };
    const res = await post('/api/agents', {
      name: 'a',
      description: 'd',
      connectionId: gh.id,
      model: 'm',
      skills: [],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('not a model') });
  });
});

describe('job api', () => {
  const stepBody = (agentId: string) => ({
    title: 'Fetch PRs',
    agentId,
    instructions: 'List open PRs',
    acceptance: '',
  });

  it('creates, schedules, pauses, runs and deletes a job', async () => {
    const agent = await e.addAgent('writer');
    const created = await post('/api/jobs', {
      name: 'Daily PR scan',
      goal: 'PRs summarized',
      schedule: '0 9 * * *',
      timezone: 'UTC',
      steps: [stepBody(agent.id)],
    });
    expect(created.statusCode).toBe(201);
    const job = created.json() as { id: string; nextRunAt: string | null };
    expect(job.nextRunAt).toBeTruthy();

    const paused = await patch(`/api/jobs/${job.id}`, { enabled: false });
    expect(paused.json()).toMatchObject({ enabled: false, nextRunAt: null });

    const run = await post(`/api/jobs/${job.id}/run`, {});
    expect(run.statusCode).toBe(201);
    const { taskId } = run.json() as { taskId: string };
    // A second run while the first is going is refused, with a reason.
    expect((await post(`/api/jobs/${job.id}/run`, {})).statusCode).toBe(409);
    await e.waitFor(taskId);

    const runs = (await app.inject({ url: `/api/jobs/${job.id}/runs`, headers: auth })).json() as {
      id: string;
    }[];
    expect(runs.map((r) => r.id)).toEqual([taskId]);

    const del = await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect(await e.deps.queues.nextRun(job.id)).toBeNull();
  });

  it('rejects a bad cron pattern, an unknown agent and a duplicate name', async () => {
    const agent = await e.addAgent('writer');
    const body = (extra: object) => ({
      name: 'job',
      goal: 'g',
      steps: [stepBody(agent.id)],
      ...extra,
    });
    expect((await post('/api/jobs', body({ schedule: 'not a cron' }))).statusCode).toBe(400);
    expect((await post('/api/jobs', body({ schedule: '99 99 * * *' }))).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/jobs', headers: auth })).json()).toEqual([]);
    expect(
      (await post('/api/jobs', body({ steps: [stepBody('00000000-0000-7000-8000-000000000000')] })))
        .statusCode,
    ).toBe(400);
    expect((await post('/api/jobs', body({}))).statusCode).toBe(201);
    expect((await post('/api/jobs', body({}))).statusCode).toBe(409);
  });
});

/** A Slack Web API that answers auth.test and apps.connections.open the way a chosen token would. */
function fakeSlack(answers: { bot: Record<string, unknown>; app: Record<string, unknown> }) {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const bot = req.url === '/auth.test';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(bot ? answers.bot : answers.app));
    });
  });
  return server;
}

describe('testing a Slack connection, as the Connect Slack page reads it', () => {
  const run = async (answers: { bot: Record<string, unknown>; app: Record<string, unknown> }) => {
    const slack = fakeSlack(answers);
    await new Promise<void>((r) => slack.listen(0, '127.0.0.1', r));
    try {
      const baseUrl = `http://127.0.0.1:${(slack.address() as AddressInfo).port}`;
      const made = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: auth,
        payload: {
          name: `slack-${Math.random().toString(36).slice(2, 8)}`,
          provider: 'slack',
          baseUrl,
          headers: {
            'Bot-Token': `xoxb-${'1'.repeat(30)}`,
            'App-Token': `xapp-1-${'A'.repeat(30)}`,
          },
          settings: { allowedUsers: 'U01ABCDE2F' },
        },
      });
      expect(made.statusCode).toBe(201);
      const tested = await app.inject({
        method: 'POST',
        url: `/api/connections/${made.json().id}/test`,
        headers: auth,
      });
      expect(tested.statusCode).toBe(200);
      return interpretSlackTest(tested.json());
    } finally {
      slack.close();
    }
  };

  it('reads a working connection: who the bot is, which workspace, and Socket Mode', async () => {
    expect(
      await run({ bot: { ok: true, user: 'gantrix', team: 'Acme Co' }, app: { ok: true } }),
    ).toMatchObject({ ok: true, bot: 'gantrix', team: 'Acme Co', socketMode: true, problems: [] });
  });

  it('blames the bot token when Slack rejects it', async () => {
    const r = await run({ bot: { ok: false, error: 'invalid_auth' }, app: { ok: true } });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      { field: 'bot', message: expect.stringContaining('Bot User OAuth Token') },
    ]);
  });

  it('blames the app-level token when only that one is rejected', async () => {
    const r = await run({
      bot: { ok: true, user: 'gantrix', team: 'Acme Co' },
      app: { ok: false, error: 'invalid_auth' },
    });
    expect(r.ok).toBe(false);
    expect(r.bot).toBe('gantrix');
    expect(r.problems).toEqual([
      { field: 'app', message: expect.stringContaining('connections:write') },
    ]);
  });
});
