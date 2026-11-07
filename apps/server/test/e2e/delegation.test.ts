import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { delegations, events, steps } from '../../src/db/schema.ts';
import { createTask } from '../../src/engine/commands.ts';
import { type Engine, startEngine } from './harness.ts';

const step = (key: string, agent: string) => ({
  key,
  title: key,
  agent,
  instructions: `Do ${key}`,
  acceptance: `${key} is done`,
  dependsOn: [],
});
const handOff = (agent: string, title: string) => ({
  name: 'delegate',
  args: {
    agent,
    title,
    instructions: `Please do ${title} in infra/ and report the outputs.`,
    acceptance: `${title} is written`,
  },
});

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

const stepsOf = (taskId: string) =>
  e.db.select().from(steps).where(eq(steps.taskId, taskId)).orderBy(asc(steps.createdAt));

describe('delegation (sub-agents)', () => {
  it('runs a sub-task for another agent and resumes the lead with its result', async () => {
    await e.addAgent('deployer', ['read_file', 'delegate']);
    await e.addAgent('aws', ['write_file']);
    e.fake.script.plan = () => ({ steps: [step('deploy', 'deployer')] });
    const leadSaw: string[] = [];
    e.fake.script.worker = ({ title, toolResults, tools }) => {
      if (title === 'deploy') {
        expect(tools).toContain('delegate');
        if (!toolResults.length) return handOff('aws', 'Write main.tf');
        leadSaw.push(toolResults.at(-1) ?? '');
        return `Deployed. ${toolResults.at(-1)}`;
      }
      expect(tools).not.toContain('delegate'); // one level only
      return 'main.tf written; output url = https://example.test';
    };
    // Isolated steps: the lead is told where the sub-agent's files were copied.
    const isolated = { ...e.deps, config: { ...e.config, GANTRIX_ISOLATED_STEPS: true } };
    const task = await createTask(isolated, { goal: 'Deploy to AWS', approveAll: true });
    expect((await e.waitFor(task.id)).status).toBe('succeeded');

    const [lead, sub] = await stepsOf(task.id);
    expect(sub).toMatchObject({
      title: 'Write main.tf',
      parentStepId: lead?.id,
      status: 'succeeded',
    });
    expect(lead?.status).toBe('succeeded');
    expect(leadSaw[0]).toContain('aws finished "Write main.tf"');
    expect(leadSaw[0]).toContain('https://example.test');
    expect(leadSaw[0]).toContain(`inputs/${sub!.id}/`);
    expect(leadSaw[0]).toContain(`child step ${sub!.id}`);
    const types = (await e.db.select().from(events).where(eq(events.taskId, task.id))).map(
      (r) => r.type,
    );
    expect(types).toContain('delegation.started');
    expect(types).toContain('delegation.finished');
    expect(
      (
        await e.db
          .select()
          .from(steps)
          .where(and(eq(steps.taskId, task.id), eq(steps.status, 'delegating')))
      ).length,
    ).toBe(0);
  });

  it('answers a bad hand-off at once and the lead carries on', async () => {
    await e.addAgent('deployer', ['delegate']);
    e.fake.script.plan = () => ({ steps: [step('deploy', 'deployer')] });
    const leadSaw: string[] = [];
    e.fake.script.worker = ({ toolResults }) => {
      if (!toolResults.length) return handOff('nobody', 'Write main.tf');
      leadSaw.push(toolResults.at(-1) ?? '');
      return 'Did it myself.';
    };
    const task = await createTask(e.deps, { goal: 'Deploy', approveAll: true });
    expect((await e.waitFor(task.id)).status).toBe('succeeded');
    expect(leadSaw[0]).toContain('there is no agent named "nobody"');
    expect(await stepsOf(task.id)).toHaveLength(1);
    const [d] = await e.db.select().from(delegations).where(eq(delegations.taskId, task.id));
    expect(d).toMatchObject({ status: 'done', childStepId: null });
  });

  it('reports a failed sub-task to the lead instead of failing the project', async () => {
    await e.addAgent('deployer', ['delegate']);
    await e.addAgent('gcp', ['write_file']);
    e.fake.script.plan = () => ({ steps: [step('deploy', 'deployer')] });
    e.fake.script.judge = (prompt) =>
      prompt.includes('Cloud Run')
        ? { passed: false, reason: 'No service was created.' }
        : { passed: true, reason: 'ok' };
    const leadSaw: string[] = [];
    e.fake.script.worker = ({ title, toolResults }) => {
      if (title === 'deploy') {
        if (!toolResults.length) return handOff('gcp', 'Cloud Run service');
        leadSaw.push(toolResults.at(-1) ?? '');
        return 'The GCP part failed; reported it.';
      }
      return 'I tried.';
    };
    const task = await createTask(e.deps, { goal: 'Deploy to GCP', approveAll: true });
    const done = await e.waitFor(task.id, undefined, 60_000);
    expect(done.status).toBe('succeeded');
    expect(done.replans).toBe(0);
    const [, sub] = await stepsOf(task.id);
    expect(sub?.status).toBe('failed');
    expect(leadSaw[0]).toContain('gcp couldn\'t finish "Cloud Run service" (failed)');
  });
});
