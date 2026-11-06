import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approvals, events, steps } from '../../src/db/schema.ts';
import { cancelTask, createTask, decideApproval } from '../../src/engine/commands.ts';
import { type Engine, startEngine } from './harness.ts';

const step = (key: string, agent: string, dependsOn: string[] = []) => ({
  key,
  title: key,
  agent,
  instructions: `Do ${key}`,
  acceptance: `${key}.md exists`,
  dependsOn,
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
  e.db.select().from(steps).where(eq(steps.taskId, taskId)).orderBy(asc(steps.id));
const eventTypes = async (taskId: string) =>
  (await e.db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.id))).map(
    (r) => r.type,
  );

describe('engine', () => {
  it('runs a diamond plan: parallel steps, then the join, then the goal check', async () => {
    await e.addAgent('writer', undefined, 2);
    e.fake.script.plan = () => ({
      steps: [step('a', 'writer'), step('b', 'writer'), step('c', 'writer', ['a', 'b'])],
    });
    const task = await createTask(e.deps, { goal: 'Write a, b, then c' });
    const done = await e.waitFor(task.id);

    expect(done.status).toBe('succeeded');
    const [a, b, c] = await stepsOf(task.id);
    expect([a?.status, b?.status, c?.status]).toEqual(['succeeded', 'succeeded', 'succeeded']);
    // a and b ran at the same time; c started only after both finished.
    expect(a?.startedAt && b?.finishedAt && a.startedAt < b.finishedAt).toBe(true);
    expect(c?.startedAt?.getTime()).toBeGreaterThanOrEqual(
      Math.max(+a!.finishedAt!, +b!.finishedAt!),
    );
    expect(await readFile(join(done.workspacePath, 'c.md'), 'utf8')).toContain('# c');
    expect(done.result).toContain('### c'); // the final step's reply
    expect(done.tokensUsed).toBeGreaterThan(0);
    expect(await eventTypes(task.id)).toContain('goal.judged');
  });

  it('retries a rejected step with feedback, then replans when attempts run out', async () => {
    await e.addAgent('writer');
    e.fake.script.plan = (prompt) =>
      prompt.includes('Why a new plan is needed')
        ? { steps: [step('good', 'writer')] }
        : { steps: [step('bad', 'writer')] };
    e.fake.script.judge = (prompt) =>
      prompt.includes('Step: bad')
        ? { passed: false, reason: 'Missing the conclusion.' }
        : { passed: true, reason: 'Fine.' };
    const task = await createTask(e.deps, { goal: 'Recover from a bad step' });
    const done = await e.waitFor(task.id);

    expect(done.status).toBe('succeeded');
    expect(done.replans).toBe(1);
    const [bad, good] = await stepsOf(task.id);
    expect(bad).toMatchObject({
      key: 'bad',
      attempt: 3,
      status: 'superseded',
      judgeReason: 'Missing the conclusion.',
    });
    expect(good).toMatchObject({ key: 'good', planVersion: 2, status: 'succeeded' });
  });

  it('pauses for approval, resumes after a yes, and runs the tool once', async () => {
    await e.addAgent('fetcher', ['web_fetch']);
    e.fake.script.plan = () => ({ steps: [step('fetch', 'fetcher')] });
    // web_fetch to 127.0.0.1 is refused by the tool itself, so nothing real is fetched.
    e.fake.script.worker = ({ toolResults }) =>
      toolResults.length
        ? `Fetch result: ${toolResults[0]}`
        : { name: 'web_fetch', args: { url: 'http://127.0.0.1:9/' } };
    const task = await createTask(e.deps, { goal: 'Fetch a page' });
    await e.waitFor(task.id, (t) => t.status === 'awaiting_approval');

    const [pending] = await e.db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(pending).toMatchObject({
      tool: 'web_fetch',
      status: 'pending',
      args: { url: 'http://127.0.0.1:9/' },
    });
    expect(await decideApproval(e.deps, pending!.id, true)).toBe('decided');
    expect(await decideApproval(e.deps, pending!.id, true)).toBe('already_decided');

    const done = await e.waitFor(task.id);
    expect(done.status).toBe('succeeded');
    const [fetch] = await stepsOf(task.id);
    expect(fetch?.output).toMatch(/private or local address/); // the tool ran and refused
    const toolCalls = (await eventTypes(task.id)).filter((t) => t === 'step.tool_call');
    expect(toolCalls).toHaveLength(1);
  });

  it('tells the agent when an approval is denied', async () => {
    await e.addAgent('fetcher', ['web_fetch']);
    e.fake.script.plan = () => ({ steps: [step('fetch', 'fetcher')] });
    e.fake.script.worker = ({ toolResults }) =>
      toolResults.length
        ? `Result: ${toolResults[0]}`
        : { name: 'web_fetch', args: { url: 'http://127.0.0.1:9/' } };
    const task = await createTask(e.deps, { goal: 'Fetch a page' });
    await e.waitFor(task.id, (t) => t.status === 'awaiting_approval');
    const [pending] = await e.db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await decideApproval(e.deps, pending!.id, false);

    const done = await e.waitFor(task.id);
    const [fetch] = await stepsOf(task.id);
    expect(done.status).toBe('succeeded');
    expect(fetch?.output).toMatch(/denied/);
    expect((await eventTypes(task.id)).filter((t) => t === 'step.tool_call')).toHaveLength(0);
  });

  it('cancels a task waiting for approval and cancels its unstarted steps', async () => {
    await e.addAgent('fetcher', ['web_fetch']);
    e.fake.script.plan = () => ({
      steps: [step('fetch', 'fetcher'), step('after', 'fetcher', ['fetch'])],
    });
    e.fake.script.worker = () => ({ name: 'web_fetch', args: { url: 'http://127.0.0.1:9/' } });
    const task = await createTask(e.deps, { goal: 'Cancel me' });
    await e.waitFor(task.id, (t) => t.status === 'awaiting_approval');

    expect(await cancelTask(e.deps, task.id)).toBe(true);
    expect(await cancelTask(e.deps, task.id)).toBe(false);
    const done = await e.waitFor(task.id);
    expect(done.status).toBe('cancelled');
    await expect
      .poll(async () => (await stepsOf(task.id)).find((s) => s.key === 'after')?.status)
      .toBe('cancelled');
  });

  it('stops with needs_attention when the token budget runs out', async () => {
    await e.addAgent('writer');
    e.fake.script.plan = () => ({ steps: [step('a', 'writer'), step('b', 'writer', ['a'])] });
    // Each fake reply costs 15 tokens: plan (15) + a's two turns (30) + judge (15) > 50.
    const task = await createTask(e.deps, { goal: 'Too expensive', budget: { maxTokens: 50 } });
    const done = await e.waitFor(task.id);
    expect(done.status).toBe('needs_attention');
    expect(done.error).toMatch(/tokens/);
    expect(await eventTypes(task.id)).toContain('budget.exceeded');
  });

  it('fails with a clear error when there are no agents', async () => {
    const task = await createTask(e.deps, { goal: 'Nobody to do it' });
    const done = await e.waitFor(task.id);
    expect(done).toMatchObject({
      status: 'failed',
      error: 'Create at least one agent before running a task.',
    });
  });

  it('retries an invalid plan with the validation errors', async () => {
    await e.addAgent('writer');
    e.fake.script.plan = (prompt) =>
      prompt.includes('Your previous answer had problems')
        ? { steps: [step('ok', 'writer')] }
        : { steps: [step('ok', 'nobody')] };
    const task = await createTask(e.deps, { goal: 'Plan twice' });
    expect((await e.waitFor(task.id)).status).toBe('succeeded');
    expect(e.fake.calls.plan).toBe(2);
    const plan = await e.db.query.steps.findFirst({
      where: and(eq(steps.taskId, task.id), eq(steps.key, 'ok')),
    });
    expect(plan?.planVersion).toBe(1);
  });
});
