import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeChatModel, claudeArgs, parseResult } from '../../src/models/claude-code.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
let dir: string;
let log: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-code-'));
  log = join(dir, 'calls.log');
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.GANTRIX_TOKEN = 'x'.repeat(32);
});
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_LOG;
  delete process.env.GANTRIX_TOKEN;
  await rm(dir, { recursive: true, force: true });
});

describe('ClaudeCodeChatModel', () => {
  it('runs claude -p in the workspace with file tools only and no Gantrix secrets', async () => {
    const model = new ClaudeCodeChatModel({
      workspace: dir,
      approveAll: false,
      bin: FAKE,
      model: 'sonnet',
    });
    const reply = await model.invoke([
      new SystemMessage('You are the CTO.'),
      new HumanMessage('Write notes.'),
    ]);

    expect(reply.content).toBe('Wrote claude-notes.md.');
    expect(reply.usage_metadata?.total_tokens).toBe(120); // cache reads aren't new tokens
    expect(await readFile(join(dir, 'claude-notes.md'), 'utf8')).toContain('Claude Code');
    const call = JSON.parse((await readFile(log, 'utf8')).trim());
    expect(call.cwd).toBe(await import('node:fs/promises').then((f) => f.realpath(dir)));
    expect(call.hasToken).toBe(false);
    expect(call.args).toEqual(
      expect.arrayContaining([
        '-p',
        'Write notes.',
        '--model',
        'sonnet',
        '--append-system-prompt',
        'You are the CTO.',
      ]),
    );
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('Read,Write,Edit,Glob,Grep');
    expect(call.args[call.args.indexOf('--allowedTools') + 1]).toBe('Read,Write,Edit,Glob,Grep');
    expect(call.args[call.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });

  it('allows Bash and the web only in god mode', () => {
    const args = claudeArgs({ approveAll: true, system: '', prompt: 'x' });
    expect(args[args.indexOf('--tools') + 1]).toContain('Bash');
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('WebFetch');
  });

  it('reads the result from the event array that current versions print', () => {
    const out = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'assistant' },
      { type: 'result', result: 'Done.', usage: { input_tokens: 3, output_tokens: 2 } },
    ]);
    expect(parseResult(out)).toMatchObject({ result: 'Done.' });
    expect(() => parseResult('[{"type":"system"}]')).toThrow(/without a result/);
  });

  it('explains a missing claude command', async () => {
    const model = new ClaudeCodeChatModel({
      workspace: dir,
      approveAll: false,
      bin: join(dir, 'nope'),
      maxRetries: 0,
    });
    await expect(model.invoke([new HumanMessage('hi')])).rejects.toThrow(/not found/);
  });
});
