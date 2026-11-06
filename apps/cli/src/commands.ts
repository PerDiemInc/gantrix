import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  type AgentDto,
  type ApprovalListItem,
  type ConnectionDto,
  isTerminal,
  type SkillDto,
  type StepConversationDto,
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
    connection?: string;
  },
): Promise<void> {
  const skillIds = o.skills ? await skillIdsByName(client, o.skills.split(',')) : [];
  const connectionId = o.connection ? (await connectionByName(client, o.connection)).id : undefined;
  const agent = await client.post<AgentDto>('/api/agents', {
    name,
    skillIds,
    ...(o.description ? { description: o.description } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.baseUrl ? { modelBaseUrl: o.baseUrl } : {}),
    ...(o.maxConcurrency ? { maxConcurrency: Number(o.maxConcurrency) } : {}),
    ...(o.prompt ? { systemPrompt: o.prompt } : {}),
    ...(connectionId ? { connectionId } : {}),
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
  o: {
    maxMinutes?: string;
    maxTokens?: string;
    maxReplans?: string;
    approveAll?: boolean;
    detach?: boolean;
  },
): Promise<void> {
  const budget = {
    ...(o.maxMinutes ? { maxMinutes: Number(o.maxMinutes) } : {}),
    ...(o.maxTokens ? { maxTokens: Number(o.maxTokens) } : {}),
    ...(o.maxReplans ? { maxReplans: Number(o.maxReplans) } : {}),
  };
  const task = await client.post<TaskDto>('/api/tasks', {
    goal,
    budget,
    ...(o.approveAll ? { approveAll: true } : {}),
  });
  console.log(`Task ${paint('bold', short(task.id))} created. Workspace: ${task.workspacePath}`);
  if (task.approveAll) {
    console.log(
      paint('red', '⚡ God mode: every tool call, including shell, runs without asking.'),
    );
  }
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

// ---- logs

const CLIP = 1_200;
const clipText = (t: string, full: boolean) =>
  full || t.length <= CLIP ? t : `${t.slice(0, CLIP)}… (${t.length - CLIP} more; --full shows all)`;

/** Each step's conversation: what the agent was told, what it said, and every tool call. */
export async function logs(
  client: Client,
  ref: string,
  stepRef: string | undefined,
  o: { full?: boolean },
): Promise<void> {
  const id = await resolveTask(client, ref);
  const [task, agents] = await Promise.all([
    client.get<TaskDetailDto>(`/api/tasks/${id}`),
    client.get<AgentDto[]>('/api/agents'),
  ]);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const steps = stepRef
    ? task.steps.filter((s) => s.key === stepRef || s.id === stepRef || s.id.endsWith(stepRef))
    : task.steps.filter((s) => s.status !== 'superseded');
  if (!steps.length) {
    throw new Error(
      stepRef
        ? `No step "${stepRef}" in this task. Steps: ${task.steps.map((s) => s.key).join(', ')}.`
        : 'No steps yet.',
    );
  }
  const full = Boolean(o.full);
  for (const s of steps) {
    const convo = await client.get<StepConversationDto>(
      `/api/tasks/${id}/steps/${s.id}/conversation`,
    );
    const agent = s.agentId ? (names.get(s.agentId) ?? '?') : 'deleted agent';
    console.log(
      `\n${paint('bold', `━━ ${s.key}`)} ${paint('gray', `${agent} · ${s.status}`)}  ${s.title}`,
    );
    if (!convo.attempts.length) console.log(paint('gray', '  not started'));
    for (const a of convo.attempts) {
      if (convo.attempts.length > 1) console.log(paint('bold', `  attempt ${a.attempt}`));
      for (const m of a.messages) {
        if (m.role === 'system' && !full) {
          console.log(
            paint('gray', `  system prompt (${m.text.length} characters; --full shows it)`),
          );
          continue;
        }
        const head =
          m.role === 'assistant'
            ? paint('blue', '  agent')
            : m.role === 'tool'
              ? paint('gray', `  ${m.toolName ?? 'tool'} →`)
              : paint('yellow', `  ${m.role === 'user' ? 'task' : m.role}`);
        if (m.thinking && full)
          console.log(`${paint('gray', '  thinking')}\n${indent(m.thinking)}`);
        if (m.text) console.log(`${head}\n${indent(clipText(m.text, full))}`);
        for (const c of m.toolCalls ?? []) {
          console.log(
            `${paint('blue', '  agent calls')} ${c.name} ${clipText(JSON.stringify(c.args), full)}`,
          );
        }
      }
    }
    if (s.judgeReason) console.log(`${paint('yellow', '  judge')}\n${indent(s.judgeReason)}`);
  }
}

const indent = (t: string) =>
  t
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');

// ---- connections

async function connectionByName(client: Client, name: string): Promise<ConnectionDto> {
  const c = (await client.get<ConnectionDto[]>('/api/connections')).find((x) => x.name === name);
  if (!c)
    throw new Error(
      `No connection named "${name}". Add one: gantrix connections add ${name} --provider …`,
    );
  return c;
}

/** "Name: value" → [name, value]. */
function parseHeader(raw: string): [string, string] {
  const i = raw.indexOf(':');
  if (i < 1) throw new Error(`Header "${raw}" should look like "Name: value".`);
  return [raw.slice(0, i).trim(), raw.slice(i + 1).trim()];
}

const KEY_HEADER = {
  openai: 'Authorization',
  anthropic: 'x-api-key',
  ollama: 'Authorization',
} as const;

export async function listConnections(client: Client): Promise<void> {
  const list = await client.get<ConnectionDto[]>('/api/connections');
  if (!list.length) {
    return console.log(
      'No connections. Agents use Ollama. Add one: gantrix connections add openai --provider openai --api-key-env OPENAI_API_KEY',
    );
  }
  console.log(
    table([
      ['NAME', 'PROVIDER', 'URL', 'HEADERS', 'WHERE'].map((h) => paint('bold', h)),
      ...list.map((c) => [
        c.name,
        c.provider,
        c.effectiveUrl,
        Object.entries(c.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ') || paint('gray', 'none'),
        c.isLocal ? paint('green', 'local') : paint('yellow', 'cloud'),
      ]),
    ]),
  );
}

export async function addConnection(
  client: Client,
  name: string,
  o: { provider: string; url?: string; header?: string[]; apiKeyEnv?: string },
): Promise<void> {
  const headers = Object.fromEntries((o.header ?? []).map(parseHeader));
  if (o.apiKeyEnv) {
    const provider = o.provider as keyof typeof KEY_HEADER;
    const header = KEY_HEADER[provider] ?? 'Authorization';
    headers[header] =
      header === 'Authorization' ? `Bearer env:${o.apiKeyEnv}` : `env:${o.apiKeyEnv}`;
  }
  const c = await client.post<ConnectionDto>('/api/connections', {
    name,
    provider: o.provider,
    ...(o.url ? { baseUrl: o.url } : {}),
    headers,
  });
  console.log(`Added connection ${paint('bold', c.name)} → ${c.provider} at ${c.effectiveUrl}.`);
  if (!c.isLocal) {
    console.log(
      paint(
        'yellow',
        `⚠ Cloud: prompts and task content go to ${new URL(c.effectiveUrl).host}, and its usage costs apply.`,
      ),
    );
  }
  console.log(paint('gray', `Check it: gantrix connections test ${c.name} <model>`));
}

export async function removeConnection(client: Client, name: string): Promise<void> {
  const c = await connectionByName(client, name);
  await client.del(`/api/connections/${c.id}`);
  console.log(`Removed connection ${name}.`);
}

export async function testConnection(client: Client, name: string, model: string): Promise<void> {
  const c = await connectionByName(client, name);
  const r = await client.post<{ ok: boolean; reply?: string; error?: string; ms: number }>(
    `/api/connections/${c.id}/test`,
    { model },
  );
  if (r.ok)
    console.log(
      `${paint('green', '✔')} ${model} on ${c.name} replied "${r.reply}" in ${duration(r.ms)}.`,
    );
  else throw new Error(`${model} on ${c.name} failed after ${duration(r.ms)}: ${r.error}`);
}
