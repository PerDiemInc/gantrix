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

describe('api', () => {
  it('requires the bearer token everywhere except /api/health', async () => {
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect((await app.inject('/api/tasks')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/tasks', headers: { authorization: 'Bearer nope' } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ url: `/api/tasks?token=${token}` })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/tasks', headers: auth })).statusCode).toBe(200);
  });

  it('creates agents, rejects duplicates and bad input', async () => {
    const create = (body: object) =>
      app.inject({ method: 'POST', url: '/api/agents', headers: auth, payload: body });
    expect((await create({ name: 'writer', maxConcurrency: 2 })).statusCode).toBe(201);
    expect((await create({ name: 'writer' })).statusCode).toBe(409);
    expect((await create({ name: 'Bad Name' })).statusCode).toBe(400);
    expect(
      (await create({ name: 'x', skillIds: ['01a1ad93-969e-770a-ac86-c319f1b264f3'] })).statusCode,
    ).toBe(400);
  });

  it('creates a task with a merged budget and returns its detail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: auth,
      payload: { goal: 'Do something', budget: { maxMinutes: 5 } },
    });
    expect(res.statusCode).toBe(201);
    const task = res.json();
    expect(task.budget).toEqual({
      maxStepAttempts: 3,
      maxReplans: 5,
      maxTokens: 200_000,
      maxMinutes: 5,
    });
    const detail = (await app.inject({ url: `/api/tasks/${task.id}`, headers: auth })).json();
    expect(detail).toMatchObject({ id: task.id, plans: [], steps: [] });
    const outside = await app.inject({
      url: `/api/tasks/${task.id}/files/content?path=../../etc/passwd`,
      headers: auth,
    });
    expect(outside.statusCode).toBe(400);
  });
});
