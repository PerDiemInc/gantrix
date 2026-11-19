import { DEFAULT_MODEL } from '@gantrix/shared';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { EnsureOllama } from '../models/ollama-runtime.ts';
import type { ModelDefaults } from '../models/provider.ts';
import type { SkillFetch } from '../skills/remote.ts';
import type { CheckUrl } from '../skills/tools/verify.ts';
import type { Queues } from './queues.ts';

export interface EngineDeps {
  db: Db;
  queues: Queues;
  checkpointer: PostgresSaver;
  config: Config;
  /** How deployed URLs are fetched; tests replace it. Default: a real public fetch. */
  checkUrl?: CheckUrl;
  /** How skills are downloaded from the web; tests replace it. Default: a guarded public fetch. */
  skillFetch?: SkillFetch;
  /** Checks that Ollama answers and starts it when it doesn't; tests replace it. */
  ensureOllama?: EnsureOllama;
}

export const modelDefaults = (config: Config): ModelDefaults => ({
  // Only a last resort: resolveModelSpec fills in the model chosen on the Agents page.
  defaultModel: DEFAULT_MODEL,
  ollamaBaseUrl: config.OLLAMA_BASE_URL,
});
