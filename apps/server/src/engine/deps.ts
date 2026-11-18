import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { ModelDefaults } from '../models/provider.ts';
import type { CheckUrl } from '../skills/tools/verify.ts';
import type { Queues } from './queues.ts';

export interface EngineDeps {
  db: Db;
  queues: Queues;
  checkpointer: PostgresSaver;
  config: Config;
  /** How deployed URLs are fetched; tests replace it. Default: a real public fetch. */
  checkUrl?: CheckUrl;
}

export const modelDefaults = (config: Config): ModelDefaults => ({
  defaultModel: config.GANTRIX_DEFAULT_MODEL,
  ollamaBaseUrl: config.OLLAMA_BASE_URL,
});
