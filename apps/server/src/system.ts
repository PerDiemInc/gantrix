import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import type { ContainerStatsDto, SystemDto } from '@gantrix/shared';

/** `docker stats --no-stream` samples for about two seconds; anything past this is a stuck daemon. */
const DOCKER_TIMEOUT_MS = 10_000;

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, out, err) => (error ? reject(new Error(err.trim() || error.message)) : resolve(out)),
    );
  });
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** "17.59MiB", "23.43GiB", "512kB", "0B" → bytes, as Docker prints them. */
export function parseBytes(text: string): number {
  const m = /^\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(text);
  if (!m?.[1] || !m[2]) return 0;
  return Math.round(Number(m[1]) * (UNITS[m[2].toLowerCase()] ?? 0));
}

const percent = (text: string | undefined) => Number.parseFloat(text ?? '') || 0;

/** One JSON object per line, as `--format '{{json .}}'` prints them. */
const jsonLines = (out: string) =>
  out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, string>);

/** Joins `docker stats` with `docker ps`, which knows the image, status and Compose project. */
export function parseContainers(statsOut: string, psOut: string): ContainerStatsDto[] {
  const ps = new Map(jsonLines(psOut).map((c) => [c.ID, c]));
  return jsonLines(statsOut)
    .map((s) => {
      const c = ps.get(s.ID ?? '');
      const [used = '', limit = ''] = (s.MemUsage ?? '').split('/');
      return {
        id: s.ID ?? '',
        name: s.Name ?? c?.Names ?? '',
        image: c?.Image ?? '',
        status: c?.Status ?? '',
        project: c?.Project || null,
        cpuPercent: percent(s.CPUPerc),
        memUsedBytes: parseBytes(used),
        memLimitBytes: parseBytes(limit),
        memPercent: percent(s.MemPerc),
        pids: Number.parseInt(s.PIDs ?? '', 10) || 0,
      };
    })
    .sort((a, b) => b.memUsedBytes - a.memUsedBytes);
}

/** macOS `vm_stat`: free, inactive, speculative and purgeable pages can be handed out without swap. */
export function parseVmStat(out: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  if (!pageSize) return null;
  const pages = (name: string) =>
    Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * pageSize;
}

/**
 * Memory the OS can still give out. `os.freemem()` counts only unused pages, so on macOS and
 * Linux it looks nearly full whenever the file cache is warm.
 */
async function memAvailable(): Promise<number> {
  try {
    if (process.platform === 'darwin') return parseVmStat(await run('vm_stat', [])) ?? os.freemem();
    if (process.platform === 'linux') {
      const kb = /MemAvailable:\s+(\d+) kB/.exec(await readFile('/proc/meminfo', 'utf8'))?.[1];
      if (kb) return Number(kb) * 1024;
    }
  } catch {
    // fall through to the portable number
  }
  return os.freemem();
}

async function dockerStats(): Promise<SystemDto['docker']> {
  try {
    // Fixed arguments only: nothing from the request reaches these commands.
    const [info, stats, ps] = await Promise.all([
      run('docker', ['info', '--format', '{{.ServerVersion}}|{{.MemTotal}}|{{.NCPU}}']),
      run('docker', ['stats', '--no-stream', '--format', '{{json .}}']),
      run('docker', [
        'ps',
        '--format',
        '{"ID":"{{.ID}}","Names":"{{.Names}}","Image":"{{.Image}}","Status":"{{.Status}}","Project":"{{.Label "com.docker.compose.project"}}"}',
      ]),
    ]);
    const [version = '', mem = '0', cpus = '0'] = info.trim().split('|');
    return {
      available: true,
      version,
      memTotalBytes: Number(mem),
      cpus: Number(cpus),
      containers: parseContainers(stats, ps),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      error: /ENOENT/.test(message)
        ? 'Docker is not installed (no docker command on the PATH).'
        : /daemon|connect/i.test(message)
          ? 'Docker is installed but not running.'
          : (message.split('\n')[0] ?? message),
    };
  }
}

export async function sampleSystem(): Promise<SystemDto> {
  const [memAvailableBytes, docker] = await Promise.all([memAvailable(), dockerStats()]);
  const [l1 = 0, l5 = 0, l15 = 0] = os.loadavg();
  return {
    host: {
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      cpus: os.availableParallelism(),
      loadAvg: [l1, l5, l15],
      memTotalBytes: os.totalmem(),
      memAvailableBytes,
      uptimeSeconds: Math.round(os.uptime()),
    },
    gantrix: { rssBytes: process.memoryUsage.rss() },
    docker,
    sampledAt: new Date().toISOString(),
  };
}
