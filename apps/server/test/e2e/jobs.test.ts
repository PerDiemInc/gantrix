import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agents, jobs, steps } from '../../src/db/schema.ts';
import { startJobRun } from '../../src/engine/job-runs.ts';
import { type Engine, startEngine } from './harness.ts';

let e: Engine;
beforeAll(async () => {
  e = await startEngine();
});
afterAll(async () => {
  await e?.close();
});
beforeEach(async () => {
  await e.reset();
});

async function makeJob(agentId: string, extra: Partial<typeof jobs.$inferInsert> = {}) {
  const [job] = await e.db
    .insert(jobs)
    .values({
      name: 'daily-scan',
      goal: 'Write a.md then b.md',
      steps: [
        { title: 'a', agentId, instructions: 'Do a', acceptance: 'a.md exists' },
        { title: 'b', agentId, instructions: 'Do b', acceptance: '' },
      ],
      ...extra,
    })
    .returning();
  if (!job) throw new Error('seed failed');
  return job;
}

describe('jobs', () => {
  it('runs the steps in order with no planner, and links the run to the job', async () => {
    const agent = await e.addAgent('writer');
    const job = await makeJob(agent.id);
    const result = await startJobRun(e.deps, job.id);
    if (!result.started) throw new Error(result.detail);
    const done = await e.waitFor(result.taskId);

    expect(done.status).toBe('succeeded');
    expect(done.jobId).toBe(job.id);
    const rows = await e.db
      .select()
      .from(steps)
      .where(eq(steps.taskId, done.id))
      .orderBy(asc(steps.id));
    expect(rows.map((s) => [s.key, s.dependsOn, s.status])).toEqual([
      ['step_1', [], 'succeeded'],
      ['step_2', ['step_1'], 'succeeded'],
    ]);
    // The second step started only after the first one finished.
    expect(rows[1]?.startedAt?.getTime()).toBeGreaterThanOrEqual(+(rows[0]?.finishedAt ?? 0));
  });

  it("doesn't start a run while the previous one is still going", async () => {
    const agent = await e.addAgent('writer');
    const job = await makeJob(agent.id);
    const first = await startJobRun(e.deps, job.id);
    const second = await startJobRun(e.deps, job.id);
    expect(first.started).toBe(true);
    expect(second).toMatchObject({ started: false, reason: 'running' });
    if (first.started) await e.waitFor(first.taskId);
    expect((await startJobRun(e.deps, job.id)).started).toBe(true);
  });

  it('reports a deleted agent instead of starting', async () => {
    const agent = await e.addAgent('writer');
    const job = await makeJob(agent.id);
    await e.db.delete(agents).where(eq(agents.id, agent.id));
    expect(await startJobRun(e.deps, job.id)).toMatchObject({ started: false, reason: 'agents' });
  });

  it('registers a cron schedule and removes it when paused', async () => {
    const agent = await e.addAgent('writer');
    const job = await makeJob(agent.id, { schedule: '0 9 * * *', timezone: 'UTC' });
    await e.deps.queues.syncSchedule(job);
    expect((await e.deps.queues.nextRun(job.id))?.getUTCHours()).toBe(9);
    await e.deps.queues.syncSchedule({ ...job, enabled: false });
    expect(await e.deps.queues.nextRun(job.id)).toBeNull();
  });
});
