import type { TaskDto, TaskListItem } from '@gantrix/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../api.ts';
import { ago, label, short } from '../format.ts';
import { go, useLive } from '../hooks.ts';

function NewTask() {
  const [goal, setGoal] = useState('');
  const [minutes, setMinutes] = useState('');
  const [approveAll, setApproveAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const budget = minutes ? { maxMinutes: Number(minutes) } : {};
      const task = await api.post<TaskDto>('/api/tasks', {
        goal,
        budget,
        ...(approveAll ? { approveAll: true } : {}),
      });
      go(`/tasks/${task.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="card new-task" onSubmit={(e) => void submit(e)}>
      <h2>New task</h2>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="Describe the goal. The planner splits it into steps for your agents."
        rows={3}
        required
      />
      <div className="row-actions">
        <label className="inline">
          Time budget
          <input
            type="number"
            min={1}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="60"
          />
          min
        </label>
        <label
          className="inline god-mode"
          title="Every tool call, including shell, runs without asking"
        >
          <input
            type="checkbox"
            checked={approveAll}
            onChange={(e) => setApproveAll(e.target.checked)}
          />
          ⚡ God mode
        </label>
        <button type="submit" className="primary" disabled={busy || !goal.trim()}>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
      {approveAll && (
        <p className="error">
          God mode: every tool call runs without asking, including shell commands, web requests and
          emails. Use it only for goals and skills you trust.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Progress({ counts }: { counts: TaskListItem['stepCounts'] }) {
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  if (!total) return <span className="muted">—</span>;
  const part = (n = 0) => `${(n / total) * 100}%`;
  return (
    <div className="progress" title={`${counts.succeeded ?? 0} of ${total} steps done`}>
      <div className="seg s-succeeded" style={{ width: part(counts.succeeded) }} />
      <div
        className="seg s-running"
        style={{
          width: part((counts.running ?? 0) + (counts.judging ?? 0) + (counts.queued ?? 0)),
        }}
      />
      <div className="seg s-awaiting_approval" style={{ width: part(counts.awaiting_approval) }} />
      <div className="seg s-failed" style={{ width: part(counts.failed) }} />
    </div>
  );
}

export function TasksPage() {
  const { data: tasks, error } = useLive(
    () => api.get<TaskListItem[]>('/api/tasks?limit=50'),
    '/api/stream',
    [],
  );
  return (
    <div className="stack">
      <NewTask />
      <section className="card">
        <h2>Tasks</h2>
        {error && <p className="error">{error.message}</p>}
        {tasks && !tasks.length && (
          <p className="muted">No tasks yet. Add agents and skills, then start one above.</p>
        )}
        {tasks && tasks.length > 0 && (
          <table className="list">
            <thead>
              <tr>
                <th>Status</th>
                <th>Goal</th>
                <th>Steps</th>
                <th className="num">Tokens</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} onClick={() => go(`/tasks/${t.id}`)} className="clickable">
                  <td>
                    <span className={`pill s-${t.status}`}>{label(t.status)}</span>
                  </td>
                  <td>
                    <a href={`#/tasks/${t.id}`} className="goal">
                      {t.goal}
                    </a>
                    <div className="muted mono small">{short(t.id)}</div>
                  </td>
                  <td className="w-progress">
                    <Progress counts={t.stepCounts} />
                  </td>
                  <td className="num mono">{t.tokensUsed.toLocaleString()}</td>
                  <td className="muted">{ago(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
