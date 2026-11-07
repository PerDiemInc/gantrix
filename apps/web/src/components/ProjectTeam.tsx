import type {
  AgentDto,
  ConnectionDto,
  StepDto,
  StepStatus,
  StreamEvent,
  TaskDetailDto,
} from '@gantrix/shared';
import { isTerminal } from '@gantrix/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { duration } from '../format.ts';
import { Icon } from './Icon.tsx';
import { type AgentState, Avatar, StatusPill } from './ui.tsx';

/** "CTO: technology and engineering…" → "CTO"; otherwise the first few words. */
export function roleOf(agent: Pick<AgentDto, 'name' | 'description'>): string {
  const d = agent.description.trim();
  const head = d.split(/[:.]/)[0]?.trim() ?? '';
  if (head && head.length <= 40) return head;
  return d.split(/\s+/).slice(0, 4).join(' ') || agent.name;
}

export function modelOf(agent: AgentDto, connections: ConnectionDto[]): string {
  const c = connections.find((x) => x.id === agent.connectionId);
  const model = agent.model ?? 'default model';
  return c ? `${model} · ${c.name}` : `${model} · Ollama`;
}

const ACTIVE: ReadonlySet<StepStatus> = new Set(['running', 'judging']);

function stateOf(steps: StepDto[]): AgentState {
  if (steps.some((s) => ACTIVE.has(s.status))) return 'working';
  if (steps.some((s) => s.status === 'awaiting_approval')) return 'waiting';
  if (steps.some((s) => s.status === 'queued')) return 'queued';
  if (steps.length && steps.every((s) => s.status === 'succeeded')) return 'done';
  return 'idle';
}

/** The project's employees: who is on the team, their model, and what each is doing now. */
export function TeamPanel({
  task,
  agents,
  now,
  onMessage,
  onOpenTask,
}: {
  task: TaskDetailDto;
  agents: Map<string, AgentDto>;
  now: number;
  onMessage: (stepId: string) => void;
  onOpenTask: (stepId: string) => void;
}) {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<ConnectionDto[]>('/api/connections').then(setConnections, () => setConnections([]));
  }, []);
  const current = task.steps.filter((s) => s.status !== 'superseded');
  const onTeam = task.agentIds?.length
    ? task.agentIds
    : [...new Set(current.flatMap((s) => (s.agentId ? [s.agentId] : [])))];
  const members = onTeam.flatMap((id) => {
    const a = agents.get(id);
    return a ? [a] : [];
  });
  const others = [...agents.values()].filter((a) => !onTeam.includes(a.id));
  const live = !isTerminal(task.status) || task.status === 'needs_attention';

  const saveTeam = async (ids: string[]) => {
    setError('');
    try {
      await api.put(`/api/tasks/${task.id}/team`, { agentIds: ids });
      setAdding(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card" aria-labelledby="team-title">
      <div className="card-head">
        <h2 id="team-title">
          <Icon name="users" /> Team
        </h2>
        <span className="muted small">
          {task.agentIds?.length ? `${members.length} employees` : 'Every agent can join'}
        </span>
      </div>
      <ul className="employees">
        {members.map((a) => {
          const mine = current.filter((s) => s.agentId === a.id);
          const state = stateOf(mine);
          const doing =
            mine.find((s) => ACTIVE.has(s.status)) ??
            mine.find((s) => s.status === 'awaiting_approval') ??
            mine.find((s) => s.status === 'queued');
          const done = mine.filter((s) => s.status === 'succeeded').length;
          const since = doing?.startedAt ?? doing?.queuedAt;
          return (
            <li key={a.id} className={`employee state-${state}`}>
              <Avatar name={a.name} avatar={a.avatar} state={state} size={44} />
              <div className="employee-main">
                <div className="employee-head">
                  <b>{a.name}</b>
                  <span className="muted small">{roleOf(a)}</span>
                </div>
                <p className="employee-now small">
                  {doing ? (
                    <button type="button" className="link" onClick={() => onOpenTask(doing.id)}>
                      {state === 'waiting'
                        ? 'Waiting for you on '
                        : state === 'queued'
                          ? 'Up next: '
                          : 'Working on '}
                      {doing.title}
                    </button>
                  ) : mine.length ? (
                    state === 'done' ? (
                      'All their tasks are done'
                    ) : (
                      'Waiting on others'
                    )
                  ) : (
                    'No tasks yet'
                  )}
                  {since && state === 'working' && (
                    <span className="muted num"> · {duration(now - Date.parse(since))}</span>
                  )}
                </p>
                <p className="muted small">
                  <span className="num">
                    {done}/{mine.length}
                  </span>{' '}
                  tasks done ·{' '}
                  <a href="#/agents" title="Change the model on the Agents page">
                    {modelOf(a, connections)}
                  </a>
                </p>
              </div>
              <div className="employee-actions">
                {doing && live && (
                  <button type="button" className="ghost small" onClick={() => onMessage(doing.id)}>
                    <Icon name="chat" size={14} /> Message
                  </button>
                )}
                {live && task.agentIds?.length && (
                  <button
                    type="button"
                    className="ghost small"
                    aria-label={`Remove ${a.name} from the team`}
                    onClick={() => void saveTeam(onTeam.filter((id) => id !== a.id))}
                    disabled={onTeam.length <= 1}
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {live && others.length > 0 && (
        <div className="team-add">
          {adding ? (
            <div className="team-options">
              {others.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="agent-option"
                  onClick={() => void saveTeam([...onTeam, a.id])}
                >
                  <Avatar name={a.name} avatar={a.avatar} size={24} />
                  {a.name}
                </button>
              ))}
              <button type="button" className="ghost small" onClick={() => setAdding(false)}>
                Done
              </button>
            </div>
          ) : (
            <button type="button" className="ghost small" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} /> Add an employee
            </button>
          )}
          <span className="muted small">
            New employees get work from the next plan or a reassigned task.
          </span>
        </div>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const COLUMNS: {
  title: string;
  icon: Parameters<typeof Icon>[0]['name'];
  statuses: StepStatus[];
}[] = [
  { title: 'To do', icon: 'clock', statuses: ['pending', 'queued', 'cancelled'] },
  { title: 'In progress', icon: 'play', statuses: ['running', 'judging', 'delegating'] },
  { title: 'Needs you', icon: 'hand', statuses: ['awaiting_approval'] },
  { title: 'Done', icon: 'check', statuses: ['succeeded'] },
  { title: 'Failed', icon: 'x', statuses: ['failed'] },
];

/** Every task of the current plan in a column by status, with who does it. */
export function TaskBoard({
  steps,
  agents,
  onOpen,
}: {
  steps: StepDto[];
  agents: Map<string, AgentDto>;
  onOpen: (stepId: string) => void;
}) {
  const keyTitle = new Map(steps.map((s) => [s.key, s.title]));
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const cards = steps.filter((s) => col.statuses.includes(s.status));
        if (!cards.length && (col.title === 'Failed' || col.title === 'Needs you')) return null;
        return (
          <section
            key={col.title}
            className="board-col"
            aria-label={`${col.title}, ${cards.length} tasks`}
          >
            <h3 className="board-col-head">
              <Icon name={col.icon} size={14} /> {col.title}{' '}
              <span className="count num">{cards.length}</span>
            </h3>
            <ul>
              {cards.map((s) => {
                const a = s.agentId ? agents.get(s.agentId) : undefined;
                return (
                  <li key={s.id}>
                    <button type="button" className="task-card" onClick={() => onOpen(s.id)}>
                      <span className="task-card-title">{s.title}</span>
                      {s.parentStepId && (
                        <span className="muted small subtask">
                          <Icon name="users" size={12} /> sub-task for{' '}
                          {steps.find((p) => p.id === s.parentStepId)?.title ?? 'another task'}
                        </span>
                      )}
                      {s.status === 'delegating' && (
                        <span className="muted small">waiting for its sub-agent</span>
                      )}
                      {s.dependsOn.length > 0 && (
                        <span className="muted small">
                          after {s.dependsOn.map((k) => keyTitle.get(k) ?? k).join(', ')}
                        </span>
                      )}
                      <span className="task-card-foot">
                        {a ? (
                          <span className="assignee">
                            <Avatar name={a.name} avatar={a.avatar} size={22} />
                            <span className="small">{a.name}</span>
                          </span>
                        ) : (
                          <span className="muted small">no one</span>
                        )}
                        {s.attempt > 1 && <span className="muted small num">try {s.attempt}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
              {!cards.length && <li className="muted small board-empty">Nothing here</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const BUSY: ReadonlySet<StepStatus> = new Set([
  'running',
  'judging',
  'awaiting_approval',
  'delegating',
]);

/** One task: what it is, who does it and how it went, with editing and rerun. */
export function TaskDialog({
  task,
  step,
  agents,
  onClose,
  onMessage,
}: {
  task: TaskDetailDto;
  step: StepDto;
  agents: Map<string, AgentDto>;
  onClose: () => void;
  onMessage: (stepId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({
    title: step.title,
    instructions: step.instructions,
    acceptance: step.acceptance,
    agentId: step.agentId ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const team = task.agentIds?.length
    ? task.agentIds.flatMap((id) => {
        const a = agents.get(id);
        return a ? [a] : [];
      })
    : [...agents.values()];
  const running = BUSY.has(step.status);
  const closed = task.status === 'cancelled';
  const canRerun = ['failed', 'succeeded', 'cancelled'].includes(step.status);
  const dirty =
    form.title !== step.title ||
    form.instructions !== step.instructions ||
    form.acceptance !== step.acceptance ||
    form.agentId !== (step.agentId ?? '');

  const save = async (rerun: boolean) => {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const r = await api.patch<{ reopened: boolean }>(`/api/tasks/${task.id}/steps/${step.id}`, {
        ...(form.title !== step.title ? { title: form.title } : {}),
        ...(form.instructions !== step.instructions ? { instructions: form.instructions } : {}),
        ...(form.acceptance !== step.acceptance ? { acceptance: form.acceptance } : {}),
        ...(form.agentId && form.agentId !== step.agentId ? { agentId: form.agentId } : {}),
        ...(rerun ? { rerun: true } : {}),
      });
      setSaved(
        rerun
          ? r.reopened
            ? 'Saved. The project is open again and runs this task.'
            : 'Saved. It runs again.'
          : 'Saved.',
      );
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  return (
    <dialog ref={ref} className="task-dialog" onClose={onClose} aria-labelledby="task-dialog-title">
      <form method="dialog" className="task-dialog-head">
        <div>
          <p className="muted small mono">{step.key}</p>
          <h2 id="task-dialog-title">{step.title}</h2>
        </div>
        <StatusPill status={step.status} />
        <button type="submit" className="ghost small" aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </form>

      {running && (
        <p className="warning small" role="note">
          <Icon name="alert" /> This task is in progress, so it can't change right now.{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              onMessage(step.id);
              onClose();
            }}
          >
            Message its agent
          </button>{' '}
          instead.
        </p>
      )}

      <form className="task-form" onSubmit={submit}>
        <label>
          Title
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            disabled={running || closed}
            required
          />
        </label>
        <label>
          Assigned to
          <select
            value={form.agentId}
            onChange={(e) => setForm({ ...form, agentId: e.target.value })}
            disabled={running || closed}
          >
            {!form.agentId && <option value="">No one</option>}
            {team.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {roleOf(a)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Instructions
          <textarea
            rows={5}
            value={form.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
            disabled={running || closed}
            required
          />
        </label>
        <label>
          Done when
          <textarea
            rows={2}
            value={form.acceptance}
            onChange={(e) => setForm({ ...form, acceptance: e.target.value })}
            disabled={running || closed}
            required
          />
          <span className="muted small">The judge checks the result against this.</span>
        </label>
        <div className="row-actions">
          <button type="submit" className="primary" disabled={busy || running || closed || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {canRerun && (
            <button
              type="button"
              className="ghost"
              disabled={busy || closed}
              onClick={() => void save(true)}
            >
              <Icon name="play" size={14} /> {dirty ? 'Save and run again' : 'Run again'}
            </button>
          )}
          <a className="push small" href={`#/projects/${task.id}/logs/${step.id}`}>
            <Icon name="chat" size={12} /> Full conversation
          </a>
        </div>
        {saved && (
          <p className="small" role="status">
            <Icon name="check" size={14} /> {saved}
          </p>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
      </form>

      {step.judgeReason && (
        <section>
          <h3 className="small">Judge</h3>
          <p className="prose">{step.judgeReason}</p>
        </section>
      )}
      {step.error && <p className="error small">{step.error}</p>}
      {step.output && (
        <section>
          <h3 className="small">Agent's reply</h3>
          <pre className="output">{step.output}</pre>
        </section>
      )}
    </dialog>
  );
}

export type { StreamEvent };
