import type { ConnectionDto } from '@gantrix/shared';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { type agents, connections } from '../db/schema.ts';
import { DEFAULT_URLS, type ModelSpec } from './provider.ts';

type Connection = typeof connections.$inferSelect;
type Agent = typeof agents.$inferSelect;

const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/** "env:NAME" → that variable from the worker's environment; anything else as saved. */
export function resolveHeaders(
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      // "Bearer env:NAME" is allowed too, so the prefix can stay in the saved value.
      const parts = /^(\S+\s+)?(env:\S+)$/.exec(value.trim());
      const ref = parts?.[2] ? ENV_REF.exec(parts[2]) : null;
      if (!ref?.[1]) return [name, value];
      const resolved = env[ref[1]];
      if (!resolved) {
        throw new Error(
          `Header ${name} reads ${ref[1]}, which isn't set in the worker's environment (add it to .env and restart the worker).`,
        );
      }
      return [name, `${parts?.[1] ?? ''}${resolved}`];
    }),
  );
}

/** What the API may show: env references as they are, saved values hidden. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      const parts = /^(\S+\s+)?(env:[A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
      return [name, parts?.[2] ? `${parts[1] ?? ''}${parts[2]}` : 'hidden'];
    }),
  );
}

export function effectiveUrl(c: Pick<Connection, 'provider' | 'baseUrl'>, ollamaUrl: string) {
  if (c.baseUrl) return c.baseUrl;
  if (c.provider === 'claude-code') return 'claude';
  if (c.provider === 'http') return c.baseUrl ?? '';
  return c.provider === 'ollama' ? ollamaUrl : DEFAULT_URLS[c.provider];
}

/** Loopback and private addresses stay on this machine or network. */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === 'host.docker.internal'
  );
}

export function toConnectionDto(c: Connection, ollamaUrl: string): ConnectionDto {
  const url = effectiveUrl(c, ollamaUrl);
  // Claude Code runs here but sends the prompts to Anthropic.
  return {
    id: c.id,
    name: c.name,
    provider: c.provider,
    baseUrl: c.baseUrl,
    effectiveUrl: url,
    headers: maskHeaders(c.headers),
    isLocal: c.provider !== 'claude-code' && isLocalUrl(url),
    request: c.request ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export const connectionSpec = (c: Connection, model: string | null): ModelSpec => ({
  model,
  baseUrl: c.baseUrl,
  provider: c.provider,
  headers: resolveHeaders(c.headers),
  request: c.request,
});

/**
 * The model an agent's steps use. Without an agent (planner and judges) or without its own
 * settings, GANTRIX_DEFAULT_CONNECTION if set, else Ollama.
 */
export async function resolveModelSpec(
  db: Db,
  config: Config,
  agent: Pick<Agent, 'model' | 'modelBaseUrl' | 'connectionId'> | null,
): Promise<ModelSpec> {
  if (agent?.connectionId) {
    const c = await db.query.connections.findFirst({
      where: eq(connections.id, agent.connectionId),
    });
    if (!c) throw new Error("The agent's connection was deleted.");
    return connectionSpec(c, agent.model);
  }
  if (agent?.model || agent?.modelBaseUrl) {
    return { model: agent.model, baseUrl: agent.modelBaseUrl };
  }
  if (config.GANTRIX_DEFAULT_CONNECTION) {
    const c = await db.query.connections.findFirst({
      where: eq(connections.name, config.GANTRIX_DEFAULT_CONNECTION),
    });
    if (!c) {
      throw new Error(
        `GANTRIX_DEFAULT_CONNECTION is "${config.GANTRIX_DEFAULT_CONNECTION}", but no connection has that name.`,
      );
    }
    if (c.provider === 'claude-code' || c.provider === 'http') {
      throw new Error(
        "GANTRIX_DEFAULT_CONNECTION can't be a Claude Code or custom HTTP connection: the planner and judge need an Ollama, OpenAI or Anthropic model.",
      );
    }
    return connectionSpec(c, null);
  }
  return { model: null, baseUrl: null };
}
