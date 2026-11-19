import type { DefaultModelSettingDto } from '@gantrix/shared';
import { eq } from 'drizzle-orm';
import { type Config, RUNTIME_DEFAULTS, type RuntimeSettings } from './config.ts';
import type { Db } from './db/client.ts';
import { appSettings } from './db/schema.ts';

const DEFAULT_MODEL_KEY = 'default_model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The default model: what the planner, the judges and every agent without its own model use.
 * Chosen on the Agents page and kept in the database, not in the environment. Nothing saved
 * means the built-in model on the local Ollama.
 */
export async function loadDefaultModel(db: Db): Promise<DefaultModelSettingDto> {
  const row = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, DEFAULT_MODEL_KEY),
  });
  const v = row?.value as { connectionId?: unknown; model?: unknown } | undefined;
  return {
    connectionId:
      typeof v?.connectionId === 'string' && UUID.test(v.connectionId) ? v.connectionId : null,
    model: typeof v?.model === 'string' && v.model.trim() ? v.model.trim() : null,
  };
}

export async function saveDefaultModel(db: Db, value: DefaultModelSettingDto): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: DEFAULT_MODEL_KEY, value: { ...value } })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: { ...value }, updatedAt: new Date() },
    });
}

// ---- Settings page: the Ollama address, task defaults, and Slack for projects

/** Where the local Ollama is. */
export interface OllamaSettings {
  baseUrl: string;
}

/** What a new project starts with. */
export interface TaskDefaults {
  maxMinutes: number;
  maxTokens: number;
  maxReplans: number;
  maxStepAttempts: number;
  /** New projects ask before shell, web, MCP and email tools. */
  askFirst: boolean;
  /** Each step works in its own folder. */
  isolatedSteps: boolean;
  /** Model calls at once per worker. */
  llmConcurrency: number;
}

/** Slack for projects. The tokens are secrets: the API says whether they are set, never what they are. */
export interface SlackSettings {
  botToken: string | null;
  appToken: string | null;
  channelId: string | null;
  allowedUsers: string[];
  dashboardUrl: string;
}

export interface StoredSettings {
  ollama: OllamaSettings;
  taskDefaults: TaskDefaults;
  slack: SlackSettings;
}

export type SettingsGroup = 'ollama' | 'task_defaults' | 'slack';
const GROUPS: readonly SettingsGroup[] = ['ollama', 'task_defaults', 'slack'];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const int = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** The settings as saved, with the built-in default for anything not saved or not readable. */
export function settingsFromRows(
  rows: ReadonlyMap<string, Record<string, unknown>>,
): StoredSettings {
  const d = RUNTIME_DEFAULTS;
  const o = rows.get('ollama') ?? {};
  const t = rows.get('task_defaults') ?? {};
  const s = rows.get('slack') ?? {};
  return {
    ollama: { baseUrl: str(o.baseUrl) ?? d.OLLAMA_BASE_URL },
    taskDefaults: {
      maxMinutes: int(t.maxMinutes, d.GANTRIX_MAX_MINUTES, 1, 24 * 60),
      maxTokens: int(t.maxTokens, d.GANTRIX_MAX_TOKENS, 1_000, 10_000_000),
      maxReplans: int(t.maxReplans, d.GANTRIX_MAX_REPLANS, 0, 20),
      maxStepAttempts: int(t.maxStepAttempts, d.GANTRIX_MAX_STEP_ATTEMPTS, 1, 10),
      askFirst: flag(t.askFirst, !d.GANTRIX_APPROVE_ALL),
      isolatedSteps: flag(t.isolatedSteps, d.GANTRIX_ISOLATED_STEPS),
      llmConcurrency: int(t.llmConcurrency, d.GANTRIX_LLM_CONCURRENCY, 1, 16),
    },
    slack: {
      botToken: str(s.botToken),
      appToken: str(s.appToken),
      channelId: str(s.channelId),
      allowedUsers: Array.isArray(s.allowedUsers)
        ? s.allowedUsers.filter((u): u is string => typeof u === 'string' && u.trim() !== '')
        : [],
      dashboardUrl: str(s.dashboardUrl) ?? d.GANTRIX_DASHBOARD_URL,
    },
  };
}

export async function loadSettings(db: Db): Promise<StoredSettings> {
  const rows = await db.select().from(appSettings);
  return settingsFromRows(new Map(rows.map((r) => [r.key, r.value])));
}

export async function saveSettingsGroup(
  db: Db,
  group: SettingsGroup,
  value: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: group, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/** Forget what was saved for a group: it goes back to the built-in values. */
export async function clearSettingsGroup(db: Db, group: SettingsGroup): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, group));
}

/** The settings as the config object holds them. */
export function toRuntime(s: StoredSettings): RuntimeSettings {
  return {
    OLLAMA_BASE_URL: s.ollama.baseUrl.replace(/\/+$/, ''),
    GANTRIX_LLM_CONCURRENCY: s.taskDefaults.llmConcurrency,
    GANTRIX_MAX_STEP_ATTEMPTS: s.taskDefaults.maxStepAttempts,
    GANTRIX_MAX_REPLANS: s.taskDefaults.maxReplans,
    GANTRIX_MAX_TOKENS: s.taskDefaults.maxTokens,
    GANTRIX_MAX_MINUTES: s.taskDefaults.maxMinutes,
    GANTRIX_APPROVE_ALL: !s.taskDefaults.askFirst,
    GANTRIX_ISOLATED_STEPS: s.taskDefaults.isolatedSteps,
    SLACK_BOT_TOKEN: s.slack.botToken ?? undefined,
    SLACK_APP_TOKEN: s.slack.appToken ?? undefined,
    SLACK_CHANNEL_ID: s.slack.channelId ?? undefined,
    SLACK_ALLOWED_USERS: s.slack.allowedUsers,
    GANTRIX_DASHBOARD_URL: s.slack.dashboardUrl.replace(/\/+$/, ''),
  };
}

export interface SettingsChange {
  ollama: boolean;
  /** How many model calls run at once. */
  concurrency: boolean;
  /** The Slack bridge has to restart: its tokens or channel changed. */
  slack: boolean;
}

/**
 * Loads what is saved and puts it on the config object, in place, so every reader sees it on its
 * next read. Reports what changed, for the parts that have to react (the Slack bridge, the
 * worker's concurrency).
 */
export async function applyStoredSettings(db: Db, config: Config): Promise<SettingsChange> {
  const next = toRuntime(await loadSettings(db));
  const slackKeys = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL_ID'] as const;
  const change: SettingsChange = {
    ollama: config.OLLAMA_BASE_URL !== next.OLLAMA_BASE_URL,
    concurrency: config.GANTRIX_LLM_CONCURRENCY !== next.GANTRIX_LLM_CONCURRENCY,
    slack: slackKeys.some((k) => config[k] !== next[k]),
  };
  Object.assign(config, next);
  return change;
}

/**
 * Keeps a process's config in step with the saved settings: loads them now, and again every few
 * seconds, which is how the worker sees a change made through the API.
 */
export async function startSettingsSync(
  db: Db,
  config: Config,
  options: {
    intervalMs?: number;
    onChange?: (change: SettingsChange) => void | Promise<void>;
  } = {},
): Promise<{ refresh: () => Promise<SettingsChange>; stop: () => void }> {
  const refresh = async () => {
    const change = await applyStoredSettings(db, config);
    if (change.ollama || change.concurrency || change.slack) await options.onChange?.(change);
    return change;
  };
  await applyStoredSettings(db, config); // the first load is not a "change": nothing is running yet
  const timer = setInterval(() => {
    refresh().catch((e: unknown) =>
      console.error(`Settings: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, options.intervalMs ?? 5_000);
  timer.unref();
  return { refresh, stop: () => clearInterval(timer) };
}

export const SETTINGS_GROUPS = GROUPS;
