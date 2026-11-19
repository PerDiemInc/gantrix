import type { GantrixEvent } from './events.ts';
import type {
  ApprovalStatus,
  ConnectionProvider,
  ModelProvider,
  SkillSearchSource,
  StepStatus,
  TaskStatus,
} from './status.ts';
import type { AgentModelChoice, Budget, HttpRequestConfig, SkillManifest } from './types.ts';

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
  /** A saved model connection; null = the default model's place (see Agents → Default model). */
  connectionId: string | null;
  /** A Slack connection (bot and app token): people can chat with this agent in Slack. */
  slackConnectionId: string | null;
  /** "preset:<id>", "initials", a data:image URL, or null for the default picked by name. */
  avatar: string | null;
  maxConcurrency: number;
  /** Longest one run of a step may take, in minutes; null = no limit. */
  stepTimeoutMinutes: number | null;
  createdAt: string;
  updatedAt: string;
  skills: SkillRef[];
}

export interface SkillDto extends SkillRef {
  description: string;
  sourcePath: string;
  checksum: string;
  manifest: SkillManifest;
  /** Where it was installed from on the web, pinned to a commit; null for a local folder. */
  sourceUrl: string | null;
  /** The commit it was pinned to. */
  sourceRef: string | null;
  createdAt: string;
}

/** Something worth knowing before installing a skill: what it can do on this machine. */
export interface SkillReviewWarning {
  level: 'info' | 'caution';
  text: string;
}

/** A skill downloaded to a holding area and shown to the user, not yet installed. */
export interface SkillPreviewDto {
  kind: 'skill';
  /** Pass this back to install exactly what was shown. Expires. */
  id: string;
  expiresAt: string;
  /** Where it is from, for display: github.com/owner/repo/path. */
  source: string;
  /** The pinned link it will be recorded with. */
  sourceUrl: string;
  /** The commit it was pinned to, for GitHub sources. */
  commit: string | null;
  name: string;
  version: string;
  description: string;
  manifest: SkillManifest;
  /** The text the agent is given. */
  instructions: string;
  files: { path: string; size: number }[];
  totalBytes: number;
  warnings: SkillReviewWarning[];
  /** Of the downloaded files; install refuses if they changed since. */
  checksum: string;
}

/** A link to a place with several skills: pick one to review. */
export interface SkillChoicesDto {
  kind: 'choices';
  source: string;
  choices: { name: string; path: string; url: string }[];
}

export type SkillLookupDto = SkillPreviewDto | SkillChoicesDto;

/** One thing a search found: a skill, or a repository that may hold some. */
export interface SkillHitDto {
  /** Unique within a result set. */
  id: string;
  source: SkillSearchSource;
  /** For display: "skills.sh", "Featured", "GitHub", "GitHub code". */
  sourceLabel: string;
  kind: 'skill' | 'repo';
  name: string;
  description: string;
  /** owner/repo on GitHub. */
  repo: string;
  /** The folder in the repository, when known. */
  path: string | null;
  /** What to look up to review it: a skills.sh or GitHub link. */
  url: string;
  /** How many times it was installed, where the source counts. */
  installs: number | null;
  stars: number | null;
}

export interface SkillSearchNote {
  source: SkillSearchSource;
  level: 'info' | 'problem';
  text: string;
}

export interface SkillSearchDto {
  query: string;
  hits: SkillHitDto[];
  /** Why a source gave nothing, or how to get more from it. */
  notes: SkillSearchNote[];
  /** The GitHub connection whose token was used, if any. */
  githubConnection: string | null;
}

export interface TaskDto {
  id: string;
  goal: string;
  /** What the project is, in the user's words. */
  description: string | null;
  /** The user's name for the project; null shows the description or goal. */
  name: string | null;
  /** Progress goes to the Slack thread. */
  slack: boolean;
  slackThreadTs: string | null;
  slackChannel: string | null;
  /** Per-project model choices: agentId → connection + model. */
  agentModels: Record<string, AgentModelChoice> | null;
  /** Offload: agents without their own choice run on this connection. */
  offloadConnectionId: string | null;
  /** Finished only when a deployed public URL answers. */
  liveCheck: boolean;
  /** Names of the variables this project's shell commands get; values are never returned. */
  shellEnvNames: string[] | null;
  /** Time stopped; it doesn't count against the time limit. */
  pausedMs: number;
  status: TaskStatus;
  budget: Budget;
  tokensUsed: number;
  replans: number;
  workspacePath: string;
  /** The job this project is a run of; null for a project made by hand. */
  jobId: string | null;
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

/** A saved job: ordered steps, run on demand or on a cron schedule. */
export interface JobDto {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  steps: { title: string; agentId: string; instructions: string; acceptance: string }[];
  /** Cron pattern, e.g. "0 9 * * *"; null = only runs on demand. */
  schedule: string | null;
  timezone: string;
  enabled: boolean;
  budget: Partial<Budget> | null;
  approveAll: boolean | null;
  slack: boolean;
  /** When the schedule fires next; null if paused or unscheduled. */
  nextRunAt: string | null;
  lastRun: { id: string; status: TaskStatus; createdAt: string } | null;
  createdAt: string;
  updatedAt: string;
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
  /** Set on a sub-task: the step that delegated it. */
  parentStepId: string | null;
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
  provider: ConnectionProvider;
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
  /** GitHub and Slack: non-secret settings (org, repos, channel, allowedUsers). */
  settings: Record<string, string>;
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

/** One running Docker container, from `docker stats` joined with `docker ps`. */
export interface ContainerStatsDto {
  id: string;
  name: string;
  image: string;
  /** "Up 26 hours (healthy)" */
  status: string;
  /** The Compose project it belongs to, if any. */
  project: string | null;
  /** Share of one CPU core: 150 means one and a half cores. */
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPercent: number;
  pids: number;
}

/** What this machine and its Docker engine are using right now. */
export interface SystemDto {
  host: {
    platform: string;
    cpus: number;
    /** 1, 5 and 15 minute load averages. */
    loadAvg: [number, number, number];
    memTotalBytes: number;
    /** Memory the OS can hand out without swapping (free plus reclaimable cache). */
    memAvailableBytes: number;
    uptimeSeconds: number;
  };
  /** The Gantrix API process itself. */
  gantrix: { rssBytes: number };
  docker:
    | {
        available: true;
        version: string;
        /** The memory and CPUs Docker may use (the Docker Desktop VM on a Mac). */
        memTotalBytes: number;
        cpus: number;
        containers: ContainerStatsDto[];
      }
    | { available: false; error: string };
  sampledAt: string;
}

/** One turn in a project's discussion with its owner. */
export interface DiscussionMessageDto {
  id: string;
  role: 'user' | 'owner';
  text: string;
  createdAt: string;
}

/** A project's discussion with its owner, oldest message first. */
export interface DiscussionDto {
  owner: {
    /** The lead agent's name, or "Project owner" when no agent leads the project. */
    name: string;
    /** The agent leading the project, if any. */
    agentId: string | null;
    avatar: string | null;
  };
  messages: DiscussionMessageDto[];
}

/** The saved choice of default model: where it runs and which model. Both null = the built-in. */
export interface DefaultModelSettingDto {
  /** A saved model connection (Ollama, OpenAI or Anthropic); null = the local Ollama. */
  connectionId: string | null;
  /** null = the built-in model. */
  model: string | null;
}

/** The default model, as saved and as it works out now. */
export interface DefaultModelDto extends DefaultModelSettingDto {
  /** What the planner, the judges and every agent without its own model use right now. */
  effective: {
    model: string;
    provider: ModelProvider;
    /** The connection's name; null for the local Ollama. */
    connection: string | null;
    isLocal: boolean;
  };
  /** The model used when none is chosen. */
  builtIn: string;
}

/** The answer to a message to the project owner. */
export interface DiscussionReplyDto {
  /** The message and the owner's answer, saved together. */
  messages: DiscussionMessageDto[];
  /** Ollama was not running, so Gantrix started it for this answer. */
  startedOllama: boolean;
}

/** One agent (or the planner, or a judge) holding work right now. */
export interface LiveAgentDto {
  /** The step's id; for the planner, the project's id. */
  id: string;
  role: 'agent' | 'judge' | 'planner';
  agentId: string | null;
  agentName: string;
  avatar: string | null;
  taskId: string;
  /** The project's title. */
  project: string;
  stepId: string | null;
  stepTitle: string | null;
  status: StepStatus | 'planning';
  attempt: number;
  tokensUsed: number;
  /** When this piece of work started. */
  since: string | null;
  /** The model this work runs on, and where. */
  model: string;
  provider: ModelProvider;
  /** The saved connection's name; null = the default Ollama or the agent's own URL. */
  connection: string | null;
  /** False when prompts and task content leave this machine. */
  isLocal: boolean;
}

/** A model an Ollama server holds in memory, from its /api/ps. */
export interface LoadedModelDto {
  name: string;
  sizeBytes: number;
  /** The part on the GPU; the rest runs on the CPU. */
  vramBytes: number;
  /** "8.2B" */
  parameterSize: string | null;
  /** "Q4_K_M" */
  quantization: string | null;
  contextLength: number | null;
  /** When Ollama unloads it if nothing else uses it. */
  expiresAt: string | null;
}

export interface ModelServerDto {
  name: string;
  url: string;
  isLocal: boolean;
  available: boolean;
  models: LoadedModelDto[];
  error?: string;
}

/** Who is working right now, on which model, and which models are loaded in memory. */
export interface LiveDto {
  agents: LiveAgentDto[];
  /** Steps waiting for a free slot. */
  queued: number;
  servers: ModelServerDto[];
  /** The model the planner, judges and agents without their own use. */
  defaultModel: string;
  sampledAt: string;
}
