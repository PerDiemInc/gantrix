import type { StepStatus, TaskStatus } from './status.ts';

/** Everything the web app and CLI receive live. Large data (step output) is fetched over REST. */
export type GantrixEvent =
  | { type: 'task.status'; status: TaskStatus; reason?: string }
  | { type: 'plan.created'; version: number; stepKeys: string[]; reason: string }
  | { type: 'step.status'; stepId: string; key: string; status: StepStatus; attempt: number }
  | {
      type: 'step.tool_call';
      stepId: string;
      tool: string;
      summary: string;
      /** Would have asked, but the task is in god mode. */
      autoApproved?: boolean;
    }
  | {
      type: 'approval.requested';
      approvalId: string;
      stepId: string;
      tool: string;
      /** ask_user: the agent's question. */
      question?: string;
    }
  | {
      type: 'approval.decided';
      approvalId: string;
      approved: boolean;
      /** ask_user: the user's answer. */
      answer?: string;
    }
  | { type: 'user.message'; messageId: string; text: string; stepId?: string }
  | { type: 'user.message_delivered'; messageId: string; stepId: string }
  | {
      type: 'step.edited';
      stepId: string;
      key: string;
      /** Which fields the user changed, e.g. ["instructions", "agent"]. */
      fields: string[];
      rerun: boolean;
    }
  | { type: 'task.team'; agentIds: string[] | null }
  /** The user changed project settings, e.g. ["name"] or ["slack"]. */
  | { type: 'task.updated'; fields: string[] }
  | { type: 'goal.judged'; planVersion: number; passed: boolean; reason: string }
  | { type: 'budget.exceeded'; limit: 'tokens' | 'time' | 'replans'; detail: string };

export type GantrixEventType = GantrixEvent['type'];

/** The NOTIFY payload: ids only, so it stays far below Postgres's 8 KB limit. */
export interface EventNotice {
  taskId: string;
  id: number;
}

export const EVENTS_CHANNEL = 'gantrix_events';
