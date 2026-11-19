import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Redis } from 'ioredis';
import { EventHub } from './api/event-hub.ts';
import { buildServer } from './api/server.ts';
import { loadConfig, removedEnvWarnings } from './config.ts';
import { createDb } from './db/client.ts';
import { createQueues } from './engine/queues.ts';
import { prTasks } from './integrations/pr-tasks.ts';
import { createPreviewServer } from './preview.ts';
import { startSettingsSync } from './settings.ts';
import { AgentSlack } from './slack/agent-chat.ts';
import { SlackManager } from './slack/manager.ts';
import { seedDefaultTeam } from './team-seed.ts';

const config = loadConfig();
for (const warning of removedEnvWarnings()) console.warn(`Warning: ${warning}`);
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
// The Ollama address, task defaults and Slack settings are saved in the database, not the
// environment: load them, and keep them current if they change from elsewhere.
let slackChanged: () => Promise<void> = async () => {};
const settingsSync = await startSettingsSync(db, config, {
  onChange: (change) => (change.slack ? slackChanged() : undefined),
});
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queues = createQueues(connection);
const checkpointer = new PostgresSaver(pool, undefined, { schema: 'langgraph' });
const hub = new EventHub(db, config.DATABASE_URL);
await hub.start();

// A first run starts with the built-in team instead of an empty Agents page.
const seeded = await seedDefaultTeam(db, connection, config).catch((error: unknown) => {
  console.error(
    `Starter team not added: ${error instanceof Error ? error.message : String(error)}`,
  );
  return 0;
});
if (seeded) console.log(`Added ${seeded} starter agents. Edit them on the Agents page.`);

const app = buildServer(
  { db, queues, checkpointer, config, hub, onSlackSettings: () => slackChanged() },
  config.GANTRIX_TOKEN,
);
const prScans = prTasks(app, db, connection, pool, config, config.GANTRIX_TOKEN);
await app.listen({ host: config.GANTRIX_HOST, port: config.GANTRIX_PORT });

// Sites published by deploy_site, on their own origin (see preview.ts).
const preview = createPreviewServer(config.GANTRIX_SITES_DIR, {
  checkHost: ['127.0.0.1', 'localhost', '::1'].includes(config.GANTRIX_HOST),
});
preview.on('error', (error) => console.error(`Preview server: ${error.message}`));
preview.listen(config.GANTRIX_PREVIEW_PORT, config.GANTRIX_HOST);

// Slack for projects (Settings → Slack): progress posts to a thread per project, and Socket Mode
// brings replies back. It restarts when its settings change.
const slack = new SlackManager({ db, queues, checkpointer, config }, hub, prScans.handleSlack);
slackChanged = () => slack.apply(true);
await slack.apply();

// Agents with a Slack connection (bot + app token) can be chatted with in Slack.
const agentSlack = new AgentSlack({ db, queues, checkpointer, config });
await agentSlack.start();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  preview.closeAllConnections();
  preview.close();
  await app.close();
  settingsSync.stop();
  await slack.close();
  await agentSlack.close();
  await prScans.close();
  await hub.close();
  await queues.close();
  connection.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
