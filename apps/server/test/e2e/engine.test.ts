import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agents, approvals, connections, events, steps } from '../../src/db/schema.ts';
import { cancelTask, createTask, decideApproval, sendMessage } from '../../src/engine/commands.ts';
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

  it('runs gated tools without asking in god mode and marks them auto-approved', async () => {
    await e.addAgent('fetcher', ['web_fetch']);
    e.fake.script.plan = () => ({ steps: [step('fetch', 'fetcher')] });
    e.fake.script.worker = ({ toolResults }) =>
      toolResults.length
        ? `Fetch result: ${toolResults[0]}`
        : { name: 'web_fetch', args: { url: 'http://127.0.0.1:9/' } };
    const task = await createTask(e.deps, { goal: 'Fetch a page', approveAll: true });
    const done = await e.waitFor(task.id);

    expect(done.status).toBe('succeeded');
    expect(await e.db.select().from(approvals).where(eq(approvals.taskId, task.id))).toHaveLength(
      0,
    );
    const calls = (
      await e.db.select().from(events).where(eq(events.taskId, task.id)).orderBy(asc(events.id))
    ).filter((r) => r.type === 'step.tool_call');
    expect(calls.map((c) => c.payload)).toEqual([
      expect.objectContaining({ tool: 'web_fetch', autoApproved: true }),
    ]);
  });

  it('still asks when god mode is off by default', async () => {
    const t = await createTask(e.deps, { goal: 'Default task' });
    expect(t.approveAll).toBe(false);
  });

  it("sends an agent's connection headers, reading env: values from the environment", async () => {
    process.env.GX_E2E_HEADER = 'secret-123';
    await e.addAgent('writer');
    const [conn] = await e.db
      .insert(connections)
      .values({
        name: 'proxy',
        provider: 'ollama',
        baseUrl: e.fake.url,
        headers: { 'X-Gantrix-Test': 'env:GX_E2E_HEADER' },
      })
      .returning();
    await e.db.update(agents).set({ connectionId: conn!.id }).where(eq(agents.name, 'writer'));
    e.fake.script.plan = () => ({ steps: [step('notes', 'writer')] });
    const task = await createTask(e.deps, { goal: 'Write notes' });
    expect((await e.waitFor(task.id)).status).toBe('succeeded');
    // The worker's calls carry the header; the planner and judge (default model) don't.
    const sent = e.fake.headers.map((h) => h['x-gantrix-test']).filter(Boolean);
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent)).toEqual(new Set(['secret-123']));
    delete process.env.GX_E2E_HEADER;
  });

  it('runs a step with local Claude Code and judges its result', async () => {
    await e.addAgent('coder');
    const [conn] = await e.db
      .insert(connections)
      .values({
        name: 'claude-local',
        provider: 'claude-code',
        baseUrl: fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url)),
      })
      .returning();
    await e.db.update(agents).set({ connectionId: conn!.id }).where(eq(agents.name, 'coder'));
    e.fake.script.plan = () => ({ steps: [step('notes', 'coder')] });
    const task = await createTask(e.deps, { goal: 'Write notes with Claude Code' });
    const done = await e.waitFor(task.id);

    expect(done.status).toBe('succeeded');
    const [notes] = await stepsOf(task.id);
    expect(notes).toMatchObject({ status: 'succeeded', output: 'Wrote claude-notes.md.' });
    expect(notes?.tokensUsed).toBe(125 + 15); // Claude Code, then the judge
    expect(await readFile(join(done.workspacePath, 'claude-notes.md'), 'utf8')).toContain(
      'Claude Code',
    );
    expect(e.fake.calls.worker).toBe(0); // the fake Ollama only planned and judged
  });

  it("gives a running step the user's note before its next model turn", async () => {
    await e.addAgent('fetcher', ['web_fetch']);
    e.fake.script.plan = () => ({ steps: [step('fetch', 'fetcher')] });
    e.fake.script.worker = ({ toolResults }) =>
      toolResults.length ? 'Done.' : { name: 'web_fetch', args: { url: 'http://127.0.0.1:9/' } };
    const task = await createTask(e.deps, { goal: 'Fetch a page' });
    await e.waitFor(task.id, (t) => t.status === 'awaiting_approval');
    const [fetch] = await stepsOf(task.id);

    expect(
      await sendMessage(e.deps, task.id, { text: 'Use the EU site.', stepId: fetch!.id }),
    ).toMatchObject({
      status: 'sent',
    });
    const [pending] = await e.db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await decideApproval(e.deps, pending!.id, true);
    expect((await e.waitFor(task.id)).status).toBe('succeeded');

    const sawNote = e.fake.bodies.some((b) =>
      b.messages.some((m) => m.role === 'user' && m.content.includes('Use the EU site.')),
    );
    expect(sawNote).toBe(true);
    expect(await eventTypes(task.id)).toContain('user.message_delivered');
  });

  it('replans with a note to the whole team after running steps finish, keeping done work', async () => {
    await e.addAgent('fetcher', ['web_fetch', 'write_file']);
    const prompts: string[] = [];
    e.fake.script.plan = (prompt) => {
      prompts.push(prompt);
      return prompt.includes('The user says: Also add a summary.')
        ? { steps: [step('summary', 'fetcher', ['fetch'])] }
        : { steps: [step('fetch', 'fetcher')] };
    };
    e.fake.script.worker = ({ title, toolResults }) =>
      title !== 'fetch' || toolResults.length
        ? `Done ${title}.`
        : { name: 'web_fetch', args: { url: 'http://127.0.0.1:9/' } };
    const task = await createTask(e.deps, { goal: 'Fetch a page' });
    await e.waitFor(task.id, (t) => t.status === 'awaiting_approval');

    await sendMessage(e.deps, task.id, { text: 'Also add a summary.' });
    const [pending] = await e.db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await decideApproval(e.deps, pending!.id, true);
    const done = await e.waitFor(task.id);

    expect(done.status).toBe('succeeded');
    expect(done.replans).toBe(1);
    expect(prompts.at(-1)).toContain('The user says: Also add a summary.');
    const all = await stepsOf(task.id);
    expect(all.map((s) => `${s.key}:${s.status}`)).toEqual([
      'fetch:succeeded',
      'summary:succeeded',
    ]);
  });

  it('refuses notes to a finished task', async () => {
    await e.addAgent('writer');
    e.fake.script.plan = () => ({ steps: [step('notes', 'writer')] });
    const task = await createTask(e.deps, { goal: 'Write notes' });
    await e.waitFor(task.id);
    expect(await sendMessage(e.deps, task.id, { text: 'More please' })).toEqual({
      status: 'task_finished',
    });
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
