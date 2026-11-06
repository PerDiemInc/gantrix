import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { MediaConfig } from '../config.ts';
import {
  type ImageRequest,
  type ImageResult,
  MediaError,
  type Provider,
  sleep,
  type VideoRequest,
  type VideoResult,
} from '../types.ts';

const VIDEO_MODEL: Record<string, string> = { 'ltx-2.5': 'ltx-2.5-fast' };
const DURATIONS = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20]; // LTX's allowed clip lengths
const BUSY_RETRY_MS = 30_000;
const POLL_MS = 5_000;

export interface Connection {
  url: string;
  token: string;
}

/** LTX Desktop's backend: 127.0.0.1, random port, token in the backend's environment (macOS). */
export function discover(cfg: MediaConfig): Connection {
  if (cfg.ltxUrl && cfg.ltxToken) return { url: cfg.ltxUrl, token: cfg.ltxToken };
  try {
    const pid = execFileSync('pgrep', ['-f', 'backend/ltx2_server'])
      .toString()
      .trim()
      .split(/\s+/)[0];
    if (pid) {
      const env = execFileSync('ps', ['-E', '-p', pid, '-o', 'command=']).toString();
      const token = /LTX_AUTH_TOKEN=(\S+)/.exec(env)?.[1];
      const listen = execFileSync('lsof', [
        '-nP',
        '-a',
        '-p',
        pid,
        '-iTCP',
        '-sTCP:LISTEN',
      ]).toString();
      const port = /127\.0\.0\.1:(\d+) \(LISTEN\)/.exec(listen)?.[1];
      if (token && port) return { url: `http://127.0.0.1:${port}`, token };
    }
  } catch {
    // not running; fall through
  }
  throw new MediaError('LTX Desktop is not running. Open it and wait until it says it is ready.');
}

interface Output {
  path: string;
  metadata?: {
    metadata?: { width?: number; height?: number; durationMs?: number; audioStreamCount?: number };
  };
}

interface Generation {
  id: string;
  status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  error_code?: string | null;
  outputs: Output[];
}

export class LtxDesktop implements Provider {
  readonly #cfg: MediaConfig;
  readonly #connect: () => Connection;
  readonly #assetsDir: string;

  constructor(
    cfg: MediaConfig,
    connect: () => Connection = () => discover(cfg),
    assetsDir?: string,
  ) {
    this.#cfg = cfg;
    this.#connect = connect;
    this.#assetsDir =
      assetsDir ??
      join(homedir(), 'Library', 'Application Support', 'LTXDesktop', 'assets', 'gantrix');
  }

  /** Waits while LTX is busy (409, e.g. a movie render), up to MEDIA_BUSY_WAIT_MINUTES. */
  async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { url, token } = this.#connect();
    const deadline = Date.now() + this.#cfg.busyWaitMs;
    for (;;) {
      const response = await fetch(url + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
      });
      if (response.status === 409 && Date.now() < deadline) {
        await sleep(BUSY_RETRY_MS);
        continue;
      }
      const text = await response.text();
      if (response.status === 409) {
        throw new MediaError(
          `LTX Desktop stayed busy for ${Math.round(this.#cfg.busyWaitMs / 60_000)} min. Try again later.`,
        );
      }
      if (!response.ok)
        throw new MediaError(
          `LTX Desktop ${path} failed (${response.status}): ${text.slice(0, 300)}`,
        );
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  async #ensureLocal(): Promise<void> {
    const s = await this.#call<Record<string, unknown>>('GET', '/api/settings');
    if (s.userPrefersLtxApiVideoGenerations || s.userPrefersFalApiImageGenerations) {
      throw new MediaError(
        'LTX Desktop is set to generate with a paid cloud API. Switch it to local in its Settings.',
      );
    }
  }

  /** LTX Desktop reads input images from its own assets folder. */
  async #stage(image: string): Promise<string> {
    await mkdir(this.#assetsDir, { recursive: true });
    const staged = join(this.#assetsDir, `${randomUUID()}${extname(image) || '.png'}`);
    await copyFile(image, staged);
    return staged;
  }

  async image(req: ImageRequest, out: string): Promise<ImageResult> {
    await this.#ensureLocal();
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      numSteps: req.steps ?? 4,
      numImages: 1,
    };
    if (req.fromImage) {
      body.imagePath = await this.#stage(req.fromImage);
      body.strength = req.strength ?? 0.6;
    }
    const r = await this.#call<{ status?: string; image_paths?: string[] }>(
      'POST',
      '/api/generate-image',
      body,
    );
    const path = r.image_paths?.[0];
    if (!path)
      throw new MediaError(`LTX Desktop returned no image (status: ${r.status ?? 'unknown'}).`);
    await copyFile(path, out);
    return { width: req.width, height: req.height };
  }

  async video(req: VideoRequest, out: string): Promise<VideoResult> {
    const model = VIDEO_MODEL[req.model];
    if (!model) throw new MediaError(`LTX Desktop can't run "${req.model}".`);
    await this.#ensureLocal();
    const duration = DURATIONS.find((d) => d >= req.seconds) ?? 20;
    const params: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      resolution: '720p',
      duration,
      fps: 24,
      aspectRatio: req.aspectRatio,
      cameraMotion: req.camera,
      promptProvenance: 'typed',
      negativePrompt: req.negativePrompt ?? '',
      ...(req.seed === undefined ? {} : { seed: req.seed }),
    };
    let created: Generation;
    if (req.fromImage) {
      const asset = await this.#call<{ id: string }>('POST', '/api/assets', {
        path: req.fromImage,
      });
      created = await this.#call<Generation>('POST', '/api/generations/image-to-video', {
        params: { ...params, aspectRatio: req.aspectRatio === '16:9' ? 'auto' : req.aspectRatio },
        inputs: { startFrame: { assetId: asset.id } },
      });
    } else {
      created = await this.#call<Generation>('POST', '/api/generations/text-to-video', { params });
    }
    let g = created;
    while (!['succeeded', 'failed', 'cancelled'].includes(g.status)) {
      await sleep(POLL_MS);
      g = await this.#call<Generation>('GET', `/api/generations/${created.id}`);
    }
    const output = g.outputs[0];
    if (g.status !== 'succeeded' || !output) {
      throw new MediaError(
        `LTX Desktop video ${g.status}${g.error_code ? `: ${g.error_code}` : ''}.`,
      );
    }
    await copyFile(output.path, out);
    const m = output.metadata?.metadata ?? {};
    return {
      width: m.width ?? 0,
      height: m.height ?? 0,
      durationMs: m.durationMs ?? duration * 1000,
      hasAudio: (m.audioStreamCount ?? 0) > 0,
    };
  }
}
