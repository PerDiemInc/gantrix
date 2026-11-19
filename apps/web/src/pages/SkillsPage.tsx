import type { SkillDto, SkillLookupDto, SkillPreviewDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { bytes } from '../format.ts';

type Source = 'web' | 'folder';

/** Where a skill came from, as a short label: "github.com/acme/skills/pdf @ a1b2c3d". */
export const sourceLabel = (s: Pick<SkillDto, 'sourceUrl' | 'sourceRef'>): string | null => {
  if (!s.sourceUrl) return null;
  const short = s.sourceUrl
    .replace(/^https:\/\//, '')
    .replace(/\/tree\/[0-9a-f]{40}/, '')
    .replace(/\/$/, '');
  return `${short}${s.sourceRef ? ` @ ${s.sourceRef.slice(0, 7)}` : ''}`;
};

/** What the skill can do on this machine, then what it says, so the yes is an informed one. */
function Review({
  skill,
  busy,
  error,
  onInstall,
  onCancel,
}: {
  skill: SkillPreviewDto;
  busy: boolean;
  error: string;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const cautions = skill.warnings.filter((w) => w.level === 'caution').length;
  return (
    <section className="skill-review" aria-label={`Review ${skill.name}`}>
      <div className="item-head">
        <strong>{skill.name}</strong>
        <span className="muted mono small">v{skill.version}</span>
        {cautions > 0 && (
          <span className="pill s-awaiting_approval">
            <Icon name="alert" size={12} /> {cautions} to check
          </span>
        )}
      </div>
      <p>{skill.description}</p>
      <p className="muted small">
        From{' '}
        <a href={skill.sourceUrl} target="_blank" rel="noopener noreferrer">
          {skill.source}
        </a>
        {skill.commit && (
          <>
            {' '}
            at commit <code>{skill.commit.slice(0, 7)}</code> (it stays on this version)
          </>
        )}
        .
      </p>

      <h3>What it can do on this machine</h3>
      <ul className="skill-warnings">
        {skill.warnings.map((w) => (
          <li key={w.text} className={w.level}>
            <Icon name={w.level === 'caution' ? 'alert' : 'dot'} size={14} /> {w.text}
          </li>
        ))}
      </ul>

      <details>
        <summary>Instructions the agent will follow</summary>
        <pre className="output">{skill.instructions || '(none)'}</pre>
      </details>
      <details>
        <summary>
          {skill.files.length} file{skill.files.length === 1 ? '' : 's'}, {bytes(skill.totalBytes)}
        </summary>
        <ul className="skill-files mono small">
          {skill.files.map((f) => (
            <li key={f.path}>
              {f.path} <span className="muted">{bytes(f.size)}</span>
            </li>
          ))}
        </ul>
      </details>

      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I
        have read what this skill can do and want to install it.
      </label>
      <div className="row-actions">
        <button type="button" className="primary" disabled={!agreed || busy} onClick={onInstall}>
          {busy ? 'Installing…' : `Install ${skill.name}`}
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="muted small">Nothing has been installed or run yet.</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Paste a link, see what it is, then decide. Nothing is installed until the yes. */
function WebInstall({ onInstalled }: { onInstalled: (skill: SkillDto) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<SkillLookupDto | null>(null);
  const [error, setError] = useState('');
  const [installError, setInstallError] = useState('');
  const [done, setDone] = useState<SkillDto | null>(null);

  const look = async (link: string) => {
    setBusy(true);
    setError('');
    setInstallError('');
    setDone(null);
    setFound(null);
    try {
      setFound(await api.post<SkillLookupDto>('/api/skills/lookup', { url: link }));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void look(url.trim());
  };
  const install = async (skill: SkillPreviewDto) => {
    setBusy(true);
    setInstallError('');
    try {
      const installed = await api.post<SkillDto>('/api/skills/install-online', {
        previewId: skill.id,
        checksum: skill.checksum,
      });
      setDone(installed);
      setFound(null);
      setUrl('');
      onInstalled(installed);
    } catch (err) {
      setInstallError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <>
      <p className="muted small">
        Paste a GitHub link to a skill, a folder of skills, or a repository, or a direct link to a{' '}
        <code>SKILL.md</code>. You see what it can do before anything is installed, and GitHub
        skills are pinned to the version you reviewed.
      </p>
      <form className="row-actions" onSubmit={submit}>
        <label className="sr-only" htmlFor="skill-url">
          Link to a skill
        </label>
        <input
          id="skill-url"
          className="grow mono"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
          spellCheck={false}
          required
        />
        <button type="submit" className="primary" disabled={busy || !url.trim()}>
          {busy && !found ? 'Looking…' : 'Review'}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="ok-note" role="status">
          <Icon name="check" size={14} /> Installed <b>{done.name}</b> {done.version}. Give it to an
          agent on the <a href="#/agents">Agents page</a>.
        </p>
      )}
      {found?.kind === 'choices' && (
        <section aria-label="Skills in this place">
          <h3>
            {found.choices.length} skill{found.choices.length === 1 ? '' : 's'} in {found.source}
          </h3>
          <ul className="cards">
            {found.choices.map((c) => (
              <li key={c.path} className="item">
                <div className="item-head">
                  <strong>{c.name}</strong>
                  <span className="muted mono small">{c.path}</span>
                  <button
                    type="button"
                    className="ghost small push"
                    disabled={busy}
                    onClick={() => {
                      setUrl(c.url);
                      void look(c.url);
                    }}
                  >
                    Review
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {found?.kind === 'skill' && (
        <Review
          skill={found}
          busy={busy}
          error={installError}
          onInstall={() => void install(found)}
          onCancel={() => setFound(null)}
        />
      )}
    </>
  );
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [source, setSource] = useState<Source>('web');
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
      <section className="card">
        <div className="card-head">
          <h2>Install a skill</h2>
          <div className="segmented small-seg" role="tablist" aria-label="Where from">
            {(
              [
                ['web', 'From the web'],
                ['folder', 'From this machine'],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={source === key}
                className={source === key ? 'active' : ''}
                onClick={() => setSource(key)}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        {source === 'web' ? (
          <WebInstall onInstalled={load} />
        ) : (
          <form onSubmit={(e) => void install(e)}>
            <p className="muted small">
              A skill is a folder with a SKILL.md. Gantrix copies it and records a checksum, so
              later edits to your folder don't change what runs. Bump the version to update it.
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
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </section>
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
              {s.sourceUrl && (
                <p className="muted small">
                  From{' '}
                  <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {sourceLabel(s)}
                  </a>
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
