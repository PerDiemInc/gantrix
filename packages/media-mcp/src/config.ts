import { CATALOG, findModel, licenseWarning, type MediaKind, type ModelInfo } from './registry.ts';
import type { VideoQuality } from './types.ts';

export interface MediaConfig {
  models: ModelInfo[];
  defaults: Partial<Record<MediaKind, string>>;
  comfyUrl: string;
  /** Free ComfyUI's models from RAM after each job (MEDIA_UNLOAD_AFTER, default true). */
  unloadAfter: boolean;
  /** Default video quality (MEDIA_VIDEO_QUALITY): fast, standard or high. */
  videoQuality: VideoQuality;
}

/** Reads the skill's MCP env. Fails fast with the list of known models if an id is unknown. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const ids = (env.MEDIA_MODELS ?? 'z-image-turbo')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const models = ids.map((id) => {
    const model = findModel(id);
    if (!model) {
      throw new Error(
        `Unknown model "${id}" in MEDIA_MODELS. Known: ${CATALOG.map((m) => m.id).join(', ')}.`,
      );
    }
    return model;
  });
  // Non-open-source models need a deliberate opt-in, and the error says why.
  const accepted = new Set(
    (env.MEDIA_ACCEPT_LICENSES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const m of models) {
    if (!m.osiOpenSource && !accepted.has(m.id)) {
      throw new Error(
        `${licenseWarning(m)}\nTo enable it anyway, add "${m.id}" to MEDIA_ACCEPT_LICENSES.`,
      );
    }
  }
  const defaults: Partial<Record<MediaKind, string>> = {};
  for (const kind of ['image', 'video'] as const) {
    const wanted = env[kind === 'image' ? 'MEDIA_DEFAULT_IMAGE' : 'MEDIA_DEFAULT_VIDEO'];
    const enabled = models.filter((m) => m.kind === kind);
    if (wanted && !enabled.some((m) => m.id === wanted)) {
      throw new Error(`Default ${kind} model "${wanted}" isn't enabled in MEDIA_MODELS.`);
    }
    const chosen = wanted ?? enabled[0]?.id;
    if (chosen) defaults[kind] = chosen;
  }
  const unload = (env.MEDIA_UNLOAD_AFTER ?? 'true').toLowerCase();
  if (!['true', 'false'].includes(unload))
    throw new Error('MEDIA_UNLOAD_AFTER must be true or false.');
  const quality = (env.MEDIA_VIDEO_QUALITY ?? 'standard').toLowerCase();
  if (quality !== 'fast' && quality !== 'standard' && quality !== 'high') {
    throw new Error('MEDIA_VIDEO_QUALITY must be fast, standard or high.');
  }
  return {
    models,
    defaults,
    comfyUrl: (env.COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, ''),
    unloadAfter: unload === 'true',
    videoQuality: quality,
  };
}
