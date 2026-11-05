import { homedir } from 'node:os';
import { z } from 'zod';

const path = z.string().transform((p) => (p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p));
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
  GANTRIX_LLM_CONCURRENCY: positiveInt(2),
  GANTRIX_WORKSPACES_DIR: path.default('~/.gantrix/workspaces'),
  GANTRIX_SKILLS_DIR: path.default('~/.gantrix/skills'),
  GANTRIX_MAX_STEP_ATTEMPTS: positiveInt(3),
  GANTRIX_MAX_REPLANS: positiveInt(5),
  GANTRIX_MAX_TOKENS: positiveInt(200_000),
  GANTRIX_MAX_MINUTES: positiveInt(60),
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
