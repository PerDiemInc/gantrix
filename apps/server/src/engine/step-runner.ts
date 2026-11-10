import { readFile } from 'node:fs/promises';
import { isTerminal, type StepStatus } from '@gantrix/shared';
import { type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Command, GraphRecursionError } from '@langchain/langgraph';
import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { canRetry } from '../budget.ts';
import type { Db } from '../db/client.ts';
import {
  agentSkills,
  agents,
  approvals,
  delegations,
  skills,
  steps,
  taskMessages,
  tasks,
} from '../db/schema.ts';
import { emit } from '../events.ts';
import { agentForProject, resolveModelSpec } from '../models/connections.ts';
import { createChatModel } from '../models/provider.ts';
import { changedFiles, snapshotFiles } from '../skills/file-changes.ts';
import { type AgentToolkit, combineSkills, loadVerifiedSkill } from '../skills/loader.ts';
import { openMcpTools } from '../skills/mcp.ts';
import {
  snapshotProjectInput,
  snapshotStepInput,
  stepWorkspace,
} from '../skills/step-workspace.ts';
import { ASK_USER } from '../skills/tools/ask.ts';
import { DELEGATE, delegateTool } from '../skills/tools/delegate.ts';
import { fileTools } from '../skills/tools/files.ts';
import { builtinTools } from '../skills/tools/index.ts';
import { resolveInWorkspace } from '../skills/workspace.ts';
import { startDelegations, stillWaiting } from './delegation.ts';
import { type EngineDeps, modelDefaults } from './deps.ts';
import { judgeStep, type Verdict } from './judge.ts';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  buildStepAgent,
  MAX_MODEL_TURNS,
  summarize,
} from './step-agent.ts';
import { stepThreadId } from './threads.ts';

type Task = typeof tasks.$inferSelect;
type Step = typeof steps.$inferSelect;
type Agent = typeof agents.$inferSelect;
type StepAgent = ReturnType<typeof buildStepAgent>;
type RunConfig = { configurable: { thread_id: string }; recursionLimit: number };
type AgentInput = Parameters<StepAgent['invoke']>[0];

// queued: a new attempt or a resume after approval. running/judging: BullMQ retrying after a crash.
const RUNNABLE: ReadonlySet<StepStatus> = new Set(['queued', 'running', 'judging']);
const DEP_OUTPUT_CHARS = 4_000;
// A job may no longer change a step in one of these: Resume or a new attempt took it over.
const NOT_OURS: ReadonlySet<StepStatus> = new Set(['pending', 'superseded', 'cancelled']);
const STALE_CHECK_MS = 3_000;

/** Thrown before a model turn when the task has ended, so the step stops quietly. */
export class StepStopped extends Error {}

const clip = (text: string | null, max: number) =>
  !text ? '' : text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;

export async function runStepJob(
  deps: EngineDeps,
  job: { stepId: string; attempt: number },
): Promise<void> {
  const { db } = deps;
  const step = await db.query.steps.findFirst({ where: eq(steps.id, job.stepId) });
  if (!step || step.attempt !== job.attempt || !RUNNABLE.has(step.status)) return; // stale job
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, step.taskId) });
  if (!task || isTerminal(task.status)) return;
  try {
    // 'again': every delegate request was answered at once (e.g. an unknown agent), so the
    // agent continues in this job; a new job with the same id would be dropped by BullMQ.
    for (let i = 0; i < 3; i++) {
      const fresh = await db.query.steps.findFirst({ where: eq(steps.id, job.stepId) });
      if (!fresh || (await execute(deps, task, fresh)) !== 'again') break;
    }
  } catch (error) {
    if (error instanceof StepStopped) {
      await closeStoppedStep(deps, step);
      return; // the supervisor tidies up the task
    }
    if (error instanceof GraphRecursionError) {
      const reason = `Stopped after ${MAX_MODEL_TURNS} model turns without finishing.`;
      await recordVerdict(deps, task, step, { passed: false, reason, tokens: 0 }, '');
      return;
    }
    throw error; // BullMQ retries; after the last attempt the worker marks the step failed
  } finally {
    await deps.queues.tick(task.id);
  }
}

/** A job stopped mid-run on a stopped project: its step isn't running any more. */
async function closeStoppedStep(deps: EngineDeps, step: Step): Promise<void> {
  const task = await deps.db.query.tasks.findFirst({
    columns: { status: true },
    where: eq(tasks.id, step.taskId),
  });
  if (!task || !isTerminal(task.status)) return; // resumed: a new attempt owns the step now
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(steps)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(
        and(
          eq(steps.id, step.id),
          eq(steps.attempt, step.attempt),
          inArray(steps.status, ['running', 'judging']),
        ),
      )
      .returning({ id: steps.id });
    if (row) {
      await emit(
        tx,
        step.taskId,
        {
          type: 'step.status',
          stepId: step.id,
          key: step.key,
          status: 'cancelled',
          attempt: step.attempt,
        },
        step.id,
      );
    }
  });
}

/** Whether this job should give up: the project ended, or a newer attempt owns the step. */
async function isStale(db: Db, task: Task, step: Step): Promise<boolean> {
  const [row] = await db
    .select({ taskStatus: tasks.status, attempt: steps.attempt, status: steps.status })
    .from(steps)
    .innerJoin(tasks, eq(tasks.id, steps.taskId))
    .where(and(eq(steps.id, step.id), eq(tasks.id, task.id)));
  return (
    !row || isTerminal(row.taskStatus) || row.attempt !== step.attempt || NOT_OURS.has(row.status)
  );
}

async function execute(deps: EngineDeps, task: Task, step: Step): Promise<'again' | undefined> {
  const { db, config, checkpointer } = deps;
  const agent = step.agentId
    ? await db.query.agents.findFirst({ where: eq(agents.id, step.agentId) })
    : undefined;
  if (!agent) {
    await setStep(db, task.id, step, 'failed', { error: 'Its agent was deleted.' });
    return;
  }
  const skillRows = await db
    .select({ name: skills.name, sourcePath: skills.sourcePath, checksum: skills.checksum })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(eq(agentSkills.agentId, agent.id));
  const toolkit = combineSkills(await Promise.all(skillRows.map(loadVerifiedSkill)));
  const workspace = await stepWorkspace(task.workspacePath, step.id);
  // A sub-task can't hand out sub-tasks of its own: one level keeps it understandable.
  const delegates =
    toolkit.builtinTools.has(DELEGATE) && !step.parentStepId
      ? [
          delegateTool(
            (
              await db
                .select({ id: agents.id, name: agents.name, description: agents.description })
                .from(agents)
                .where(ne(agents.id, agent.id))
            ).filter((a) => !task.agentIds?.length || task.agentIds.includes(a.id)),
            workspace !== task.workspacePath ? step.id : undefined,
          ),
        ]
      : [];

  await snapshotProjectInput(task.workspacePath, workspace, step.attempt);
  if (workspace !== task.workspacePath) {
    const sources = await db.select().from(steps).where(eq(steps.taskId, task.id));
    // Everything this step builds on, not only direct dependencies: A → B → C means C also
    // gets A's files (B's copies of them aren't passed along).
    const byKey = new Map(
      sources.filter((s) => s.status === 'succeeded' && !s.parentStepId).map((s) => [s.key, s]),
    );
    const upstream = new Set<string>();
    const visit = (keys: string[]) => {
      for (const k of keys) {
        const s = byKey.get(k);
        if (!s || upstream.has(s.id)) continue;
        upstream.add(s.id);
        visit(s.dependsOn);
      }
    };
    visit(step.dependsOn);
    for (const source of sources) {
      if (
        upstream.has(source.id) ||
        (source.status === 'succeeded' && source.parentStepId === step.id) ||
        source.id === step.parentStepId
      )
        await snapshotStepInput(task.workspacePath, workspace, source.id, step.attempt);
    }
  }
  // The project's own choice (or offload) wins over the agent's setting.
  const spec = await resolveModelSpec(db, config, agentForProject(task, agent));
  const localCli = spec.provider === 'claude-code' || spec.provider === 'codex';
  const mcp = await openMcpTools(localCli ? {} : toolkit.mcpServers, workspace);
  // A model turn can last 30 minutes on a CLI: Stop has to reach it during the turn.
  const abort = new AbortController();
  const watch = setInterval(() => {
    void isStale(db, task, step).then(
      (stale) => stale && abort.abort(),
      () => {}, // a database hiccup isn't a reason to stop
    );
  }, STALE_CHECK_MS);
  watch.unref();
  try {
    const graph = buildStepAgent({
      model: createChatModel(
        {
          ...spec,
          workspace,
          approveAll: task.approveAll,
        },
        'worker',
        modelDefaults(config),
      ),
      tools: [
        ...builtinTools(toolkit.builtinTools, workspace, {
          sitesDir: config.GANTRIX_SITES_DIR,
          previewUrl: `http://${config.GANTRIX_HOST}:${config.GANTRIX_PREVIEW_PORT}`,
        }),
        ...delegates,
        ...mcp.tools,
      ],
      autoApprove: toolkit.autoApprove,
      approveAll: task.approveAll,
      checkpointer,
      signal: abort.signal,
      beforeTurn: async () => {
        if (await isStale(db, task, step)) throw new StepStopped();
        const pending = await db
          .select()
          .from(taskMessages)
          .where(and(eq(taskMessages.stepId, step.id), isNull(taskMessages.deliveredAt)))
          .orderBy(asc(taskMessages.createdAt));
        if (!pending.length) return undefined;
        return {
          notes: pending.map(
            (m) => new HumanMessage(`Note from the user, sent while you work: ${m.text}`),
          ),
          delivered: async () => {
            await db.transaction(async (tx) => {
              await tx
                .update(taskMessages)
                .set({ deliveredAt: new Date() })
                .where(
                  inArray(
                    taskMessages.id,
                    pending.map((m) => m.id),
                  ),
                );
              for (const m of pending) {
                await emit(
                  tx,
                  task.id,
                  { type: 'user.message_delivered', messageId: m.id, stepId: step.id },
                  step.id,
                );
              }
            });
          },
        };
      },
      onToolCall: async (tool, args, autoApproved) => {
        const summary = clip(JSON.stringify(args), 200);
        await emit(
          db,
          task.id,
          {
            type: 'step.tool_call',
            stepId: step.id,
            tool,
            summary,
            ...(autoApproved ? { autoApproved } : {}),
          },
          step.id,
        );
      },
    });
    const run: RunConfig = {
      configurable: { thread_id: stepThreadId(step.id, step.attempt) },
      recursionLimit: MAX_MODEL_TURNS * 2 + 1,
    };
    const before = await graph.getState(run);
    const tokensBefore = summarize(before.values.messages ?? []).tokens;
    const input = await nextInput(
      deps,
      graph,
      run,
      task,
      step,
      agent,
      toolkit,
      workspace,
      localCli,
    );
    if (input === 'waiting') return undefined;

    if (step.status !== 'running') {
      await setStep(db, task.id, step, 'running', step.startedAt ? {} : { startedAt: new Date() });
    }
    // The judge can't see inside a CLI run, so note which files it changed.
    const filesBefore = localCli && input !== 'finished' ? await snapshotFiles(workspace) : null;
    if (input !== 'finished') {
      try {
        await graph.invoke(input, run);
      } catch (error) {
        if (abort.signal.aborted) throw new StepStopped();
        throw error;
      }
    }
    const changed = filesBefore ? await changedFiles(workspace, filesBefore) : [];

    const after = await graph.getState(run);
    const { output, tokens } = summarize((after.values.messages ?? []) as BaseMessage[]);
    await addTokens(db, task.id, step.id, tokens - tokensBefore);
    const interrupts = after.tasks.flatMap((t) => t.interrupts);
    if (interrupts.length) {
      return (await requestApprovals(deps, task, step, interrupts)) ? 'again' : undefined;
    }

    await setStep(db, task.id, step, 'judging', {});
    const workspaceFiles = await describeWorkspace(workspace, after.values.messages ?? [], changed);
    const judge = createChatModel(
      await resolveModelSpec(db, config, null),
      'judge',
      modelDefaults(config),
    );
    const verdict = await judgeStep(judge, {
      title: step.title,
      acceptance: step.acceptance,
      output,
      workspaceFiles,
    });
    await recordVerdict(deps, task, step, verdict, output);
    return undefined;
  } finally {
    clearInterval(watch);
    await mcp.close();
  }
}

/**
 * What to send the step agent next: a resume with the user's decisions, null to continue after
 * a crash, 'finished' if the agent already finished (a crash hit while judging), or the first
 * messages of a new attempt.
 */
async function nextInput(
  deps: EngineDeps,
  graph: StepAgent,
  run: RunConfig,
  task: Task,
  step: Step,
  agent: Agent,
  toolkit: AgentToolkit,
  workspace: string,
  localCli: boolean,
): Promise<AgentInput | 'waiting' | 'finished'> {
  const snapshot = await graph.getState(run);
  const interrupts = snapshot.tasks.flatMap((t) => t.interrupts);
  if (interrupts.length) {
    const ids = interrupts.map((i) => i.id ?? '');
    const rows = await deps.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.stepId, step.id), inArray(approvals.interruptId, ids)));
    const subs = await deps.db
      .select()
      .from(delegations)
      .where(and(eq(delegations.stepId, step.id), inArray(delegations.interruptId, ids)));
    if (rows.length + subs.length < ids.length) {
      await requestApprovals(deps, task, step, interrupts); // heal a crash before they were saved
      return 'waiting';
    }
    if (rows.some((r) => r.status === 'pending') || subs.some((d) => d.status === 'running')) {
      return 'waiting';
    }
    const decisions: Record<string, ApprovalDecision> = Object.fromEntries([
      ...rows.map((r) => [r.interruptId, { approved: r.status === 'approved', answer: r.answer }]),
      ...subs.map((d) => [d.interruptId, { approved: true, answer: d.answer }]),
    ]);
    return new Command({ resume: decisions }) as AgentInput;
  }
  if (snapshot.next.length) return null;
  if (snapshot.values.messages?.length) return 'finished';
  return {
    messages: await firstMessages(deps.db, task, step, agent, toolkit, workspace, localCli),
  };
}

async function firstMessages(
  db: Db,
  task: Task,
  step: Step,
  agent: Agent,
  toolkit: AgentToolkit,
  /** The step's folder: the project folder, or steps/<id>/ when steps are isolated. */
  workspace: string,
  /** Claude Code or Codex: they use their own tools, not Gantrix's. */
  localCli: boolean,
): Promise<BaseMessage[]> {
  const inputs = step.dependsOn.length
    ? await db
        .select({ id: steps.id, title: steps.title, output: steps.output })
        .from(steps)
        .where(
          and(
            eq(steps.taskId, task.id),
            eq(steps.status, 'succeeded'),
            inArray(steps.key, step.dependsOn),
          ),
        )
    : [];
  const isolated = workspace !== task.workspacePath;
  const workspaceInstructions = isolated
    ? `Use your tools in your separate step workspace. Project inputs are in inputs/project/.
Completed dependency artifacts and delegated results are copied into inputs/<step-id>/.
Use list_files to discover their paths; predecessor paths are not at this workspace's root.`
    : 'Use your tools in the shared task workspace. Other agents may also write there.';
  const system = [
    agent.systemPrompt,
    `You are "${agent.name}", one agent in a team working toward this goal:
${task.goal}

Your step: ${step.title}
Done when: ${step.acceptance}

Do only this step: other agents handle the other steps, so don't do their work.${
      step.parentStepId
        ? '\nAnother agent handed you this step as a sub-task and waits for your reply: make it complete and specific (what you did, files, URLs, values, anything that failed).'
        : ''
    }
${workspaceInstructions}
Shell and MCP are NOT sandboxed; stay within this workspace.${
      localCli
        ? "\nGantrix tools your instructions may name (ask_user, delegate, deploy_site, MCP tools) don't exist in this run: use your own file and shell tools. Don't wait for an answer: make a sensible assumption, say what you assumed, and say what is left for someone else to do."
        : ''
    }
When you finish, reply with a summary that
includes the key content and the paths of any files you wrote. A reviewer checks that reply
against "Done when".`,
    toolkit.instructions,
  ]
    .filter(Boolean)
    .join('\n\n');
  const user = [
    step.instructions,
    inputs.length
      ? `Results of the steps this one depends on:\n${inputs.map((i) => `### ${i.title}${isolated ? ` (files: inputs/${i.id}/)` : ''}\n${clip(i.output, DEP_OUTPUT_CHARS)}`).join('\n\n')}`
      : '',
    step.attempt > 1 && step.judgeReason
      ? `Your previous attempt was rejected: ${step.judgeReason}\nPrevious reply:\n${clip(step.output, DEP_OUTPUT_CHARS)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [new SystemMessage(system), new HumanMessage(user)];
}

/**
 * Saves what a paused step waits for: approvals and questions for the user, and sub-tasks for
 * other agents. Returns true when nothing is left to wait for (every delegate request was
 * answered at once), so the caller resumes the agent straight away.
 */
async function requestApprovals(
  deps: EngineDeps,
  task: Task,
  step: Step,
  interrupts: { id?: string; value?: unknown }[],
): Promise<boolean> {
  const asks = interrupts.filter((i) => (i.value as ApprovalRequest).tool !== DELEGATE);
  const subs = interrupts.filter((i) => (i.value as ApprovalRequest).tool === DELEGATE);
  return deps.db.transaction(async (tx) => {
    const created = asks.length
      ? await tx
          .insert(approvals)
          .values(
            asks.map((i) => {
              const request = i.value as ApprovalRequest;
              return {
                taskId: task.id,
                stepId: step.id,
                interruptId: i.id ?? '',
                tool: request.tool,
                args: request.args,
              };
            }),
          )
          .onConflictDoNothing()
          .returning()
      : [];
    for (const a of created) {
      await emit(
        tx,
        task.id,
        {
          type: 'approval.requested',
          approvalId: a.id,
          stepId: step.id,
          tool: a.tool,
          ...(a.tool === ASK_USER ? { question: String(a.args.question ?? '') } : {}),
        },
        step.id,
      );
    }
    if (subs.length) {
      await startDelegations(
        tx,
        task,
        step,
        subs.map((i) => ({ interruptId: i.id ?? '', args: (i.value as ApprovalRequest).args })),
      );
    }
    const waiting = await stillWaiting(tx, step.id);
    if (!waiting) return true;
    const status = waiting === 'user' ? 'awaiting_approval' : 'delegating';
    await tx.update(steps).set({ status }).where(eq(steps.id, step.id));
    await emit(
      tx,
      task.id,
      { type: 'step.status', stepId: step.id, key: step.key, status, attempt: step.attempt },
      step.id,
    );
    return false;
  });
}

/** Passed → succeeded. Failed → another attempt with the judge's feedback, or failed when out of attempts. */
async function recordVerdict(
  deps: EngineDeps,
  task: Task,
  step: Step,
  verdict: Verdict,
  output: string,
): Promise<void> {
  await addTokens(deps.db, task.id, step.id, verdict.tokens);
  const fields = { output, judgeReason: verdict.reason };
  if (verdict.passed) {
    await setStep(deps.db, task.id, step, 'succeeded', { ...fields, finishedAt: new Date() });
  } else if (canRetry(step, task.budget)) {
    await setStep(deps.db, task.id, step, 'pending', fields); // the supervisor queues the next attempt
  } else {
    await setStep(deps.db, task.id, step, 'failed', {
      ...fields,
      error: verdict.reason,
      finishedAt: new Date(),
    });
  }
}

export async function setStep(
  db: Db,
  taskId: string,
  step: Step,
  status: StepStatus,
  fields: Partial<typeof steps.$inferInsert>,
): Promise<void> {
  const applied = await db.transaction(async (tx) => {
    // Only this attempt, and only while it still owns the step (see NOT_OURS).
    const [row] = await tx
      .update(steps)
      .set({ ...fields, status })
      .where(
        and(
          eq(steps.id, step.id),
          eq(steps.attempt, step.attempt),
          notInArray(steps.status, [...NOT_OURS]),
        ),
      )
      .returning({ id: steps.id });
    if (!row) return false;
    await emit(
      tx,
      taskId,
      { type: 'step.status', stepId: step.id, key: step.key, status, attempt: step.attempt },
      step.id,
    );
    return true;
  });
  if (!applied) throw new StepStopped();
  step.status = status;
}

async function addTokens(db: Db, taskId: string, stepId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  await db.transaction(async (tx) => {
    await tx
      .update(steps)
      .set({ tokensUsed: sql`${steps.tokensUsed} + ${tokens}` })
      .where(eq(steps.id, stepId));
    await tx
      .update(tasks)
      .set({ tokensUsed: sql`${tasks.tokensUsed} + ${tokens}` })
      .where(eq(tasks.id, taskId));
  });
}

const MAX_JUDGED_FILES = 5;
const MAX_JUDGED_FILE_CHARS = 4_000;

/** The workspace listing, plus the contents of the files this step wrote, for the judge. */
async function describeWorkspace(
  workspace: string,
  messages: readonly BaseMessage[],
  /** Files a CLI run changed; it makes no write_file calls for us to read. */
  changed: readonly string[] = [],
): Promise<string> {
  const list = fileTools(workspace).find((t) => t.name === 'list_files');
  const listing = list ? String(await list.invoke({})) : '';
  const written = new Set<string>(changed);
  for (const m of messages) {
    for (const call of (m as { tool_calls?: { name: string; args: { path?: unknown } }[] })
      .tool_calls ?? []) {
      if (call.name === 'write_file' && typeof call.args.path === 'string')
        written.add(call.args.path);
    }
  }
  const contents: string[] = [];
  for (const path of [...written].slice(-MAX_JUDGED_FILES)) {
    try {
      const text = await readFile(await resolveInWorkspace(workspace, path), 'utf8');
      if (text.includes('\0')) contents.push(`### ${path}\n(binary file)`);
      else contents.push(`### ${path}\n${clip(text, MAX_JUDGED_FILE_CHARS)}`);
    } catch {
      contents.push(`### ${path}\n(could not be read)`);
    }
  }
  return contents.length
    ? `${listing}\n\nFiles this step wrote:\n${contents.join('\n\n')}`
    : listing;
}
