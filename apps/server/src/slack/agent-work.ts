import { projectTitle, type StepStatus, TERMINAL_TASK_STATUSES } from '@gantrix/shared';
import { and, desc, eq, gte, inArray, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { approvals, steps, tasks } from '../db/schema.ts';
import { clip, esc } from './api.ts';

/** One task an agent has, or had, on one project. */
export interface WorkItem {
  project: string;
  title: string;
  status: StepStatus;
  attempt: number;
  /** Minutes since it started (or was queued); null if it hasn't. */
  minutes: number | null;
  /** What it produced, or why it failed, for finished work. */
  note: string;
}

export interface Waiting {
  project: string;
  title: string;
  /** What a person has to do: answer a question or approve a tool. */
  what: string;
}

/** What an agent is doing, what waits on people, and what it finished lately. */
export interface AgentWork {
  active: WorkItem[];
  waiting: Waiting[];
  recent: WorkItem[];
}

const IN_FLIGHT: readonly StepStatus[] = ['running', 'judging', 'awaiting_approval', 'delegating'];
const NOT_STARTED: readonly StepStatus[] = ['queued', 'pending'];
const RECENT_HOURS = 24;
const MAX_ACTIVE = 12;
const MAX_RECENT = 5;
const MAX_WAITING = 6;
const RANK = new Map<StepStatus, number>(
  [...IN_FLIGHT, ...NOT_STARTED].map((s, i) => [s, i] as const),
);

const minutesBetween = (from: Date | null, to: Date) =>
  from ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000)) : null;

/**
 * The agent's own work: its tasks in projects that are still going, what those tasks wait for
 * from a person, and what it finished or failed in the last day (in any project).
 */
export async function loadAgentWork(db: Db, agentId: string, now = new Date()): Promise<AgentWork> {
  const open = notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]);
  const [live, finished] = await Promise.all([
    db
      .select({ step: steps, task: tasks })
      .from(steps)
      .innerJoin(tasks, eq(tasks.id, steps.taskId))
      .where(
        and(
          eq(steps.agentId, agentId),
          inArray(steps.status, [...IN_FLIGHT, ...NOT_STARTED]),
          open,
        ),
      ),
    db
      .select({ step: steps, task: tasks })
      .from(steps)
      .innerJoin(tasks, eq(tasks.id, steps.taskId))
      .where(
        and(
          eq(steps.agentId, agentId),
          inArray(steps.status, ['succeeded', 'failed']),
          gte(steps.finishedAt, new Date(now.getTime() - RECENT_HOURS * 3_600_000)),
        ),
      )
      .orderBy(desc(steps.finishedAt))
      .limit(MAX_RECENT),
  ]);
  const pending = live.length
    ? await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.status, 'pending'),
            inArray(
              approvals.stepId,
              live.map((l) => l.step.id),
            ),
          ),
        )
    : [];

  const item = ({ step, task }: (typeof live)[number], note = ''): WorkItem => ({
    project: projectTitle(task),
    title: step.title,
    status: step.status,
    attempt: step.attempt,
    minutes: minutesBetween(step.startedAt ?? step.queuedAt, now),
    note,
  });
  const byId = new Map(live.map((l) => [l.step.id, l]));
  return {
    active: live
      .sort((a, b) => (RANK.get(a.step.status) ?? 99) - (RANK.get(b.step.status) ?? 99))
      .slice(0, MAX_ACTIVE)
      .map((l) => item(l)),
    waiting: pending.slice(0, MAX_WAITING).flatMap((a) => {
      const l = byId.get(a.stepId);
      if (!l) return [];
      return [
        {
          project: projectTitle(l.task),
          title: l.step.title,
          what:
            a.tool === 'ask_user'
              ? `answer the question "${clip(String(a.args.question ?? ''), 160)}"`
              : `approve running ${a.tool}`,
        },
      ];
    }),
    recent: finished.map((f) =>
      item(f, clip(f.step.status === 'failed' ? (f.step.error ?? '') : (f.step.output ?? ''), 200)),
    ),
  };
}

const age = (minutes: number | null) =>
  minutes === null
    ? ''
    : minutes < 1
      ? ' (just started)'
      : minutes < 90
        ? ` (${minutes} min)`
        : ` (${Math.round(minutes / 60)} h)`;
const tried = (i: WorkItem) => (i.attempt > 1 ? `, attempt ${i.attempt}` : '');

/** The agent's work as plain facts for its model to summarize. */
export function describeWork(work: AgentWork): string {
  if (!work.active.length && !work.waiting.length && !work.recent.length) {
    return 'You have no tasks in any running project, and finished nothing in the last 24 hours.';
  }
  return [
    work.active.length
      ? `Your tasks in running projects:\n${work.active
          .map(
            (i) =>
              `- "${i.title}" in project "${i.project}": ${i.status.replace('_', ' ')}${age(i.minutes)}${tried(i)}`,
          )
          .join('\n')}`
      : 'You have no tasks in any running project.',
    work.waiting.length
      ? `Waiting for a person:\n${work.waiting.map((w) => `- On "${w.title}" in "${w.project}": needs someone to ${w.what}`).join('\n')}`
      : '',
    work.recent.length
      ? `Finished in the last ${RECENT_HOURS} hours, newest first:\n${work.recent
          .map(
            (i) =>
              `- "${i.title}" in "${i.project}": ${i.status}${i.note ? `. ${i.status === 'failed' ? 'Why' : 'Result'}: ${i.note}` : ''}`,
          )
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Whether a message is asking where things stand, for the answer to fall back on facts. */
export const isStatusQuestion = (text: string): boolean =>
  /\b(status|progress|working on|up to|update|summar(y|ize|ise)|how('s| is| are)|what('s| is| are) (left|next|blocked|going)|blocked|stuck)\b/i.test(
    text,
  );

/** The same facts as a ready-to-send Slack message, for when no model is available. */
export function statusReply(agentName: string, work: AgentWork): string {
  const running = work.active.filter((i) => (IN_FLIGHT as readonly string[]).includes(i.status));
  const next = work.active.filter((i) => (NOT_STARTED as readonly string[]).includes(i.status));
  if (!work.active.length && !work.recent.length) {
    return `*${esc(agentName)}*: nothing on my plate right now, and nothing finished in the last day.`;
  }
  return [
    running.length
      ? `*${esc(agentName)}* is on ${running.length} task${running.length > 1 ? 's' : ''}:`
      : `*${esc(agentName)}* has nothing running right now.`,
    ...running.map(
      (i) =>
        `• *${esc(i.title)}* (${esc(i.project)}): ${i.status.replace('_', ' ')}${age(i.minutes)}${tried(i)}`,
    ),
    ...work.waiting.map(
      (w) => `• Needs a person on *${esc(w.title)}*: ${esc(w.what)} (${esc(w.project)})`,
    ),
    ...next.slice(0, 4).map((i) => `• Up next: *${esc(i.title)}* (${esc(i.project)})`),
    ...work.recent
      .slice(0, 3)
      .map(
        (i) =>
          `• ${i.status === 'failed' ? 'Failed' : 'Done'}: *${esc(i.title)}* (${esc(i.project)})${i.note ? ` — ${esc(clip(i.note, 120))}` : ''}`,
      ),
  ].join('\n');
}
