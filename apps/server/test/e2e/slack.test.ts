import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { approvals, tasks } from '../../src/db/schema.ts';
import { createTask } from '../../src/engine/commands.ts';
import type { EngineDeps } from '../../src/engine/deps.ts';
import { SlackBridge } from '../../src/slack/bridge.ts';
import { type Engine, startEngine } from './harness.ts';

const step = (key: string, agent: string) => ({
  key,
  title: `Write ${key}`,
  agent,
  instructions: `Do ${key}`,
  acceptance: `${key} is done`,
  dependsOn: [],
});

/** A fake Slack Web API that records every call. */
function fakeSlack() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let ts = 1000;
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
      if (method === 'chat.postMessage') {
        return res.end(JSON.stringify({ ok: true, channel: body.channel, ts: String(++ts) }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { calls, server };
}

let e: Engine;
let hub: EventHub;
let bridge: SlackBridge;
let deps: EngineDeps;
const slack = fakeSlack();
const posts = () => slack.calls.filter((c) => c.method === 'chat.postMessage');
const said = (re: RegExp) => posts().some((p) => re.test(String(p.body.text)));
async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out. Slack posts:\n${posts()
      .map((p) => p.body.text)
      .join('\n---\n')}`,
  );
}

beforeAll(async () => {
  e = await startEngine();
  await new Promise<void>((r) => slack.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(slack.server.address() as AddressInfo).port}`;
  deps = {
    ...e.deps,
    config: {
      ...e.config,
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_CHANNEL_ID: 'C0TEST123',
      SLACK_ALLOWED_USERS: ['UBOSS'],
      SLACK_API_URL: url,
    },
  };
  hub = new EventHub(e.db, e.config.DATABASE_URL);
  await hub.start();
  bridge = new SlackBridge(deps, hub);
  await bridge.start();
});
afterAll(async () => {
  await bridge?.close();
  await hub?.close();
  slack.server.close();
  await e?.close();
});
beforeEach(async () => {
  await e.reset();
  slack.calls.length = 0;
});

describe('slack', () => {
  it('posts a project into its own thread: intro, plan, finished tasks, done', async () => {
    await e.addAgent('writer');
    e.fake.script.plan = () => ({ steps: [step('notes', 'writer')] });
    const quiet = await createTask(e.deps, { goal: 'No Slack here' });
    const task = await createTask(e.deps, {
      goal: 'Notes for the team',
      name: 'Team notes',
      slack: true,
    });
    expect((await e.waitFor(task.id)).status).toBe('succeeded');
    await e.waitFor(quiet.id);
    await until(() => said(/is done/));

    const [intro, ...rest] = posts();
    expect(intro?.body).toMatchObject({ channel: 'C0TEST123' });
    expect(intro?.body.thread_ts).toBeUndefined();
    expect(String(intro?.body.text)).toContain('*Team notes*');
    const saved = await e.db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(saved?.slackThreadTs).toBe('1001');
    // Everything else goes in that thread, and nothing comes from the quiet project.
    expect(rest.every((p) => p.body.thread_ts === '1001')).toBe(true);
    expect(said(/The plan\* \(1 tasks\)\n• Write notes: \*writer\*/)).toBe(true);
    expect(said(/\*writer\* finished “Write notes”/)).toBe(true);
    expect(posts().find((p) => /is done/.test(String(p.body.text)))?.body.reply_broadcast).toBe(
      true,
    );
    expect(said(/No Slack here/)).toBe(false);
  });

  it('answers an agent question from a thread reply, and only for allowed users', async () => {
    await e.addAgent('pm', ['ask_user', 'write_file']);
    e.fake.script.plan = () => ({ steps: [step('brief', 'pm')] });
    e.fake.script.worker = ({ toolResults }) =>
      toolResults.length
        ? `Brief written for ${toolResults.at(-1)}`
        : { name: 'ask_user', args: { question: 'Which colour?', options: ['red', 'blue'] } };
    const task = await createTask(e.deps, { goal: 'Brief', slack: true });
    await e.waitFor(task.id, (t) => t.status === 'awaiting_approval');
    await until(() => said(/\*pm\* asks: Which colour\?\n1\. red\n2\. blue/));
    const thread_ts = (await e.db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }))
      ?.slackThreadTs;

    const msg = (user: string, text: string, ts: string) =>
      bridge.handle({
        type: 'message',
        user,
        text,
        channel: 'C0TEST123',
        ts,
        thread_ts: thread_ts ?? '',
      });
    await msg('USTRANGER', '1', '2001');
    expect(said(/Only people listed in SLACK_ALLOWED_USERS/)).toBe(true);
    expect(
      (await e.db.select().from(approvals).where(eq(approvals.taskId, task.id)))[0]?.status,
    ).toBe('pending');

    await msg('UBOSS', '2', '2002');
    const [answered] = await e.db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(answered).toMatchObject({ status: 'approved', answer: 'blue' });
    expect((await e.waitFor(task.id)).status).toBe('succeeded');
    expect(
      slack.calls.some((c) => c.method === 'reactions.add' && c.body.timestamp === '2002'),
    ).toBe(true);
  });

  it('takes commands and questions as mentions in the thread', async () => {
    await e.addAgent('writer');
    await e.addAgent('designer');
    e.fake.script.plan = () => ({ steps: [step('notes', 'writer')] });
    const writer = await e.db.query.agents.findFirst();
    const task = await createTask(e.deps, {
      goal: 'Notes',
      slack: true,
      agentIds: [writer?.id ?? ''],
    });
    await e.waitFor(task.id);
    await until(() => said(/is done/));
    const thread_ts =
      (await e.db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }))?.slackThreadTs ?? '';
    let n = 3000;
    const mention = async (text: string, user = 'UBOSS') => {
      const before = posts().length;
      await bridge.handle({
        type: 'app_mention',
        user,
        text: `<@UBOT> ${text}`,
        channel: 'C0TEST123',
        ts: String(++n),
        thread_ts,
      });
      await bridge.idle();
      return posts()
        .slice(before)
        .map((p) => String(p.body.text))
        .join('\n');
    };

    expect(await mention('help')).toContain('add designer');
    expect(await mention('status')).toMatch(/succeeded · 1\/1 tasks done/);
    expect(await mention('add designer')).toContain('Added *designer*');
    expect(
      (await e.db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }))?.agentIds,
    ).toHaveLength(2);
    expect(await mention('add nobody')).toContain("I don't know nobody");
    expect(await mention('rename Launch notes', 'USTRANGER')).toContain('SLACK_ALLOWED_USERS');
    expect(await mention('rename Launch notes')).toContain('Renamed to *Launch notes*');
    expect((await e.db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }))?.name).toBe(
      'Launch notes',
    );

    e.fake.script.worker = () => 'Everything is done: notes.md was written.';
    expect(await mention('what is left?', 'USTRANGER')).toContain('Everything is done');
    // The model saw the project's facts.
    const asked = e.fake.bodies.at(-1)?.messages.at(-1)?.content ?? '';
    expect(asked).toContain('Project: Launch notes');
    expect(asked).toContain('Question: what is left?');
  });
});
