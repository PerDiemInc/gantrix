import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { agents, connections } from '../../src/db/schema.ts';
import { createTask } from '../../src/engine/commands.ts';
import { resolveModelSpec } from '../../src/models/connections.ts';
import { loadDefaultModel } from '../../src/settings.ts';
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

const get = () => app.inject({ url: '/api/settings/default-model', headers: auth });
const put = (payload: object) =>
  app.inject({ method: 'PUT', url: '/api/settings/default-model', headers: auth, payload });
const connect = async (name: string, provider: string, baseUrl: string | null = null) => {
  const [c] = await e.db
    .insert(connections)
    .values({ name, provider: provider as never, baseUrl })
    .returning();
  if (!c) throw new Error('seed failed');
  return c;
};

describe('the default model is a saved setting', () => {
  it('starts as the built-in model, and shows what it works out to', async () => {
    // The harness saved the fake model; clearing it is "nothing chosen".
    expect((await get()).json()).toMatchObject({
      connectionId: null,
      model: 'fake',
      effective: { model: 'fake', provider: 'ollama', connection: null, isLocal: true },
      builtIn: 'qwen3:8b',
    });
    const cleared = await put({ connectionId: null, model: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ model: null, effective: { model: 'qwen3:8b' } });
    expect(await resolveModelSpec(e.db, null)).toEqual({ model: 'qwen3:8b', baseUrl: null });
    // An empty box is the same as nothing.
    expect((await put({ connectionId: null, model: '   ' })).json().model).toBeNull();
  });

  it('can be a model on a saved connection, which the planner and judges then use', async () => {
    const c = await connect('lmstudio', 'openai', 'http://127.0.0.1:1234/v1');
    const res = await put({ connectionId: c.id, model: ' local-model ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      connectionId: c.id,
      model: 'local-model',
      effective: {
        model: 'local-model',
        provider: 'openai',
        connection: 'lmstudio',
        isLocal: true,
      },
    });
    expect(await loadDefaultModel(e.db)).toEqual({ connectionId: c.id, model: 'local-model' });
    expect(await resolveModelSpec(e.db, null)).toMatchObject({
      provider: 'openai',
      model: 'local-model',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
  });

  it('refuses a default that could not plan or judge, or that does not exist', async () => {
    const cli = await connect('claude-local', 'claude-code');
    const gh = await connect('gh', 'github');
    const cloud = await connect('claude', 'anthropic');
    const no = async (payload: object, why: RegExp) => {
      const r = await put(payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toMatch(why);
    };
    await no({ connectionId: cli.id, model: 'sonnet' }, /planner and judges/);
    await no({ connectionId: gh.id, model: 'x' }, /not a model/);
    await no({ connectionId: cloud.id, model: null }, /needs a model/);
    await no(
      { connectionId: '01a1ad93-969e-770a-ac86-c319f1b264f3', model: 'x' },
      /does not exist/,
    );
    expect((await put({ connectionId: 'not-a-uuid', model: null })).statusCode).toBe(400);
    expect((await put({ model: 'x' })).statusCode).toBe(400);
    // None of that changed what was saved.
    expect((await get()).json().model).toBe('fake');
  });

  it('keeps its connection from being deleted while it is the default', async () => {
    const c = await connect('lmstudio', 'openai', 'http://127.0.0.1:1234/v1');
    await put({ connectionId: c.id, model: 'm' });
    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/connections/${c.id}`,
      headers: auth,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/default model's connection/);
    await put({ connectionId: null, model: null });
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/connections/${c.id}`, headers: auth }))
        .statusCode,
    ).toBe(204);
  });

  it('gives agents the default where they have none of their own', async () => {
    const office = await connect('office', 'ollama', 'http://10.0.0.5:11434');
    const cloud = await connect('claude', 'anthropic');
    const other = await connect('openai', 'openai');
    await put({ connectionId: cloud.id, model: 'claude-sonnet-5-5' });
    const agent = (over: object) => ({
      model: null,
      modelBaseUrl: null,
      connectionId: null,
      ...over,
    });

    // No model of its own, on an Ollama connection: the default's name.
    expect(await resolveModelSpec(e.db, agent({ connectionId: office.id }))).toMatchObject({
      model: 'claude-sonnet-5-5',
      baseUrl: 'http://10.0.0.5:11434',
    });
    // On the default's own connection, it is that model; on another cloud connection it must choose.
    expect(await resolveModelSpec(e.db, agent({ connectionId: cloud.id }))).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
    await expect(resolveModelSpec(e.db, agent({ connectionId: other.id }))).rejects.toThrow(
      /needs a model/,
    );
    // Its own model wins; a bare server URL takes the default's name.
    expect(await resolveModelSpec(e.db, agent({ model: 'mine' }))).toEqual({
      model: 'mine',
      baseUrl: null,
    });
    expect(await resolveModelSpec(e.db, agent({ modelBaseUrl: 'http://x:11434' }))).toEqual({
      model: 'claude-sonnet-5-5',
      baseUrl: 'http://x:11434',
    });
  });

  it('falls back to the built-in model if its connection has gone, instead of failing every task', async () => {
    const c = await connect('lmstudio', 'openai', 'http://127.0.0.1:1234/v1');
    await put({ connectionId: c.id, model: 'm' });
    await e.db.delete(connections).where(eq(connections.id, c.id)); // behind the API's back
    expect(await resolveModelSpec(e.db, null)).toEqual({ model: 'qwen3:8b', baseUrl: null });
    expect((await get()).json().effective.model).toBe('qwen3:8b');
  });

  it('is what a project really runs on: the planner, the agent and the judge', async () => {
    await put({ connectionId: null, model: 'fake-big' });
    await e.addAgent('writer');
    e.fake.script.plan = () => ({
      steps: [
        {
          key: 'notes',
          title: 'notes',
          agent: 'writer',
          instructions: 'Do notes',
          acceptance: 'notes.md exists',
          dependsOn: [],
        },
      ],
    });
    const task = await createTask(e.deps, { goal: 'Write notes' });
    await e.waitFor(task.id);
    const used = new Set(e.fake.bodies.map((b) => b.model));
    expect([...used]).toEqual(['fake-big']);
    expect(e.fake.bodies.length).toBeGreaterThanOrEqual(3); // plan, at least one turn, judge

    // Changing it takes effect for the next project, with no restart.
    e.fake.bodies.length = 0;
    await put({ connectionId: null, model: 'fake' });
    const second = await createTask(e.deps, { goal: 'Write more notes' });
    await e.waitFor(second.id);
    expect([...new Set(e.fake.bodies.map((b) => b.model))]).toEqual(['fake']);
  });

  it('leaves an agent with a model of its own alone', async () => {
    await put({ connectionId: null, model: 'fake-big' });
    const writer = await e.addAgent('writer');
    await e.db.update(agents).set({ model: 'fake' }).where(eq(agents.id, writer.id));
    e.fake.script.plan = () => ({
      steps: [
        {
          key: 'a',
          title: 'a',
          agent: 'writer',
          instructions: 'Do a',
          acceptance: 'a.md',
          dependsOn: [],
        },
      ],
    });
    const task = await createTask(e.deps, { goal: 'Mixed' });
    await e.waitFor(task.id);
    // The planner and judge on the default; the agent's own turns on its own model.
    expect(new Set(e.fake.bodies.map((b) => b.model))).toEqual(new Set(['fake-big', 'fake']));
  });
});
