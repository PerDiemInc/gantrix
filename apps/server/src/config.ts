import { homedir } from 'node:os';
import { z } from 'zod';

// The default goes through the transform too: in Zod 4, .default() on a transformed schema
// would return the raw "~/..." string, which then became a folder literally named "~".
const path = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((p) => (p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p));
const ConfigSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  GANTRIX_HOST: z.string().default('127.0.0.1'),
  GANTRIX_PORT: z.coerce.number().int().min(1).max(65535).default(4700),
  // Optional here so the worker and migrations run without it; the API requires it at startup.
  GANTRIX_TOKEN: z.string().min(32, 'GANTRIX_TOKEN must be at least 32 characters').optional(),
  GANTRIX_WORKSPACES_DIR: path('~/.gantrix/workspaces'),
  GANTRIX_SKILLS_DIR: path('~/.gantrix/skills'),
  // deploy_site publishes here, and the preview server serves it on its own port.
  GANTRIX_SITES_DIR: path('~/.gantrix/sites'),
  GANTRIX_PREVIEW_PORT: z.coerce.number().int().min(1).max(65535).default(4702),
  // Where Slack's API is; only tests point it elsewhere.
  SLACK_API_URL: z.url().default('https://slack.com/api'),
});

/**
 * Settings chosen on the Settings page and kept in the database, not read from the environment.
 * They live on the config object (under the names the code has always read) so readers don't
 * change; the object is refreshed from the database (see settings.ts), the API the moment a
 * setting is saved and the worker every few seconds, so a change needs no restart.
 */
export interface RuntimeSettings {
  /** The local Ollama. */
  OLLAMA_BASE_URL: string;
  /** Model calls at once per worker. */
  GANTRIX_LLM_CONCURRENCY: number;
  /** New projects' limits. */
  GANTRIX_MAX_STEP_ATTEMPTS: number;
  GANTRIX_MAX_REPLANS: number;
  GANTRIX_MAX_TOKENS: number;
  GANTRIX_MAX_MINUTES: number;
  /** New projects run tools without asking (off = they ask first). */
  GANTRIX_APPROVE_ALL: boolean;
  /** New projects give each step its own folder. */
  GANTRIX_ISOLATED_STEPS: boolean;
  /** Slack for projects: a bot token and channel post a thread per project; an app token hears replies. */
  SLACK_BOT_TOKEN: string | undefined;
  SLACK_APP_TOKEN: string | undefined;
  SLACK_CHANNEL_ID: string | undefined;
  /** Slack member ids who may steer a project from Slack. */
  SLACK_ALLOWED_USERS: string[];
  /** Links in Slack messages point here. */
  GANTRIX_DASHBOARD_URL: string;
}

export const RUNTIME_DEFAULTS: Readonly<RuntimeSettings> = {
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  GANTRIX_LLM_CONCURRENCY: 2,
  GANTRIX_MAX_STEP_ATTEMPTS: 3,
  GANTRIX_MAX_REPLANS: 5,
  GANTRIX_MAX_TOKENS: 200_000,
  GANTRIX_MAX_MINUTES: 60,
  GANTRIX_APPROVE_ALL: true,
  GANTRIX_ISOLATED_STEPS: false,
  SLACK_BOT_TOKEN: undefined,
  SLACK_APP_TOKEN: undefined,
  SLACK_CHANNEL_ID: undefined,
  SLACK_ALLOWED_USERS: [],
  GANTRIX_DASHBOARD_URL: 'http://127.0.0.1:4701',
};

export type Config = z.infer<typeof ConfigSchema> & RuntimeSettings;

/**
 * The environment, plus the runtime settings at their defaults (or `overrides`, which is how tests
 * set them). A process then loads what was saved in the database over them.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<RuntimeSettings> = {},
): Config {
  // Treat empty values (e.g. "GANTRIX_TOKEN=" copied from .env.example) as unset.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = ConfigSchema.safeParse(set);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    ...parsed.data,
    ...RUNTIME_DEFAULTS,
    ...overrides,
    SLACK_ALLOWED_USERS: [
      ...(overrides.SLACK_ALLOWED_USERS ?? RUNTIME_DEFAULTS.SLACK_ALLOWED_USERS),
    ],
  };
}

/**
 * Variables that used to configure Gantrix and are not read any more: they are settings now, chosen
 * in the dashboard. Say so instead of ignoring them silently. A secret's value is never printed.
 */
const REMOVED: { name: string; what: string; where: string; secret?: true }[] = [
  { name: 'GANTRIX_DEFAULT_MODEL', what: 'the default model', where: 'Agents → Default model' },
  {
    name: 'GANTRIX_DEFAULT_CONNECTION',
    what: "the default model's connection",
    where: 'Agents → Default model',
  },
  { name: 'OLLAMA_BASE_URL', what: "Ollama's address", where: 'Settings → Ollama' },
  {
    name: 'GANTRIX_LLM_CONCURRENCY',
    what: 'how many model calls run at once',
    where: 'Settings → Task defaults',
  },
  {
    name: 'GANTRIX_MAX_STEP_ATTEMPTS',
    what: 'attempts per step',
    where: 'Settings → Task defaults',
  },
  { name: 'GANTRIX_MAX_REPLANS', what: 'the replan limit', where: 'Settings → Task defaults' },
  { name: 'GANTRIX_MAX_TOKENS', what: 'the token limit', where: 'Settings → Task defaults' },
  { name: 'GANTRIX_MAX_MINUTES', what: 'the time limit', where: 'Settings → Task defaults' },
  {
    name: 'GANTRIX_APPROVE_ALL',
    what: 'whether new projects ask first',
    where: 'Settings → Task defaults',
  },
  {
    name: 'GANTRIX_ISOLATED_STEPS',
    what: 'separate folders per step',
    where: 'Settings → Task defaults',
  },
  { name: 'SLACK_BOT_TOKEN', what: "Slack's bot token", where: 'Settings → Slack', secret: true },
  {
    name: 'SLACK_APP_TOKEN',
    what: "Slack's app-level token",
    where: 'Settings → Slack',
    secret: true,
  },
  { name: 'SLACK_CHANNEL_ID', what: 'the Slack channel', where: 'Settings → Slack' },
  { name: 'SLACK_ALLOWED_USERS', what: 'who may steer from Slack', where: 'Settings → Slack' },
  {
    name: 'GANTRIX_DASHBOARD_URL',
    what: 'the dashboard link used in Slack',
    where: 'Settings → Slack',
  },
];

export function removedEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  return REMOVED.flatMap(({ name, what, where, secret }) => {
    const value = env[name]?.trim();
    if (!value) return [];
    return [
      `${secret ? name : `${name}=${value}`} in .env is no longer read: ${what} is a setting now. Set it on ${where}, then delete the line from .env.`,
    ];
  });
}
