import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { createTask } from '../../src/engine/commands.ts';
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

  it("returns a step's conversation with tool calls, scoped to its task", async () => {
    await e.addAgent('writer');
    e.fake.script.plan = () => ({
      steps: [
        {
          key: 'notes',
          title: 'Write notes',
          agent: 'writer',
          instructions: 'Write notes.md',
          acceptance: 'notes.md exists',
          dependsOn: [],
        },
      ],
    });
    e.fake.script.worker = ({ toolResults }) =>
      toolResults.length
        ? 'Wrote notes.md.'
        : { name: 'write_file', args: { path: 'notes.md', content: 'hello' } };
    const task = await createTask(e.deps, { goal: 'Write notes' });
    await e.waitFor(task.id);
    const detail = (await app.inject({ url: `/api/tasks/${task.id}`, headers: auth })).json();
    const stepId = detail.steps[0].id;

    const res = await app.inject({
      url: `/api/tasks/${task.id}/steps/${stepId}/conversation`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const convo = res.json();
    expect(convo).toMatchObject({ key: 'notes', attempts: [{ attempt: 1 }] });
    const roles = convo.attempts[0].messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(convo.attempts[0].messages[2].toolCalls[0]).toMatchObject({
      name: 'write_file',
      args: { path: 'notes.md' },
    });
    expect(convo.attempts[0].messages[3]).toMatchObject({ role: 'tool', toolName: 'write_file' });
    expect(convo.attempts[0].messages[4].text).toBe('Wrote notes.md.');

    const other = await createTask(e.deps, { goal: 'Another task' });
    const wrongTask = await app.inject({
      url: `/api/tasks/${other.id}/steps/${stepId}/conversation`,
      headers: auth,
    });
    expect(wrongTask.statusCode).toBe(404);
  });

  it('saves connections without ever returning header values', async () => {
    const post = (body: object) =>
      app.inject({ method: 'POST', url: '/api/connections', headers: auth, payload: body });
    const res = await post({
      name: 'openai-cloud',
      provider: 'openai',
      headers: { Authorization: 'Bearer env:OPENAI_API_KEY', 'OpenAI-Organization': 'org-secret' },
    });
    expect(res.statusCode).toBe(201);
    const conn = res.json();
    expect(conn).toMatchObject({
      provider: 'openai',
      baseUrl: null,
      effectiveUrl: 'https://api.openai.com/v1',
      isLocal: false,
      headers: { Authorization: 'Bearer env:OPENAI_API_KEY', 'OpenAI-Organization': 'hidden' },
    });
    const list = await app.inject({ url: '/api/connections', headers: auth });
    expect(list.body).not.toContain('org-secret');
    expect((await post({ name: 'bad', provider: 'gemini' })).statusCode).toBe(400);
    expect((await post({ name: 'x', provider: 'openai', baseUrl: 'file:///etc' })).statusCode).toBe(
      400,
    );

    // "hidden" keeps the saved value on update.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/connections/${conn.id}`,
      headers: auth,
      payload: { headers: { 'OpenAI-Organization': 'hidden' } },
    });
    expect(patched.json().headers).toEqual({ 'OpenAI-Organization': 'hidden' });

    const agent = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: auth,
      payload: { name: 'gpt', model: 'gpt-5.1', connectionId: conn.id },
    });
    expect(agent.json()).toMatchObject({ connectionId: conn.id });
    const del = () =>
      app.inject({ method: 'DELETE', url: `/api/connections/${conn.id}`, headers: auth });
    expect((await del()).statusCode).toBe(409);
    await app.inject({ method: 'DELETE', url: `/api/agents/${agent.json().id}`, headers: auth });
    expect((await del()).statusCode).toBe(204);
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
