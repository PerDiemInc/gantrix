import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvText } from '@gantrix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetBreach, canReplan } from '../../src/budget.ts';
import { liveFailure } from '../../src/engine/jobs.ts';
import { resolveShellEnv } from '../../src/skills/shell-env.ts';
import { shellTool } from '../../src/skills/tools/shell.ts';

const budget = { maxStepAttempts: 3, maxReplans: 2, maxTokens: 100, maxMinutes: 10 };
const spent = { tokensUsed: 500, replans: 9, startedAt: new Date(Date.now() - 3_600_000) };

describe('keep going', () => {
  it('stops on a limit, unless the project keeps going', () => {
    expect(budgetBreach(spent, budget)?.limit).toBe('tokens');
    expect(canReplan(spent, budget)).toBe(false);
    expect(budgetBreach(spent, { ...budget, keepGoing: true })).toBeNull();
    expect(canReplan(spent, { ...budget, keepGoing: true })).toBe(true);
  });
});

describe('project variables', () => {
  it('reads NAME=value lines, skipping comments and dropping export and quotes', () => {
    const { vars, errors } = parseEnvText(
      ['# deploy', 'AWS_PROFILE=deploy', 'export AWS_REGION="us-east-1"', '', "NOTE='a=b'"].join(
        '\n',
      ),
    );
    expect(errors).toEqual([]);
    expect(vars).toEqual({ AWS_PROFILE: 'deploy', AWS_REGION: 'us-east-1', NOTE: 'a=b' });
  });

  it('says which line is wrong', () => {
    const { vars, errors } = parseEnvText('GOOD=1\nnot a variable\n9BAD=x');
    expect(vars).toEqual({ GOOD: '1' });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Line 2');
    expect(errors[1]).toContain('Line 3');
  });

  it("resolves env:NAME from the worker's environment, and fails loudly when it is missing", () => {
    expect(resolveShellEnv({ A: 'plain', B: 'env:SECRET' }, { SECRET: 's3' }, '/home/me')).toEqual({
      A: 'plain',
      B: 's3',
    });
    expect(() => resolveShellEnv({ B: 'env:MISSING' }, {}, '/home/me')).toThrow(/MISSING/);
  });

  it('points an AWS profile at the real home, where its config lives', () => {
    expect(resolveShellEnv({ AWS_PROFILE: 'deploy' }, {}, '/home/me')).toEqual({
      AWS_PROFILE: 'deploy',
      AWS_CONFIG_FILE: '/home/me/.aws/config',
      AWS_SHARED_CREDENTIALS_FILE: '/home/me/.aws/credentials',
    });
    // The project's own choices win.
    expect(
      resolveShellEnv({ AWS_PROFILE: 'deploy', AWS_CONFIG_FILE: '/x/config' }, {}, '/home/me')
        .AWS_CONFIG_FILE,
    ).toBe('/x/config');
    expect(resolveShellEnv({ AWS_PROFILE: 'deploy', HOME: '/home/me' }, {}, '/home/me')).toEqual({
      AWS_PROFILE: 'deploy',
      HOME: '/home/me',
    });
  });
});

describe('shell tool', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gantrix-shell-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const run = (tool: ReturnType<typeof shellTool>, command: string) =>
    tool.invoke({ command }) as Promise<string>;

  it("passes the project's variables, and nothing else of the server's", async () => {
    process.env.GANTRIX_TOKEN_FOR_TEST = 'server-secret';
    const out = await run(
      shellTool(dir, { env: { AWS_PROFILE: 'deploy' } }),
      'echo "$AWS_PROFILE:$GANTRIX_TOKEN_FOR_TEST."',
    );
    delete process.env.GANTRIX_TOKEN_FOR_TEST;
    expect(out).toBe('exit 0\ndeploy:.\n');
  });

  it('kills a command at its time limit', async () => {
    const started = Date.now();
    const out = await run(shellTool(dir, { timeoutMs: 300 }), 'sleep 20');
    expect(out).toMatch(/^killed after/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('kills a command when the step is stopped', async () => {
    const abort = new AbortController();
    const started = Date.now();
    const pending = run(shellTool(dir, { signal: abort.signal }), 'sleep 20');
    setTimeout(() => abort.abort(), 200);
    await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('live check', () => {
  const check = (ok: boolean, status = ok ? 200 : 503) => ({
    url: 'https://site.example/',
    status,
    ok,
    title: '',
    detail: status ? '' : 'getaddrinfo ENOTFOUND site.example',
  });

  it('is not done until some deployed URL answers', () => {
    expect(liveFailure([])).toContain('no agent has checked a public URL');
    expect(liveFailure([check(false)])).toContain('HTTP 503');
    expect(liveFailure([check(false, 0)])).toContain('ENOTFOUND');
    expect(liveFailure([check(false), check(true)])).toBeNull();
  });
});
