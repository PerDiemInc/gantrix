import {
  APPROVAL_STATUSES,
  type ApprovalStatus,
  type Budget,
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

export const agents = pgTable(
  'agents',
  {
    id: id(),
    name: text('name').notNull().unique(),
    description: text('description').notNull().default(''),
    systemPrompt: text('system_prompt').notNull().default(''),
    model: text('model'), // null → GANTRIX_DEFAULT_MODEL
    modelBaseUrl: text('model_base_url'), // null → OLLAMA_BASE_URL
    maxConcurrency: integer('max_concurrency').notNull().default(1), // enforced by the supervisor
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('agents_max_concurrency_positive', sql`${t.maxConcurrency} > 0`)],
);

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
    status: text('status').$type<TaskStatus>().notNull().default('planning'),
    budget: jsonb('budget').$type<Budget>().notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
    replans: integer('replans').notNull().default(0),
    workspacePath: text('workspace_path').notNull(),
    // God mode: every tool call runs without asking, including shell.
    approveAll: boolean('approve_all').notNull().default(false),
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
    createdAt: createdAt(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    check('approvals_status_valid', oneOf('status', APPROVAL_STATUSES)),
    unique('approvals_step_interrupt_key').on(t.stepId, t.interruptId),
    index('approvals_pending_idx').on(t.taskId).where(sql`${t.status} = 'pending'`),
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
