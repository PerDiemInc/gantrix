import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { agentSkills, agents, connections, plans, skills, steps, tasks } from '../db/schema.ts';
import { emit } from '../events.ts';
import { agentForProject, resolveModelSpec } from '../models/connections.ts';
import { createChatModel, structuredMethod, tokensUsed } from '../models/provider.ts';
import { validatePlan } from '../plan/dag.ts';
import { type Plan, PlanSchema } from '../plan/schema.ts';
import { type EngineDeps, modelDefaults } from './deps.ts';
import { latestGoalVerdict, teamNotesFor } from './supervisor.ts';

const PLAN_ATTEMPTS = 3;
const clip = (text: string | null, max: number) =>
  !text ? '' : text.length > max ? `${text.slice(0, max)}…` : text;

const SYSTEM = `You plan work for a team of AI agents. Break the goal into 2-12 steps.
Rules:
- Each step is done by one agent, chosen by name from the list.
- Steps that don't need each other's results must not depend on each other (empty dependsOn),
  so they run in parallel. Add a dependency only when a step needs another step's output.
- Each acceptance criterion must be checkable from the agent's final reply or the files it wrote.
- Never redo finished steps. New steps may depend on finished steps' keys.`;

interface TeamMember {
  id: string;
  name: string;
  description: string;
  tools: string[];
}

export async function runPlanJob(
  deps: EngineDeps,
  job: { taskId: string; version: number },
): Promise<void> {
  const { db } = deps;
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, job.taskId) });
  if (task?.status !== 'planning') return;
  const existing = await db.query.plans.findFirst({
    where: and(eq(plans.taskId, task.id), eq(plans.version, job.version)),
  });
  if (existing) return; // already planned; this is a repeated job

  const team = await loadTeam(deps, task);
  if (!team.length) {
    await failTask(
      deps,
      task.id,
      task.agentIds?.length
        ? "None of this project's agents exist any more. Start it again with other agents."
        : 'Create at least one agent before running a task.',
      0,
    );
    return;
  }
  const all = await db.select().from(steps).where(eq(steps.taskId, task.id)).orderBy(steps.id);
  const done = all.filter((s) => s.status === 'succeeded');
  const why = await whyReplan(deps, task.id, job.version, all);

  const chat = createChatModel(
    await resolveModelSpec(db, deps.config, null),
    'planner',
    modelDefaults(deps.config),
  );
  const model = chat.withStructuredOutput(PlanSchema, {
    name: 'plan',
    includeRaw: true,
    ...structuredMethod(chat),
  });
  const ctx = {
    agentNames: new Set(team.map((a) => a.name)),
    doneKeys: new Set(done.map((s) => s.key)),
  };

  let problems: string[] = [];
  let tokens = 0;
  for (let i = 0; i < PLAN_ATTEMPTS; i++) {
    const prompt = [
      task.description ? `Project: ${task.description}` : '',
      `Goal: ${task.goal}`,
      `Agents:\n${team.map((a) => `- ${a.name}: ${a.description || '(no description)'} Tools: ${a.tools.join(', ') || 'none'}`).join('\n')}`,
      done.length
        ? `Finished steps (depend on their keys; don't redo them):\n${done.map((s) => `- ${s.key}: ${s.title}. Result: ${clip(s.output, 600)}`).join('\n')}`
        : '',
      why ? `Why a new plan is needed:\n${why}` : '',
      problems.length
        ? `Your previous answer had problems; fix all of them:\n${problems.map((p) => `- ${p}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    let plan: Plan | null = null;
    try {
      const { raw, parsed } = await model.invoke([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ]);
      tokens += tokensUsed(raw as Parameters<typeof tokensUsed>[0]);
      plan = parsed ?? null;
    } catch (error) {
      problems = [`Your answer didn't match the plan schema: ${(error as Error).message}`];
      continue;
    }
    problems = plan ? validatePlan(plan, ctx) : ["Your answer didn't match the plan schema."];
    if (plan && !problems.length) {
      await savePlan(deps, task, job.version, plan, team, why || 'initial', tokens);
      return;
    }
  }
  await failTask(
    deps,
    task.id,
    `Couldn't produce a valid plan in ${PLAN_ATTEMPTS} tries:\n${problems.join('\n')}`,
    tokens,
  );
}

/** Every agent, or only the ones the project chose. */
async function loadTeam(deps: EngineDeps, task: typeof tasks.$inferSelect): Promise<TeamMember[]> {
  const only = task.agentIds;
  const rows = await deps.db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      manifest: skills.manifest,
      model: agents.model,
      modelBaseUrl: agents.modelBaseUrl,
      connectionId: agents.connectionId,
    })
    .from(agents)
    .leftJoin(agentSkills, eq(agentSkills.agentId, agents.id))
    .leftJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(only?.length ? inArray(agents.id, only) : undefined)
    .orderBy(agents.name);
  const providers = new Map(
    (
      await deps.db.select({ id: connections.id, provider: connections.provider }).from(connections)
    ).map((c) => [c.id, c.provider as string]),
  );
  const team = new Map<string, TeamMember>();
  for (const r of rows) {
    const member = team.get(r.id) ?? {
      id: r.id,
      name: r.name,
      description: r.description,
      tools: [],
    };
    // Claude Code and Codex use their own tools, so don't plan around Gantrix-only ones.
    const { connectionId } = agentForProject(task, r);
    const provider = connectionId ? providers.get(connectionId) : undefined;
    if (provider === 'claude-code' || provider === 'codex') {
      member.tools = [
        'read_file',
        'write_file',
        'list_files',
        ...(task.approveAll ? ['shell', 'web_fetch'] : []),
      ];
    } else if (r.manifest) {
      member.tools.push(
        ...r.manifest.tools,
        ...Object.keys(r.manifest.mcpServers).map((s) => `${s} (MCP)`),
      );
    }
    team.set(r.id, member);
  }
  return [...team.values()].map((m) => ({ ...m, tools: [...new Set(m.tools)] }));
}

/** Why the previous plan didn't finish the goal: failed steps, or the goal judge's reason. */
async function whyReplan(
  deps: EngineDeps,
  taskId: string,
  version: number,
  all: (typeof steps.$inferSelect)[],
): Promise<string> {
  if (version === 1) return '';
  const failed = all
    .filter((s) => s.planVersion === version - 1 && s.status === 'failed')
    .map((s) => `- Step "${s.title}" failed: ${s.error ?? s.judgeReason ?? 'unknown error'}`);
  const verdict = await latestGoalVerdict(deps.db, taskId, version - 1);
  if (verdict && !verdict.passed) failed.push(`- The goal isn't met yet: ${verdict.reason}`);
  for (const note of await teamNotesFor(deps.db, taskId, version)) {
    failed.push(`- The user says: ${note}`);
  }
  return failed.join('\n');
}

async function savePlan(
  deps: EngineDeps,
  task: typeof tasks.$inferSelect,
  version: number,
  plan: Plan,
  team: TeamMember[],
  reason: string,
  tokens: number,
): Promise<void> {
  const agentIds = new Map(team.map((a) => [a.name, a.id]));
  const startedAt = task.startedAt ?? new Date();
  await deps.db.transaction(async (tx) => {
    await tx.insert(plans).values({ taskId: task.id, version, reason });
    await tx
      .update(steps)
      .set({ status: 'superseded' })
      .where(and(eq(steps.taskId, task.id), notInArray(steps.status, ['succeeded', 'superseded'])));
    await tx.insert(steps).values(
      plan.steps.map((s) => ({
        taskId: task.id,
        planVersion: version,
        key: s.key,
        title: s.title,
        instructions: s.instructions,
        acceptance: s.acceptance,
        agentId: agentIds.get(s.agent) ?? null,
        dependsOn: s.dependsOn,
      })),
    );
    await tx
      .update(tasks)
      .set({
        status: 'running',
        replans: version - 1,
        startedAt,
        tokensUsed: sql`${tasks.tokensUsed} + ${tokens}`,
      })
      .where(eq(tasks.id, task.id));
    await emit(tx, task.id, {
      type: 'plan.created',
      version,
      stepKeys: plan.steps.map((s) => s.key),
      reason,
    });
    await emit(tx, task.id, { type: 'task.status', status: 'running' });
  });
  if (!task.startedAt) {
    // Wakes the supervisor when the time budget runs out, even if no step finishes by then.
    await deps.queues.tick(task.id, task.budget.maxMinutes * 60_000 + 1_000);
  }
  await deps.queues.tick(task.id);
}

export async function failTask(
  deps: EngineDeps,
  taskId: string,
  error: string,
  tokens: number,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status: 'failed',
        error,
        finishedAt: new Date(),
        tokensUsed: sql`${tasks.tokensUsed} + ${tokens}`,
      })
      .where(eq(tasks.id, taskId));
    await emit(tx, taskId, { type: 'task.status', status: 'failed', reason: error });
  });
  await deps.queues.tick(taskId);
}
