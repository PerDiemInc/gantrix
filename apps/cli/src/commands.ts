import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  type AgentDto,
  type ApprovalListItem,
  isTerminal,
  type SkillDto,
  type TaskDetailDto,
  type TaskDto,
  type TaskListItem,
} from '@gantrix/shared';
import { ApiError, type Client } from './client.ts';
import { describeEvent, duration, gantt, paint, stepIcon, table, taskStatus } from './format.ts';

const short = (id: string) => id.slice(-8);

/** "last", a full id, or the end of one (as `gantrix tasks` prints it). */
export async function resolveTask(client: Client, ref: string): Promise<string> {
  const tasks = await client.get<TaskListItem[]>('/api/tasks?limit=200');
  if (ref === 'last') {
    if (!tasks[0]) throw new Error('No tasks yet.');
    return tasks[0].id;
  }
  const matches = tasks.filter((t) => t.id === ref || t.id.endsWith(ref));
  if (matches.length === 1 && matches[0]) return matches[0].id;
  throw new Error(
    matches.length
      ? `"${ref}" matches ${matches.length} tasks; use more characters.`
      : `No task matches "${ref}".`,
  );
}

// ---- agents

export async function listAgents(client: Client): Promise<void> {
  const agents = await client.get<AgentDto[]>('/api/agents');
  if (!agents.length)
    return console.log(
      'No agents yet. Add one: gantrix agents add writer --skills workspace-files',
    );
  console.log(
    table([
      ['NAME', 'MODEL', 'MAX', 'SKILLS', 'DESCRIPTION'].map((h) => paint('bold', h)),
      ...agents.map((a) => [
        a.name,
        a.model ?? paint('gray', 'default'),
        String(a.maxConcurrency),
        a.skills.map((s) => s.name).join(', ') || paint('gray', 'none'),
        a.description,
      ]),
    ]),
  );
}

export async function addAgent(
  client: Client,
  name: string,
  o: {
    description?: string;
    model?: string;
    baseUrl?: string;
    maxConcurrency?: string;
    skills?: string;
    prompt?: string;
  },
): Promise<void> {
  const skillIds = o.skills ? await skillIdsByName(client, o.skills.split(',')) : [];
  const agent = await client.post<AgentDto>('/api/agents', {
    name,
    skillIds,
    ...(o.description ? { description: o.description } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.baseUrl ? { modelBaseUrl: o.baseUrl } : {}),
    ...(o.maxConcurrency ? { maxConcurrency: Number(o.maxConcurrency) } : {}),
    ...(o.prompt ? { systemPrompt: o.prompt } : {}),
  });
  console.log(`Added agent ${paint('bold', agent.name)} with ${agent.skills.length} skill(s).`);
}

export async function removeAgent(client: Client, name: string): Promise<void> {
  const agent = (await client.get<AgentDto[]>('/api/agents')).find((a) => a.name === name);
  if (!agent) throw new Error(`No agent named "${name}".`);
  await client.del(`/api/agents/${agent.id}`);
  console.log(`Removed agent ${name}.`);
}

// ---- skills

/** Newest installed version of each named skill. */
async function skillIdsByName(client: Client, names: string[]): Promise<string[]> {
  const skills = await client.get<SkillDto[]>('/api/skills');
  return names.map((raw) => {
    const name = raw.trim();
    const versions = skills.filter((s) => s.name === name);
    const newest = versions.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    )[0];
    if (!newest)
      throw new Error(`No skill named "${name}". Install it first: gantrix skills add <folder>`);
    return newest.id;
  });
}

export async function listSkills(client: Client): Promise<void> {
  const skills = await client.get<SkillDto[]>('/api/skills');
  if (!skills.length)
    return console.log('No skills yet. Install one: gantrix skills add ./path/to/skill-folder');
  console.log(
    table([
      ['NAME', 'VERSION', 'TOOLS', 'MCP', 'DESCRIPTION'].map((h) => paint('bold', h)),
      ...skills.map((s) => [
        s.name,
        s.version,
        s.manifest.tools.join(', ') || paint('gray', 'none'),
        Object.keys(s.manifest.mcpServers).join(', ') || paint('gray', 'none'),
        s.description,
      ]),
    ]),
  );
}

export async function addSkill(client: Client, folder: string): Promise<void> {
  const skill = await client.post<SkillDto>('/api/skills', { path: resolve(folder) });
  console.log(
    `Installed ${paint('bold', skill.name)} ${skill.version} (${skill.manifest.tools.length} tools).`,
  );
}

export async function removeSkill(client: Client, ref: string): Promise<void> {
  const [name, version] = ref.split('@');
  const matches = (await client.get<SkillDto[]>('/api/skills')).filter(
    (s) => s.name === name && (!version || s.version === version),
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      matches.length ? `Several versions installed; use ${name}@<version>.` : `No skill "${ref}".`,
    );
  }
  await client.del(`/api/skills/${matches[0].id}`);
  console.log(`Removed skill ${ref}.`);
}

// ---- tasks

export async function listTasks(client: Client, o: { limit?: string }): Promise<void> {
  const tasks = await client.get<TaskListItem[]>(`/api/tasks?limit=${o.limit ?? 20}`);
  if (!tasks.length) return console.log('No tasks yet. Start one: gantrix run "<goal>"');
  console.log(
    table([
      ['ID', 'STATUS', 'STEPS', 'TOKENS', 'AGE', 'GOAL'].map((h) => paint('bold', h)),
      ...tasks.map((t) => {
        const total = Object.values(t.stepCounts).reduce((a, b) => a + (b ?? 0), 0);
        return [
          short(t.id),
          taskStatus(t.status),
          total ? `${t.stepCounts.succeeded ?? 0}/${total}` : '-',
          String(t.tokensUsed),
          duration(Date.now() - new Date(t.createdAt).getTime()),
          t.goal.length > 60 ? `${t.goal.slice(0, 59)}…` : t.goal,
        ];
      }),
    ]),
  );
}

export async function runTask(
  client: Client,
  goal: string,
  o: { maxMinutes?: string; maxTokens?: string; maxReplans?: string; detach?: boolean },
): Promise<void> {
  const budget = {
    ...(o.maxMinutes ? { maxMinutes: Number(o.maxMinutes) } : {}),
    ...(o.maxTokens ? { maxTokens: Number(o.maxTokens) } : {}),
    ...(o.maxReplans ? { maxReplans: Number(o.maxReplans) } : {}),
  };
  const task = await client.post<TaskDto>('/api/tasks', { goal, budget });
  console.log(`Task ${paint('bold', short(task.id))} created. Workspace: ${task.workspacePath}`);
  if (!o.detach) await tail(client, task.id);
}

export async function showTask(client: Client, ref: string, o: { all?: boolean }): Promise<void> {
  const id = await resolveTask(client, ref);
  const [task, agents] = await Promise.all([
    client.get<TaskDetailDto>(`/api/tasks/${id}`),
    client.get<AgentDto[]>('/api/agents'),
  ]);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const steps = o.all ? task.steps : task.steps.filter((s) => s.status !== 'superseded');
  console.log(`${paint('bold', short(task.id))}  ${taskStatus(task.status)}  ${task.goal}`);
  console.log(
    paint(
      'gray',
      `plan v${task.plans.length} · ${task.replans} replans · ${task.tokensUsed}/${task.budget.maxTokens} tokens · ${task.workspacePath}`,
    ),
  );
  console.log(`\n${gantt(task, steps, names)}\n`);
  const pending = task.approvals.filter((a) => a.status === 'pending');
  for (const a of pending)
    console.log(
      paint(
        'yellow',
        `✋ waiting for approval ${short(a.id)}: ${a.tool} ${JSON.stringify(a.args)}`,
      ),
    );
  if (task.error) console.log(paint('red', task.error));
  if (task.result) console.log(`${paint('bold', 'Result')}\n${task.result}`);
}

/** Streams a task's events until it finishes; asks about approvals when run in a terminal. */
export async function tail(client: Client, ref: string): Promise<void> {
  const id = await resolveTask(client, ref);
  const detail = await client.get<TaskDetailDto>(`/api/tasks/${id}`);
  const keys = new Map(detail.steps.map((s) => [s.id, s.key]));
  const interactive = stdin.isTTY && stdout.isTTY;
  const done = new AbortController();
  let finished = isTerminal(detail.status);
  await client.stream(
    `/api/stream?taskId=${id}`,
    async (e) => {
      if (e.type === 'step.status') keys.set(e.stepId, e.key);
      console.log(describeEvent(e, keys));
      if (e.type === 'approval.requested' && interactive) await askApproval(client, e.approvalId);
      if (e.type === 'task.status' && isTerminal(e.status)) finished = true;
      // The replay ends with the latest event; stop once a finished task has been printed.
      if (finished && e.type === 'task.status' && isTerminal(e.status)) done.abort();
    },
    done.signal,
  );
  console.log();
  await showTask(client, id, {});
}

async function askApproval(client: Client, approvalId: string): Promise<void> {
  const pending = await client.get<ApprovalListItem[]>('/api/approvals?status=pending');
  const approval = pending.find((a) => a.id === approvalId);
  if (!approval) return; // already decided (e.g. replayed history)
  console.log(
    paint(
      'yellow',
      `\n  Step "${approval.stepTitle}" wants to run ${paint('bold', approval.tool)}:`,
    ),
  );
  console.log(`  ${JSON.stringify(approval.args, null, 2).replace(/\n/g, '\n  ')}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(paint('yellow', '  Approve? [y/N] '))).trim().toLowerCase();
  rl.close();
  await decide(client, approvalId, answer === 'y' || answer === 'yes');
}

export async function cancel(client: Client, ref: string): Promise<void> {
  const id = await resolveTask(client, ref);
  const { cancelled } = await client.post<{ cancelled: boolean }>(`/api/tasks/${id}/cancel`);
  console.log(cancelled ? `Cancelled ${short(id)}.` : `${short(id)} had already finished.`);
}

export async function files(client: Client, ref: string, path?: string): Promise<void> {
  const id = await resolveTask(client, ref);
  if (path) {
    process.stdout.write(
      await client.get<string>(`/api/tasks/${id}/files/content?path=${encodeURIComponent(path)}`),
    );
    return;
  }
  const { files: list } = await client.get<{ files: string[] }>(`/api/tasks/${id}/files`);
  console.log(list.length ? list.join('\n') : paint('gray', '(no files)'));
}

// ---- approvals

export async function listApprovals(client: Client): Promise<void> {
  const pending = await client.get<ApprovalListItem[]>('/api/approvals?status=pending');
  if (!pending.length) return console.log('Nothing is waiting for approval.');
  for (const a of pending) {
    console.log(
      `${paint('bold', short(a.id))}  ${a.tool}  ${paint('gray', `task ${short(a.taskId)} · ${a.stepTitle}`)}`,
    );
    console.log(`  ${JSON.stringify(a.args)}`);
  }
  console.log(paint('gray', '\nDecide with: gantrix approve <id>  or  gantrix deny <id>'));
}

export async function decide(client: Client, ref: string, approved: boolean): Promise<void> {
  let id = ref;
  if (ref.length < 36) {
    const match = (await client.get<ApprovalListItem[]>('/api/approvals?status=pending')).filter(
      (a) => a.id.endsWith(ref),
    );
    if (match.length !== 1 || !match[0])
      throw new Error(`No single pending approval matches "${ref}".`);
    id = match[0].id;
  }
  await client.post(`/api/approvals/${id}`, { approved });
  console.log(
    `  ${approved ? `${stepIcon('succeeded')} approved` : `${stepIcon('failed')} denied`}`,
  );
}

export function explain(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'The API rejected the token. Set GANTRIX_TOKEN to the value in the server .env.';
  }
  return error instanceof Error ? error.message : String(error);
}
