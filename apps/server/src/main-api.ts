import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Redis } from 'ioredis';
import { EventHub } from './api/event-hub.ts';
import { buildServer } from './api/server.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { createQueues } from './engine/queues.ts';
import { createPreviewServer } from './preview.ts';

const config = loadConfig();
if (!config.GANTRIX_TOKEN) {
  console.error('GANTRIX_TOKEN is required to start the API. Generate one: openssl rand -hex 32');
  process.exit(1);
}
if (!['127.0.0.1', 'localhost', '::1'].includes(config.GANTRIX_HOST)) {
  console.warn(
    `Warning: listening on ${config.GANTRIX_HOST}. Anyone who can reach it and has the token can run shell commands you approve.`,
  );
}

const { db, pool } = createDb(config.DATABASE_URL);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queues = createQueues(connection);
const checkpointer = new PostgresSaver(pool, undefined, { schema: 'langgraph' });
const hub = new EventHub(db, config.DATABASE_URL);
await hub.start();

const app = buildServer({ db, queues, checkpointer, config, hub }, config.GANTRIX_TOKEN);
await app.listen({ host: config.GANTRIX_HOST, port: config.GANTRIX_PORT });

// Sites published by deploy_site, on their own origin (see preview.ts).
const preview = createPreviewServer(config.GANTRIX_SITES_DIR);
preview.on('error', (error) => console.error(`Preview server: ${error.message}`));
preview.listen(config.GANTRIX_PREVIEW_PORT, config.GANTRIX_HOST);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  preview.closeAllConnections();
  preview.close();
  await app.close();
  await hub.close();
  await queues.close();
  connection.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
