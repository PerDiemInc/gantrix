import type { AgentDto, SkillDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ModelPicker } from './ModelPicker.tsx';

const empty = {
  name: '',
  description: '',
  model: '',
  connectionId: '',
  maxConcurrency: '1',
  stepTimeoutMinutes: '',
  systemPrompt: '',
};

/** The form for a new agent: name, model, limits and skills. */
export function AgentForm({
  onCreated,
  onCancel,
}: {
  onCreated: (agent: AgentDto) => void;
  onCancel?: () => void;
}) {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [form, setForm] = useState(empty);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<SkillDto[]>('/api/skills').then(setSkills, () => setSkills([]));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const agent = await api.post<AgentDto>('/api/agents', {
        name: form.name,
        description: form.description,
        systemPrompt: form.systemPrompt,
        maxConcurrency: Number(form.maxConcurrency),
        ...(form.stepTimeoutMinutes ? { stepTimeoutMinutes: Number(form.stepTimeoutMinutes) } : {}),
        skillIds: [...picked],
        ...(form.model ? { model: form.model } : {}),
        ...(form.connectionId ? { connectionId: form.connectionId } : {}),
      });
      onCreated(agent);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
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
    <form className="card new-project" onSubmit={(e) => void create(e)}>
      <div className="card-head">
        <h2>New agent</h2>
        {onCancel && (
          <button type="button" className="ghost small" onClick={onCancel}>
            Close
          </button>
        )}
      </div>
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
      <label>
        Time limit per task, in minutes (empty = none)
        <input
          type="number"
          min={1}
          max={1440}
          value={form.stepTimeoutMinutes}
          onChange={set('stepTimeoutMinutes')}
          placeholder="e.g. 30 for an agent that runs terraform apply"
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
      <button type="submit" className="primary" disabled={busy || !form.name}>
        {busy ? 'Adding…' : 'Add agent'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
