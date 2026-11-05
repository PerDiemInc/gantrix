export const TASK_STATUSES = [
  'planning',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed', // a system error the loop can't recover from
  'needs_attention', // a budget ran out before the goal was met
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES = [
  'succeeded',
  'failed',
  'needs_attention',
  'cancelled',
] as const;
export const isTerminal = (status: TaskStatus): boolean =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);

export const STEP_STATUSES = [
  'pending',
  'queued',
  'running',
  'awaiting_approval',
  'judging',
  'succeeded',
  'failed',
  'superseded', // replaced by a replan
  'cancelled',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
