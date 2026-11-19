import { TERMINAL_TASK_STATUSES } from '@gantrix/shared';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Worker } from 'bullmq';
import { notInArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { loadConfig, removedEnvWarnings } from './config.ts';
import { createDb } from './db/client.ts';
import { tasks } from './db/schema.ts';
import type { EngineDeps } from './engine/deps.ts';
import { startJobRun } from './engine/job-runs.ts';
import { onWorkJobFailed, runWorkJob } from './engine/jobs.ts';
import {
  createQueues,
  SCHEDULES_QUEUE,
  type ScheduleJob,
  TICKS_QUEUE,
  type TickJob,
  WORK_QUEUE,
  type WorkJob,
} from './engine/queues.ts';
import { buildSupervisor, tick } from './engine/supervisor.ts';
import { startSettingsSync } from './settings.ts';

const config = loadConfig();
for (const warning of removedEnvWarnings()) console.warn(`Warning: ${warning}`);
const { db, pool } = createDb(config.DATABASE_URL);
// Ollama's address and how many model calls run at once are saved in the database; the API
// changes them, so look again every few seconds.
let setConcurrency: (n: number) => void = () => {};
const settingsSync = await startSettingsSync(db, config, {
  onChange: (change) => {
    if (change.concurrency) setConcurrency(config.GANTRIX_LLM_CONCURRENCY);
  },
});
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
setConcurrency = (n) => {
  workWorker.concurrency = n;
  console.log(`Model slots: ${n}.`);
};
// A job's cron schedule fired: start a run (skipped while the last run is still going).
const scheduleWorker = new Worker<ScheduleJob>(
  SCHEDULES_QUEUE,
  async (job) => {
    const result = await startJobRun(deps, job.data.jobId);
    if (!result.started) console.log(`Job ${job.data.jobId} not run: ${result.detail}`);
  },
  { connection, concurrency: 1 },
);
workWorker.on('failed', (job, error) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    onWorkJobFailed(deps, job.data, error).catch((e) => console.error('onWorkJobFailed:', e));
  }
});
for (const w of [tickWorker, workWorker, scheduleWorker])
  w.on('error', (e) => console.error(`${w.name}:`, e));

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
  settingsSync.stop();
  await Promise.all([tickWorker.close(), workWorker.close(), scheduleWorker.close()]);
  await queues.close();
  connection.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
