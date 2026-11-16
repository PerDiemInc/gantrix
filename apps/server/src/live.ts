import type {
  LiveAgentDto,
  LiveDto,
  LoadedModelDto,
  ModelProvider,
  ModelServerDto,
} from '@gantrix/shared';
import { projectTitle, TERMINAL_TASK_STATUSES } from '@gantrix/shared';
import { and, asc, count, eq, inArray, notInArray } from 'drizzle-orm';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { agents, connections, steps, tasks } from './db/schema.ts';
import { agentForProject, effectiveUrl, isLocalUrl, resolveHeaders } from './models/connections.ts';

type Connection = typeof connections.$inferSelect;
type AgentModel = Pick<
  typeof agents.$inferSelect,
  'id' | 'model' | 'modelBaseUrl' | 'connectionId'
>;

/** Ollama answers /api/ps from memory; anything slower means it isn't there. */
const PS_TIMEOUT_MS = 3_000;

/** Step states where an agent holds work: a model call, a judge, an approval or a sub-task. */
const LIVE_STEP_STATUSES = ['running', 'judging', 'awaiting_approval', 'delegating'] as const;

export type ModelUse = Pick<LiveAgentDto, 'model' | 'provider' | 'connection' | 'isLocal'>;

/**
 * Which model an agent's steps run on, for display. Follows resolveModelSpec, but never
 * throws and never reads header values: a broken setup shows as it is saved.
 */
export function describeModel(
  config: Pick<Config, 'GANTRIX_DEFAULT_MODEL' | 'GANTRIX_DEFAULT_CONNECTION' | 'OLLAMA_BASE_URL'>,
  rows: Connection[],
  agent: Omit<AgentModel, 'id'> | null,
): ModelUse {
  const viaConnection = (c: Connection, model: string | null): ModelUse => {
    const cli = c.provider === 'claude-code' || c.provider === 'codex';
    return {
      model:
        model ??
        (c.name === config.GANTRIX_DEFAULT_CONNECTION || c.provider === 'ollama'
          ? config.GANTRIX_DEFAULT_MODEL
          : 'default'),
      provider: c.provider,
      connection: c.name,
      // Claude Code and Codex run here but send the prompts to their vendors.
      isLocal: !cli && isLocalUrl(effectiveUrl(c, config.OLLAMA_BASE_URL)),
    };
  };
  const own = agent?.connectionId ? rows.find((c) => c.id === agent.connectionId) : undefined;
  if (own) return viaConnection(own, agent?.model ?? null);
  if (agent?.model || agent?.modelBaseUrl) {
    const name = agent.model ?? config.GANTRIX_DEFAULT_MODEL;
    const provider: ModelProvider = name.startsWith('openai/') ? 'openai' : 'ollama';
    const url = agent.modelBaseUrl ?? (provider === 'ollama' ? config.OLLAMA_BASE_URL : '');
    return {
      model: name.replace(/^(openai|ollama)\//, ''),
      provider,
      connection: null,
      isLocal: isLocalUrl(url),
    };
  }
  const fallback = config.GANTRIX_DEFAULT_CONNECTION
    ? rows.find((c) => c.name === config.GANTRIX_DEFAULT_CONNECTION)
    : undefined;
  if (fallback) return viaConnection(fallback, null);
  return {
    model: config.GANTRIX_DEFAULT_MODEL,
    provider: 'ollama',
    connection: null,
    isLocal: isLocalUrl(config.OLLAMA_BASE_URL),
  };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The body of Ollama's GET /api/ps: the models held in memory right now, biggest first. */
export function parseOllamaPs(body: unknown): LoadedModelDto[] {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .flatMap((raw): LoadedModelDto[] => {
      if (!raw || typeof raw !== 'object') return [];
      const m = raw as Record<string, unknown>;
      const name = str(m.name) ?? str(m.model);
      if (!name) return [];
      const details = (m.details ?? {}) as Record<string, unknown>;
      return [
        {
          name,
          sizeBytes: num(m.size),
          vramBytes: num(m.size_vram),
          parameterSize: str(details.parameter_size),
          quantization: str(details.quantization_level),
          contextLength: num(m.context_length) || null,
          expiresAt: str(m.expires_at),
        },
      ];
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

async function sampleServer(
  name: string,
  url: string,
  rawHeaders: Record<string, string>,
): Promise<ModelServerDto> {
  const base = { name, url, isLocal: isLocalUrl(url) };
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/ps`, {
      headers: resolveHeaders(rawHeaders),
      signal: AbortSignal.timeout(PS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return { ...base, available: true, models: parseOllamaPs(await res.json()) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      available: false,
      models: [],
      error: /fetch failed|ECONNREFUSED|timeout|aborted/i.test(message)
        ? 'Not reachable. Is Ollama running?'
        : message,
    };
  }
}

/** The default Ollama, then every saved Ollama connection at a different address. */
async function sampleServers(config: Config, rows: Connection[]): Promise<ModelServerDto[]> {
  const targets = new Map<string, { name: string; headers: Record<string, string> }>([
    [config.OLLAMA_BASE_URL.replace(/\/+$/, ''), { name: 'Ollama (default)', headers: {} }],
  ]);
  for (const c of rows) {
    if (c.provider !== 'ollama') continue;
    const url = effectiveUrl(c, config.OLLAMA_BASE_URL).replace(/\/+$/, '');
    if (!targets.has(url)) targets.set(url, { name: c.name, headers: c.headers });
  }
  return Promise.all([...targets].map(([url, t]) => sampleServer(t.name, url, t.headers)));
}

async function liveAgents(db: Db, config: Config, rows: Connection[]): Promise<LiveAgentDto[]> {
  const [active, planning] = await Promise.all([
    db
      .select({ step: steps, task: tasks, agent: agents })
      .from(steps)
      .innerJoin(tasks, eq(tasks.id, steps.taskId))
      .leftJoin(agents, eq(agents.id, steps.agentId))
      // A stopped project keeps its steps as they were so it can resume; they aren't live.
      .where(
        and(
          inArray(steps.status, [...LIVE_STEP_STATUSES]),
          notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        ),
      )
      .orderBy(asc(steps.startedAt)),
    db.select().from(tasks).where(eq(tasks.status, 'planning')).orderBy(asc(tasks.createdAt)),
  ]);
  const planner = describeModel(config, rows, null);
  return [
    ...active.map(({ step, task, agent }): LiveAgentDto => {
      // The judge runs on the default model, whatever the agent that did the work used.
      const judging = step.status === 'judging';
      const use =
        judging || !agent ? planner : describeModel(config, rows, agentForProject(task, agent));
      return {
        id: step.id,
        role: judging ? 'judge' : 'agent',
        agentId: agent?.id ?? null,
        agentName: agent?.name ?? 'removed agent',
        avatar: agent?.avatar ?? null,
        taskId: task.id,
        project: projectTitle(task),
        stepId: step.id,
        stepTitle: step.title,
        status: step.status,
        attempt: step.attempt,
        tokensUsed: step.tokensUsed,
        since: (step.startedAt ?? step.queuedAt)?.toISOString() ?? null,
        ...use,
      };
    }),
    ...planning.map(
      (task): LiveAgentDto => ({
        id: task.id,
        role: 'planner',
        agentId: null,
        agentName: 'planner',
        avatar: null,
        taskId: task.id,
        project: projectTitle(task),
        stepId: null,
        stepTitle: null,
        status: 'planning',
        attempt: 0,
        tokensUsed: task.tokensUsed,
        since: (task.startedAt ?? task.createdAt).toISOString(),
        ...planner,
      }),
    ),
  ];
}

/** Who is working right now, on which model, and which models are loaded in memory. */
export async function sampleLive(db: Db, config: Config): Promise<LiveDto> {
  const rows = await db.select().from(connections);
  const [working, servers, queued] = await Promise.all([
    liveAgents(db, config, rows),
    sampleServers(config, rows),
    db
      .select({ n: count() })
      .from(steps)
      .innerJoin(tasks, eq(tasks.id, steps.taskId))
      .where(and(eq(steps.status, 'queued'), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])))
      .then(([row]) => row?.n ?? 0),
  ]);
  return {
    agents: working,
    queued,
    servers,
    defaultModel: describeModel(config, rows, null).model,
    sampledAt: new Date().toISOString(),
  };
}
