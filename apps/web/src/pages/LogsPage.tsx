import type { ConversationMessage, StepConversationDto } from '@gantrix/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { label, short } from '../format.ts';
import { go, useAgents, useTask } from '../hooks.ts';
import { eventText } from './TaskPage.tsx';

const ROLE_LABEL: Record<ConversationMessage['role'], string> = {
  system: 'System prompt',
  user: 'Task',
  assistant: 'Agent',
  tool: 'Tool result',
};

function Message({ m }: { m: ConversationMessage }) {
  // The system prompt and long tool results are folded so the conversation stays readable.
  const folded = m.role === 'system' || (m.role === 'tool' && m.text.length > 600);
  const body = (
    <>
      {m.thinking && (
        <details className="thinking">
          <summary>Thinking</summary>
          <pre className="output">{m.thinking}</pre>
        </details>
      )}
      {m.text && <pre className="output">{m.text}</pre>}
      {m.toolCalls?.map((c) => (
        <div key={c.id || c.name} className="tool-call">
          <span className="mono">→ {c.name}</span>
          <pre className="output">{JSON.stringify(c.args, null, 2)}</pre>
        </div>
      ))}
    </>
  );
  const title = (
    <>
      <b>{ROLE_LABEL[m.role]}</b>
      {m.toolName && <span className="mono"> {m.toolName}</span>}
      {m.tokens ? <span className="muted small"> · {m.tokens.toLocaleString()} tokens</span> : null}
    </>
  );
  return (
    <li className={`msg msg-${m.role}`}>
      {folded ? (
        <details>
          <summary>{title}</summary>
          {body}
        </details>
      ) : (
        <>
          <div className="msg-head">{title}</div>
          {body}
        </>
      )}
    </li>
  );
}

function Conversation({
  taskId,
  stepId,
  version,
}: {
  taskId: string;
  stepId: string;
  version: number;
}) {
  const [data, setData] = useState<StepConversationDto | null>(null);
  const [error, setError] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch as the step's events arrive
  useEffect(() => {
    api
      .get<StepConversationDto>(`/api/tasks/${taskId}/steps/${stepId}/conversation`)
      .then(setData, (e: Error) => setError(e.message));
  }, [taskId, stepId, version]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.attempts.length) return <p className="muted">This step hasn't started yet.</p>;
  return (
    <>
      {data.attempts.map((a) => (
        <section key={a.attempt}>
          {data.attempts.length > 1 && <h3>Attempt {a.attempt}</h3>}
          <ol className="conversation">
            {a.messages.map((m, i) => (
              // Messages never reorder, so the index is a stable key.
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              <Message key={i} m={m} />
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}

export function LogsPage({ id, stepId }: { id: string; stepId?: string }) {
  const { task, events, error } = useTask(id);
  const agents = useAgents();
  const [filter, setFilter] = useState<'all' | 'step'>('all');
  if (error) return <p className="error">{error.message}</p>;
  if (!task) return <p className="muted">Loading…</p>;

  const steps = task.steps.filter((s) => s.status !== 'superseded' || s.id === stepId);
  const selected = task.steps.find((s) => s.id === stepId) ?? steps[0];
  const keys = new Map(task.steps.map((s) => [s.id, s.key]));
  const stepEvents = selected
    ? events.filter((e) => 'stepId' in e && e.stepId === selected.id)
    : [];
  const shown = filter === 'step' ? stepEvents : events;

  return (
    <div className="task-page logs">
      <header className="task-head">
        <div>
          <div className="eyebrow mono">
            <a href={`#/tasks/${task.id}`}>task {short(task.id)}</a> · logs
          </div>
          <h1>{task.goal}</h1>
        </div>
      </header>

      <div className="columns logs-columns">
        <section className="card">
          <h2>Steps</h2>
          <ul className="step-list">
            {steps.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`link ${selected?.id === s.id ? 'active' : ''}`}
                  onClick={() => go(`/tasks/${task.id}/logs/${s.id}`)}
                >
                  <span className="mono">{s.key}</span>{' '}
                  <span className="muted small">
                    {s.agentId ? (agents.get(s.agentId)?.name ?? '…') : 'deleted agent'}
                  </span>{' '}
                  <span className={`pill s-${s.status}`}>{label(s.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Conversation{selected ? `: ${selected.title}` : ''}</h2>
          {selected ? (
            <>
              {selected.judgeReason && (
                <p className="judge">
                  <b>Judge:</b> {selected.judgeReason}
                </p>
              )}
              <Conversation taskId={task.id} stepId={selected.id} version={stepEvents.length} />
            </>
          ) : (
            <p className="muted">No steps yet; the planner is still working.</p>
          )}
        </section>
      </div>

      <section className="card">
        <div className="row-actions">
          <h2>Event log</h2>
          <label className="inline">
            <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'step')}>
              <option value="all">Whole task</option>
              <option value="step">Selected step only</option>
            </select>
          </label>
        </div>
        <ol className="activity">
          {shown.map((e) => (
            <li key={e.id} className={`ev ev-${e.type.replace('.', '-')}`}>
              <time className="mono">{new Date(e.at).toLocaleTimeString()}</time>
              <span>{eventText(e, keys)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
