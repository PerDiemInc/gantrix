import type { AgentDto, ConnectionDto, SkillDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { AvatarPicker } from '../components/AvatarPicker.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';

const empty = {
  name: '',
  description: '',
  model: '',
  connectionId: '',
  maxConcurrency: '1',
  systemPrompt: '',
};
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
        <code>@Gantrix {agent.name}: …</code>. It needs a Slack connection with a bot token, an
        app-level token and allowed user IDs.{' '}
        {slack.length === 0 && <a href="#/connections">Add a Slack connection first.</a>}
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

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [form, setForm] = useState(empty);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const load = () => {
    api.get<AgentDto[]>('/api/agents').then(setAgents);
    api.get<SkillDto[]>('/api/skills').then(setSkills);
    api.get<ConnectionDto[]>('/api/connections').then(setConnections);
  };
  useEffect(load, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/agents', {
        name: form.name,
        description: form.description,
        systemPrompt: form.systemPrompt,
        maxConcurrency: Number(form.maxConcurrency),
        skillIds: [...picked],
        ...(form.model ? { model: form.model } : {}),
        ...(form.connectionId ? { connectionId: form.connectionId } : {}),
      });
      setForm(empty);
      setPicked(new Set());
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (agent: AgentDto) => {
    if (!confirm(`Remove agent "${agent.name}"? Its unfinished steps will be replanned.`)) return;
    await api.del(`/api/agents/${agent.id}`);
    load();
  };
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const set = (key: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <div className="columns wide-left">
      <section className="card">
        <h2>Agents</h2>
        {!agents.length && (
          <p className="muted">
            No agents yet. The planner assigns each step to one of them. A first run adds a starter
            team you can edit here.
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
              <RunsOn agent={a} connections={connections} onSaved={load} />
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
      <form className="card" onSubmit={(e) => void create(e)}>
        <h2>Add agent</h2>
        <label>
          Name
          <input
            value={form.name}
            onChange={set('name')}
            placeholder="researcher"
            pattern="[a-z0-9][a-z0-9-]*"
            required
          />
        </label>
        <label>
          What it's good at
          <input
            value={form.description}
            onChange={set('description')}
            placeholder="Finds sources and writes notes"
          />
        </label>
        <ModelPicker
          connectionId={form.connectionId}
          model={form.model}
          onChange={(v) => setForm({ ...form, ...v })}
        />
        <label>
          Steps at a time
          <input
            type="number"
            min={1}
            max={16}
            value={form.maxConcurrency}
            onChange={set('maxConcurrency')}
          />
        </label>
        <fieldset>
          <legend>Skills</legend>
          {!skills.length && <p className="muted small">Install skills first.</p>}
          {skills.map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
              {s.name}{' '}
              <span className="muted small">
                {s.version} · {s.manifest.tools.join(', ')}
              </span>
            </label>
          ))}
        </fieldset>
        <label>
          Extra instructions <span className="muted small">(optional)</span>
          <textarea rows={3} value={form.systemPrompt} onChange={set('systemPrompt')} />
        </label>
        <button type="submit" className="primary">
          Add agent
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
