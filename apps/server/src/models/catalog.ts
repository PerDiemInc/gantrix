import type { ModelProvider, ModelSource } from '@gantrix/shared';
import type { connections } from '../db/schema.ts';
import { effectiveUrl, resolveHeaders } from './connections.ts';
import { splitAuth } from './provider.ts';

type Connection = typeof connections.$inferSelect;

const TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;
/** Claude Code takes these aliases (and full model ids typed by hand). */
const CLAUDE_CODE_MODELS = ['sonnet', 'opus', 'haiku'];

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res.json();
}

const ids = (body: unknown) =>
  ((body as { data?: { id?: unknown }[] }).data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string');

/** The models one server offers, from its own list endpoint. */
export async function listModels(
  provider: ModelProvider,
  url: string,
  rawHeaders: Record<string, string>,
): Promise<string[]> {
  const headers = resolveHeaders(rawHeaders);
  const base = url.replace(/\/+$/, '');
  if (provider === 'claude-code') return CLAUDE_CODE_MODELS;
  // A custom server has no standard model list; the agent form takes a typed name.
  if (provider === 'http') return [];
  if (provider === 'ollama') {
    const body = (await getJson(`${base}/api/tags`, headers)) as { models?: { name?: string }[] };
    return (body.models ?? []).flatMap((m) => (m.name ? [m.name] : []));
  }
  const { bearer, apiKey, rest } = splitAuth(headers);
  if (provider === 'openai') {
    const key = bearer ?? apiKey ?? process.env.OPENAI_API_KEY;
    return ids(
      await getJson(`${base}/models`, {
        ...rest,
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      }),
    );
  }
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  return ids(
    await getJson(`${base}/v1/models?limit=100`, {
      ...rest,
      'anthropic-version': '2023-06-01',
      ...(key ? { 'x-api-key': key } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    }),
  );
}

let cache: { at: number; sources: ModelSource[] } | null = null;

/** Every model you can pick for an agent: local Ollama first, then each saved connection. */
export async function modelCatalog(
  rows: Connection[],
  ollamaUrl: string,
  fresh = false,
): Promise<ModelSource[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.sources;
  const targets: Omit<ModelSource, 'models'>[] = [
    { connectionId: null, name: 'Ollama (default)', provider: 'ollama' },
    ...rows.map((c) => ({ connectionId: c.id, name: c.name, provider: c.provider })),
  ];
  const sources = await Promise.all(
    targets.map(async (t): Promise<ModelSource> => {
      const row = rows.find((c) => c.id === t.connectionId);
      const url = row ? effectiveUrl(row, ollamaUrl) : ollamaUrl;
      try {
        const models = await listModels(t.provider, url, row?.headers ?? {});
        return { ...t, models: [...new Set(models)].sort() };
      } catch (error) {
        return { ...t, models: [], error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  cache = { at: Date.now(), sources };
  return sources;
}

export const clearModelCatalog = () => {
  cache = null;
};
