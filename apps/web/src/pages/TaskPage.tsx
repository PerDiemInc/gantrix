import {
  isTerminal,
  type StepDto,
  type StepStatus,
  type StreamEvent,
  type TaskDetailDto,
} from '@gantrix/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { FilePreview, previewKind } from '../components/FilePreview.tsx';
import { Gantt } from '../components/Gantt.tsx';
import { Icon } from '../components/Icon.tsx';
import { Meeting } from '../components/Meeting.tsx';
import { type AgentState, Avatar, StatusPill, TaskProgress } from '../components/ui.tsx';
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
        <span className="num">
          {used.toLocaleString()}
          {unit} / {max.toLocaleString()}
          {unit}
        </span>
      </div>
      <div
        className="meter-track"
        role="progressbar"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={used}
      >
        <div className={`meter-fill ${pct > 85 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const ACTIVE: ReadonlySet<StepStatus> = new Set([
  'running',
  'judging',
  'awaiting_approval',
  'queued',
]);
const stateOf = (status: StepStatus): AgentState =>
  status === 'awaiting_approval' ? 'waiting' : status === 'queued' ? 'queued' : 'working';

/** One card per task that's moving: who, what, for how long, and the last thing it did. */
function WorkingNow({
  task,
  events,
  agents,
  now,
  onMessage,
}: {
  task: TaskDetailDto;
  events: StreamEvent[];
  agents: Map<string, { name: string }>;
  now: number;
  onMessage: (stepId: string) => void;
}) {
  const active = task.steps.filter((s) => ACTIVE.has(s.status));
  if (!active.length) return null;
  return (
    <section className="card" aria-labelledby="working-now">
      <h2 id="working-now">Working now</h2>
      <ul className="working">
        {active.map((s) => {
          const name = (s.agentId && agents.get(s.agentId)?.name) || 'agent';
          const lastTool = events.findLast((e) => e.type === 'step.tool_call' && e.stepId === s.id);
          const since = s.startedAt ?? s.queuedAt;
          return (
            <li key={s.id} className="worker">
              <Avatar name={name} state={stateOf(s.status)} size={36} />
              <div className="worker-main">
                <div className="worker-head">
                  <b>{name}</b>
                  <StatusPill status={s.status} />
                  {since && (
                    <span className="muted small num push">
                      <Icon name="clock" size={12} /> {duration(now - Date.parse(since))}
                    </span>
                  )}
                </div>
                <p className="worker-task">{s.title}</p>
                {lastTool?.type === 'step.tool_call' && (
                  <p className="muted small mono worker-tool">
                    {lastTool.tool} {lastTool.summary}
                  </p>
                )}
              </div>
              <button type="button" className="ghost small" onClick={() => onMessage(s.id)}>
                <Icon name="chat" size={14} /> Message
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function eventText(e: StreamEvent, keys: Map<string, string>): string {
  switch (e.type) {
    case 'task.status':
      return `Project ${label(e.status)}${e.reason ? ` — ${e.reason}` : ''}`;
    case 'plan.created':
      return `Plan v${e.version}: ${e.stepKeys.join(', ')}${e.reason !== 'initial' ? ` — because ${e.reason}` : ''}`;
    case 'step.status':
      return `${e.key} ${label(e.status)}${e.attempt > 1 ? ` (try ${e.attempt})` : ''}`;
    case 'step.tool_call':
      return `${keys.get(e.stepId) ?? 'step'} → ${e.tool} ${e.summary}${e.autoApproved ? ' (no approval needed)' : ''}`;
    case 'approval.requested':
      return `${keys.get(e.stepId) ?? 'A step'} asks to run ${e.tool}`;
    case 'approval.decided':
      return e.approved ? 'Approved' : 'Denied';
    case 'goal.judged':
      return `Goal ${e.passed ? 'met' : 'not met'}: ${e.reason}`;
    case 'budget.exceeded':
      return `Budget exceeded (${e.limit}): ${e.detail}`;
    case 'user.message':
      return `You → ${e.stepId ? (keys.get(e.stepId) ?? 'a step') : 'the team'}: ${e.text}`;
    case 'user.message_delivered':
      return `${keys.get(e.stepId) ?? 'A step'} read your note`;
  }
}

export function StepPanel({ step, agentName }: { step: StepDto; agentName: string }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{step.title}</h3>
        <StatusPill status={step.status} />
        <a className="small push" href={`#/projects/${step.taskId}/logs/${step.id}`}>
          <Icon name="chat" size={12} /> Full conversation
        </a>
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

export function Files({ taskId, version }: { taskId: string; version: number }) {
  const [files, setFiles] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the task changes
  useEffect(() => {
    api.get<{ files: string[] }>(`/api/tasks/${taskId}/files`).then((r) => setFiles(r.files));
  }, [taskId, version]);
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
                className={`link mono ${open === f ? 'active' : ''}`}
                aria-pressed={open === f}
                onClick={() => setOpen(open === f ? null : f)}
              >
                <Icon name={previewKind(f) === 'text' ? 'file' : 'play'} size={12} /> {f}
              </button>
            )}
          </li>
        ))}
      </ul>
      {open && <FilePreview taskId={taskId} path={open} />}
    </div>
  );
}

export function TaskPage({ id }: { id: string }) {
  const { task, events, error, reload } = useTask(id);
  const agents = useAgents();
  const [selected, setSelected] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  const [raw, setRaw] = useState(false);
  const [tab, setTab] = useState<'progress' | 'chat' | 'files'>('progress');
  const [chatTarget, setChatTarget] = useState('');
  const now = useNow(1000, Boolean(task && !isTerminal(task.status)));

  if (error) {
    return (
      <p className="error" role="alert">
        {error.message}
      </p>
    );
  }
  if (!task) return <div className="skeleton page-skeleton" aria-busy="true" />;

  const current = task.steps.filter((s) => s.status !== 'superseded');
  const steps = showOld ? task.steps : current;
  const keys = new Map(task.steps.map((s) => [s.id, s.key]));
  const step = task.steps.find((s) => s.id === selected);
  const pending = task.approvals.filter((a) => a.status === 'pending');
  const counts: Partial<Record<StepStatus, number>> = {};
  for (const s of current) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
  const elapsedMin = task.startedAt ? Math.floor((end - Date.parse(task.startedAt)) / 60_000) : 0;
  const decide = async (approvalId: string, approved: boolean) => {
    await api.post(`/api/approvals/${approvalId}`, { approved });
    reload();
  };
  const cancel = async () => {
    if (!confirm('Cancel this project? Running tasks stop; finished work stays in its folder.'))
      return;
    await api.post(`/api/tasks/${task.id}/cancel`);
  };
  const message = (stepId: string) => {
    setChatTarget(stepId);
    setTab('chat');
    document.getElementById('chat')?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div className={`project-page tab-${tab}`}>
      <header className="project-header">
        <a className="back small" href="#/projects">
          <Icon name="arrowLeft" size={14} /> Projects
        </a>
        <div className="project-title">
          <div>
            <div className="muted small tabular">
              project {short(task.id)} · plan v{task.plans.length || '–'} ·{' '}
              {duration(end - Date.parse(task.createdAt))}
            </div>
            <h1>{task.goal}</h1>
          </div>
          <div className="task-actions">
            {!task.approveAll && (
              <span className="pill big ask" title="Risky tool calls wait for your approval">
                <Icon name="hand" size={14} /> asks first
              </span>
            )}
            <StatusPill status={task.status} big />
            <a className="button ghost" href={`#/projects/${task.id}/logs`}>
              <Icon name="list" size={14} /> Logs
            </a>
            {!isTerminal(task.status) && (
              <button type="button" className="ghost danger" onClick={() => void cancel()}>
                <Icon name="stop" size={14} /> Cancel
              </button>
            )}
          </div>
        </div>
        <div className="project-summary">
          <TaskProgress counts={counts} />
          <div className="meters">
            <Meter name="Tokens" used={task.tokensUsed} max={task.budget.maxTokens} />
            <Meter name="Time" used={elapsedMin} max={task.budget.maxMinutes} unit=" min" />
            <Meter name="Replans" used={task.replans} max={task.budget.maxReplans} />
          </div>
        </div>
        {task.error && (
          <p className="error" role="alert">
            {task.error}
          </p>
        )}
        {task.result && (
          <details className="result" open>
            <summary>
              <Icon name="check" size={14} /> Result
            </summary>
            <pre className="output">{task.result}</pre>
          </details>
        )}
      </header>

      <div className="segmented tabs-mobile" role="tablist" aria-label="Project views">
        {(
          [
            ['progress', 'Progress'],
            ['chat', 'Chat'],
            ['files', 'Files'],
          ] as const
        ).map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {text}
          </button>
        ))}
      </div>

      <div className="project-body">
        <div className="project-main">
          <div className="panel-progress stack">
            {pending.map((a) => (
              <section key={a.id} className="approval" aria-label="Approval needed">
                <div>
                  <p>
                    <Icon name="hand" /> <strong>{keys.get(a.stepId) ?? 'A task'}</strong> wants to
                    run <code>{a.tool}</code>
                  </p>
                  <pre className="args">{JSON.stringify(a.args, null, 2)}</pre>
                </div>
                <div className="approval-actions">
                  <button type="button" className="primary" onClick={() => void decide(a.id, true)}>
                    <Icon name="check" size={14} /> Approve
                  </button>
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={() => void decide(a.id, false)}
                  >
                    <Icon name="x" size={14} /> Deny
                  </button>
                </div>
              </section>
            ))}

            <WorkingNow task={task} events={events} agents={agents} now={now} onMessage={message} />

            <section className="card">
              <div className="card-head">
                <h2>Timeline</h2>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={showOld}
                    onChange={(e) => setShowOld(e.target.checked)}
                  />{' '}
                  show replaced tasks
                </label>
              </div>
              {steps.length ? (
                <Gantt
                  steps={steps}
                  agents={agents}
                  finishedAt={task.finishedAt}
                  selected={selected}
                  onSelect={(s) => setSelected(s === selected ? null : s)}
                />
              ) : (
                <p className="muted">The planner is splitting the goal into tasks…</p>
              )}
              {step ? (
                <StepPanel
                  step={step}
                  agentName={
                    step.agentId ? (agents.get(step.agentId)?.name ?? '…') : 'deleted agent'
                  }
                />
              ) : (
                steps.length > 0 && (
                  <p className="muted small">Select a task on the timeline to see its work.</p>
                )
              )}
            </section>
          </div>

          <section className="card panel-files">
            <h2>Files</h2>
            <p className="muted mono small">{task.workspacePath}</p>
            <Files
              taskId={task.id}
              version={task.steps.filter((s) => s.status === 'succeeded').length}
            />
          </section>
        </div>

        <aside className="card chat-panel panel-chat" id="chat" aria-label="Project chat">
          <div className="card-head">
            <h2>
              <Icon name="chat" /> {raw ? 'Events' : 'Chat'}
            </h2>
            <label className="toggle">
              <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> raw
              events
            </label>
          </div>
          {raw ? (
            <ol className="activity">
              {[...events].reverse().map((e) => (
                <li key={e.id} className={`ev ev-${e.type.replace('.', '-')}`}>
                  <time className="num">{new Date(e.at).toLocaleTimeString()}</time>
                  <span>{eventText(e, keys)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <Meeting
              task={task}
              events={events}
              agentNames={agents}
              target={chatTarget}
              onTarget={setChatTarget}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

export const ProjectPage = TaskPage;
