import type { StepStatus, StreamEvent, TaskListItem, TaskStatus } from '@gantrix/shared';
import { label } from '../format.ts';
import { Icon, STATUS_ICON } from './Icon.tsx';

/** Status as an icon and words; the colour only reinforces it. */
export function StatusPill({ status, big }: { status: TaskStatus | StepStatus; big?: boolean }) {
  return (
    <span className={`pill s-${status}${big ? ' big' : ''}`}>
      <Icon name={STATUS_ICON[status] ?? 'dot'} size={big ? 14 : 12} />
      {label(status)}
    </span>
  );
}

// Six agent colours from the brand, picked by name so an agent keeps its colour everywhere.
const AVATAR_TONES = 6;
function tone(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % AVATAR_TONES;
}

const STATE_LABEL = {
  working: 'working',
  waiting: 'waiting for you',
  queued: 'up next',
  done: 'done',
  idle: 'waiting on others',
} as const;

export type AgentState = keyof typeof STATE_LABEL;

export function Avatar({
  name,
  state,
  size = 32,
}: {
  name: string;
  state?: AgentState;
  size?: number;
}) {
  const text = state ? `${name}, ${STATE_LABEL[state]}` : name;
  return (
    <span
      className={`avatar tone-${tone(name)}${state ? ` state-${state}` : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      role="img"
      aria-label={text}
      title={text}
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function TaskProgress({ counts }: { counts: TaskListItem['stepCounts'] }) {
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const done = counts.succeeded ?? 0;
  if (!total) {
    return <div className="bar-label muted small">Planning the tasks…</div>;
  }
  const part = (n = 0) => `${(n / total) * 100}%`;
  return (
    <div>
      <div
        className="pbar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={`${done} of ${total} tasks done`}
      >
        <span className="seg s-succeeded" style={{ width: part(done) }} />
        <span
          className="seg s-running"
          style={{ width: part((counts.running ?? 0) + (counts.judging ?? 0)) }}
        />
        <span
          className="seg s-awaiting_approval"
          style={{ width: part(counts.awaiting_approval) }}
        />
        <span className="seg s-failed" style={{ width: part(counts.failed) }} />
      </div>
      <div className="bar-label small">
        <span>
          <b className="num">{done}</b> of <span className="num">{total}</span> tasks done
        </span>
        {(counts.failed ?? 0) > 0 && <span className="danger-text">{counts.failed} failed</span>}
      </div>
    </div>
  );
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One line on what happened last, for project cards. */
export function nowText(e: StreamEvent | null, agentName: (stepId: string) => string): string {
  if (!e) return 'Starting…';
  switch (e.type) {
    case 'task.status':
      return e.status === 'planning'
        ? e.reason
          ? `Replanning: ${e.reason}`
          : 'The planner is splitting the goal into tasks'
        : `Project ${label(e.status)}${e.reason ? `: ${e.reason}` : ''}`;
    case 'plan.created':
      return `Plan v${e.version}: ${e.stepKeys.length} tasks`;
    case 'step.status':
      return `${agentName(e.stepId)} · ${e.key}: ${label(e.status)}`;
    case 'step.tool_call':
      return `${agentName(e.stepId)} used ${e.tool}`;
    case 'approval.requested':
      return `${agentName(e.stepId)} asks to run ${e.tool}`;
    case 'approval.decided':
      return e.approved ? 'You approved a tool call' : 'You denied a tool call';
    case 'goal.judged':
      return `Goal ${e.passed ? 'met' : 'not met yet'}: ${clip(e.reason)}`;
    case 'budget.exceeded':
      return `Budget reached (${e.limit})`;
    case 'user.message':
      return `You: ${clip(e.text)}`;
    case 'user.message_delivered':
      return `${agentName(e.stepId)} read your note`;
  }
}
