import { spawn as nodeSpawn } from 'node:child_process';
import { cliEnv } from './cli-env.ts';

/** Where `ollama` may live when the API was started without it on its PATH (Homebrew, the installer). */
const BINARIES = ['ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'];
const WAIT_MS = 20_000;
const POLL_MS = 500;
const PROBE_MS = 2_000;

export type EnsureOllama = (
  baseUrl: string,
  options?: { headers?: Record<string, string> },
) => Promise<OllamaStatus>;

export type OllamaStatus =
  | {
      ok: true;
      /** True when it was not running and Gantrix started it. */
      started: boolean;
      /** The models it has downloaded. */
      models: string[];
    }
  | { ok: false; reason: 'remote' | 'not-installed' | 'no-answer'; message: string };

/** The part of node's `spawn` that is used, so a test can watch it. */
export type Spawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv },
) => {
  once(event: 'spawn' | 'error' | 'exit', listener: (arg?: unknown) => void): unknown;
  unref(): void;
};

export interface RuntimeDeps {
  fetch?: typeof fetch;
  spawn?: Spawn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
  pollMs?: number;
  binaries?: readonly string[];
}

/** Loopback addresses: an Ollama that Gantrix could start is one on this machine. */
export function isLocalOllama(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/** The models an Ollama server answers with, or null when it does not answer. */
export async function probeOllama(
  baseUrl: string,
  headers: Record<string, string> = {},
  f: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const res = await f(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      headers,
      signal: AbortSignal.timeout(PROBE_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).flatMap((m) => (m.name ? [m.name] : []));
  } catch {
    return null;
  }
}

/** "qwen3:8b" is there if it is listed; a name with no tag means ":latest". */
export const hasModel = (models: readonly string[], name: string): boolean =>
  models.includes(name) || (!name.includes(':') && models.includes(`${name}:latest`));

/**
 * What the new Ollama is allowed to see: the basics a program needs, and its own OLLAMA_ settings.
 * Not the API's environment, which holds the token, the database password and other secrets.
 */
export function ollamaEnv(baseUrl: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const own = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('OLLAMA_')));
  const url = new URL(baseUrl);
  return {
    ...cliEnv(env),
    ...own,
    // Listen where Gantrix will look for it.
    OLLAMA_HOST: url.port ? `${url.hostname}:${url.port}` : url.hostname,
  };
}

/** Runs one command detached, so it keeps going after the API stops. Resolves how that went. */
function launch(
  spawn: Spawn,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ started: true; exited: Promise<void> } | { started: false; missing: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<Spawn>;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', env });
    } catch {
      return resolve({ started: false, missing: true });
    }
    child.once('error', (error) => {
      resolve({
        started: false,
        missing: (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
      });
    });
    child.once('spawn', () => {
      child.unref();
      resolve({
        started: true,
        exited: new Promise((done) => child.once('exit', () => done())),
      });
    });
  });
}

/** One start at a time per address. */
const starting = new Map<string, Promise<OllamaStatus>>();

/**
 * Makes sure an Ollama is answering at `baseUrl`, starting one if there isn't and the address is
 * this machine's. It never starts anything for a remote address, and starts only `ollama serve`
 * (or, on a Mac with the app, opens it). Concurrent callers share one start.
 */
export function ensureOllama(
  baseUrl: string,
  options: { headers?: Record<string, string> } = {},
  deps: RuntimeDeps = {},
): Promise<OllamaStatus> {
  const f = deps.fetch ?? fetch;
  const run = async (): Promise<OllamaStatus> => {
    const up = await probeOllama(baseUrl, options.headers, f);
    if (up) return { ok: true, started: false, models: up };
    if (!isLocalOllama(baseUrl)) {
      return {
        ok: false,
        reason: 'remote',
        message: `The Ollama server at ${new URL(baseUrl).host} isn't reachable, and it isn't on this machine, so Gantrix can't start it.`,
      };
    }
    return start(baseUrl, options.headers ?? {}, deps, f);
  };
  // A second request while one is starting Ollama waits for that start instead of starting another.
  const key = baseUrl.replace(/\/+$/, '');
  let pending = starting.get(key);
  if (!pending) {
    pending = run().finally(() => starting.delete(key));
    starting.set(key, pending);
  }
  return pending;
}

async function start(
  baseUrl: string,
  headers: Record<string, string>,
  deps: RuntimeDeps,
  f: typeof fetch,
): Promise<OllamaStatus> {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as Spawn);
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const env = ollamaEnv(baseUrl, deps.env ?? process.env);

  let launched: Awaited<ReturnType<typeof launch>> = { started: false, missing: true };
  for (const bin of deps.binaries ?? BINARIES) {
    launched = await launch(spawn, bin, ['serve'], env);
    if (launched.started || !launched.missing) break;
  }
  // A Mac with the Ollama app but no command on the PATH.
  if (!launched.started && launched.missing && (deps.platform ?? process.platform) === 'darwin') {
    launched = await launch(spawn, 'open', ['-a', 'Ollama'], env);
  }
  if (!launched.started) {
    return {
      ok: false,
      reason: 'not-installed',
      message:
        "Ollama isn't installed on this machine. Install it from https://ollama.com, then try again.",
    };
  }

  let exited = false;
  void launched.exited.then(() => {
    exited = true;
  });
  const waitMs = deps.waitMs ?? WAIT_MS;
  const began = now();
  while (now() - began < waitMs) {
    await sleep(deps.pollMs ?? POLL_MS);
    const models = await probeOllama(baseUrl, headers, f);
    if (models) return { ok: true, started: true, models };
    // `ollama serve` that stops by itself usually means something else holds the port.
    if (exited) break;
  }
  return {
    ok: false,
    reason: 'no-answer',
    message: exited
      ? 'I tried to start Ollama, but it stopped straight away. Something else may be using its port; try running `ollama serve` in a terminal.'
      : `I started Ollama, but it didn't answer within ${Math.round(waitMs / 1000)} seconds. Try running \`ollama serve\` in a terminal to see why.`,
  };
}
