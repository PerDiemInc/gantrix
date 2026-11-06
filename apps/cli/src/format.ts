import { stripVTControlCharacters, styleText } from 'node:util';
import type { StepDto, StepStatus, StreamEvent, TaskDto, TaskStatus } from '@gantrix/shared';

type Style = Parameters<typeof styleText>[0];
// styleText drops colours when stdout isn't a terminal or NO_COLOR is set.
export const paint = (style: Style, text: string) => styleText(style, text);

const STEP_LOOK: Record<StepStatus, [string, Style]> = {
  pending: ['·', 'gray'],
  queued: ['◷', 'gray'],
  running: ['▶', 'cyan'],
  judging: ['⚖', 'magenta'],
  awaiting_approval: ['✋', 'yellow'],
  succeeded: ['✔', 'green'],
  failed: ['✖', 'red'],
  superseded: ['↷', 'gray'],
  cancelled: ['⊘', 'gray'],
};

const TASK_STYLE: Record<TaskStatus, Style> = {
  planning: 'cyan',
  running: 'cyan',
  awaiting_approval: 'yellow',
  succeeded: 'green',
  failed: 'red',
  needs_attention: 'yellow',
  cancelled: 'gray',
};

export const stepIcon = (s: StepStatus) => paint(STEP_LOOK[s][1], STEP_LOOK[s][0]);
export const taskStatus = (s: TaskStatus) => paint(TASK_STYLE[s], s.replace('_', ' '));

const visible = (text: string) => stripVTControlCharacters(text).length;
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - visible(text)));

export function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => visible(r[i] ?? '')))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, i) => pad(cell, widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export const duration = (ms: number) =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;

const time = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

/** One row per step: ░ waiting in the queue, █ running; coloured by status. */
export function gantt(
  task: TaskDto,
  steps: StepDto[],
  agentNames: Map<string, string>,
  width = 48,
): string {
  if (!steps.length) return paint('gray', '(no steps yet)');
  const now = Date.now();
  const start = Math.min(...steps.map((s) => time(s.queuedAt) ?? time(s.createdAt) ?? now));
  const end = Math.max(time(task.finishedAt) ?? 0, ...steps.map((s) => time(s.finishedAt) ?? now));
  const span = Math.max(end - start, 1);
  const col = (t: number) => Math.round(((t - start) / span) * width);
  const keyWidth = Math.max(...steps.map((s) => s.key.length));
  const lines = steps.map((s) => {
    const queued = time(s.queuedAt);
    const started = time(s.startedAt);
    const finished = time(s.finishedAt) ?? (started ? now : null);
    let bar = '';
    if (queued !== null) {
      const q = col(queued);
      const r = started !== null ? col(started) : col(now);
      const f = finished !== null ? Math.max(col(finished), r + 1) : r;
      bar =
        ' '.repeat(q) +
        '░'.repeat(Math.max(0, r - q)) +
        paint(STEP_LOOK[s.status][1], '█'.repeat(Math.max(0, f - r)));
    }
    const took = started !== null && finished !== null ? duration(finished - started) : '';
    const agent = s.agentId ? (agentNames.get(s.agentId) ?? '?') : 'deleted agent';
    const tries = s.attempt > 1 ? ` ×${s.attempt}` : '';
    return `${stepIcon(s.status)} ${s.key.padEnd(keyWidth)} │${pad(bar, width)}│ ${took.padStart(6)}${tries}  ${paint('gray', agent)}`;
  });
  const axis = `${' '.repeat(keyWidth + 3)}0${' '.repeat(width - 1)}${duration(span)}`;
  return [...lines, paint('gray', axis)].join('\n');
}

export function describeEvent(e: StreamEvent, stepKeys: Map<string, string>): string {
  const at = paint('gray', new Date(e.at).toLocaleTimeString());
  switch (e.type) {
    case 'task.status':
      return `${at} task ${taskStatus(e.status)}${e.reason ? paint('gray', ` (${e.reason})`) : ''}`;
    case 'plan.created':
      return `${at} plan v${e.version}: ${e.stepKeys.join(', ')}${e.reason !== 'initial' ? paint('gray', `\n         because ${e.reason}`) : ''}`;
    case 'step.status':
      return `${at} ${stepIcon(e.status)} ${e.key} ${e.status.replace('_', ' ')}${e.attempt > 1 ? ` (try ${e.attempt})` : ''}`;
    case 'step.tool_call':
      return `${at}   ${paint('gray', `↳ ${stepKeys.get(e.stepId) ?? 'step'}: ${e.tool} ${e.summary}`)}${e.autoApproved ? paint('red', ' ⚡ auto-approved') : ''}`;
    case 'approval.requested':
      return `${at} ${paint('yellow', `✋ ${stepKeys.get(e.stepId) ?? 'a step'} wants to run ${e.tool}`)}`;
    case 'approval.decided':
      return `${at} ${e.approved ? paint('green', 'approved') : paint('red', 'denied')}`;
    case 'goal.judged':
      return `${at} goal ${e.passed ? paint('green', 'met') : paint('yellow', 'not met')}: ${e.reason}`;
    case 'budget.exceeded':
      return `${at} ${paint('red', `budget exceeded (${e.limit}): ${e.detail}`)}`;
  }
}
