import { homedir } from 'node:os';
import { z } from 'zod';

// The default goes through the transform too: in Zod 4, .default() on a transformed schema
// would return the raw "~/..." string, which then became a folder literally named "~".
const path = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((p) => (p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p));
// An empty value in .env counts as unset.
const optionalMatch = (re: RegExp, message: string) =>
  z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .pipe(z.string().regex(re, message).optional());
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const ConfigSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  GANTRIX_HOST: z.string().default('127.0.0.1'),
  GANTRIX_PORT: z.coerce.number().int().min(1).max(65535).default(4700),
  // Optional here so the worker and migrations run without it; the API requires it at startup.
  GANTRIX_TOKEN: z.string().min(32, 'GANTRIX_TOKEN must be at least 32 characters').optional(),
  OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  GANTRIX_DEFAULT_MODEL: z.string().min(1).default('qwen3:8b'),
  // A saved connection (by name) for the planner, judges and agents without their own model.
  GANTRIX_DEFAULT_CONNECTION: z.string().min(1).optional(),
  GANTRIX_LLM_CONCURRENCY: positiveInt(2),
  GANTRIX_WORKSPACES_DIR: path('~/.gantrix/workspaces'),
  GANTRIX_SKILLS_DIR: path('~/.gantrix/skills'),
  // deploy_site publishes here, and the preview server serves it on its own port.
  GANTRIX_SITES_DIR: path('~/.gantrix/sites'),
  GANTRIX_PREVIEW_PORT: z.coerce.number().int().min(1).max(65535).default(4702),
  GANTRIX_MAX_STEP_ATTEMPTS: positiveInt(3),
  GANTRIX_MAX_REPLANS: positiveInt(5),
  GANTRIX_MAX_TOKENS: positiveInt(200_000),
  GANTRIX_MAX_MINUTES: positiveInt(60),
  // Tool calls run without asking unless a task turns approvals on ("ask first"). Set false
  // to make every new task ask before shell, web, MCP and email tools.
  GANTRIX_APPROVE_ALL: z.stringbool().default(true),
  // Give each step its own folder (steps/<id>/) with copies of its inputs, instead of one
  // shared project folder. Off by default: new projects keep the shared layout.
  GANTRIX_ISOLATED_STEPS: z.stringbool().default(false),
  // Slack (optional). Bot token + channel: projects post progress to a thread.
  // Add the app-level token (Socket Mode) and replies in the thread steer the project.
  SLACK_BOT_TOKEN: optionalMatch(/^xoxb-/, 'SLACK_BOT_TOKEN starts with xoxb-'),
  SLACK_APP_TOKEN: optionalMatch(/^xapp-/, 'SLACK_APP_TOKEN starts with xapp-'),
  SLACK_CHANNEL_ID: optionalMatch(
    /^[CG][A-Z0-9]{6,}$/,
    'SLACK_CHANNEL_ID is a channel id like C0123ABCD',
  ),
  // Slack user ids (U…) allowed to steer, answer, add agents or stop. Anyone in the channel can ask.
  SLACK_ALLOWED_USERS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  SLACK_API_URL: z.url().default('https://slack.com/api'),
  // Links in Slack messages point here.
  GANTRIX_DASHBOARD_URL: z.url().default('http://127.0.0.1:4701'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty values (e.g. "GANTRIX_TOKEN=" copied from .env.example) as unset.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = ConfigSchema.safeParse(set);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
