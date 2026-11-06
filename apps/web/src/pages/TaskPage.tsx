import { isTerminal, type StepDto, type StreamEvent } from '@gantrix/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Gantt } from '../components/Gantt.tsx';
import { duration, label, short } from '../format.ts';
import { useAgents, useNow, useTask } from '../hooks.ts';

function Meter({
  name,
  used,
  max,
  unit = '',
}: {
  name: string;
  used: number;
  max: number;
  unit?: string;
}) {
  const pct = Math.min(100, (used / max) * 100);
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{name}</span>
        <span className="mono">
          {used.toLocaleString()}
          {unit} / {max.toLocaleString()}
          {unit}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${pct > 85 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function eventText(e: StreamEvent, keys: Map<string, string>): string {
  switch (e.type) {
    case 'task.status':
      return `Task ${label(e.status)}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'plan.created':
      return `Plan v${e.version}: ${e.stepKeys.join(', ')}${e.reason !== 'initial' ? ` — because ${e.reason}` : ''}`;
    case 'step.status':
      return `${e.key} ${label(e.status)}${e.attempt > 1 ? ` (try ${e.attempt})` : ''}`;
    case 'step.tool_call':
      return `${keys.get(e.stepId) ?? 'step'} → ${e.tool} ${e.summary}${e.autoApproved ? ' ⚡ auto-approved' : ''}`;
    case 'approval.requested':
      return `${keys.get(e.stepId) ?? 'A step'} asks to run ${e.tool}`;
    case 'approval.decided':
      return e.approved ? 'Approved' : 'Denied';
    case 'goal.judged':
      return `Goal ${e.passed ? 'met' : 'not met'}: ${e.reason}`;
    case 'budget.exceeded':
      return `Budget exceeded (${e.limit}): ${e.detail}`;
  }
}

function StepPanel({ step, agentName }: { step: StepDto; agentName: string }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{step.title}</h3>
        <a className="small" href={`#/tasks/${step.taskId}/logs/${step.id}`}>
          View conversation →
        </a>
        <span className={`pill s-${step.status}`}>{label(step.status)}</span>
      </div>
      <dl className="facts">
        <dt>Key</dt>
        <dd className="mono">{step.key}</dd>
        <dt>Agent</dt>
        <dd>{agentName}</dd>
        <dt>Attempt</dt>
        <dd>{step.attempt}</dd>
        <dt>Plan</dt>
        <dd>v{step.planVersion}</dd>
        <dt>Waits for</dt>
        <dd className="mono">{step.dependsOn.join(', ') || '—'}</dd>
        <dt>Tokens</dt>
        <dd>{step.tokensUsed.toLocaleString()}</dd>
      </dl>
      <h4>Instructions</h4>
      <p className="prose">{step.instructions}</p>
      <h4>Done when</h4>
      <p className="prose">{step.acceptance}</p>
      {step.judgeReason && (
        <>
          <h4>Judge</h4>
          <p className="prose">{step.judgeReason}</p>
        </>
      )}
      {step.error && <p className="error">{step.error}</p>}
      {step.output && (
        <>
          <h4>Agent reply</h4>
          <pre className="output">{step.output}</pre>
        </>
      )}
    </div>
  );
}

function Files({ taskId, version }: { taskId: string; version: number }) {
  const [files, setFiles] = useState<string[]>([]);
  const [open, setOpen] = useState<{ path: string; text: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the task changes
  useEffect(() => {
    api.get<{ files: string[] }>(`/api/tasks/${taskId}/files`).then((r) => setFiles(r.files));
  }, [taskId, version]);
  const show = async (path: string) =>
    setOpen({
      path,
      text: await api.get<string>(
        `/api/tasks/${taskId}/files/content?path=${encodeURIComponent(path)}`,
      ),
    });
  if (!files.length) return <p className="muted">No files yet.</p>;
  return (
    <div className="files">
      <ul>
        {files.map((f) => (
          <li key={f}>
            {f.endsWith('/') || f.endsWith('@') ? (
              <span className="muted mono">{f}</span>
            ) : (
              <button
                type="button"
                className={`link mono ${open?.path === f ? 'active' : ''}`}
                onClick={() => void show(f)}
              >
                {f}
              </button>
            )}
          </li>
        ))}
      </ul>
      {open && <pre className="output">{open.text}</pre>}
    </div>
  );
}

export function TaskPage({ id }: { id: string }) {
  const { task, events, error, reload } = useTask(id);
  const agents = useAgents();
  const [selected, setSelected] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  const now = useNow(1000, Boolean(task && !isTerminal(task.status)));

  if (error) return <p className="error">{error.message}</p>;
  if (!task) return <p className="muted">Loading…</p>;

  const steps = showOld ? task.steps : task.steps.filter((s) => s.status !== 'superseded');
  const keys = new Map(task.steps.map((s) => [s.id, s.key]));
  const step = task.steps.find((s) => s.id === selected);
  const pending = task.approvals.filter((a) => a.status === 'pending');
  const elapsedMin = task.startedAt
    ? Math.floor(
        ((task.finishedAt ? Date.parse(task.finishedAt) : now) - Date.parse(task.startedAt)) /
          60_000,
      )
    : 0;
  const decide = async (approvalId: string, approved: boolean) => {
    await api.post(`/api/approvals/${approvalId}`, { approved });
    reload();
  };

  return (
    <div className="task-page">
      <header className="task-head">
        <div>
          <div className="eyebrow mono">
            task {short(task.id)} · plan v{task.plans.length || '–'}
          </div>
          <h1>{task.goal}</h1>
        </div>
        <div className="task-actions">
          <a className="ghost button" href={`#/tasks/${task.id}/logs`}>
            Logs
          </a>
          {task.approveAll && (
            <span className="pill big god-mode" title="Tool calls run without asking">
              ⚡ God mode
            </span>
          )}
          <span className={`pill big s-${task.status}`}>{label(task.status)}</span>
          {!isTerminal(task.status) && (
            <button
              type="button"
              className="ghost danger"
              onClick={() => void api.post(`/api/tasks/${task.id}/cancel`)}
            >
              Cancel
            </button>
          )}
        </div>
      </header>

      <section className="meters">
        <Meter name="Tokens" used={task.tokensUsed} max={task.budget.maxTokens} />
        <Meter name="Replans" used={task.replans} max={task.budget.maxReplans} />
        <Meter name="Time" used={elapsedMin} max={task.budget.maxMinutes} unit=" min" />
      </section>

      {pending.map((a) => (
        <section key={a.id} className="approval">
          <div>
            <strong>{keys.get(a.stepId) ?? 'A step'}</strong> wants to run <code>{a.tool}</code>
            <pre className="args">{JSON.stringify(a.args, null, 2)}</pre>
          </div>
          <div className="approval-actions">
            <button type="button" className="primary" onClick={() => void decide(a.id, true)}>
              Approve
            </button>
            <button type="button" className="ghost danger" onClick={() => void decide(a.id, false)}>
              Deny
            </button>
          </div>
        </section>
      ))}

      {task.error && <p className="error">{task.error}</p>}

      <section className="card">
        <div className="card-head">
          <h2>Timeline</h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showOld}
              onChange={(e) => setShowOld(e.target.checked)}
            />{' '}
            show replaced steps
          </label>
        </div>
        <Gantt
          steps={steps}
          agents={agents}
          finishedAt={task.finishedAt}
          selected={selected}
          onSelect={(s) => setSelected(s === selected ? null : s)}
        />
      </section>

      <div className="columns">
        <section className="card">
          <h2>{step ? 'Step' : 'Result'}</h2>
          {step ? (
            <StepPanel
              step={step}
              agentName={step.agentId ? (agents.get(step.agentId)?.name ?? '…') : 'deleted agent'}
            />
          ) : task.result ? (
            <pre className="output">{task.result}</pre>
          ) : (
            <p className="muted">
              Select a step on the timeline to see its work. The result appears here when the goal
              is met.
            </p>
          )}
        </section>
        <section className="card">
          <h2>Activity</h2>
          <ol className="activity">
            {[...events].reverse().map((e) => (
              <li key={e.id} className={`ev ev-${e.type.replace('.', '-')}`}>
                <time className="mono">{new Date(e.at).toLocaleTimeString()}</time>
                <span>{eventText(e, keys)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="card">
        <h2>Workspace</h2>
        <p className="muted mono small">{task.workspacePath}</p>
        <Files
          taskId={task.id}
          version={task.steps.filter((s) => s.status === 'succeeded').length}
        />
      </section>
      <p className="muted small">
        Running for{' '}
        {duration(
          (task.finishedAt ? Date.parse(task.finishedAt) : now) - Date.parse(task.createdAt),
        )}
      </p>
    </div>
  );
}
