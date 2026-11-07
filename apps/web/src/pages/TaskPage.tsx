import { isTerminal, type StepStatus, type StreamEvent } from '@gantrix/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { FilePreview, previewKind } from '../components/FilePreview.tsx';
import { Gallery } from '../components/Gallery.tsx';
import { Gantt } from '../components/Gantt.tsx';
import { Icon } from '../components/Icon.tsx';
import { Meeting } from '../components/Meeting.tsx';
import { DeleteProject, ProjectName, SlackSwitch } from '../components/ProjectControls.tsx';
import { TaskBoard, TaskDialog, TeamPanel } from '../components/ProjectTeam.tsx';
import { QuestionCard } from '../components/QuestionCard.tsx';
import { type AgentState, StatusPill, TaskProgress } from '../components/ui.tsx';
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

const _ACTIVE: ReadonlySet<StepStatus> = new Set([
  'running',
  'judging',
  'awaiting_approval',
  'queued',
]);
const _stateOf = (status: StepStatus): AgentState =>
  status === 'awaiting_approval' ? 'waiting' : status === 'queued' ? 'queued' : 'working';

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
      return e.question
        ? `${keys.get(e.stepId) ?? 'A step'} asks: ${e.question}`
        : `${keys.get(e.stepId) ?? 'A step'} asks to run ${e.tool}`;
    case 'approval.decided':
      return e.answer ? `Answered: ${e.answer}` : e.approved ? 'Approved' : 'Denied';
    case 'goal.judged':
      return `Goal ${e.passed ? 'met' : 'not met'}: ${e.reason}`;
    case 'budget.exceeded':
      return `Budget exceeded (${e.limit}): ${e.detail}`;
    case 'user.message':
      return `You → ${e.stepId ? (keys.get(e.stepId) ?? 'a step') : 'the team'}: ${e.text}`;
    case 'step.edited':
      return `You edited ${e.key}${e.fields.length ? ` (${e.fields.join(', ')})` : ''}${e.rerun ? ' and reran it' : ''}`;
    case 'task.team':
      return e.agentIds ? `Team set to ${e.agentIds.length} agents` : 'Team: every agent';
    case 'task.updated':
      return `You changed the project's ${e.fields.join(' and ')}`;
    case 'user.message_delivered':
      return `${keys.get(e.stepId) ?? 'A step'} read your note`;
  }
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
  const [view, setView] = useState<'board' | 'timeline'>('board');
  const [showOld, setShowOld] = useState(false);
  const [raw, setRaw] = useState(false);
  const [tab, setTab] = useState<'progress' | 'chat' | 'files'>('progress');
  const [chatTarget, setChatTarget] = useState('');
  const [extendError, setExtendError] = useState('');
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
  const extend = async (add: { minutes?: number; tokens?: number; replans?: number }) => {
    setExtendError('');
    try {
      await api.post(`/api/tasks/${task.id}/extend`, add);
      reload();
    } catch (err) {
      setExtendError((err as Error).message);
    }
  };
  const cancel = async () => {
    if (!confirm('Cancel this project? Running tasks stop; finished work stays in its folder.'))
      return;
    await api.post(`/api/tasks/${task.id}/cancel`);
  };
  const stoppedByYou = task.status === 'needs_attention' && task.error === 'Stopped by you.';
  const control = async (action: 'stop' | 'resume') => {
    setExtendError('');
    try {
      await api.post(`/api/tasks/${task.id}/${action}`);
      reload();
    } catch (err) {
      setExtendError((err as Error).message);
    }
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
            <ProjectName task={task} onChange={reload} />
            {task.description && <p className="project-description">{task.description}</p>}
            <details className="project-goal" open={!task.name && !task.description}>
              <summary className="small">Goal</summary>
              <p className="project-goal-text">{task.goal}</p>
            </details>
          </div>
          <div className="task-actions">
            {!task.approveAll && (
              <span className="pill big ask" title="Risky tool calls wait for your approval">
                <Icon name="hand" size={14} /> asks first
              </span>
            )}
            <StatusPill status={task.status} big />
            {events.some((e) => e.type === 'step.tool_call' && e.tool === 'deploy_site') && (
              <a
                className="button ghost"
                href={`${location.protocol}//${location.hostname}:4702/`}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="play" size={14} /> Open deployed site
              </a>
            )}
            <a className="button ghost" href={`#/projects/${task.id}/logs`}>
              <Icon name="list" size={14} /> Logs
            </a>
            <SlackSwitch task={task} onChange={reload} />
            {!isTerminal(task.status) && (
              <>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void control('stop')}
                  title="Pause it: running tasks stop at their next step; resume any time"
                >
                  <Icon name="pause" size={14} /> Stop
                </button>
                <button type="button" className="ghost danger" onClick={() => void cancel()}>
                  <Icon name="stop" size={14} /> Cancel
                </button>
              </>
            )}
            {stoppedByYou && (
              <button type="button" className="primary" onClick={() => void control('resume')}>
                <Icon name="play" size={14} /> Resume
              </button>
            )}
            {isTerminal(task.status) && <DeleteProject task={task} />}
          </div>
        </div>
        <div className="project-summary">
          <TaskProgress counts={counts} stopped={isTerminal(task.status)} />
          <div className="meters">
            <Meter name="Tokens" used={task.tokensUsed} max={task.budget.maxTokens} />
            <Meter name="Time" used={elapsedMin} max={task.budget.maxMinutes} unit=" min" />
            <Meter name="Replans" used={task.replans} max={task.budget.maxReplans} />
          </div>
          {(!isTerminal(task.status) || task.status === 'needs_attention') && (
            <fieldset className="extend">
              <legend className="muted small">Add time</legend>
              {[15, 30, 60].map((m) => (
                <button
                  key={m}
                  type="button"
                  className="ghost small"
                  onClick={() => void extend({ minutes: m })}
                >
                  +{m < 60 ? `${m} min` : '1 h'}
                </button>
              ))}
            </fieldset>
          )}
        </div>
        {task.status === 'needs_attention' && !stoppedByYou && (
          <section className="resume" aria-label="Continue the project">
            <p>
              <Icon name="alert" /> <b>Stopped:</b> {task.error ?? 'it needs your attention.'} Add
              budget to continue where it stopped; finished work is kept.
            </p>
            <div className="row-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void extend({ minutes: 30, tokens: 100_000, replans: 2 })}
              >
                <Icon name="play" size={14} /> Continue: +30 min, +100k tokens, +2 replans
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void extend({ minutes: 60, tokens: 200_000, replans: 3 })}
              >
                +1 h, +200k tokens, +3 replans
              </button>
            </div>
          </section>
        )}
        {task.error && task.status !== 'needs_attention' && (
          <p className="error" role="alert">
            {task.error}
          </p>
        )}
        {extendError && (
          <p className="error" role="alert">
            {extendError}
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
            {pending.map((a) =>
              a.tool === 'ask_user' ? (
                <QuestionCard
                  key={a.id}
                  id={a.id}
                  taskId={task.id}
                  who={`${(() => {
                    const st = task.steps.find((x) => x.id === a.stepId);
                    return (st?.agentId && agents.get(st.agentId)?.name) || 'An agent';
                  })()} · ${keys.get(a.stepId) ?? 'task'}`}
                  args={a.args}
                  onDone={reload}
                />
              ) : (
                <section key={a.id} className="approval" aria-label="Approval needed">
                  <div>
                    <p>
                      <Icon name="hand" /> <strong>{keys.get(a.stepId) ?? 'A task'}</strong> wants
                      to run <code>{a.tool}</code>
                    </p>
                    <pre className="args">{JSON.stringify(a.args, null, 2)}</pre>
                  </div>
                  <div className="approval-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void decide(a.id, true)}
                    >
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
              ),
            )}

            <TeamPanel
              task={task}
              agents={agents}
              now={now}
              onMessage={message}
              onOpenTask={setSelected}
            />

            <section className="card" aria-labelledby="tasks-title">
              <div className="card-head">
                <h2 id="tasks-title">Tasks</h2>
                <div className="segmented small-seg" role="tablist" aria-label="Task view">
                  {(['board', 'timeline'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={view === v}
                      className={view === v ? 'active' : ''}
                      onClick={() => setView(v)}
                    >
                      {v === 'board' ? 'Board' : 'Timeline'}
                    </button>
                  ))}
                </div>
              </div>
              {!steps.length ? (
                <p className="muted">
                  {isTerminal(task.status)
                    ? 'It stopped before the planner split the goal into tasks.'
                    : 'The planner is splitting the goal into tasks…'}
                </p>
              ) : view === 'board' ? (
                <TaskBoard steps={current} agents={agents} onOpen={setSelected} />
              ) : (
                <>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={showOld}
                      onChange={(e) => setShowOld(e.target.checked)}
                    />{' '}
                    show replaced tasks
                  </label>
                  <Gantt
                    steps={steps}
                    agents={agents}
                    finishedAt={task.finishedAt}
                    selected={selected}
                    onSelect={(s) => setSelected(s)}
                  />
                </>
              )}
              <p className="muted small">Click a task to see it, change it or run it again.</p>
            </section>
            {step && (
              <TaskDialog
                key={step.id}
                task={task}
                step={step}
                agents={agents}
                onClose={() => setSelected(null)}
                onMessage={message}
              />
            )}
          </div>

          <div className="panel-files stack">
            <Gallery
              taskId={task.id}
              version={task.steps.filter((s) => s.status === 'succeeded').length + events.length}
            />
            <section className="card">
              <h2>Files</h2>
              <p className="muted mono small">{task.workspacePath}</p>
              <Files
                taskId={task.id}
                version={task.steps.filter((s) => s.status === 'succeeded').length}
              />
            </section>
          </div>
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
