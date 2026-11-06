import type { AgentDto, SkillDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';

const empty = { name: '', description: '', model: '', maxConcurrency: '1', systemPrompt: '' };

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [form, setForm] = useState(empty);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const load = () => {
    api.get<AgentDto[]>('/api/agents').then(setAgents);
    api.get<SkillDto[]>('/api/skills').then(setSkills);
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
          <p className="muted">No agents yet. The planner assigns each step to one of them.</p>
        )}
        <ul className="cards">
          {agents.map((a) => (
            <li key={a.id} className="item">
              <div className="item-head">
                <strong>{a.name}</strong>
                <span className="muted mono small">
                  {a.model ?? 'default model'} · {a.maxConcurrency} at a time
                </span>
                <button type="button" className="ghost danger small" onClick={() => void remove(a)}>
                  Remove
                </button>
              </div>
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
        <label>
          Model <span className="muted small">(blank = default)</span>
          <input value={form.model} onChange={set('model')} placeholder="qwen3:8b" />
        </label>
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
              {s.name} <span className="muted small">{s.manifest.tools.join(', ')}</span>
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
