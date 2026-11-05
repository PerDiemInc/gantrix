import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { ModelDefaults } from '../models/provider.ts';
import type { Queues } from './queues.ts';

export interface EngineDeps {
  db: Db;
  queues: Queues;
  checkpointer: PostgresSaver;
  config: Config;
}

export const modelDefaults = (config: Config): ModelDefaults => ({
  defaultModel: config.GANTRIX_DEFAULT_MODEL,
  ollamaBaseUrl: config.OLLAMA_BASE_URL,
});
