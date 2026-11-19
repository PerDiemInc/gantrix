import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureOllama,
  hasModel,
  isLocalOllama,
  probeOllama,
  type RuntimeDeps,
  type Spawn,
} from '../../src/models/ollama-runtime.ts';

const tags = (...names: string[]) =>
  new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 });

/** A clock and a sleep that don't wait: each sleep moves the clock on. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

interface SpawnLog {
  command: string;
  args: string[];
  options: Parameters<Spawn>[2];
  unrefed: boolean;
}

/** A spawn whose commands succeed or fail as scripted, and that records what it was asked to run. */
function fakeSpawn(plan: (command: string) => 'ok' | 'missing' | 'exits' = () => 'ok') {
  const log: SpawnLog[] = [];
  const spawn: Spawn = (command, args, options) => {
    const entry: SpawnLog = { command, args, options, unrefed: false };
    log.push(entry);
    const listeners = new Map<string, (arg?: unknown) => void>();
    const outcome = plan(command);
    queueMicrotask(() => {
      if (outcome === 'missing') {
        listeners.get('error')?.(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      } else {
        listeners.get('spawn')?.();
        if (outcome === 'exits') queueMicrotask(() => listeners.get('exit')?.());
      }
    });
    return {
      once: (event, listener) => {
        listeners.set(event, listener);
      },
      unref: () => {
        entry.unrefed = true;
      },
    };
  };
  return { spawn, log };
}

/** An Ollama that starts answering after `after` probes (never, if undefined). */
function comesUp(after: number | undefined, ...names: string[]) {
  let probes = 0;
  const f = (async () => {
    probes++;
    if (after !== undefined && probes > after) return tags(...names);
    throw new Error('fetch failed');
  }) as unknown as typeof fetch;
  return { f, probes: () => probes };
}

const env = {
  PATH: '/usr/bin',
  HOME: '/home/me',
  OLLAMA_MODELS: '/models',
  DATABASE_URL: 'postgres://secret',
  GANTRIX_TOKEN: 'tok',
  SLACK_BOT_TOKEN: 'xoxb-secret',
};
const deps = (over: RuntimeDeps): RuntimeDeps => ({
  env,
  platform: 'linux',
  ...fakeTime(),
  ...over,
});

describe('is Ollama on this machine', () => {
  it('knows loopback addresses from the rest', () => {
    for (const u of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']) {
      expect(isLocalOllama(u), u).toBe(true);
    }
    for (const u of ['http://10.0.0.5:11434', 'https://ollama.example.com', 'not a url']) {
      expect(isLocalOllama(u), u).toBe(false);
    }
  });

  it('knows a model is there, with or without its tag', () => {
    expect(hasModel(['qwen3:8b'], 'qwen3:8b')).toBe(true);
    expect(hasModel(['llama3:latest'], 'llama3')).toBe(true);
    expect(hasModel(['qwen3:8b'], 'qwen3:4b')).toBe(false);
    expect(hasModel(['llama3:8b'], 'llama3')).toBe(false);
  });

  it('lists the models of a server that answers, and is null for one that does not', async () => {
    expect(await probeOllama('http://x', {}, (async () => tags('a:1', 'b:2')) as never)).toEqual([
      'a:1',
      'b:2',
    ]);
    expect(
      await probeOllama('http://x', {}, (async () => new Response('', { status: 500 })) as never),
    ).toBeNull();
    expect(
      await probeOllama('http://x', {}, (async () => {
        throw new Error('refused');
      }) as never),
    ).toBeNull();
  });
});

describe('making sure Ollama is running', () => {
  it('leaves a running Ollama alone', async () => {
    const { spawn, log } = fakeSpawn();
    const r = await ensureOllama(
      'http://127.0.0.1:11434',
      {},
      deps({ spawn, fetch: (async () => tags('qwen3:8b')) as never }),
    );
    expect(r).toEqual({ ok: true, started: false, models: ['qwen3:8b'] });
    expect(log).toHaveLength(0);
  });

  it('starts `ollama serve`, detached, and waits until it answers', async () => {
    const { spawn, log } = fakeSpawn();
    const up = comesUp(3, 'qwen3:8b');
    const r = await ensureOllama('http://127.0.0.1:11434', {}, deps({ spawn, fetch: up.f }));
    expect(r).toEqual({ ok: true, started: true, models: ['qwen3:8b'] });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ command: 'ollama', args: ['serve'], unrefed: true });
    expect(log[0]?.options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(up.probes()).toBe(4); // the first look, then until it answered
  });

  it("gives the new Ollama its own address and settings, and none of the API's secrets", async () => {
    const { spawn, log } = fakeSpawn();
    await ensureOllama('http://127.0.0.1:11500', {}, deps({ spawn, fetch: comesUp(1).f }));
    const passed = log[0]?.options.env ?? {};
    expect(passed.OLLAMA_HOST).toBe('127.0.0.1:11500');
    expect(passed.OLLAMA_MODELS).toBe('/models');
    expect(passed.PATH).toBe('/usr/bin');
    expect(passed.HOME).toBe('/home/me');
    for (const secret of ['DATABASE_URL', 'GANTRIX_TOKEN', 'SLACK_BOT_TOKEN']) {
      expect(passed, secret).not.toHaveProperty(secret);
    }
  });

  it('never starts anything for an address that is not this machine', async () => {
    const { spawn, log } = fakeSpawn();
    const r = await ensureOllama(
      'http://10.0.0.5:11434',
      {},
      deps({ spawn, fetch: comesUp(undefined).f }),
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'remote',
      message: expect.stringContaining('10.0.0.5:11434'),
    });
    expect(log).toHaveLength(0);
  });

  it('looks for the command where Homebrew and the installer put it', async () => {
    const { spawn, log } = fakeSpawn((c) => (c === '/opt/homebrew/bin/ollama' ? 'ok' : 'missing'));
    const r = await ensureOllama(
      'http://127.0.0.1:11434',
      {},
      deps({ spawn, fetch: comesUp(1, 'm').f }),
    );
    expect(r).toMatchObject({ ok: true, started: true });
    expect(log.map((l) => l.command)).toEqual(['ollama', '/opt/homebrew/bin/ollama']);
  });

  it('opens the Ollama app on a Mac that has no command, and says it is not installed elsewhere', async () => {
    const mac = fakeSpawn((c) => (c === 'open' ? 'ok' : 'missing'));
    const opened = await ensureOllama(
      'http://127.0.0.1:11434',
      {},
      deps({ spawn: mac.spawn, fetch: comesUp(1, 'm').f, platform: 'darwin' }),
    );
    expect(opened).toMatchObject({ ok: true, started: true });
    expect(mac.log.at(-1)).toMatchObject({ command: 'open', args: ['-a', 'Ollama'] });

    const none = fakeSpawn(() => 'missing');
    const r = await ensureOllama(
      'http://127.0.0.1:11434',
      {},
      deps({ spawn: none.spawn, fetch: comesUp(undefined).f, platform: 'linux' }),
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'not-installed',
      message: expect.stringContaining('https://ollama.com'),
    });
    expect(none.log.some((l) => l.command === 'open')).toBe(false);
  });

  it('gives up after a while, saying how to find out why', async () => {
    const { spawn } = fakeSpawn();
    const r = await ensureOllama(
      'http://127.0.0.1:11434',
      {},
      deps({ spawn, fetch: comesUp(undefined).f, waitMs: 5_000 }),
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'no-answer',
      message: expect.stringContaining('5 seconds'),
    });
  });

  it('stops waiting when the new Ollama exits at once, as it does when the port is taken', async () => {
    const { spawn } = fakeSpawn(() => 'exits');
    const up = comesUp(undefined);
    const r = await ensureOllama('http://127.0.0.1:11434', {}, deps({ spawn, fetch: up.f }));
    expect(r).toMatchObject({
      ok: false,
      reason: 'no-answer',
      message: expect.stringContaining('stopped straight away'),
    });
    expect(up.probes()).toBeLessThan(5);
  });

  it('starts it once when several requests arrive together, and each address on its own', async () => {
    const { spawn, log } = fakeSpawn();
    const run = (url: string) => ensureOllama(url, {}, deps({ spawn, fetch: comesUp(2, 'm').f }));
    const three = await Promise.all([
      run('http://127.0.0.1:11434'),
      run('http://127.0.0.1:11434'),
      run('http://127.0.0.1:11434'),
    ]);
    expect(three.every((r) => r.ok)).toBe(true);
    expect(log).toHaveLength(1);
    await Promise.all([run('http://127.0.0.1:11601'), run('http://127.0.0.1:11602')]);
    expect(log).toHaveLength(3);
  });
});

describe('starting a real program', () => {
  it('launches the command as its own process, which keeps answering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gantrix-fake-ollama-'));
    // A stand-in `ollama`: on "serve" it listens where OLLAMA_HOST says, and records what it saw.
    const bin = join(dir, 'ollama');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
if (process.argv[2] !== 'serve') process.exit(2);
const [host, port] = process.env.OLLAMA_HOST.split(':');
fs.writeFileSync(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify({ pid: process.pid, env: process.env, argv: process.argv.slice(2) }));
http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); }).listen(Number(port), host);
`,
    );
    await chmod(bin, 0o755);
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    let pid = 0;
    try {
      const r = await ensureOllama(
        `http://127.0.0.1:${port}`,
        {},
        {
          binaries: [bin],
          env: {
            PATH: process.env.PATH ?? '',
            HOME: dir,
            DATABASE_URL: 'postgres://secret',
            GANTRIX_TOKEN: 'tok',
          },
          waitMs: 15_000,
          pollMs: 100,
        },
      );
      expect(r).toEqual({ ok: true, started: true, models: ['qwen3:8b'] });
      const seen = JSON.parse(await readFile(join(dir, 'seen.json'), 'utf8')) as {
        pid: number;
        env: Record<string, string>;
        argv: string[];
      };
      pid = seen.pid;
      expect(seen.argv).toEqual(['serve']);
      expect(seen.env.OLLAMA_HOST).toBe(`127.0.0.1:${port}`);
      expect(seen.env.DATABASE_URL).toBeUndefined();
      expect(seen.env.GANTRIX_TOKEN).toBeUndefined();
      // It answers on its own now, with Gantrix out of the picture.
      expect(await probeOllama(`http://127.0.0.1:${port}`)).toEqual(['qwen3:8b']);
      expect(await ensureOllama(`http://127.0.0.1:${port}`, {}, {})).toMatchObject({
        ok: true,
        started: false,
      });
    } finally {
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
