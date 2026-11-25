import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { agents, connections, skills } from '../../src/db/schema.ts';
import { createTask } from '../../src/engine/commands.ts';
import { type Engine, startEngine } from './harness.ts';

let e: Engine;
let app: ReturnType<typeof buildServer>;
let hub: EventHub;
const token = 't'.repeat(32);
const auth = { authorization: `Bearer ${token}` };
const GH_TOKEN = `github_pat_${'x'.repeat(40)}`;
// A GitHub that accepts one token and knows one repository.
const githubFetch: typeof fetch = async (url, init) => {
  const sent = new Headers(init?.headers).get('authorization');
  if (sent !== `Bearer ${GH_TOKEN}`) return new Response('{}', { status: 401 });
  const path = new URL(String(url)).pathname;
  if (path === '/user') return Response.json({ login: 'octo' });
  if (path === '/repos/acme/app') return Response.json({ full_name: 'acme/app' });
  return new Response('{"message":"Not Found"}', { status: 404 });
};

beforeAll(async () => {
  e = await startEngine();
  e.deps.githubFetch = githubFetch;
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

const setup = (id: string, payload: object) =>
  app.inject({ method: 'POST', url: `/api/agents/${id}/setup`, headers: auth, payload });
const answers = { code: 'GitHub', never: 'force push' };
const withToken = { mode: 'token', token: GH_TOKEN, repos: 'acme/app' };

describe('agent setup', () => {
  it('writes the skill, saves the token as a connection and never returns it', async () => {
    const agent = await e.addAgent('cto');
    const res = await setup(agent.id, { answers, github: withToken });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(GH_TOKEN);
    const body = res.json();
    expect(body.skill).toMatchObject({ name: 'setup-cto', version: '1.0.0' });
    expect(body.skill.markdown).toContain('force push');
    expect(body.github.connection).toBe('github-cto');
    expect(body.agent.skills.map((s: { name: string }) => s.name).sort()).toEqual([
      'cto-skill',
      'setup-cto',
    ]);
    const [c] = await e.db.select().from(connections);
    expect(c?.headers.Authorization).toBe(`Bearer ${GH_TOKEN}`);
    expect(body.agent.githubConnectionId).toBe(c?.id);
    for (const url of ['/api/connections', '/api/agents', `/api/agents/${agent.id}/setup`]) {
      expect((await app.inject({ url, headers: auth })).body, url).not.toContain(GH_TOKEN);
    }
  });

  it('replaces the previous version and reuses its own connection', async () => {
    const agent = await e.addAgent('cto');
    await setup(agent.id, { answers, github: withToken });
    const [first] = await e.db.select().from(skills).where(eq(skills.name, 'setup-cto'));
    const res = await setup(agent.id, {
      answers: { code: 'GitHub', stack: 'Node' },
      github: withToken,
    });
    expect(res.json().skill.version).toBe('1.0.1');
    const rows = await e.db.select().from(skills).where(eq(skills.name, 'setup-cto'));
    expect(rows.map((r) => r.version)).toEqual(['1.0.1']);
    expect(existsSync(first?.sourcePath ?? '')).toBe(false);
    expect(await e.db.$count(connections)).toBe(1);
    // Leaving access out keeps it; "none" takes it away.
    expect((await setup(agent.id, { answers })).json().agent.githubConnectionId).toBeTruthy();
    const off = await setup(agent.id, { answers, github: { mode: 'none' } });
    expect(off.json().agent.githubConnectionId).toBeNull();
  });

  it('saves nothing when the token, repository or an answer is wrong', async () => {
    const agent = await e.addAgent('cto');
    for (const [payload, message] of [
      [{ answers, github: { mode: 'token', token: 'nope' } }, 'rejected the token'],
      [{ answers, github: { ...withToken, repos: 'acme/other' } }, "can't see acme/other"],
      [{ answers, github: { ...withToken, repos: 'app' } }, 'owner/name'],
      [{ answers: { code: 'GitHub', never: GH_TOKEN } }, 'password or token'],
      [{ answers: { bogus: 'x' } }, 'Unknown questions'],
      [{ answers: {} }, 'at least one'],
    ] as const) {
      const res = await setup(agent.id, payload);
      expect(res.statusCode, message).toBe(400);
      expect(res.json().error).toContain(message);
    }
    expect(await e.db.$count(connections)).toBe(0);
    expect(await e.db.$count(skills, eq(skills.name, 'setup-cto'))).toBe(0);
  });

  it('gives the agent github_read and its answers during a task', async () => {
    const agent = await e.addAgent('cto');
    await setup(agent.id, { answers, github: withToken });
    e.fake.script.plan = () => ({
      steps: [
        {
          key: 'look',
          title: 'look',
          instructions: 'Look.',
          acceptance: 'done',
          agent: 'cto',
          dependsOn: [],
        },
      ],
    });
    let offered: string[] = [];
    let results: string[] = [];
    e.fake.script.worker = ({ toolResults, tools }) => {
      offered = tools;
      results = toolResults;
      return toolResults.length
        ? 'Read it.'
        : { name: 'github_read', args: { path: '/repos/acme/app' } };
    };
    const task = await createTask(e.deps, { goal: 'look at the code', approveAll: true });
    const done = await e.waitFor(task.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe('succeeded');
    expect(offered).toContain('github_read');
    expect(results[0]).toContain('acme/app');
    const sent = JSON.stringify(e.fake.bodies);
    expect(sent).toContain('force push');
    expect(sent).toContain('Use github_read');
    expect(sent).not.toContain(GH_TOKEN);
  });

  it('loses access when the connection is deleted', async () => {
    const agent = await e.addAgent('cto');
    await setup(agent.id, { answers, github: withToken });
    await e.db.delete(connections);
    const row = await e.db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(row?.githubConnectionId).toBeNull();
  });
});
