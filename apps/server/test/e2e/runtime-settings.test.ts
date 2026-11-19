import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { appSettings } from '../../src/db/schema.ts';
import { createTask } from '../../src/engine/commands.ts';
import type { EnsureOllama } from '../../src/models/ollama-runtime.ts';
import {
  applyStoredSettings,
  loadSettings,
  saveSettingsGroup,
  startSettingsSync,
} from '../../src/settings.ts';
import { ISOLATED_MARKER } from '../../src/skills/workspace.ts';
import { SlackManager } from '../../src/slack/manager.ts';
import { startFakeOllama } from './fake-ollama.ts';
import { type Engine, startEngine } from './harness.ts';

let e: Engine;
let app: ReturnType<typeof buildServer>;
let hub: EventHub;
const token = 't'.repeat(32);
const auth = { authorization: `Bearer ${token}` };
let ensure: EnsureOllama | null = null;
let slackSettingsSaved = 0;

/** A Slack Web API that answers what each token would, and records the calls. */
function fakeSlack() {
  const calls: { method: string; token: string }[] = [];
  const answers: Record<string, unknown> = {
    'auth.test': { ok: true, user: 'gantrix', team: 'Acme Co', user_id: 'UBOT' },
    'apps.connections.open': { ok: true },
    'conversations.info': { ok: true },
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const method = (req.url ?? '').replace(/^\//, '');
      calls.push({ method, token: String(req.headers.authorization ?? '').replace('Bearer ', '') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answers[method] ?? { ok: true, ts: '1' }));
    });
  });
  return { calls, answers, server };
}
const slackWorld = fakeSlack();

beforeAll(async () => {
  e = await startEngine();
  await new Promise<void>((r) => slackWorld.server.listen(0, '127.0.0.1', r));
  e.config.SLACK_API_URL = `http://127.0.0.1:${(slackWorld.server.address() as AddressInfo).port}`;
  hub = new EventHub(e.db, e.config.DATABASE_URL);
  await hub.start();
  app = buildServer(
    {
      ...e.deps,
      hub,
      ensureOllama: (url, options) => (ensure ? ensure(url, options) : realEnsure(url, options)),
      onSlackSettings: async () => {
        slackSettingsSaved++;
      },
    },
    token,
    false,
  );
});
afterAll(async () => {
  await app?.close();
  await hub?.close();
  slackWorld.server.close();
  await e?.close();
});
beforeEach(async () => {
  await e.reset();
  ensure = null;
  slackSettingsSaved = 0;
  slackWorld.calls.length = 0;
  slackWorld.answers['auth.test'] = { ok: true, user: 'gantrix', team: 'Acme Co', user_id: 'UBOT' };
  slackWorld.answers['apps.connections.open'] = { ok: true };
  slackWorld.answers['conversations.info'] = { ok: true };
});

const { ensureOllama: realEnsure } = await import('../../src/models/ollama-runtime.ts');
const get = () => app.inject({ url: '/api/settings/runtime', headers: auth });
const put = (path: string, payload: object) =>
  app.inject({ method: 'PUT', url: `/api/settings/${path}`, headers: auth, payload });
const post = (path: string, payload: object = {}) =>
  app.inject({ method: 'POST', url: `/api/settings/${path}`, headers: auth, payload });

const TASKS = {
  maxMinutes: 90,
  maxTokens: 500_000,
  maxReplans: 3,
  maxStepAttempts: 4,
  askFirst: true,
  isolatedSteps: true,
  llmConcurrency: 6,
};
const SLACK = {
  botToken: 'xoxb-1111111111-secret-bot',
  appToken: 'xapp-1-secret-app-token',
  channelId: 'C0123456789',
  allowedUsers: ['U01ABCDE2F'],
  dashboardUrl: 'http://127.0.0.1:4701',
};

describe('settings chosen in the dashboard', () => {
  it('start at the built-in values, with no secrets', async () => {
    const r = (await get()).json();
    expect(r.ollama).toEqual({
      baseUrl: 'http://127.0.0.1:11434',
      builtIn: 'http://127.0.0.1:11434',
    });
    expect(r.taskDefaults).toEqual({
      maxMinutes: 60,
      maxTokens: 200_000,
      maxReplans: 5,
      maxStepAttempts: 3,
      askFirst: false,
      isolatedSteps: false,
      llmConcurrency: 2,
    });
    expect(r.taskDefaults).toEqual(r.taskDefaultsBuiltIn);
    expect(r.slack).toMatchObject({
      botTokenSet: false,
      appTokenSet: false,
      posts: false,
      listens: false,
      allowedUsers: [],
    });
  });

  describe('task defaults', () => {
    it('are checked, and nothing is saved when one is wrong', async () => {
      for (const bad of [
        { maxMinutes: 0 },
        { maxMinutes: 24 * 60 + 1 },
        { maxTokens: 999 },
        { maxReplans: -1 },
        { maxReplans: 21 },
        { maxStepAttempts: 0 },
        { llmConcurrency: 17 },
        { maxMinutes: 1.5 },
        { askFirst: 'yes' },
      ]) {
        const res = await put('task-defaults', { ...TASKS, ...bad });
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect((await put('task-defaults', { maxMinutes: 5 })).statusCode).toBe(400);
      expect((await get()).json().taskDefaults.maxMinutes).toBe(60);
    });

    it('apply at once, and the next project starts with them', async () => {
      const saved = await put('task-defaults', TASKS);
      expect(saved.statusCode).toBe(200);
      expect(saved.json().taskDefaults).toEqual(TASKS);
      expect(e.config).toMatchObject({
        GANTRIX_MAX_MINUTES: 90,
        GANTRIX_MAX_TOKENS: 500_000,
        GANTRIX_MAX_REPLANS: 3,
        GANTRIX_MAX_STEP_ATTEMPTS: 4,
        GANTRIX_APPROVE_ALL: false,
        GANTRIX_ISOLATED_STEPS: true,
        GANTRIX_LLM_CONCURRENCY: 6,
      });
      const task = await createTask(e.deps, { goal: 'Use the defaults' });
      expect(task.budget).toMatchObject({
        maxMinutes: 90,
        maxTokens: 500_000,
        maxReplans: 3,
        maxStepAttempts: 4,
      });
      expect(task.approveAll).toBe(false);
      expect(existsSync(join(task.workspacePath, ISOLATED_MARKER))).toBe(true);
      // What the New project form reads.
      expect((await app.inject({ url: '/api/settings', headers: auth })).json().approveAll).toBe(
        false,
      );

      // And back: tools run without asking, a shared folder.
      await put('task-defaults', { ...TASKS, askFirst: false, isolatedSteps: false });
      const next = await createTask(e.deps, { goal: 'Back again' });
      expect(next.approveAll).toBe(true);
      expect(existsSync(join(next.workspacePath, ISOLATED_MARKER))).toBe(false);
    });
  });

  describe('the Ollama address', () => {
    it('must be a plain http or https address', async () => {
      for (const bad of [
        '',
        'localhost:11434',
        'ftp://x',
        'https://user:pw@x:11434',
        'not a url',
      ]) {
        expect((await put('ollama', { baseUrl: bad })).statusCode, bad).toBe(400);
      }
      const ok = await put('ollama', { baseUrl: ' http://10.0.0.5:11434/// ' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ollama.baseUrl).toBe('http://10.0.0.5:11434');
      expect(e.config.OLLAMA_BASE_URL).toBe('http://10.0.0.5:11434');
    });

    it('is where the planner, agents and judge really send their requests', async () => {
      const other = await startFakeOllama();
      try {
        await e.addAgent('writer');
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
        // The harness's Ollama is the one in use until the address changes.
        const first = await createTask(e.deps, { goal: 'On the first server' });
        await e.waitFor(first.id);
        expect(e.fake.bodies.length).toBeGreaterThan(0);
        expect(other.bodies).toHaveLength(0);

        await put('ollama', { baseUrl: other.url });
        other.script.plan = e.fake.script.plan;
        e.fake.bodies.length = 0;
        const second = await createTask(e.deps, { goal: 'On the second server' });
        await e.waitFor(second.id);
        expect(other.bodies.length).toBeGreaterThanOrEqual(3);
        expect(e.fake.bodies).toHaveLength(0);
      } finally {
        await other.close();
      }
    });

    it('can be checked, and starts a local Ollama that is not running', async () => {
      // A running Ollama at the saved address (the harness's), as it reports itself.
      await put('ollama', { baseUrl: e.config.OLLAMA_BASE_URL });
      const up = (await post('ollama/check')).json();
      expect(up).toMatchObject({ ok: true, started: false, message: null });
      expect(up.models).toEqual(['fake', 'fake-big']);

      const asked: string[] = [];
      ensure = async (url) => {
        asked.push(url);
        return { ok: true, started: true, models: ['qwen3:8b'] };
      };
      expect((await post('ollama/check', { baseUrl: 'http://127.0.0.1:11555/' })).json()).toEqual({
        ok: true,
        started: true,
        models: ['qwen3:8b'],
        message: null,
      });
      expect(asked).toEqual(['http://127.0.0.1:11555']);

      ensure = async () => ({
        ok: false,
        reason: 'not-installed',
        message: "Ollama isn't installed.",
      });
      expect((await post('ollama/check')).json()).toEqual({
        ok: false,
        started: false,
        models: [],
        message: "Ollama isn't installed.",
      });
      expect((await post('ollama/check', { baseUrl: 'nope' })).statusCode).toBe(400);
    });
  });

  describe('finding Ollama', () => {
    it('answers with the address that responds, and says what it tried when none does', async () => {
      await put('ollama', { baseUrl: e.config.OLLAMA_BASE_URL });
      const hit = (await post('ollama/detect')).json();
      expect(hit).toMatchObject({
        baseUrl: e.config.OLLAMA_BASE_URL,
        started: false,
        message: null,
      });
      expect(hit.models).toEqual(['fake', 'fake-big']);
      expect(hit.tried).toContain('http://127.0.0.1:11434');

      // Nothing answers (the saved address is dead too): it tries to start one.
      await put('ollama', { baseUrl: 'http://127.0.0.1:1' });
      ensure = async () => ({
        ok: false,
        reason: 'not-installed',
        message: "Ollama isn't installed.",
      });
      const miss = (await post('ollama/detect')).json();
      if (!miss.baseUrl)
        expect(miss).toMatchObject({ message: "Ollama isn't installed.", models: [] });
      expect(miss.tried[0]).toBe('http://127.0.0.1:1');
    });
  });

  describe('Slack for projects', () => {
    it('is checked, and says what is missing', async () => {
      const no = async (payload: object, why: RegExp) => {
        const res = await put('slack', { ...SLACK, ...payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().error).toMatch(why);
      };
      await no({ botToken: 'xapp-wrong' }, /xoxb-/);
      await no({ appToken: 'xoxb-wrong' }, /xapp-/);
      await no({ channelId: 'general' }, /ID like C0123456789/);
      await no({ channelId: null }, /Choose the channel/);
      await no({ botToken: null, appToken: null }, /needs a bot token/);
      await no({ botToken: null, channelId: null }, /needs the bot token too/);
      await no({ allowedUsers: [] }, /at least one member ID/);
      await no({ allowedUsers: ['doron'] }, /Member IDs look like/);
      await no({ dashboardUrl: 'not a url' }, /http/);
      expect(slackSettingsSaved).toBe(0);
      expect((await get()).json().slack.botTokenSet).toBe(false);
    });

    it('is saved, applied, and never given back', async () => {
      const saved = await put('slack', SLACK);
      expect(saved.statusCode).toBe(200);
      expect(saved.json().slack).toMatchObject({
        botTokenSet: true,
        appTokenSet: true,
        channelId: 'C0123456789',
        allowedUsers: ['U01ABCDE2F'],
        posts: true,
        listens: true,
      });
      // No response carries a token.
      for (const body of [saved.body, (await get()).body]) {
        expect(body).not.toContain('secret-bot');
        expect(body).not.toContain('secret-app');
      }
      expect(e.config).toMatchObject({
        SLACK_BOT_TOKEN: SLACK.botToken,
        SLACK_APP_TOKEN: SLACK.appToken,
        SLACK_CHANNEL_ID: 'C0123456789',
        SLACK_ALLOWED_USERS: ['U01ABCDE2F'],
      });
      expect(slackSettingsSaved).toBe(1); // the bridge was told

      // Leaving a token out keeps it; null removes it.
      const { botToken: _b, appToken: _a, ...rest } = SLACK;
      await put('slack', { ...rest, allowedUsers: ['U01ABCDE2F', 'U02GHIJK3L'] });
      expect(e.config.SLACK_BOT_TOKEN).toBe(SLACK.botToken);
      expect(e.config.SLACK_ALLOWED_USERS).toEqual(['U01ABCDE2F', 'U02GHIJK3L']);
      const off = await put('slack', { ...rest, appToken: null });
      expect(off.json().slack).toMatchObject({
        botTokenSet: true,
        appTokenSet: false,
        listens: false,
      });
      expect(e.config.SLACK_APP_TOKEN).toBeUndefined();
    });

    it('can be tested: the bot, the workspace, Socket Mode and the channel', async () => {
      expect((await post('slack/test')).statusCode).toBe(400); // nothing saved
      await put('slack', SLACK);
      const ok = (await post('slack/test')).json();
      expect(ok).toMatchObject({
        ok: true,
        bot: 'gantrix',
        team: 'Acme Co',
        socketMode: true,
        channel: 'found',
        problems: [],
      });
      // Each token went to Slack as itself.
      expect(slackWorld.calls.find((c) => c.method === 'auth.test')?.token).toBe(SLACK.botToken);
      expect(slackWorld.calls.find((c) => c.method === 'apps.connections.open')?.token).toBe(
        SLACK.appToken,
      );

      slackWorld.answers['conversations.info'] = { ok: false, error: 'channel_not_found' };
      expect((await post('slack/test')).json().channel).toBe('invite');

      slackWorld.answers['apps.connections.open'] = { ok: false, error: 'invalid_auth' };
      const badApp = (await post('slack/test')).json();
      expect(badApp.ok).toBe(false);
      expect(badApp.problems[0]).toMatchObject({
        field: 'app',
        message: expect.stringContaining('connections:write'),
      });

      slackWorld.answers['auth.test'] = { ok: false, error: 'invalid_auth' };
      const badBot = (await post('slack/test')).json();
      expect(badBot.ok).toBe(false);
      expect(badBot.problems[0]).toMatchObject({
        field: 'bot',
        message: expect.stringContaining('Bot User OAuth Token'),
      });
    });
  });
});

describe('keeping a process in step with the saved settings', () => {
  it('reads what was saved, reports what changed, and tolerates garbage', async () => {
    expect(await applyStoredSettings(e.db, e.config)).toMatchObject({
      ollama: true,
      concurrency: true,
      slack: false,
    });
    // The same again changes nothing.
    expect(await applyStoredSettings(e.db, e.config)).toEqual({
      ollama: false,
      concurrency: false,
      slack: false,
    });
    await saveSettingsGroup(e.db, 'slack', {
      botToken: 'xoxb-1',
      channelId: 'C0123456789',
      allowedUsers: [],
    });
    expect((await applyStoredSettings(e.db, e.config)).slack).toBe(true);
    // Unreadable values fall back to the built-in ones instead of breaking every task.
    await saveSettingsGroup(e.db, 'task_defaults', {
      maxMinutes: 'soon',
      maxTokens: -5,
      askFirst: 'yes',
      llmConcurrency: 99,
    });
    await applyStoredSettings(e.db, e.config);
    expect(e.config).toMatchObject({
      GANTRIX_MAX_MINUTES: 60,
      GANTRIX_MAX_TOKENS: 200_000,
      GANTRIX_APPROVE_ALL: true,
      GANTRIX_LLM_CONCURRENCY: 2,
    });
    await e.db.delete(appSettings);
    expect((await loadSettings(e.db)).slack.botToken).toBeNull();
  });

  it('notices a change made elsewhere, such as through the API of another process', async () => {
    const changes: { concurrency: boolean }[] = [];
    const sync = await startSettingsSync(e.db, e.config, {
      intervalMs: 30,
      onChange: (c) => void changes.push(c),
    });
    try {
      expect(changes).toHaveLength(0); // loading at start is not a change
      await saveSettingsGroup(e.db, 'task_defaults', { ...TASKS, llmConcurrency: 8 });
      const until = Date.now() + 3_000;
      while (!changes.length && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
      expect(changes[0]?.concurrency).toBe(true);
      expect(e.config.GANTRIX_LLM_CONCURRENCY).toBe(8);
    } finally {
      sync.stop();
    }
  });
});

describe('the Slack bridge follows the settings', () => {
  const manager = () => new SlackManager({ ...e.deps }, hub);
  const slackOn = async (over: Partial<typeof SLACK> = {}) => {
    Object.assign(e.config, {
      SLACK_BOT_TOKEN: over.botToken ?? 'xoxb-first',
      SLACK_APP_TOKEN: undefined,
      SLACK_CHANNEL_ID: over.channelId ?? 'C0123456789',
    });
  };
  const authTests = () => slackWorld.calls.filter((c) => c.method === 'auth.test');

  it('starts when Slack is set up, restarts on new tokens, and stops when it is removed', async () => {
    const m = manager();
    try {
      await m.apply();
      expect(m.running).toBe(false); // nothing set up
      expect(authTests()).toHaveLength(0);

      await slackOn();
      await m.apply();
      expect(m.running).toBe(true);
      expect(authTests().map((c) => c.token)).toEqual(['xoxb-first']);

      await m.apply(); // nothing changed: nothing happens
      expect(authTests()).toHaveLength(1);

      await slackOn({ botToken: 'xoxb-second' });
      await m.apply();
      expect(authTests().map((c) => c.token)).toEqual(['xoxb-first', 'xoxb-second']);

      Object.assign(e.config, { SLACK_BOT_TOKEN: undefined, SLACK_CHANNEL_ID: undefined });
      await m.apply();
      expect(m.running).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('survives a token Slack rejects, and tries again when asked', async () => {
    const m = manager();
    try {
      slackWorld.answers['auth.test'] = { ok: false, error: 'invalid_auth' };
      await slackOn();
      await m.apply();
      expect(m.running).toBe(false);

      slackWorld.answers['auth.test'] = {
        ok: true,
        user: 'gantrix',
        team: 'Acme',
        user_id: 'UBOT',
      };
      await m.apply(); // same values, not forced: left alone
      expect(m.running).toBe(false);
      await m.apply(true); // Save on the Settings page forces another try
      expect(m.running).toBe(true);
    } finally {
      await m.close();
    }
  });

  it('keeps two quick saves from leaving two bridges open', async () => {
    const m = manager();
    try {
      await slackOn();
      await Promise.all([m.apply(true), m.apply(true), m.apply(true)]);
      expect(m.running).toBe(true);
      await m.close();
      expect(m.running).toBe(false);
    } finally {
      await m.close();
    }
  });
});
