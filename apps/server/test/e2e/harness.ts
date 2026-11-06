import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTerminal } from '@gantrix/shared';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import pg from 'pg';
import { loadConfig } from '../../src/config.ts';
import { createDb } from '../../src/db/client.ts';
import { agentSkills, agents, skills, tasks } from '../../src/db/schema.ts';
import type { EngineDeps } from '../../src/engine/deps.ts';
import { onWorkJobFailed, runWorkJob } from '../../src/engine/jobs.ts';
import {
  createQueues,
  TICKS_QUEUE,
  type TickJob,
  WORK_QUEUE,
  type WorkJob,
} from '../../src/engine/queues.ts';
import { buildSupervisor, tick } from '../../src/engine/supervisor.ts';
import { installSkill } from '../../src/skills/loader.ts';
import { startFakeOllama } from './fake-ollama.ts';

// Defaults match docker-compose.yml. The test database is created fresh; your data isn't touched.
const ADMIN_URL =
  process.env.GANTRIX_TEST_ADMIN_URL ?? 'postgres://gantrix:gantrix@127.0.0.1:15432/gantrix';
const TEST_DB = 'gantrix_test';
const REDIS_URL = process.env.GANTRIX_TEST_REDIS_URL ?? 'redis://127.0.0.1:16379/2';

async function freshDatabase(): Promise<string> {
  const admin = new pg.Client(ADMIN_URL);
  await admin.connect();
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${TEST_DB}'`,
  );
  await admin.query(`drop database if exists ${TEST_DB}`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

/** The real engine (supervisor + workers) against a fresh database, Valkey DB 2 and a fake model. */
export async function startEngine() {
  const databaseUrl = await freshDatabase();
  const fake = await startFakeOllama();
  const dir = await mkdtemp(join(tmpdir(), 'gantrix-e2e-'));
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL,
    OLLAMA_BASE_URL: fake.url,
    GANTRIX_DEFAULT_MODEL: 'fake',
    GANTRIX_TOKEN: 't'.repeat(32),
    GANTRIX_WORKSPACES_DIR: join(dir, 'workspaces'),
    GANTRIX_SKILLS_DIR: join(dir, 'skills'),
    GANTRIX_LLM_CONCURRENCY: '4',
  });
  const { db, pool } = createDb(databaseUrl);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  await pool.query('create schema if not exists langgraph');
  const checkpointer = new PostgresSaver(pool, undefined, { schema: 'langgraph' });
  await checkpointer.setup();

  const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await connection.flushdb();
  const queues = createQueues(connection);
  const deps: EngineDeps = { db, queues, checkpointer, config };
  const supervisor = buildSupervisor(deps);
  await queues.ticks.setGlobalConcurrency(1);
  const workers = [
    new Worker<TickJob>(TICKS_QUEUE, (job) => tick(supervisor, job.data.taskId), {
      connection,
      concurrency: 1,
    }),
    new Worker<WorkJob>(WORK_QUEUE, (job) => runWorkJob(deps, job.data), {
      connection,
      concurrency: 4,
    }),
  ];
  workers[1]?.on('failed', (job, error) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
      void onWorkJobFailed(deps, job.data, error);
  });

  /** Installs a skill with the given built-in tools and gives it to new agents. */
  async function addAgent(
    name: string,
    tools: string[] = ['read_file', 'write_file', 'list_files'],
    maxConcurrency = 2,
  ) {
    const src = join(dir, 'src', name);
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, 'SKILL.md'),
      `---\nname: ${name}-skill\ndescription: test\ntools: [${tools.join(', ')}]\n---\nTest skill.\n`,
    );
    const s = await installSkill(src, config.GANTRIX_SKILLS_DIR);
    const [skill] = await db
      .insert(skills)
      .values({
        name: s.name,
        version: s.version,
        description: s.description,
        sourcePath: s.sourcePath,
        checksum: s.checksum,
        manifest: s.manifest,
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ name, description: `${name} agent`, maxConcurrency })
      .returning();
    if (!agent || !skill) throw new Error('seed failed');
    await db.insert(agentSkills).values({ agentId: agent.id, skillId: skill.id });
    return agent;
  }

  /** Polls until the task matches `until` (default: finished), or fails after `ms`. */
  async function waitFor(
    taskId: string,
    until: (t: typeof tasks.$inferSelect) => boolean = (t) => isTerminal(t.status),
    ms = 30_000,
  ) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      if (task && until(task)) return task;
      await new Promise((r) => setTimeout(r, 100));
    }
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    throw new Error(`Timed out waiting for task ${taskId} (status: ${task?.status})`);
  }

  async function reset() {
    fake.reset();
    await db.execute('truncate tasks, agents, skills, connections, task_messages cascade');
    await rm(config.GANTRIX_SKILLS_DIR, { recursive: true, force: true });
  }

  async function close() {
    await Promise.all(workers.map((w) => w.close()));
    await queues.close();
    connection.disconnect();
    await pool.end();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }

  return { deps, db, config, fake, addAgent, waitFor, reset, close };
}

export type Engine = Awaited<ReturnType<typeof startEngine>>;
