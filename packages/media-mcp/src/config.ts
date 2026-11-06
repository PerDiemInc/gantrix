import { CATALOG, findModel, licenseWarning, type MediaKind, type ModelInfo } from './registry.ts';

export interface Window {
  start: number; // minutes after midnight
  end: number;
}

export interface MediaConfig {
  models: ModelInfo[];
  defaults: Partial<Record<MediaKind, string>>;
  ltxUrl?: string;
  ltxToken?: string;
  ltxWindow?: Window;
  comfyUrl: string;
  busyWaitMs: number;
}

const minutes = (hhmm: string): number => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`"${hhmm}" isn't a time like 01:00.`);
  return Number(m[1]) * 60 + Number(m[2]);
};

export function parseWindow(value: string): Window {
  const [start, end] = value.split('-');
  if (!start || !end) throw new Error(`LTX_WINDOW must look like 01:00-06:00, not "${value}".`);
  return { start: minutes(start.trim()), end: minutes(end.trim()) };
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
  const waitMinutes = Number(env.MEDIA_BUSY_WAIT_MINUTES ?? 30);
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) {
    throw new Error('MEDIA_BUSY_WAIT_MINUTES must be a number of minutes.');
  }
  return {
    models,
    defaults,
    ...(env.LTX_URL ? { ltxUrl: env.LTX_URL.replace(/\/$/, '') } : {}),
    ...(env.LTX_TOKEN ? { ltxToken: env.LTX_TOKEN } : {}),
    ...(env.LTX_WINDOW ? { ltxWindow: parseWindow(env.LTX_WINDOW) } : {}),
    comfyUrl: (env.COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, ''),
    busyWaitMs: waitMinutes * 60_000,
  };
}

/** True when `now` falls inside the window; windows may wrap midnight (22:00-06:00). */
export function inWindow(w: Window, now = new Date()): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  return w.start <= w.end ? t >= w.start && t < w.end : t >= w.start || t < w.end;
}
