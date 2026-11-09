import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexChatModel, codexArgs, parseEvents } from '../../src/models/codex.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
let dir: string;
let log: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-'));
  log = join(dir, 'calls.log');
  process.env.CODEX_FAKE_LOG = log;
  process.env.GANTRIX_TOKEN = 'x'.repeat(32);
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
});
afterEach(async () => {
  delete process.env.CODEX_FAKE_LOG;
  delete process.env.CODEX_FAKE_FAIL;
  delete process.env.GANTRIX_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  await rm(dir, { recursive: true, force: true });
});

describe('CodexChatModel', () => {
  it('runs codex exec in the folder, sends the prompt on stdin and hides Gantrix secrets', async () => {
    const model = new CodexChatModel({
      workspace: dir,
      approveAll: false,
      bin: FAKE,
      model: 'gpt-x',
    });
    const reply = await model.invoke([
      new SystemMessage('You are the CTO.'),
      new HumanMessage('Write notes.'),
    ]);

    expect(reply.content).toBe('Wrote codex-notes.md.'); // the last message, not the first
    expect(reply.usage_metadata?.total_tokens).toBe(120); // cached input isn't counted
    expect(await readFile(join(dir, 'codex-notes.md'), 'utf8')).toContain('Codex');
    const call = JSON.parse((await readFile(log, 'utf8')).trim());
    expect(call.prompt).toBe('You are the CTO.\n\nWrite notes.');
    expect(call.hasToken).toBe(false);
    expect(call.hasSlack).toBe(false);
    expect(call.args).toEqual(
      expect.arrayContaining(['-m', 'gpt-x', '--sandbox', 'workspace-write']),
    );
  });

  it('reports a failed turn, even though the command printed events', async () => {
    process.env.CODEX_FAKE_FAIL = '1';
    const model = new CodexChatModel({
      workspace: dir,
      approveAll: false,
      bin: FAKE,
      maxRetries: 0,
    });
    await expect(model.invoke([new HumanMessage('Go')])).rejects.toThrow('usage limit reached');
  });

  it('does not pass off an interim message as the answer when the run is killed', async () => {
    process.env.CODEX_FAKE_SLEEP_MS = '5000';
    const model = new CodexChatModel({
      workspace: dir,
      approveAll: false,
      bin: FAKE,
      maxRetries: 0,
      timeoutMs: 300,
    });
    await expect(model.invoke([new HumanMessage('Go')])).rejects.toThrow('ChatGPT (Codex) failed');
    delete process.env.CODEX_FAKE_SLEEP_MS;
  });

  it('says so when codex is not installed', async () => {
    const model = new CodexChatModel({
      workspace: dir,
      approveAll: false,
      bin: join(dir, 'nope'),
      maxRetries: 0,
    });
    await expect(model.invoke([new HumanMessage('Go')])).rejects.toThrow('not found');
  });
});

describe('codex arguments and events', () => {
  it('stays in the workspace sandbox; the network opens only without asking first', () => {
    const safe = codexArgs({ approveAll: false, workspace: '/w' });
    expect(safe).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', '-C', '/w']));
    expect(safe.join(' ')).not.toContain('network_access');
    expect(safe.join(' ')).not.toContain('danger');
    const open = codexArgs({ approveAll: true, workspace: '/w' });
    expect(open).toContain('sandbox_workspace_write.network_access=true');
    expect(open.join(' ')).not.toContain('danger');
  });
  it('treats "default" as no model', () => {
    expect(codexArgs({ approveAll: false, workspace: '/w', model: 'default' })).not.toContain('-m');
  });
  it('only a completed last turn counts: an early error is forgiven, partial text is not', () => {
    const msg = '{"type":"item.completed","item":{"type":"agent_message","text":"Working"}}';
    const done = '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}';
    expect(parseEvents(`{"type":"error","message":"retrying"}\n${msg}\n${done}`)).toMatchObject({
      completed: true,
      error: null,
    });
    expect(parseEvents(msg)).toMatchObject({ text: 'Working', completed: false });
  });
  it('skips lines that are not JSON', () => {
    const r = parseEvents(
      'WARN something\n{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}\n{bad\n',
    );
    expect(r).toMatchObject({ text: 'Hi', error: null });
  });
});
