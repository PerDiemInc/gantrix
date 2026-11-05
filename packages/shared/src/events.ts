import type { StepStatus, TaskStatus } from './status.ts';

/** Everything the web app and CLI receive live. Large data (step output) is fetched over REST. */
export type GantrixEvent =
  | { type: 'task.status'; status: TaskStatus; reason?: string }
  | { type: 'plan.created'; version: number; stepKeys: string[]; reason: string }
  | { type: 'step.status'; stepId: string; key: string; status: StepStatus; attempt: number }
  | { type: 'step.tool_call'; stepId: string; tool: string; summary: string }
  | { type: 'approval.requested'; approvalId: string; stepId: string; tool: string }
  | { type: 'approval.decided'; approvalId: string; approved: boolean }
  | { type: 'budget.exceeded'; limit: 'tokens' | 'time' | 'replans'; detail: string };

export type GantrixEventType = GantrixEvent['type'];

/** The NOTIFY payload: ids only, so it stays far below Postgres's 8 KB limit. */
export interface EventNotice {
  taskId: string;
  id: number;
}

export const EVENTS_CHANNEL = 'gantrix_events';
