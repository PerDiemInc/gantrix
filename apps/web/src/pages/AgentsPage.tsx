import type { AgentDto, ConnectionDto, DefaultModelDto, SkillDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { AgentSetup } from '../components/AgentSetup.tsx';
import { AvatarPicker } from '../components/AvatarPicker.tsx';
import { Icon } from '../components/Icon.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';

/** How long one run of this agent's task may take before it is stopped and retried. */
function TimeLimit({ agent, onSaved }: { agent: AgentDto; onSaved: () => void }) {
  const [value, setValue] = useState(agent.stepTimeoutMinutes?.toString() ?? '');
  const [error, setError] = useState('');
  const saved = agent.stepTimeoutMinutes?.toString() ?? '';
  const save = async () => {
    if (value === saved) return;
    setError('');
    try {
      await api.patch(`/api/agents/${agent.id}`, {
        stepTimeoutMinutes: value ? Number(value) : null,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="agent-limit small">
      <label className="inline">
        Time limit per task
        <input
          type="number"
          min={1}
          max={1440}
          placeholder="none"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
        min
      </label>
      <span className="muted">
        {saved
          ? 'A task that runs longer is stopped and tried again. Shell commands may run this long.'
          : 'No limit. Shell commands stop after 2 minutes.'}
      </span>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
/** Which model an existing agent runs on: local Ollama by default, or any connection. */
function RunsOn({
  agent,
  connections,
  onSaved,
}: {
  agent: AgentDto;
  connections: ConnectionDto[];
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState({
    connectionId: agent.connectionId ?? '',
    model: agent.model ?? '',
  });
  const [error, setError] = useState('');
  const conn = connections.find((c) => c.id === agent.connectionId);
  const save = async () => {
    setError('');
    try {
      await api.patch(`/api/agents/${agent.id}`, {
        connectionId: value.connectionId || null,
        model: value.model || null,
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!editing) {
    return (
      <p className="runs-on small">
        <span className="muted">Runs on</span> <b>{agent.model ?? 'the default model'}</b>{' '}
        <span className="muted">
          ·{' '}
          {conn
            ? `${conn.name} (${conn.provider}${conn.isLocal ? ', local' : ', cloud'})`
            : 'local Ollama'}
        </span>{' '}
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            setValue({ connectionId: agent.connectionId ?? '', model: agent.model ?? '' });
            setEditing(true);
          }}
        >
          Change
        </button>
      </p>
    );
  }
  return (
    <div className="runs-on-edit">
      <ModelPicker connectionId={value.connectionId} model={value.model} onChange={setValue} />
      <div className="row-actions">
        <button type="button" className="primary small" onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="ghost small" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Edit an agent in place: its name, what it does, its instructions and its skills. */
function AgentEditor({
  agent,
  skills,
  onSaved,
}: {
  agent: AgentDto;
  skills: SkillDto[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    maxConcurrency: String(agent.maxConcurrency),
  });
  const [picked, setPicked] = useState(new Set(agent.skills.map((s) => s.id)));
  const [error, setError] = useState('');
  const start = () => {
    setForm({
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      maxConcurrency: String(agent.maxConcurrency),
    });
    setPicked(new Set(agent.skills.map((s) => s.id)));
    setError('');
    setOpen(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.patch(`/api/agents/${agent.id}`, {
        name: form.name,
        description: form.description,
        systemPrompt: form.systemPrompt,
        maxConcurrency: Number(form.maxConcurrency),
        skillIds: [...picked],
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!open) {
    return (
      <button type="button" className="ghost small" onClick={start}>
        Edit
      </button>
    );
  }
  return (
    <form className="runs-on-edit" onSubmit={(e) => void save(e)}>
      <label>
        Name
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          pattern="[a-z0-9][a-z0-9-]*"
          required
        />
      </label>
      <label>
        What it does <span className="muted small">(the planner reads this)</span>
        <textarea
          rows={3}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </label>
      <label>
        Extra instructions <span className="muted small">(system prompt)</span>
        <textarea
          rows={4}
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
      </label>
      <label>
        Steps at a time
        <input
          type="number"
          min={1}
          max={16}
          value={form.maxConcurrency}
          onChange={(e) => setForm({ ...form, maxConcurrency: e.target.value })}
        />
      </label>
      <fieldset className="chips">
        <legend className="muted small">Skills</legend>
        {skills.map((s) => (
          <label key={s.id} className="chip">
            <input
              type="checkbox"
              checked={picked.has(s.id)}
              onChange={() => {
                const next = new Set(picked);
                if (next.has(s.id)) next.delete(s.id);
                else next.add(s.id);
                setPicked(next);
              }}
            />{' '}
            {s.name}
          </label>
        ))}
      </fieldset>
      <div className="row-actions">
        <button type="submit" className="primary small">
          Save
        </button>
        <button type="button" className="ghost small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** Chat with an agent in Slack: needs a Slack connection with bot and app tokens. */
function SlackChat({
  agent,
  connections,
  onSaved,
}: {
  agent: AgentDto;
  connections: ConnectionDto[];
  onSaved: () => void;
}) {
  const slack = connections.filter((c) => c.provider === 'slack');
  const current = slack.find((c) => c.id === agent.slackConnectionId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(agent.slackConnectionId ?? '');
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    try {
      await api.patch(`/api/agents/${agent.id}`, { slackConnectionId: value || null });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!editing) {
    return (
      <p className="runs-on small">
        <span className="muted">Slack</span> <b>{current ? `chat via ${current.name}` : 'off'}</b>{' '}
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            setValue(agent.slackConnectionId ?? '');
            setEditing(true);
          }}
        >
          {current ? 'Change' : 'Set up'}
        </button>
      </p>
    );
  }
  return (
    <div className="runs-on-edit">
      <label>
        Slack connection
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Off: not in Slack</option>
          {slack.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        The agent replies when an allowed person DMs the bot or mentions it:{' '}
        <code>@Gantrix {agent.name}: …</code>. Ask it for its status and it summarizes what it is
        working on. It needs a Slack connection with a bot token, an app-level token and allowed
        user IDs. {slack.length === 0 && <a href="#/connect/slack">Connect Slack first.</a>}
      </p>
      <div className="row-actions">
        <button type="button" className="primary small" onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="ghost small" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The model that plans, judges and runs every agent that has none of its own. Chosen here and
 * kept in the database, so the API and the worker always agree and no restart is needed.
 */
function DefaultModel() {
  const [saved, setSaved] = useState<DefaultModelDto | null>(null);
  const [value, setValue] = useState({ connectionId: '', model: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const adopt = (d: DefaultModelDto) => {
    setSaved(d);
    setValue({ connectionId: d.connectionId ?? '', model: d.model ?? '' });
  };
  useEffect(() => {
    api.get<DefaultModelDto>('/api/settings/default-model').then(
      (d) => {
        setSaved(d);
        setValue({ connectionId: d.connectionId ?? '', model: d.model ?? '' });
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const dirty =
    saved !== null &&
    (value.connectionId !== (saved.connectionId ?? '') || value.model !== (saved.model ?? ''));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOk(false);
    try {
      adopt(
        await api.put<DefaultModelDto>('/api/settings/default-model', {
          connectionId: value.connectionId || null,
          model: value.model.trim() || null,
        }),
      );
      setOk(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <form className="card default-model" onSubmit={(e) => void save(e)}>
      <h2>Default model</h2>
      <p className="muted small">
        The model that plans projects, judges every task, and runs each agent that has none of its
        own. A change applies to the next task; there is nothing to restart.
      </p>
      {saved && (
        <p className="small" aria-live="polite">
          Now: <b className="mono">{saved.effective.model}</b>{' '}
          {saved.effective.connection ? `on ${saved.effective.connection}` : 'on the local Ollama'}{' '}
          <span
            className={`pill ${saved.effective.isLocal ? 's-succeeded' : 's-awaiting_approval'}`}
          >
            {saved.effective.isLocal ? 'local' : 'cloud'}
          </span>
        </p>
      )}
      <ModelPicker
        connectionId={value.connectionId}
        model={value.model}
        onChange={(v) => {
          setValue(v);
          setOk(false);
        }}
        emptyLabel={`Built-in (${saved?.builtIn ?? 'qwen3:8b'})`}
        modelServersOnly
      />
      <div className="row-actions">
        <button type="submit" className="primary" disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save default model'}
        </button>
        {ok && !dirty && (
          <span className="ok-note small" role="status">
            <Icon name="check" size={14} /> Saved
          </span>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const load = () => {
    api.get<AgentDto[]>('/api/agents').then(setAgents);
    api.get<SkillDto[]>('/api/skills').then(setSkills);
    api.get<ConnectionDto[]>('/api/connections').then(setConnections);
  };
  useEffect(load, []);

  const remove = async (agent: AgentDto) => {
    if (!confirm(`Remove agent "${agent.name}"? Its unfinished steps will be replanned.`)) return;
    await api.del(`/api/agents/${agent.id}`);
    load();
  };
  return (
    <div className="stack">
      <DefaultModel />
      <section className="card">
        <h2>Agents</h2>
        {!agents.length && (
          <p className="muted">
            No agents yet. The planner assigns each step to one of them. A first run adds a starter
            team you can edit here, or press <b>New</b> and choose <b>Agent</b>.
          </p>
        )}
        <ul className="cards">
          {agents.map((a) => (
            <li key={a.id} className="item">
              <div className="item-head">
                <AvatarPicker agent={a} onSaved={load} />
                <strong>{a.name}</strong>
                <span className="muted small">{a.maxConcurrency} at a time</span>
                <AgentEditor
                  key={`${a.id}-${a.updatedAt}`}
                  agent={a}
                  skills={skills}
                  onSaved={load}
                />
                <button type="button" className="ghost danger small" onClick={() => void remove(a)}>
                  Remove
                </button>
              </div>
              <AgentSetup key={`setup-${a.id}`} agent={a} onSaved={load} />
              <RunsOn agent={a} connections={connections} onSaved={load} />
              <TimeLimit agent={a} onSaved={load} />
              <SlackChat agent={a} connections={connections} onSaved={load} />
              <p>
                {a.description || (
                  <span className="muted">
                    No description: the planner reads this to pick agents.
                  </span>
                )}
              </p>
              <div className="chips">
                {a.skills.length ? (
                  a.skills.map((s) => (
                    <span key={s.id} className="chip">
                      {s.name}
                    </span>
                  ))
                ) : (
                  <span className="muted small">no skills</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
