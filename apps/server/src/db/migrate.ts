import { fileURLToPath } from 'node:url';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.ts';
import { createDb } from './client.ts';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL, 2);

try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  // LangGraph checkpoints live in their own schema, apart from Gantrix's tables.
  await pool.query('create schema if not exists langgraph');
  await new PostgresSaver(pool, undefined, { schema: 'langgraph' }).setup();
  console.log('Migrations applied.');
} finally {
  await pool.end();
}
