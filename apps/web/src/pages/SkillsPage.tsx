import type { SkillDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const load = () => void api.get<SkillDto[]>('/api/skills').then(setSkills);
  useEffect(load, []);

  const install = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/skills', { path });
      setPath('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (skill: SkillDto) => {
    if (!confirm(`Remove skill "${skill.name}" ${skill.version}?`)) return;
    try {
      await api.del(`/api/skills/${skill.id}`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="stack">
      <form className="card" onSubmit={(e) => void install(e)}>
        <h2>Install a skill</h2>
        <p className="muted small">
          A skill is a folder with a SKILL.md. Gantrix copies it and records a checksum, so later
          edits to your folder don't change what runs. Bump the version to update it.
        </p>
        <div className="row-actions">
          <input
            className="grow mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/skills/web-researcher"
            required
          />
          <button type="submit" className="primary">
            Install
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
      <section className="card">
        <h2>Skills</h2>
        {!skills.length && <p className="muted">No skills installed.</p>}
        <ul className="cards">
          {skills.map((s) => (
            <li key={s.id} className="item">
              <div className="item-head">
                <strong>{s.name}</strong>
                <span className="muted mono small">v{s.version}</span>
                <button type="button" className="ghost danger small" onClick={() => void remove(s)}>
                  Remove
                </button>
              </div>
              <p>{s.description}</p>
              <div className="chips">
                {s.manifest.tools.map((t) => (
                  <span key={t} className={`chip ${t === 'shell' ? 'warn' : ''}`}>
                    {t}
                  </span>
                ))}
                {Object.keys(s.manifest.mcpServers).map((m) => (
                  <span key={m} className="chip mcp">
                    MCP: {m}
                  </span>
                ))}
              </div>
              {s.manifest.autoApprove.length > 0 && (
                <p className="muted small">
                  Runs without asking: {s.manifest.autoApprove.join(', ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
