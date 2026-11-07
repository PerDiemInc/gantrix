import { projectTitle } from '@gantrix/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { agents, approvals, events, steps, type tasks } from '../db/schema.ts';
import { clip } from './api.ts';

type Task = typeof tasks.$inferSelect;

export const minutesSince = (from: Date, to: Date = new Date()) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

/** Everything about a project a question could be about, as plain text for a model. */
export async function projectFacts(db: Db, task: Task): Promise<string> {
  const [all, team, pending, recent] = await Promise.all([
    db.select().from(steps).where(eq(steps.taskId, task.id)).orderBy(asc(steps.createdAt)),
    db.select({ id: agents.id, name: agents.name, description: agents.description }).from(agents),
    db
      .select()
      .from(approvals)
      .where(and(eq(approvals.taskId, task.id), eq(approvals.status, 'pending'))),
    db
      .select({ type: events.type, payload: events.payload, at: events.createdAt })
      .from(events)
      .where(eq(events.taskId, task.id))
      .orderBy(desc(events.id))
      .limit(25),
  ]);
  const name = new Map(team.map((a) => [a.id, a.name]));
  const latest = Math.max(0, ...all.map((s) => s.planVersion));
  const current = all.filter((s) => s.planVersion === latest);
  const members = task.agentIds ? team.filter((a) => task.agentIds?.includes(a.id)) : team;
  const used = minutesSince(task.createdAt, task.finishedAt ?? new Date());
  return [
    `Project: ${projectTitle(task)}`,
    task.description ? `Description: ${task.description}` : '',
    `Goal: ${task.goal}`,
    `Status: ${task.status}${task.error ? ` (${task.error})` : ''}`,
    `Time: ${used} of ${task.budget.maxMinutes} minutes used. Tokens: ${task.tokensUsed} of ${task.budget.maxTokens}. Replans: ${task.replans} of ${task.budget.maxReplans}.`,
    `Team: ${members.map((a) => `${a.name} (${clip(a.description ?? '', 80)})`).join('; ')}`,
    `Tasks in the current plan (v${latest}):`,
    ...current.map(
      (s) =>
        `- ${s.title} [${s.status}] by ${name.get(s.agentId ?? '') ?? 'unassigned'}${s.output ? `. Result: ${clip(s.output, 400)}` : ''}${s.error ? `. Error: ${clip(s.error, 200)}` : ''}`,
    ),
    pending.length
      ? `Waiting for the user:\n${pending.map((a) => `- ${a.tool === 'ask_user' ? `question: ${String(a.args.question ?? '')}` : `approval for ${a.tool}`}`).join('\n')}`
      : '',
    task.result ? `Final result: ${clip(task.result, 1200)}` : '',
    `Recent activity, newest first:\n${recent.map((e) => `- ${e.at.toISOString()} ${e.type} ${clip(JSON.stringify(e.payload), 160)}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** A short, deterministic status for "@Gantrix status". */
export async function projectStatus(db: Db, task: Task, link: string): Promise<string> {
  const [all, team, pending] = await Promise.all([
    db.select().from(steps).where(eq(steps.taskId, task.id)),
    db.select({ id: agents.id, name: agents.name }).from(agents),
    db
      .select()
      .from(approvals)
      .where(and(eq(approvals.taskId, task.id), eq(approvals.status, 'pending'))),
  ]);
  const name = new Map(team.map((a) => [a.id, a.name]));
  const latest = Math.max(0, ...all.map((s) => s.planVersion));
  const current = all.filter((s) => s.planVersion === latest);
  const done = current.filter((s) => s.status === 'succeeded').length;
  const working = current.filter((s) => ['running', 'judging'].includes(s.status));
  const next = current.filter((s) => ['pending', 'queued'].includes(s.status)).slice(0, 3);
  const used = minutesSince(task.createdAt, task.finishedAt ?? new Date());
  const who = (s: { agentId: string | null }) => name.get(s.agentId ?? '') ?? 'someone';
  return [
    `*${projectTitle(task)}*: ${task.status.replace('_', ' ')} · ${done}/${current.length} tasks done · ${used} of ${task.budget.maxMinutes} min used · <${link}|Open in Gantrix>`,
    ...working.map((s) => `• Working: *${who(s)}* on “${s.title}”`),
    ...pending.map((a) =>
      a.tool === 'ask_user'
        ? `• Needs you: ${String(a.args.question ?? '')}`
        : `• Needs your OK: ${a.tool}`,
    ),
    ...next.map((s) => `• Up next: *${who(s)}* on “${s.title}”`),
    task.error ? `• ${task.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
