import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { MediaConfig } from '../config.ts';
import {
  type ImageRequest,
  type ImageResult,
  MediaError,
  type Provider,
  sleep,
  type VideoQuality,
  type VideoRequest,
  type VideoResult,
} from '../types.ts';

const POLL_MS = 3_000;
const FPS = 24;

// Frame sizes per quality (multiples of 32). On a 48 GB M5 Pro a 2 s 16:9 clip took about
// 96 s (fast), 214 s (standard) and 12 min with heavy swapping (high, Wan's native 1280x704).
const WAN_SIZE: Record<VideoQuality, Record<string, [number, number]>> = {
  fast: {
    '16:9': [640, 352],
    '9:16': [352, 640],
    '1:1': [480, 480],
    '4:3': [544, 416],
    '3:4': [416, 544],
    '21:9': [736, 320],
  },
  standard: {
    '16:9': [832, 480],
    '9:16': [480, 832],
    '1:1': [640, 640],
    '4:3': [704, 544],
    '3:4': [544, 704],
    '21:9': [960, 416],
  },
  high: {
    '16:9': [1280, 704],
    '9:16': [704, 1280],
    '1:1': [960, 960],
    '4:3': [1088, 832],
    '3:4': [832, 1088],
    '21:9': [1472, 640],
  },
};

// Wan has no camera control input, so the move goes into the prompt.
const CAMERA_TEXT: Record<string, string> = {
  static: 'Static camera.',
  none: '',
  dolly_in: 'The camera slowly pushes in.',
  dolly_out: 'The camera slowly pulls back.',
  dolly_left: 'The camera tracks left.',
  dolly_right: 'The camera tracks right.',
  jib_up: 'The camera rises.',
  jib_down: 'The camera lowers.',
  focus_shift: 'The focus shifts.',
};

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

/** ComfyUI API-format graph for Wan2.2-TI2V-5B (text or image to video), checked against ComfyUI 0.42.1. */
export function wanWorkflow(o: {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  frames: number;
  seed: number;
  startImage?: string;
}): Graph {
  const latent: Record<string, unknown> = {
    vae: ['3', 0],
    width: o.width,
    height: o.height,
    length: o.frames,
    batch_size: 1,
  };
  const graph: Graph = {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' },
    },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 'umt5_xxl_fp16.safetensors', type: 'wan', device: 'default' },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: o.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: o.negative, clip: ['2', 0] } },
    '6': { class_type: 'Wan22ImageToVideoLatent', inputs: latent },
    '7': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['7', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed: o.seed,
        steps: 20,
        cfg: 5,
        sampler_name: 'uni_pc',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps: FPS } },
    '11': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['10', 0],
        filename_prefix: 'gantrix/video',
        format: 'mp4',
        'format.codec': 'h264',
      },
    },
  };
  if (o.startImage) {
    graph['12'] = { class_type: 'LoadImage', inputs: { image: o.startImage } };
    latent.start_image = ['12', 0];
  }
  return graph;
}

/** ComfyUI API-format graph for Z-Image-Turbo (settings from ComfyUI's own blueprint): text or image to image. */
export function zImageWorkflow(o: {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /** ComfyUI input name of an image to edit; how much changes = strength (denoise). */
  baseImage?: string;
  strength?: number;
}): Graph {
  const sampler: Record<string, unknown> = {
    model: ['7', 0],
    positive: ['4', 0],
    negative: ['5', 0],
    latent_image: ['6', 0],
    seed: o.seed,
    steps: 8,
    cfg: 1,
    sampler_name: 'res_multistep',
    scheduler: 'simple',
    denoise: 1,
  };
  const graph: Graph = {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' },
    },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: o.prompt, clip: ['2', 0] } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: o.width, height: o.height, batch_size: 1 },
    },
    '7': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    '8': { class_type: 'KSampler', inputs: sampler },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': {
      class_type: 'SaveImage',
      inputs: { images: ['9', 0], filename_prefix: 'gantrix/image' },
    },
  };
  if (o.baseImage) {
    graph['11'] = { class_type: 'LoadImage', inputs: { image: o.baseImage } };
    graph['12'] = {
      class_type: 'ImageScale',
      inputs: {
        image: ['11', 0],
        upscale_method: 'lanczos',
        width: o.width,
        height: o.height,
        crop: 'center',
      },
    };
    graph['13'] = { class_type: 'VAEEncode', inputs: { pixels: ['12', 0], vae: ['3', 0] } };
    sampler.latent_image = ['13', 0];
    sampler.denoise = o.strength ?? 0.8;
  }
  return graph;
}

interface SavedFile {
  filename: string;
  subfolder: string;
  type: string;
  metadata?: { width?: number; height?: number; duration?: number };
}

interface History {
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: [string, Record<string, unknown>][];
  };
  outputs?: Record<string, { images?: SavedFile[] }>;
}

export class ComfyUI implements Provider {
  readonly #url: string;
  readonly #unloadAfter: boolean;

  constructor(cfg: MediaConfig) {
    this.#url = cfg.comfyUrl;
    this.#unloadAfter = cfg.unloadAfter;
  }

  async #fetch(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(this.#url + path, init);
    } catch {
      throw new MediaError(
        `ComfyUI isn't running at ${this.#url}. Start it (python main.py --listen 127.0.0.1 --port 8188) and try again.`,
      );
    }
  }

  /** Copies a workspace image into ComfyUI's input folder; returns the name LoadImage expects. */
  async #upload(path: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([await readFile(path)]), basename(path));
    form.append('subfolder', 'gantrix');
    form.append('overwrite', 'true');
    const r = await this.#fetch('/upload/image', { method: 'POST', body: form });
    if (!r.ok) throw new MediaError(`ComfyUI rejected the input image (${r.status}).`);
    const { name, subfolder } = (await r.json()) as { name: string; subfolder?: string };
    return subfolder ? `${subfolder}/${name}` : name;
  }

  /** Queues a graph, waits for it to finish, and returns the first file it saved. */
  async #run(graph: Graph, what: string): Promise<SavedFile> {
    const queued = await this.#fetch('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: 'gantrix' }),
    });
    if (!queued.ok) {
      throw new MediaError(
        `ComfyUI rejected the ${what} workflow (${queued.status}): ${(await queued.text()).slice(0, 400)}`,
      );
    }
    const { prompt_id: id } = (await queued.json()) as { prompt_id: string };
    let entry: History | undefined;
    for (;;) {
      const h = (await (await this.#fetch(`/history/${id}`)).json()) as Record<string, History>;
      entry = h[id];
      if (entry?.status?.completed || entry?.status?.status_str === 'error') break;
      await sleep(POLL_MS);
    }
    if (entry.status?.status_str === 'error') {
      const err = entry.status.messages?.find(([kind]) => kind === 'execution_error')?.[1];
      throw new MediaError(
        `${what} failed in ComfyUI: ${String(err?.exception_message ?? 'unknown error').slice(0, 300)}`,
      );
    }
    const file = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
    if (!file) throw new MediaError(`ComfyUI finished the ${what} but saved nothing.`);
    return file;
  }

  async #download(file: SavedFile, out: string): Promise<void> {
    const q = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder,
      type: file.type,
    });
    const r = await this.#fetch(`/view?${q}`);
    if (!r.ok) throw new MediaError(`Couldn't download the result from ComfyUI (${r.status}).`);
    await writeFile(out, Buffer.from(await r.arrayBuffer()));
  }

  /** Frees ComfyUI's models from RAM (MEDIA_UNLOAD_AFTER); a failure here never fails the job. */
  async #free(): Promise<void> {
    if (!this.#unloadAfter) return;
    await this.#fetch('/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }).catch(() => {});
  }

  async image(req: ImageRequest, out: string): Promise<ImageResult> {
    if (req.model !== 'z-image-turbo') throw new MediaError(`ComfyUI can't run "${req.model}".`);
    const round32 = (n: number) => Math.max(256, Math.round(n / 32) * 32);
    const width = round32(req.width);
    const height = round32(req.height);
    try {
      const graph = zImageWorkflow({
        prompt: req.prompt,
        width,
        height,
        seed: randomSeed(),
        ...(req.fromImage ? { baseImage: await this.#upload(req.fromImage) } : {}),
        ...(req.strength === undefined ? {} : { strength: req.strength }),
      });
      await this.#download(await this.#run(graph, 'Z-Image'), out);
      return { width, height };
    } finally {
      await this.#free();
    }
  }

  async video(req: VideoRequest, out: string): Promise<VideoResult> {
    if (req.model !== 'wan-2.2-5b') throw new MediaError(`ComfyUI can't run "${req.model}".`);
    const [width, height] = WAN_SIZE[req.quality][req.aspectRatio] ??
      WAN_SIZE[req.quality]['16:9'] ?? [832, 480];
    const camera = CAMERA_TEXT[req.camera] ?? '';
    try {
      const graph = wanWorkflow({
        prompt: camera ? `${req.prompt} ${camera}` : req.prompt,
        negative: req.negativePrompt || 'blurry, distorted, low quality, watermark, text',
        width,
        height,
        frames: req.seconds * FPS + 1, // Wan wants 4n+1 frames; 24 fps keeps that true
        seed: req.seed ?? randomSeed(),
        ...(req.fromImage ? { startImage: await this.#upload(req.fromImage) } : {}),
      });
      const file = await this.#run(graph, 'Wan video');
      await this.#download(file, out);
      return {
        width: file.metadata?.width ?? width,
        height: file.metadata?.height ?? height,
        durationMs: Math.round((file.metadata?.duration ?? req.seconds) * 1000),
        hasAudio: false,
      };
    } finally {
      await this.#free();
    }
  }
}
