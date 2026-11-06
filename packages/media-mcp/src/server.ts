import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MediaConfig } from './config.ts';
import { inputImage, outputPath } from './files.ts';
import { licenseWarning, type MediaKind, type ModelInfo, type ProviderId } from './registry.ts';
import { MediaError, type Provider } from './types.ts';

const CAMERAS = [
  'static',
  'none',
  'dolly_in',
  'dolly_out',
  'dolly_left',
  'dolly_right',
  'jib_up',
  'jib_down',
  'focus_shift',
] as const;
const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;

const took = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  ...(isError ? { isError } : {}),
});

export function createServer(cfg: MediaConfig, providers: Record<ProviderId, () => Provider>) {
  const server = new McpServer({ name: 'gantrix-media', version: '0.1.0' });

  function pick(kind: MediaKind, requested?: string, needsImage = false): ModelInfo {
    const enabled = cfg.models.filter((m) => m.kind === kind);
    if (!enabled.length) throw new MediaError(`No ${kind} model is enabled in this skill.`);
    const id = requested ?? cfg.defaults[kind];
    const model = cfg.models.find((m) => m.id === id);
    if (!model) {
      throw new MediaError(
        `"${id}" isn't enabled here. Enabled ${kind} models: ${enabled.map((m) => m.id).join(', ')}.`,
      );
    }
    if (model.kind !== kind)
      throw new MediaError(`${model.id} is a ${model.kind} model, not a ${kind} model.`);
    if (needsImage && !model.inputs.includes('image'))
      throw new MediaError(`${model.id} can't start from an image.`);
    return model;
  }

  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (error) {
      if (error instanceof MediaError) return text(error.message, true);
      return text(
        `Media generation failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  };
  const withWarning = (model: ModelInfo, summary: string) => {
    const warning = licenseWarning(model);
    return warning ? `${summary}\n${warning}` : summary;
  };

  server.registerTool(
    'list_media_models',
    {
      description:
        'List the image and video models you may use here, with their licences and defaults.',
    },
    async () =>
      text(
        cfg.models
          .map((m) => {
            const isDefault = cfg.defaults[m.kind] === m.id ? ' (default)' : '';
            const line = `${m.id}${isDefault}: ${m.kind} from ${m.inputs.join(' or ')}; licence ${m.license}. ${m.notes}`;
            const warning = licenseWarning(m);
            return warning ? `${line}\n  ${warning}` : line;
          })
          .join('\n'),
      ),
  );

  server.registerTool(
    'generate_image',
    {
      description:
        'Create a PNG image from a prompt, or edit an existing workspace image (from_image). Saves it in the task workspace.',
      inputSchema: {
        prompt: z.string().min(1).describe('what the image shows'),
        path: z.string().describe('where to save it, relative to the workspace, ending in .png'),
        model: z
          .string()
          .optional()
          .describe('an image model from list_media_models; default if omitted'),
        width: z.number().int().min(256).max(2048).default(1024),
        height: z.number().int().min(256).max(2048).default(1024),
        from_image: z.string().optional().describe('a workspace image to edit'),
        strength: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'how much to change from_image. 0.3-0.8 (default 0.8) = variations that keep its layout and colours; 0.95+ = a new picture loosely based on it. It cannot keep the subject while changing the scene.',
          ),
      },
    },
    (args) =>
      run(async () => {
        const model = pick('image', args.model, Boolean(args.from_image));
        const out = await outputPath(args.path, '.png');
        const from = args.from_image ? await inputImage(args.from_image) : undefined;
        const t = Date.now();
        const r = await providers[model.provider]().image(
          {
            model: model.id,
            prompt: args.prompt,
            width: args.width,
            height: args.height,
            ...(from ? { fromImage: from } : {}),
            ...(args.strength === undefined ? {} : { strength: args.strength }),
          },
          out,
        );
        return withWarning(
          model,
          `Saved ${args.path} (${r.width}×${r.height}) with ${model.id} in ${took(Date.now() - t)}.`,
        );
      }),
  );

  server.registerTool(
    'generate_video',
    {
      description:
        'Create an MP4 clip from a prompt, or animate a workspace image (from_image). Saves it in the task workspace. Takes minutes.',
      inputSchema: {
        prompt: z.string().min(1).describe('what happens in the clip'),
        path: z.string().describe('where to save it, relative to the workspace, ending in .mp4'),
        model: z
          .string()
          .optional()
          .describe('a video model from list_media_models; default if omitted'),
        seconds: z.number().int().min(2).max(20).default(4),
        from_image: z.string().optional().describe('a workspace image to use as the first frame'),
        aspect_ratio: z.enum(ASPECTS).default('16:9'),
        camera: z.enum(CAMERAS).default('static'),
        seed: z.number().int().min(0).optional(),
        quality: z
          .enum(['fast', 'standard', 'high'])
          .optional()
          .describe(
            'fast 640x352 (~1.5 min per 2 s), standard 832x480 (~3.5 min, default), high 1280x704 (~12 min on 48 GB RAM); use high only when asked',
          ),
      },
    },
    (args) =>
      run(async () => {
        const model = pick('video', args.model, Boolean(args.from_image));
        const out = await outputPath(args.path, '.mp4');
        const from = args.from_image ? await inputImage(args.from_image) : undefined;
        const t = Date.now();
        const r = await providers[model.provider]().video(
          {
            model: model.id,
            prompt: args.prompt,
            seconds: args.seconds,
            aspectRatio: args.aspect_ratio,
            camera: args.camera,
            quality: args.quality ?? cfg.videoQuality,
            ...(from ? { fromImage: from } : {}),
            ...(args.seed === undefined ? {} : { seed: args.seed }),
          },
          out,
        );
        const sound = r.hasAudio ? ', with sound' : '';
        return withWarning(
          model,
          `Saved ${args.path} (${r.width}×${r.height}, ${(r.durationMs / 1000).toFixed(1)} s${sound}) with ${model.id} in ${took(Date.now() - t)}.`,
        );
      }),
  );

  return server;
}
