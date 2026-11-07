import { EXAMPLES, isTerminal, type TaskDto, type TaskListItem } from '@gantrix/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { Avatar, nowText, StatusPill, TaskProgress } from '../components/ui.tsx';
import { ago, duration, label } from '../format.ts';
import { go, useAgents, useLive } from '../hooks.ts';

function NewProject({ onClose }: { onClose: () => void }) {
  const [goal, setGoal] = useState('');
  const [minutes, setMinutes] = useState('');
  // Approvals are off by default; "Ask first" turns them on for this project.
  const [askFirst, setAskFirst] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const agents = useAgents();
  // Empty = every agent may work on the project.
  const [team, setTeam] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setTeam((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const task = await api.post<TaskDto>('/api/tasks', {
        goal,
        budget: minutes ? { maxMinutes: Number(minutes) } : {},
        approveAll: !askFirst,
        ...(team.size ? { agentIds: [...team] } : {}),
      });
      go(`/projects/${task.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="card new-project" onSubmit={(e) => void submit(e)}>
      <div className="card-head">
        <h2>New project</h2>
        <button type="button" className="ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="examples">
        <span className="muted small">Try an example:</span>
        {Object.entries(EXAMPLES).map(([key, ex]) => (
          <button
            key={key}
            type="button"
            className="chip"
            onClick={() => {
              setGoal(ex.goal);
              setMinutes(String(ex.maxMinutes));
              setTeam(
                new Set(
                  [...agents.values()].filter((a) => ex.agents.includes(a.name)).map((a) => a.id),
                ),
              );
            }}
            title={`Needs the ${ex.agents.join(', ')} agents (gantrix team add)`}
          >
            {ex.title}
          </button>
        ))}
      </div>
      <label>
        Goal
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Plan the v2 launch: a PRD, a build estimate, a launch post and a deck"
          rows={3}
          required
          // biome-ignore lint/a11y/noAutofocus: the form opens because the user asked for it
          autoFocus
        />
        <span className="muted small">
          The planner splits it into tasks and gives each one to the agent that fits.
        </span>
      </label>
      <fieldset className="team-picker">
        <legend>
          Agents <span className="muted small">({team.size ? `${team.size} chosen` : 'all'})</span>
        </legend>
        <div className="team-options">
          {[...agents.values()].map((a) => (
            <label
              key={a.id}
              className={`agent-option${team.has(a.id) ? ' on' : ''}`}
              title={a.description}
            >
              <input
                type="checkbox"
                checked={team.has(a.id)}
                onChange={() => toggle(a.id)}
                className="sr-only"
              />
              <Avatar name={a.name} avatar={a.avatar} size={28} />
              {a.name}
            </label>
          ))}
        </div>
        <span className="muted small">
          Pick the agents the planner may use. None picked means all of them.
        </span>
      </fieldset>
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
        <label className="inline switch" title="Shell, web, MCP and email tools wait for your OK">
          <input
            type="checkbox"
            role="switch"
            aria-checked={askFirst}
            checked={askFirst}
            onChange={(e) => setAskFirst(e.target.checked)}
          />
          <Icon name="hand" />
          Ask me before risky tools
        </label>
        <button type="submit" className="primary" disabled={busy || !goal.trim()}>
          {busy ? 'Starting…' : 'Start project'}
        </button>
      </div>
      <p className="muted small" role="note">
        {askFirst
          ? 'Shell commands, web requests, MCP tools and emails wait for your approval on this project.'
          : 'Agents run every tool without asking, including shell commands (not sandboxed) and emails. Turn on "Ask me" to approve them one by one.'}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function ProjectCard({
  p,
  agents,
}: {
  p: TaskListItem;
  agents: Map<string, { name: string; avatar?: string | null }>;
}) {
  const name = (agentId: string | null) => (agentId && agents.get(agentId)?.name) || 'agent';
  const stepAgent = new Map(p.active.map((s) => [s.id, name(s.agentId)]));
  const live = !isTerminal(p.status);
  const end = p.finishedAt ? Date.parse(p.finishedAt) : Date.now();
  const working = p.active.filter((s) => s.status !== 'queued');
  const queued = p.active.filter((s) => s.status === 'queued');
  return (
    <li className={`project${p.pendingApprovals ? ' needs-you' : ''}`}>
      <a className="project-link" href={`#/projects/${p.id}`}>
        <div className="project-head">
          <StatusPill status={p.status} />
          {!p.approveAll && (
            <span className="pill ask" title="Risky tool calls wait for your approval">
              <Icon name="hand" size={12} />
              asks first
            </span>
          )}
          <span className="muted small push">{ago(p.createdAt)}</span>
        </div>
        <h3 className="project-goal" title={p.goal}>
          {p.goal}
        </h3>
        <TaskProgress counts={p.stepCounts} />
        {p.team.length > 0 && (
          <ul className="team" aria-label="Agents on this project">
            {p.team.map((t) => (
              <li key={t.agentId}>
                <Avatar
                  name={name(t.agentId)}
                  avatar={agents.get(t.agentId)?.avatar}
                  state={t.state}
                  size={28}
                />
              </li>
            ))}
          </ul>
        )}
        <div className="now" aria-live="off">
          <span className="now-label">{live ? 'Now' : 'Last'}</span>
          {working.length ? (
            <ul>
              {working.slice(0, 3).map((s) => (
                <li key={s.id}>
                  <b>{name(s.agentId)}</b>{' '}
                  {s.status === 'awaiting_approval' ? 'waits for you on' : label(s.status)}{' '}
                  <span className="mono">{s.key}</span>
                </li>
              ))}
              {working.length > 3 && <li className="muted">and {working.length - 3} more</li>}
            </ul>
          ) : queued.length ? (
            <p>
              Up next: <b>{name(queued[0]?.agentId ?? null)}</b> on{' '}
              <span className="mono">{queued[0]?.key}</span>
              {queued.length > 1 ? ` and ${queued.length - 1} more` : ''}
            </p>
          ) : (
            <p>{nowText(p.lastEvent, (id) => stepAgent.get(id) ?? 'An agent')}</p>
          )}
        </div>
        <div className="project-foot muted small">
          <span>
            <Icon name="clock" size={12} /> {duration(end - Date.parse(p.startedAt ?? p.createdAt))}
          </span>
          <span className="num">{p.tokensUsed.toLocaleString()} tokens</span>
        </div>
      </a>
      {p.pendingApprovals > 0 && (
        <a className="needs-you-bar" href={`#/projects/${p.id}`}>
          <Icon name="hand" size={14} />
          {p.pendingApprovals === 1
            ? 'An agent is waiting for you'
            : `${p.pendingApprovals} questions or approvals wait for you`}
        </a>
      )}
    </li>
  );
}

type Filter = 'all' | 'active' | 'you' | 'done';

export function ProjectsPage() {
  const { data, error } = useLive(
    () => api.get<TaskListItem[]>('/api/tasks?limit=100'),
    '/api/stream',
    [],
  );
  const agents = useAgents();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const all = data ?? [];
  const active = all.filter((p) => !isTerminal(p.status));
  const you = all.filter((p) => p.pendingApprovals > 0 || p.status === 'needs_attention');
  const done = all.filter((p) => isTerminal(p.status));
  const shown = { all, active, you, done }[filter];
  const tabs: [Filter, string, number][] = [
    ['all', 'All', all.length],
    ['active', 'Running', active.length],
    ['you', 'Needs you', you.length],
    ['done', 'Finished', done.length],
  ];

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">
            Each project is a goal your agents work on together. Open one to follow it and steer it.
          </p>
        </div>
        {!creating && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New project
          </button>
        )}
      </header>

      {creating && <NewProject onClose={() => setCreating(false)} />}

      <div className="segmented" role="tablist" aria-label="Filter projects">
        {tabs.map(([key, text, n]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={filter === key ? 'active' : ''}
            onClick={() => setFilter(key)}
          >
            {text} <span className="count num">{n}</span>
          </button>
        ))}
      </div>

      {error && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
      {!data && !error && (
        <ul className="projects" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="project skeleton" />
          ))}
        </ul>
      )}
      {data && !all.length && (
        <section className="card empty">
          <img src="/gant.svg" alt="" width="96" height="78" />
          <h2>No projects yet</h2>
          <p className="muted">
            Add agents with skills, or run <code>npm run gantrix -- team add</code> for a ready-made
            team. Then start your first project.
          </p>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New project
          </button>
        </section>
      )}
      {data && all.length > 0 && !shown.length && <p className="muted">Nothing here right now.</p>}
      {shown.length > 0 && (
        <ul className="projects">
          {shown.map((p) => (
            <ProjectCard key={p.id} p={p} agents={agents} />
          ))}
        </ul>
      )}
    </div>
  );
}
