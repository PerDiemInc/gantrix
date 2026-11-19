import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { tasks } from '../../src/db/schema.ts';
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

  it("can't be walked around with an encoded path, an absolute URL or a rebound Host", async () => {
    // The router decodes these to /api/tasks; the check must too.
    for (const url of ['/%61pi/tasks', '/%61%70%69/agents', '/api/%74asks', '//api/tasks']) {
      expect((await app.inject(url)).statusCode, url).toBe(401);
    }
    expect((await app.inject('/nowhere')).statusCode).toBe(401); // unrouted needs it too
    // A page that rebinds evil.example to 127.0.0.1 sends its own name as Host.
    const rebound = await app.inject({
      url: '/api/tasks',
      headers: { ...auth, host: 'evil.example:4700' },
    });
    expect(rebound.statusCode).toBe(421);
    for (const host of ['127.0.0.1:4700', 'localhost:4701', '[::1]:4700']) {
      expect((await app.inject({ url: '/api/tasks', headers: { ...auth, host } })).statusCode).toBe(
        200,
      );
    }
    expect(
      (await app.inject({ url: '/api/health', headers: { host: 'localhost' } })).statusCode,
    ).toBe(200);
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

  it('lists the models each place offers, with an error for one it cannot reach', async () => {
    const add = (body: object) =>
      app.inject({ method: 'POST', url: '/api/connections', headers: auth, payload: body });
    await add({ name: 'claude-local', provider: 'claude-code' });
    await add({ name: 'dead', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1' });
    const res = await app.inject({ url: '/api/models?fresh=true', headers: auth });
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(res.json().map((s: { name: string }) => [s.name, s]));
    expect(byName['Ollama (default)']).toMatchObject({
      connectionId: null,
      models: ['fake', 'fake-big'],
    });
    expect(byName['claude-local'].models).toEqual(['haiku', 'opus', 'sonnet']);
    expect(byName.dead.models).toEqual([]);
    expect(byName.dead.error).toBeTruthy();
  });

  it('shows who is working on which model, the loaded models, and drops a stopped project', async () => {
    const fetcher = await e.addAgent('fetcher', ['web_fetch']);
    e.fake.script.plan = () => ({
      steps: [
        {
          key: 'fetch',
          title: 'Fetch the page',
          agent: 'fetcher',
          instructions: 'go',
          acceptance: 'ok',
          dependsOn: [],
        },
      ],
    });
    e.fake.script.worker = ({ toolResults }) =>
      toolResults.length ? 'Fetched.' : { name: 'web_fetch', args: { url: 'http://127.0.0.1:9/' } };
    const live = async () => (await app.inject({ url: '/api/live', headers: auth })).json();

    expect(await live()).toMatchObject({ agents: [], queued: 0, defaultModel: 'fake' });

    const task = await createTask(e.deps, { goal: 'Fetch', name: 'Fetching', approveAll: false });
    await e.waitFor(task.id, (t) => t.status === 'awaiting_approval');
    const now = await live();
    expect(now.agents).toHaveLength(1);
    expect(now.agents[0]).toMatchObject({
      role: 'agent',
      agentId: fetcher.id,
      agentName: 'fetcher',
      taskId: task.id,
      project: 'Fetching',
      stepTitle: 'Fetch the page',
      status: 'awaiting_approval',
      model: 'fake',
      provider: 'ollama',
      connection: null,
      isLocal: true,
    });
    expect(now.servers).toEqual([
      expect.objectContaining({
        name: 'Ollama (default)',
        available: true,
        isLocal: true,
        models: [expect.objectContaining({ name: 'fake', parameterSize: '8.2B' })],
      }),
    ]);

    // A stopped project keeps its step where it was, but nobody is working on it.
    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/stop`, headers: auth });
    expect((await live()).agents).toEqual([]);
  });

  it('lets you discuss the status with the project owner, who answers from the live facts', async () => {
    await e.addAgent('cpo');
    await e.addAgent('writer');
    e.fake.script.plan = () => ({
      steps: [
        {
          key: 'notes',
          title: 'Write the launch notes',
          agent: 'writer',
          instructions: 'Write notes.md',
          acceptance: 'notes.md exists',
          dependsOn: [],
        },
      ],
    });
    const task = await createTask(e.deps, { goal: 'Launch the product', name: 'Launch' });
    await e.waitFor(task.id);
    const url = `/api/tasks/${task.id}/discussion`;
    const talk = (text: string) =>
      app.inject({ method: 'POST', url, headers: auth, payload: { text } });

    // Nothing said yet; the owner is the cpo, since the team has one.
    const empty = (await app.inject({ url, headers: auth })).json();
    expect(empty).toMatchObject({ owner: { name: 'cpo' }, messages: [] });
    expect(empty.owner.agentId).toBeTruthy();

    // The model sees the project's facts and then the question. Its thinking is dropped.
    e.fake.script.worker = () => '<think>checking</think>The notes are written; we are done.';
    const first = await talk("  How's it going?  ");
    expect(first.statusCode).toBe(201);
    expect(first.json().messages).toMatchObject([
      { role: 'user', text: "How's it going?" },
      { role: 'owner', text: 'The notes are written; we are done.' },
    ]);
    const sent = e.fake.bodies.at(-1)?.messages ?? [];
    expect(sent[0]?.content).toContain('You are cpo, the owner of a project');
    expect(sent[0]?.content).toContain('Project: Launch');
    expect(sent[0]?.content).toContain('Write the launch notes [succeeded]');
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: "How's it going?" });

    // A follow-up carries the conversation so far.
    e.fake.script.worker = () => 'Nothing is blocking us.';
    await talk('Anything blocking?');
    const turns = (e.fake.bodies.at(-1)?.messages ?? []).filter((m) => m.role !== 'system');
    expect(turns.map((m) => m.content)).toEqual([
      "How's it going?",
      'The notes are written; we are done.',
      'Anything blocking?',
    ]);
    const all = (await app.inject({ url, headers: auth })).json();
    expect(all.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'owner',
      'user',
      'owner',
    ]);

    // It changes nothing: no note reached the team, and the project is as it was.
    const detail = (await app.inject({ url: `/api/tasks/${task.id}`, headers: auth })).json();
    expect(detail.status).toBe('succeeded');
  });

  it('saves nothing when the owner cannot answer, so the question can be sent again', async () => {
    await e.addAgent('writer');
    e.fake.script.plan = () => ({ steps: [] });
    const task = await createTask(e.deps, { goal: 'Anything' });
    await e.waitFor(task.id);
    const url = `/api/tasks/${task.id}/discussion`;
    e.fake.script.worker = () => '<think>only thoughts</think>';
    const failed = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { text: 'Hi' },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toMatch(/couldn't answer/);
    expect((await app.inject({ url, headers: auth })).json().messages).toEqual([]);

    // Without an agent for the role, the default model speaks as the generic owner.
    expect((await app.inject({ url, headers: auth })).json().owner).toMatchObject({
      name: 'Project owner',
      agentId: null,
    });
    // Empty and oversized questions are refused, and an unknown project is not found.
    for (const text of ['   ', 'x'.repeat(4001)]) {
      expect(
        (await app.inject({ method: 'POST', url, headers: auth, payload: { text } })).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          url: '/api/tasks/01a1ad93-969e-770a-ac86-c319f1b264f3/discussion',
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('lists projects with their team, active tasks, approvals and latest event', async () => {
    const writer = await e.addAgent('writer');
    e.fake.script.plan = () => ({
      steps: [
        {
          key: 'a',
          title: 'A',
          agent: 'writer',
          instructions: 'Do a',
          acceptance: 'a.md',
          dependsOn: [],
        },
      ],
    });
    const task = await createTask(e.deps, { goal: 'List me' });
    await e.waitFor(task.id);
    const [item] = (await app.inject({ url: '/api/tasks', headers: auth })).json();
    expect(item).toMatchObject({
      id: task.id,
      team: [{ agentId: writer.id, state: 'done' }],
      active: [],
      pendingApprovals: 0,
      lastEvent: { type: 'task.status', status: 'succeeded', taskId: task.id },
    });
  });

  it('returns workspace images as base64 for previews, and nothing else', async () => {
    const task = await createTask(e.deps, { goal: 'Preview files' });
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(task.workspacePath, 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(task.workspacePath, 'notes.md'), '# Hi');
    const url = (path: string, enc = '') =>
      `/api/tasks/${task.id}/files/content?path=${path}${enc ? `&encoding=${enc}` : ''}`;
    const img = await app.inject({ url: url('dot.png', 'base64'), headers: auth });
    expect(img.json()).toEqual({ mime: 'image/png', base64: 'iVBORw==' });
    expect((await app.inject({ url: url('notes.md', 'base64'), headers: auth })).statusCode).toBe(
      415,
    );
    expect((await app.inject({ url: url('notes.md'), headers: auth })).body).toBe('# Hi');
    expect((await app.inject({ url: url('../x.png', 'base64'), headers: auth })).statusCode).toBe(
      400,
    );
  });

  it('saves an agent avatar: a built-in, initials, or a small PNG/JPEG/WebP, never SVG', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: auth,
      payload: { name: 'pic', avatar: 'preset:gant-glasses' },
    });
    expect(created.json().avatar).toBe('preset:gant-glasses');
    const id = created.json().id;
    const patch = (avatar: unknown) =>
      app.inject({ method: 'PATCH', url: `/api/agents/${id}`, headers: auth, payload: { avatar } });
    expect((await patch('data:image/png;base64,iVBORw0KGgo=')).statusCode).toBe(200);
    expect((await patch('initials')).json().avatar).toBe('initials');
    expect((await patch(null)).json().avatar).toBeNull();
    expect((await patch('data:image/svg+xml;base64,PHN2Zz4=')).statusCode).toBe(400);
    expect((await patch(`data:image/png;base64,${'A'.repeat(200_001)}`)).statusCode).toBe(400);
    expect((await patch('https://example.com/a.png')).statusCode).toBe(400);
  });

  it('tests and edits a custom HTTP connection, showing the request and response', async () => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.headers.authorization !== 'Bearer secret-1') {
          res.writeHead(401).end('{"error":"no"}');
          return;
        }
        const { q } = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { answer: `echo: ${q}` } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gen`;
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: auth,
        payload: {
          name: 'mine',
          provider: 'http',
          baseUrl: url,
          headers: { Authorization: 'Bearer secret-1', 'X-Team': 'a' },
          request: {
            method: 'PUT',
            bodyTemplate: '{"q": "{{prompt}}"}',
            replyPath: 'result.wrong',
          },
        },
      });
      expect(created.statusCode).toBe(201);
      const conn = created.json();
      expect(conn).toMatchObject({
        provider: 'http',
        effectiveUrl: url,
        isLocal: true,
        headers: { Authorization: 'hidden', 'X-Team': 'hidden' },
        request: { method: 'PUT', contentType: 'application/json', replyPath: 'result.wrong' },
      });
      const test = () =>
        app
          .inject({
            method: 'POST',
            url: `/api/connections/${conn.id}/test`,
            headers: auth,
            payload: { model: 'x', prompt: 'ping' },
          })
          .then((r) => r.json());
      const wrong = await test();
      expect(wrong.ok).toBe(false);
      expect(wrong.error).toContain('result.answer');

      // Edit: fix the reply path, change the method, keep the saved Authorization ("hidden").
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/connections/${conn.id}`,
        headers: auth,
        payload: {
          headers: { Authorization: 'hidden', 'X-Team': 'b' },
          request: {
            method: 'POST',
            bodyTemplate: '{"q": "{{prompt}}"}',
            replyPath: 'result.answer',
          },
        },
      });
      expect(patched.statusCode).toBe(200);
      const ok = await test();
      expect(ok).toMatchObject({ ok: true, reply: 'echo: ping' });
      expect(ok.http.request).toMatchObject({
        method: 'POST',
        body: '{"q": "ping"}',
        headers: {
          'content-type': 'application/json',
          Authorization: 'hidden',
          'X-Team': 'hidden',
        },
      });
      expect(ok.http.paths).toEqual(['result.answer']);
      expect(JSON.stringify(ok)).not.toContain('secret-1');
    } finally {
      server.close();
    }
  });

  it('drafts an OKR from a description and saves description and per-project models', async () => {
    const draft = await app.inject({
      method: 'POST',
      url: '/api/tasks/suggest-goal',
      headers: auth,
      payload: { description: 'A website for a small bakery in Austin' },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ objective: expect.stringContaining('bakery in Austin') });
    expect(draft.json().keyResults).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/tasks/suggest-goal',
          headers: auth,
          payload: { description: 'x' },
        })
      ).statusCode,
    ).toBe(400);

    const writer = await e.addAgent('writer');
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: auth,
      payload: {
        goal: 'Objective: a site',
        description: 'A website for a small bakery',
        agentIds: [writer.id],
        agentModels: { [writer.id]: { connectionId: null, model: 'fake-big' } },
        budget: { maxMinutes: 180 },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      description: 'A website for a small bakery',
      agentModels: { [writer.id]: { model: 'fake-big' } },
      budget: { maxMinutes: 180 },
    });
  });

  it('stops, resumes, renames and deletes a project', async () => {
    await e.addAgent('fetcher', ['web_fetch']);
    e.fake.script.plan = () => ({
      steps: [
        {
          key: 'fetch',
          title: 'fetch',
          agent: 'fetcher',
          instructions: 'go',
          acceptance: 'ok',
          dependsOn: [],
        },
      ],
    });
    e.fake.script.worker = ({ toolResults }) =>
      toolResults.length ? 'Fetched.' : { name: 'web_fetch', args: { url: 'http://127.0.0.1:9/' } };
    const task = await createTask(e.deps, { goal: 'Fetch', approveAll: false });
    await e.waitFor(task.id, (t) => t.status === 'awaiting_approval');
    const call = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      app.inject({
        method,
        url: `/api/tasks/${task.id}${url}`,
        headers: auth,
        ...(payload ? { payload } : {}),
      });

    expect((await call('DELETE', '')).statusCode).toBe(409); // still running
    expect((await call('POST', '/resume')).statusCode).toBe(409); // not stopped
    expect((await call('POST', '/stop')).json()).toEqual({ stopped: true });
    expect((await e.waitFor(task.id)).error).toBe('Stopped by you.');
    expect((await call('POST', '/stop')).json()).toEqual({ stopped: false });

    const renamed = await call('PATCH', '', { name: '  Crumb site ' });
    expect(renamed.json()).toMatchObject({ name: 'Crumb site' });
    expect((await call('PATCH', '', { slack: true })).statusCode).toBe(400); // Slack isn't set up

    await e.db.update(tasks).set({ approveAll: true }).where(eq(tasks.id, task.id));
    expect((await call('POST', '/resume')).json()).toMatchObject({ status: 'resumed' });
    expect((await e.waitFor(task.id)).status).toBe('succeeded');

    const workspace =
      (await e.db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }))?.workspacePath ?? '';
    expect(existsSync(workspace)).toBe(true);
    expect((await call('DELETE', '')).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/tasks/${task.id}`, headers: auth })).statusCode).toBe(
      404,
    );
    expect(existsSync(workspace)).toBe(false);
    expect((await app.inject({ url: '/api/slack', headers: auth })).json()).toEqual({
      posts: false,
      replies: false,
      channel: null,
    });
  });

  it('offloads a project to a local agent, creating its connection once', async () => {
    const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
    const original = process.env.CODEX_BIN;
    process.env.CODEX_BIN = fake;
    try {
      const a = await e.addAgent('writer');
      const b = await e.addAgent('editor');
      const listed = (await app.inject({ url: '/api/local-agents', headers: auth })).json();
      expect(listed.find((x: { id: string }) => x.id === 'chatgpt')).toMatchObject({
        installed: true,
        version: 'codex-cli 0.0.0-test',
      });
      const start = (payload: object) =>
        app.inject({ method: 'POST', url: '/api/tasks', headers: auth, payload });
      const first = await start({
        goal: 'One',
        offload: 'chatgpt',
        agentModels: { [b.id]: { connectionId: null, model: 'fake-big' } }, // their own choice wins
      });
      expect(first.statusCode).toBe(201);
      const body = first.json();
      expect(body.offloadConnectionId).toEqual(expect.any(String));
      expect(body.agentModels[b.id]).toEqual({ connectionId: null, model: 'fake-big' });
      expect(body.agentModels[a.id]).toBeUndefined(); // covered by offload, like agents added later
      const second = await start({ goal: 'Two', offload: 'chatgpt', agentIds: [a.id] });
      expect(second.json().offloadConnectionId).toBe(body.offloadConnectionId);

      process.env.CODEX_BIN = '/nope/codex';
      const missing = await start({ goal: 'Three', offload: 'chatgpt' });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error ?? missing.body).toContain("isn't installed");
    } finally {
      if (original === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = original;
    }
  });

  it('refuses an OpenAI or Anthropic connection with no model, on projects and agents', async () => {
    const conn = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: auth,
      payload: { name: 'openai-x', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1' },
    });
    const connectionId = conn.json().id;
    const agent = await e.addAgent('writer');
    const project = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: auth,
      payload: { goal: 'x', agentModels: { [agent.id]: { connectionId, model: null } } },
    });
    expect(project.statusCode).toBe(400);
    expect(project.body).toContain('needs a model');
    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/agents/${agent.id}`, headers: auth, payload });
    expect((await patch({ connectionId, model: null })).statusCode).toBe(400);
    expect((await patch({ connectionId, model: 'gpt-x' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/settings', headers: auth })).json()).toEqual({
      approveAll: e.config.GANTRIX_APPROVE_ALL,
    });
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
