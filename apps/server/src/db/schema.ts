import {
  type AgentModelChoice,
  APPROVAL_STATUSES,
  type ApprovalStatus,
  type Budget,
  CONNECTION_PROVIDERS,
  type ConnectionProvider,
  type HttpRequestConfig,
  type SkillManifest,
  STEP_STATUSES,
  type StepStatus,
  TASK_STATUSES,
  type TaskStatus,
} from '@gantrix/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
// Values come from constants in @gantrix/shared, never from input.
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);

export const connections = pgTable(
  'connections',
  {
    id: id(),
    name: text('name').notNull().unique(),
    provider: text('provider').$type<ConnectionProvider>().notNull(),
    baseUrl: text('base_url'), // null → the provider's default URL
    // Header name → literal value or "env:NAME". Literal values never leave the API.
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
    // Custom HTTP only: method, content type, body template and reply path.
    request: jsonb('request').$type<HttpRequestConfig>(),
    // GitHub and Slack only: non-secret settings (org, repos, channel, allowedUsers).
    settings: jsonb('settings').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  () => [check('connections_provider_valid', oneOf('provider', CONNECTION_PROVIDERS))],
);

export const agents = pgTable(
  'agents',
  {
    id: id(),
    name: text('name').notNull().unique(),
    description: text('description').notNull().default(''),
    systemPrompt: text('system_prompt').notNull().default(''),
    model: text('model'), // null → the default model (app_settings)
    modelBaseUrl: text('model_base_url'), // null → OLLAMA_BASE_URL
    // Wins over modelBaseUrl. Restrict: remove the connection from agents before deleting it.
    connectionId: uuid('connection_id').references(() => connections.id, {
      onDelete: 'restrict',
    }),
    // A Slack connection (bot + app token): people can chat with this agent in Slack.
    slackConnectionId: uuid('slack_connection_id').references(() => connections.id, {
      onDelete: 'set null',
    }),
    maxConcurrency: integer('max_concurrency').notNull().default(1), // enforced by the supervisor
    // Longest one run of a step may take; then the attempt fails and is retried. Shell commands
    // may run this long too. null → no step limit, and shell commands get two minutes.
    stepTimeoutMinutes: real('step_timeout_minutes'),
    // "preset:<id>", "initials", or a small image as a data URL; null → a preset picked by name.
    avatar: text('avatar'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('agents_max_concurrency_positive', sql`${t.maxConcurrency} > 0`),
    check(
      'agents_step_timeout_positive',
      sql`${t.stepTimeoutMinutes} is null or ${t.stepTimeoutMinutes} > 0`,
    ),
  ],
);

/**
 * Settings chosen in the dashboard, one row each, so every process (the API and the worker)
 * reads the same value. Key "default_model": see settings.ts.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const skills = pgTable(
  'skills',
  {
    id: id(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description').notNull(),
    sourcePath: text('source_path').notNull(), // the skill folder on disk; no code in the DB
    checksum: text('checksum').notNull(), // sha256 of the folder, checked before each use
    manifest: jsonb('manifest').$type<SkillManifest>().notNull(), // parsed SKILL.md frontmatter
    // Installed from the web: the link it came from (pinned to a commit for GitHub), and that commit.
    sourceUrl: text('source_url'),
    sourceRef: text('source_ref'),
    createdAt: createdAt(),
  },
  (t) => [unique('skills_name_version_key').on(t.name, t.version)],
);

export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    goal: text('goal').notNull(),
    // A short name the user gives the project; null → shown from the description or goal.
    name: text('name'),
    // Post progress to the Slack webhook (SLACK_WEBHOOK_URL) for this project.
    slack: boolean('slack').notNull().default(false),
    // The Slack thread this project posts to; replies there steer it.
    slackChannel: text('slack_channel'),
    slackThreadTs: text('slack_thread_ts'),
    // What the project is, in the user's words; the goal (often an OKR) says what done means.
    description: text('description'),
    status: text('status').$type<TaskStatus>().notNull().default('planning'),
    budget: jsonb('budget').$type<Budget>().notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
    replans: integer('replans').notNull().default(0),
    workspacePath: text('workspace_path').notNull(),
    // God mode: every tool call runs without asking, including shell.
    approveAll: boolean('approve_all').notNull().default(false),
    // The agents this project may use; null = every agent.
    agentIds: uuid('agent_ids').array(),
    // Per-project model choices that override an agent's own: agentId → connection + model.
    agentModels: jsonb('agent_models').$type<Record<string, AgentModelChoice>>(),
    // Offload: every agent without its own choice above runs on this connection.
    offloadConnectionId: uuid('offload_connection_id').references(() => connections.id, {
      onDelete: 'set null',
    }),
    // Done only when a deployed public URL answers: the engine fetches it before the goal judge.
    liveCheck: boolean('live_check').notNull().default(false),
    // Names of the variables shell commands get on this project; the values are in task_env.
    shellEnvNames: text('shell_env_names').array(),
    // The job this project is a run of; null for a project made by hand.
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    // Time the project was stopped, which doesn't count against its time limit.
    pausedMs: bigint('paused_ms', { mode: 'number' }).notNull().default(0),
    result: text('result'),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    check('tasks_status_valid', oneOf('status', TASK_STATUSES)),
    index('tasks_created_at_idx').on(t.createdAt.desc()),
  ],
);

/**
 * Variables a project's shell commands get, e.g. AWS_PROFILE. Kept out of the tasks row so no
 * route that returns a project can return a value. "env:NAME" reads the worker's environment.
 */
export const taskEnv = pgTable('task_env', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  vars: jsonb('vars').$type<Record<string, string>>().notNull(),
});

/** One step of a job: an agent does this, then the next step. */
export interface JobStep {
  title: string;
  /** The agent (and so the skills) that does this step. */
  agentId: string;
  instructions: string;
  /** What the judge checks; blank → "the instructions were carried out". */
  acceptance: string;
}

/** A saved, repeatable run: ordered steps, run on demand or on a cron schedule. */
export const jobs = pgTable('jobs', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  // The goal each run is judged against at the end.
  goal: text('goal').notNull(),
  steps: jsonb('steps').$type<JobStep[]>().notNull(),
  // Cron pattern (e.g. "0 9 * * *"); null → only runs when you press Run.
  schedule: text('schedule'),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: boolean('enabled').notNull().default(true),
  budget: jsonb('budget').$type<Partial<Budget>>(),
  approveAll: boolean('approve_all'),
  // Post each run's progress to Slack (same as the project option).
  slack: boolean('slack').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const plans = pgTable(
  'plans',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    reason: text('reason').notNull(), // 'initial' or the judge feedback that caused the replan
    createdAt: createdAt(),
  },
  (t) => [unique('plans_task_version_key').on(t.taskId, t.version)],
);

export const steps = pgTable(
  'steps',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    planVersion: integer('plan_version').notNull(),
    key: text('key').notNull(), // the planner's id, e.g. "compare_frameworks"
    title: text('title').notNull(),
    instructions: text('instructions').notNull(),
    acceptance: text('acceptance').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // A sub-task another step delegated to this one's agent (see delegations).
    parentStepId: uuid('parent_step_id'),
    dependsOn: text('depends_on').array().notNull().default(sql`'{}'::text[]`), // keys in the same task
    status: text('status').$type<StepStatus>().notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    output: text('output'),
    judgeReason: text('judge_reason'),
    error: text('error'),
    tokensUsed: integer('tokens_used').notNull().default(0),
    createdAt: createdAt(),
    queuedAt: ts('queued_at'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    check('steps_status_valid', oneOf('status', STEP_STATUSES)),
    // A replan may reuse the key of a step it superseded.
    uniqueIndex('steps_task_key_active_idx')
      .on(t.taskId, t.key)
      .where(sql`${t.status} <> 'superseded'`),
    index('steps_task_status_idx').on(t.taskId, t.status),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id')
      .notNull()
      .references(() => steps.id, { onDelete: 'cascade' }),
    interruptId: text('interrupt_id').notNull(), // LangGraph interrupt this approval resumes
    tool: text('tool').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    // ask_user: the user's answer (approved) or null when they skipped it (denied).
    answer: text('answer'),
    createdAt: createdAt(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    check('approvals_status_valid', oneOf('status', APPROVAL_STATUSES)),
    unique('approvals_step_interrupt_key').on(t.stepId, t.interruptId),
    index('approvals_pending_idx').on(t.taskId).where(sql`${t.status} = 'pending'`),
  ],
);

// What the user tells a running task: to one step (delivered before its next model turn) or
// to the whole team (read by the next plan).
export const taskMessages = pgTable(
  'task_messages',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id').references(() => steps.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    deliveredAt: ts('delivered_at'), // step notes: when the agent got it
    planVersion: integer('plan_version'), // team notes: the plan that read it
    createdAt: createdAt(),
  },
  (t) => [index('task_messages_task_idx').on(t.taskId, t.createdAt)],
);

// A conversation between the user and the project's owner about where the project stands.
// Unlike task_messages it never reaches the agents or the planner: it changes nothing.
export const projectDiscussion = pgTable(
  'project_discussion',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'owner'>().notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('project_discussion_role_valid', sql`${t.role} in ('user', 'owner')`),
    index('project_discussion_task_idx').on(t.taskId, t.createdAt),
  ],
);

// Append-only audit log; also replays missed live events (SSE Last-Event-ID).
export const events = pgTable(
  'events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('events_task_id_idx').on(t.taskId, t.id)],
);

/**
 * A step that handed a sub-task to another agent. The step waits (status "delegating") on its
 * LangGraph interrupt; when the child step ends, the supervisor resumes it with the result.
 */
export const delegations = pgTable(
  'delegations',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id')
      .notNull()
      .references(() => steps.id, { onDelete: 'cascade' }),
    interruptId: text('interrupt_id').notNull(),
    childStepId: uuid('child_step_id').references(() => steps.id, { onDelete: 'set null' }),
    // running → done; answer is what the parent agent gets back as the tool result.
    status: text('status').$type<'running' | 'done'>().notNull().default('running'),
    answer: text('answer'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    uniqueIndex('delegations_step_interrupt_idx').on(t.stepId, t.interruptId),
    index('delegations_task_status_idx').on(t.taskId, t.status),
  ],
);
