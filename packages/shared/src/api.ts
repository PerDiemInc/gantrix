import type { GantrixEvent } from './events.ts';
import type { ApprovalStatus, StepStatus, TaskStatus } from './status.ts';
import type { Budget, SkillManifest } from './types.ts';

/** JSON shapes of the HTTP API, shared by the CLI and the web app. Dates are ISO strings. */

export interface SkillRef {
  id: string;
  name: string;
  version: string;
}

export interface AgentDto {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string | null;
  modelBaseUrl: string | null;
  maxConcurrency: number;
  createdAt: string;
  updatedAt: string;
  skills: SkillRef[];
}

export interface SkillDto extends SkillRef {
  description: string;
  sourcePath: string;
  checksum: string;
  manifest: SkillManifest;
  createdAt: string;
}

export interface TaskDto {
  id: string;
  goal: string;
  status: TaskStatus;
  budget: Budget;
  tokensUsed: number;
  replans: number;
  workspacePath: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskListItem extends TaskDto {
  stepCounts: Partial<Record<StepStatus, number>>;
}

export interface PlanDto {
  id: string;
  taskId: string;
  version: number;
  reason: string;
  createdAt: string;
}

export interface StepDto {
  id: string;
  taskId: string;
  planVersion: number;
  key: string;
  title: string;
  instructions: string;
  acceptance: string;
  agentId: string | null;
  dependsOn: string[];
  status: StepStatus;
  attempt: number;
  output: string | null;
  judgeReason: string | null;
  error: string | null;
  tokensUsed: number;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ApprovalDto {
  id: string;
  taskId: string;
  stepId: string;
  interruptId: string;
  tool: string;
  args: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface ApprovalListItem extends Omit<ApprovalDto, 'interruptId'> {
  goal: string;
  stepTitle: string;
}

export interface TaskDetailDto extends TaskDto {
  plans: PlanDto[];
  steps: StepDto[];
  approvals: ApprovalDto[];
}

/** One message on /api/stream: the event plus its id, task and time. */
export type StreamEvent = GantrixEvent & { id: number; taskId: string; at: string };
