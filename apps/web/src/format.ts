import type { StepStatus, TaskStatus } from '@gantrix/shared';

export const label = (status: TaskStatus | StepStatus) => status.replace('_', ' ');

export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const ago = (iso: string, now = Date.now()) => `${duration(now - Date.parse(iso))} ago`;

export const short = (id: string) => id.slice(-8);
