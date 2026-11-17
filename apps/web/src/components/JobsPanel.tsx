import type { AgentDto, JobDto } from '@gantrix/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../api.ts';
import { ago, label } from '../format.ts';
import { go, useAgents, useLive } from '../hooks.ts';
import { Icon } from './Icon.tsx';

const PRESETS: [string, string][] = [
  ['Only when I press Run', ''],
  ['Every day at 09:00', '0 9 * * *'],
  ['Weekdays at 09:00', '0 9 * * 1-5'],
  ['Every hour', '0 * * * *'],
  ['Every Monday at 09:00', '0 9 * * 1'],
];
const CUSTOM = 'custom';
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

interface StepForm {
  key: number;
  title: string;
  agentId: string;
  instructions: string;
  acceptance: string;
}
let nextKey = 1;
const blankStep = (agentId = ''): StepForm => ({
  key: nextKey++,
  title: '',
  agentId,
  instructions: '',
  acceptance: '',
});

const presetFor = (schedule: string | null) =>
  PRESETS.some(([, cron]) => cron === (schedule ?? '')) ? (schedule ?? '') : CUSTOM;

function scheduleText(job: JobDto) {
  if (!job.schedule) return 'Runs when you press Run';
  const preset = PRESETS.find(([, cron]) => cron === job.schedule);
  return `${preset ? preset[0] : `cron ${job.schedule}`} (${job.timezone})`;
}

function JobForm({
  editing,
  agents,
  onClose,
  onSaved,
}: {
  editing: JobDto | null;
  agents: AgentDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [goal, setGoal] = useState(editing?.goal ?? '');
  const [preset, setPreset] = useState(editing ? presetFor(editing.schedule) : '0 9 * * *');
  const [cron, setCron] = useState(editing?.schedule ?? '');
  const [timezone, setTimezone] = useState(editing?.timezone ?? localZone());
  const [slack, setSlack] = useState(editing?.slack ?? false);
  const [steps, setSteps] = useState<StepForm[]>(
    editing
      ? editing.steps.map((s) => ({ ...s, key: nextKey++ }))
      : [blankStep(agents[0]?.id ?? '')],
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const patch = (key: number, change: Partial<StepForm>) =>
    setSteps(steps.map((s) => (s.key === key ? { ...s, ...change } : s)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(index + by, 0, item);
    setSteps(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const schedule = (preset === CUSTOM ? cron : preset).trim() || null;
    const body = {
      name,
      description: description.trim() || null,
      goal,
      schedule,
      timezone,
      slack,
      steps: steps.map(({ title, agentId, instructions, acceptance }) => ({
        title,
        agentId,
        instructions,
        acceptance,
      })),
    };
    try {
      if (editing) await api.patch(`/api/jobs/${editing.id}`, body);
      else await api.post('/api/jobs', body);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card new-project" onSubmit={(e) => void submit(e)}>
      <div className="card-head">
        <h2>{editing ? `Edit ${editing.name}` : 'New job'}</h2>
        <button type="button" className="ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted small">
        A job is a saved list of steps. Each step is done by one agent (using that agent's skills),
        one after the other. Every run shows up as a project.
      </p>
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily pull request scan"
          required
        />
      </label>
      <label>
        Description <span className="muted small">(optional)</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Goal <span className="muted small">(what a finished run looks like)</span>
        <textarea
          rows={2}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="A summary of every open PR with unanswered review comments is posted."
          required
        />
      </label>

      <fieldset className="header-rows">
        <legend>Steps, in order</legend>
        {steps.map((s, i) => {
          const agent = agents.find((a) => a.id === s.agentId);
          return (
            <div key={s.key} className="item">
              <div className="item-head">
                <strong>Step {i + 1}</strong>
                <button
                  type="button"
                  className="ghost small"
                  disabled={i === 0}
                  aria-label={`Move step ${i + 1} up`}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={i === steps.length - 1}
                  aria-label={`Move step ${i + 1} down`}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ghost small danger"
                  disabled={steps.length === 1}
                  aria-label={`Remove step ${i + 1}`}
                  onClick={() => setSteps(steps.filter((x) => x.key !== s.key))}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              <label>
                Title
                <input
                  value={s.title}
                  onChange={(e) => patch(s.key, { title: e.target.value })}
                  placeholder="Fetch open pull requests"
                  required
                />
              </label>
              <label>
                Agent
                <select
                  value={s.agentId}
                  onChange={(e) => patch(s.key, { agentId: e.target.value })}
                  required
                >
                  <option value="" disabled>
                    Choose an agent
                  </option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {agent && (
                  <span className="muted small">
                    Skills:{' '}
                    {agent.skills.length ? agent.skills.map((k) => k.name).join(', ') : 'none'}
                  </span>
                )}
              </label>
              <label>
                What to do
                <textarea
                  rows={3}
                  value={s.instructions}
                  onChange={(e) => patch(s.key, { instructions: e.target.value })}
                  required
                />
              </label>
              <label>
                How we know it worked <span className="muted small">(optional)</span>
                <input
                  value={s.acceptance}
                  onChange={(e) => patch(s.key, { acceptance: e.target.value })}
                  placeholder="prs.md lists every open PR"
                />
              </label>
            </div>
          );
        })}
        <button
          type="button"
          className="ghost small"
          onClick={() =>
            setSteps([...steps, blankStep(steps.at(-1)?.agentId ?? agents[0]?.id ?? '')])
          }
        >
          <Icon name="plus" size={14} /> Add step
        </button>
      </fieldset>

      <div className="row-actions">
        <label className="grow">
          Schedule
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {PRESETS.map(([text, value]) => (
              <option key={text} value={value}>
                {text}
              </option>
            ))}
            <option value={CUSTOM}>Custom cron…</option>
          </select>
        </label>
        {preset === CUSTOM && (
          <label className="grow">
            Cron
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="30 8 * * 1-5"
              spellCheck={false}
              required
            />
          </label>
        )}
        <label className="grow">
          Time zone
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={slack} onChange={(e) => setSlack(e.target.checked)} /> Post
        each run's progress to Slack
      </label>

      {agents.length === 0 && (
        <p className="error small">Add an agent first (Agents page); every step needs one.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy || agents.length === 0}>
        {editing ? 'Save job' : 'Create job'}
      </button>
    </form>
  );
}

export function JobsPanel({ creating, onClose }: { creating: boolean; onClose: () => void }) {
  const { data, reload } = useLive(() => api.get<JobDto[]>('/api/jobs'), '/api/stream', []);
  const agentMap = useAgents();
  const agents = [...agentMap.values()];
  const [editing, setEditing] = useState<JobDto | null>(null);
  const [message, setMessage] = useState('');
  const jobs = data ?? [];

  const act = async (job: JobDto, what: 'run' | 'toggle' | 'delete') => {
    setMessage('');
    try {
      if (what === 'run') {
        const { taskId } = await api.post<{ taskId: string }>(`/api/jobs/${job.id}/run`);
        go(`#/projects/${taskId}`);
        return;
      }
      if (what === 'toggle') await api.patch(`/api/jobs/${job.id}`, { enabled: !job.enabled });
      else if (confirm(`Delete job "${job.name}"? Its past runs stay as projects.`)) {
        await api.del(`/api/jobs/${job.id}`);
      }
      reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  if (!creating && !editing && jobs.length === 0) {
    return (
      <section className="card empty">
        <h2>No jobs yet</h2>
        <p className="muted">
          A job is a saved list of steps, run on demand or on a schedule. Press <b>+ New Job</b>.
        </p>
      </section>
    );
  }
  return (
    <section className="stack" aria-label="Jobs">
      {(creating || editing) && (
        <JobForm
          key={editing?.id ?? 'new'}
          editing={editing}
          agents={agents}
          onClose={() => {
            setEditing(null);
            onClose();
          }}
          onSaved={reload}
        />
      )}
      {jobs.length > 0 && (
        <div className="card">
          <h2>Jobs</h2>
          {message && (
            <p className="error small" role="alert">
              {message}
            </p>
          )}
          <ul className="cards">
            {jobs.map((job) => (
              <li key={job.id} className="item">
                <div className="item-head">
                  <strong>{job.name}</strong>
                  <span className={`pill ${job.enabled ? 's-succeeded' : 's-pending'}`}>
                    {job.schedule ? (job.enabled ? 'scheduled' : 'paused') : 'manual'}
                  </span>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => void act(job, 'run')}
                  >
                    <Icon name="play" size={14} /> Run now
                  </button>
                  {job.schedule && (
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => void act(job, 'toggle')}
                    >
                      <Icon name={job.enabled ? 'pause' : 'play'} size={14} />{' '}
                      {job.enabled ? 'Pause' : 'Play'}
                    </button>
                  )}
                  <button type="button" className="ghost small" onClick={() => setEditing(job)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost danger small"
                    onClick={() => void act(job, 'delete')}
                  >
                    Delete
                  </button>
                </div>
                <p className="muted small">
                  {scheduleText(job)}
                  {job.nextRunAt && ` · next ${new Date(job.nextRunAt).toLocaleString()}`}
                </p>
                <p className="small">
                  {job.steps.map((s, i) => `${i + 1}. ${s.title}`).join('  →  ')}
                </p>
                {job.lastRun && (
                  <p className="muted small">
                    Last run{' '}
                    <a href={`#/projects/${job.lastRun.id}`}>
                      {label(job.lastRun.status)}, {ago(job.lastRun.createdAt)}
                    </a>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
