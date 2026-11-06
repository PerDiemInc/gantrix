import { TERMINAL_TASK_STATUSES } from '@gantrix/shared';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Worker } from 'bullmq';
import { notInArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { tasks } from './db/schema.ts';
import type { EngineDeps } from './engine/deps.ts';
import { onWorkJobFailed, runWorkJob } from './engine/jobs.ts';
import {
  createQueues,
  TICKS_QUEUE,
  type TickJob,
  WORK_QUEUE,
  type WorkJob,
} from './engine/queues.ts';
import { buildSupervisor, tick } from './engine/supervisor.ts';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }); // BullMQ requires null
const queues = createQueues(connection);
const checkpointer = new PostgresSaver(pool, undefined, { schema: 'langgraph' });
const deps: EngineDeps = { db, queues, checkpointer, config };
const supervisor = buildSupervisor(deps);

// One tick at a time across all tasks and worker processes: ticks are ~13 ms and never call a model.
await queues.ticks.setGlobalConcurrency(1);

const tickWorker = new Worker<TickJob>(TICKS_QUEUE, (job) => tick(supervisor, job.data.taskId), {
  connection,
  concurrency: 1,
});
const workWorker = new Worker<WorkJob>(WORK_QUEUE, (job) => runWorkJob(deps, job.data), {
  connection,
  concurrency: config.GANTRIX_LLM_CONCURRENCY,
});
workWorker.on('failed', (job, error) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    onWorkJobFailed(deps, job.data, error).catch((e) => console.error('onWorkJobFailed:', e));
  }
});
for (const w of [tickWorker, workWorker]) w.on('error', (e) => console.error(`${w.name}:`, e));

// Catch up on tasks that changed while no worker was running.
const open = await db
  .select({ id: tasks.id })
  .from(tasks)
  .where(notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]));
for (const t of open) await queues.tick(t.id);
console.log(
  `Gantrix worker ready: ${config.GANTRIX_LLM_CONCURRENCY} model slots, ${open.length} open tasks.`,
);

// A model call can hang (a looping generation, a dead server). After this long, stop anyway:
// BullMQ hands unfinished jobs to the next worker, and steps resume from their checkpoint.
const SHUTDOWN_GRACE_MS = 20_000;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) {
    console.log(`${signal} again: stopping now.`);
    process.exit(1);
  }
  stopping = true;
  console.log(
    `${signal}: finishing current jobs (up to ${SHUTDOWN_GRACE_MS / 1000} s; press Ctrl+C again to stop now)…`,
  );
  setTimeout(() => {
    console.log('Jobs still running; stopping anyway. They will resume on the next start.');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS).unref();
  await Promise.all([tickWorker.close(), workWorker.close()]);
  await queues.close();
  connection.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
