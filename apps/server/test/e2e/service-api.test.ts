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
