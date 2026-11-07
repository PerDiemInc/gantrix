import type { GantrixEvent } from './events.ts';
import type { ApprovalStatus, ModelProvider, StepStatus, TaskStatus } from './status.ts';
import type { Budget, HttpRequestConfig, SkillManifest } from './types.ts';

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
  /** A saved model connection; null = the default (Ollama, or GANTRIX_DEFAULT_CONNECTION). */
  connectionId: string | null;
  /** "preset:<id>", "initials", a data:image URL, or null for the default picked by name. */
  avatar: string | null;
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
  /** God mode: tool calls run without asking. */
  approveAll: boolean;
  /** The agents this project may use; null = every agent. */
  agentIds: string[] | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskListItem extends TaskDto {
  stepCounts: Partial<Record<StepStatus, number>>;
  /** Every agent with a task in the current plan, and what it is doing now. */
  team: { agentId: string; state: 'working' | 'waiting' | 'queued' | 'done' | 'idle' }[];
  /** Tasks running, being judged, waiting for approval or queued, oldest first. */
  active: { id: string; key: string; title: string; agentId: string | null; status: StepStatus }[];
  pendingApprovals: number;
  /** The newest event, for the "now" line on the project card. */
  lastEvent: StreamEvent | null;
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
  /** ask_user: the user's answer. */
  answer: string | null;
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

/** One message in a step's conversation, as the agent saw it. */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  /** The model's reasoning, when the model returns it separately (e.g. qwen3 thinking). */
  thinking?: string;
  /** Tool calls the assistant asked for. */
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  /** For role "tool": which tool answered, and the call it answers. */
  toolName?: string;
  toolCallId?: string;
  tokens?: number;
}

export interface StepConversationDto {
  stepId: string;
  key: string;
  title: string;
  /** One entry per attempt, oldest first; a retry starts a fresh conversation. */
  attempts: { attempt: number; messages: ConversationMessage[] }[];
}

/** A saved way to reach a model server. Header values are never returned, only their source. */
export interface ConnectionDto {
  id: string;
  name: string;
  provider: ModelProvider;
  /** null = the provider's default (local Ollama, api.openai.com or api.anthropic.com). */
  baseUrl: string | null;
  /** The URL the worker actually calls. */
  effectiveUrl: string;
  /** Header name → "env:NAME" (read from the worker's environment) or "hidden" (saved value). */
  headers: Record<string, string>;
  /** False when prompts and task content leave this machine. */
  isLocal: boolean;
  /** Custom HTTP only: how to build the request and read the reply. */
  request: HttpRequestConfig | null;
  createdAt: string;
  updatedAt: string;
}

/** The models one place offers, for the agent form's dropdown. */
export interface ModelSource {
  /** null = the default Ollama. */
  connectionId: string | null;
  name: string;
  provider: ModelProvider;
  models: string[];
  /** Why the list couldn't be fetched (you can still type a model name). */
  error?: string;
}
