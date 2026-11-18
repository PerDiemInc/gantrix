import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { agents, connections } from '../../src/db/schema.ts';
import { AgentSlack } from '../../src/slack/agent-chat.ts';
import { type Engine, startEngine } from './harness.ts';

/** A fake Slack Web API that records every call. Socket Mode isn't served, so it just retries. */
function fakeSlack() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const method = (req.url ?? '').replace(/^\//, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ method, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (method === 'auth.test') return res.end(JSON.stringify({ ok: true, user_id: 'UBOT' }));
      if (method === 'conversations.replies') {
        return res.end(
          JSON.stringify({
            ok: true,
            messages: [
              { user: 'UBOSS', text: '<@UBOT> writer: first question', ts: '1' },
              { user: 'UBOT', text: 'first answer', ts: '2' },
              { user: 'UBOSS', text: 'second question', ts: '3' },
            ],
          }),
        );
      }
      res.end(JSON.stringify({ ok: true, ts: '9' }));
    });
  });
  return { calls, server };
}

let e: Engine;
let hub: EventHub;
let app: ReturnType<typeof buildServer>;
let chat: AgentSlack;
const slack = fakeSlack();
const token = 't'.repeat(32);
const auth = { authorization: `Bearer ${token}` };
const posts = () => slack.calls.filter((c) => c.method === 'chat.postMessage');

beforeAll(async () => {
  e = await startEngine();
  await new Promise<void>((r) => slack.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(slack.server.address() as AddressInfo).port}`;
  const deps = { ...e.deps, config: { ...e.config, SLACK_API_URL: url } };
  hub = new EventHub(e.db, e.config.DATABASE_URL);
  await hub.start();
  app = buildServer({ ...deps, hub }, token, false);
  chat = new AgentSlack(deps);
});
afterAll(async () => {
  await chat?.close();
  await app?.close();
  await hub?.close();
  slack.server.close();
  await e?.close();
});
beforeEach(async () => {
  await e.reset();
  slack.calls.length = 0;
});

async function slackConnection(headers: Record<string, string>, allowedUsers = 'UBOSS') {
  const [c] = await e.db
    .insert(connections)
    .values({ name: 'team-slack', provider: 'slack', headers, settings: { allowedUsers } })
    .returning();
  if (!c) throw new Error('seed failed');
  return c;
}
const full = { 'Bot-Token': 'xoxb-1', 'App-Token': 'xapp-1' };

describe('talking to an agent in Slack', () => {
  it('requires bot credentials and allowed users before an agent can use Slack', async () => {
    const agent = await e.addAgent('writer');
    const patch = (slackConnectionId: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/agents/${agent.id}`,
        headers: auth,
        payload: { slackConnectionId },
      });

    const noApp = await slackConnection({ 'Bot-Token': 'xoxb-1' });
    expect((await patch(noApp.id)).statusCode).toBe(400);
    await e.db.delete(connections).where(eq(connections.id, noApp.id));

    const noUsers = await slackConnection(full, '');
    const res = await patch(noUsers.id);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('allowed Slack user') });
    await e.db.delete(connections).where(eq(connections.id, noUsers.id));

    const ok = await slackConnection(full);
    expect((await patch(ok.id)).statusCode).toBe(200);
    const gh = await e.db
      .insert(connections)
      .values({ name: 'gh', provider: 'github', headers: { Authorization: 'Bearer x' } })
      .returning();
    expect((await patch(gh[0]?.id ?? '')).statusCode).toBe(400);
  });

  it('answers an allowed person in the thread as the named agent, and ignores others', async () => {
    const writer = await e.addAgent('writer');
    await e.addAgent('cto');
    const c = await slackConnection(full);
    await e.db.update(agents).set({ slackConnectionId: c.id }).where(eq(agents.id, writer.id));
    e.fake.script.worker = () => 'Here is the draft.';
    await chat.sync();

    await chat.handle(c.id, {
      type: 'app_mention',
      user: 'UINTRUDER',
      channel: 'C1',
      ts: '10.1',
      text: '<@UBOT> writer: hi',
    });
    expect(posts()).toHaveLength(0);

    await chat.handle(c.id, {
      type: 'app_mention',
      user: 'UBOSS',
      channel: 'C1',
      ts: '10.2',
      text: '<@UBOT> writer: draft the update',
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({
      channel: 'C1',
      thread_ts: '10.2',
      text: 'Here is the draft.',
    });
    // The same event delivered twice is answered once.
    await chat.handle(c.id, {
      type: 'app_mention',
      user: 'UBOSS',
      channel: 'C1',
      ts: '10.2',
      text: '<@UBOT> writer: draft the update',
    });
    expect(posts()).toHaveLength(1);
  });

  it('asks which agent when several share the connection and none is named', async () => {
    const writer = await e.addAgent('writer');
    const cto = await e.addAgent('cto');
    const c = await slackConnection(full);
    for (const a of [writer, cto]) {
      await e.db.update(agents).set({ slackConnectionId: c.id }).where(eq(agents.id, a.id));
    }
    await chat.sync();
    await chat.handle(c.id, {
      type: 'message',
      user: 'UBOSS',
      channel: 'D1',
      ts: '11.1',
      text: 'what is up?',
    });
    expect(String(posts()[0]?.body.text)).toMatch(/Which agent/);
  });

  it('uses the thread as the conversation', async () => {
    const writer = await e.addAgent('writer');
    const c = await slackConnection(full);
    await e.db.update(agents).set({ slackConnectionId: c.id }).where(eq(agents.id, writer.id));
    e.fake.script.worker = () => 'ok';
    await chat.sync();
    await chat.handle(c.id, {
      type: 'app_mention',
      user: 'UBOSS',
      channel: 'C1',
      ts: '3',
      thread_ts: '1',
      text: '<@UBOT> second question',
    });
    expect(slack.calls.some((x) => x.method === 'conversations.replies')).toBe(true);
    expect(posts()[0]?.body).toMatchObject({ thread_ts: '1' });
  });
});
