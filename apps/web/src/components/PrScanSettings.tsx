import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';

const fields = [
  [
    'GitHub',
    [
      ['GITHUB_TOKEN', 'Read-only GitHub token', true],
      ['GITHUB_PR_ORG', 'Organization'],
      ['GITHUB_PR_REPOS', 'Repositories (comma-separated owner/repo)'],
      ['GITHUB_PR_INTERVAL_SECONDS', 'Interval in seconds'],
      ['GITHUB_PR_MODEL', 'Ollama model'],
    ],
  ],
  [
    'Slack (optional)',
    [
      ['SLACK_CHANNEL_ID', 'Channel ID'],
      ['SLACK_BOT_TOKEN', 'Bot token', true],
      ['SLACK_APP_TOKEN', 'Socket Mode app token', true],
      ['SLACK_ALLOWED_USERS', 'Allowed user IDs (comma-separated)'],
    ],
  ],
  [
    'Email (optional)',
    [
      ['PR_SMTP_URL', 'SMTP URL with credentials', true],
      ['PR_EMAIL_FROM', 'Sender address'],
      ['PR_EMAIL_TO', 'Recipient and allowed reply address'],
      ['PR_IMAP_HOST', 'IMAP host'],
      ['PR_IMAP_USER', 'IMAP username'],
      ['PR_IMAP_PASSWORD', 'IMAP password', true],
    ],
  ],
] as const;

type Saved = Record<string, unknown> & { enabled: boolean; savedSecrets: string[] };
const list = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

type Report = { title: string; url: string; key: string; summary: string };

export function PrScanSettings({ taskId, builtIn = false }: { taskId: string; builtIn?: boolean }) {
  const path = `/api/tasks/${taskId}/pr-scan`;
  const [saved, setSaved] = useState<Saved | null>();
  const [removed, setRemoved] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [reports, setReports] = useState<Report[]>([]);

  useEffect(() => {
    if (!builtIn) return;
    let active = true;
    const read = () =>
      void api.get<Report[]>(`${path}/reports`).then(
        (value) => {
          if (active) setReports(value);
        },
        () => {},
      );
    read();
    const timer = setInterval(read, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, builtIn]);

  useEffect(() => {
    let active = true;
    void api.get<Saved | null>(path).then(
      (value) => {
        if (active) setSaved(value);
      },
      (error: Error) => {
        if (active) setStatus(error.message);
      },
    );
    return () => {
      active = false;
    };
  }, [path]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = {
      enabled: builtIn ? (saved?.enabled ?? true) : data.has('enabled'),
    };
    for (const [, group] of fields) {
      for (const [name, , secret] of group) {
        const value = String(data.get(name) ?? '').trim();
        if (secret && !value && !removed.includes(name)) continue;
        payload[name] = value;
      }
    }
    payload.GITHUB_PR_REPOS = list(String(payload.GITHUB_PR_REPOS));
    payload.SLACK_ALLOWED_USERS = list(String(payload.SLACK_ALLOWED_USERS));
    payload.GITHUB_PR_INTERVAL_SECONDS = Number(payload.GITHUB_PR_INTERVAL_SECONDS);
    setBusy(true);
    try {
      await api.put(path, payload);
      setSaved(await api.get<Saved | null>(path));
      setRemoved([]);
      setVersion((value) => value + 1);
      setShowSettings(false);
      setStatus(builtIn && !saved ? 'PR scan enabled.' : 'PR scan settings saved.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.del(path);
      setSaved(null);
      setRemoved([]);
      setVersion((value) => value + 1);
      setStatus('PR scan removed.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (!saved) {
      setShowSettings(true);
      return;
    }
    const enabled = !saved.enabled;
    setBusy(true);
    try {
      await api.post(`${path}/state`, { enabled });
      setSaved({ ...saved, enabled });
      setStatus(enabled ? 'PR scan enabled.' : 'PR scan paused.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const form = saved !== undefined && (
    <form key={version} onSubmit={(event) => void save(event)} autoComplete="off">
      <fieldset disabled={busy}>
        <label>
          <input type="checkbox" name="enabled" defaultChecked={saved?.enabled ?? false} /> Enable
          scheduled scan
        </label>
        {fields.map(([title, group]) => (
          <fieldset key={title}>
            <legend>{title}</legend>
            {group.map(([name, label, secret]) => {
              const value = saved?.[name];
              const defaultValue = Array.isArray(value)
                ? value.join(', ')
                : (value ??
                  (name === 'GITHUB_PR_INTERVAL_SECONDS'
                    ? 300
                    : name === 'GITHUB_PR_MODEL'
                      ? 'qwen3:8b'
                      : ''));
              const stored = secret && saved?.savedSecrets.includes(name);
              return (
                <div key={name}>
                  <label>
                    {label}{' '}
                    <input
                      name={name}
                      type={
                        secret
                          ? 'password'
                          : name === 'GITHUB_PR_INTERVAL_SECONDS'
                            ? 'number'
                            : 'text'
                      }
                      defaultValue={secret ? '' : String(defaultValue)}
                      placeholder={stored && !removed.includes(name) ? 'Saved' : undefined}
                    />
                  </label>{' '}
                  {stored && name !== 'GITHUB_TOKEN' && (
                    <label>
                      <input
                        type="checkbox"
                        checked={removed.includes(name)}
                        onChange={(event) => {
                          setRemoved(
                            event.target.checked
                              ? [...removed, name]
                              : removed.filter((field) => field !== name),
                          );
                        }}
                      />{' '}
                      Clear saved value
                    </label>
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
        <button type="submit">{builtIn && !saved ? 'Save and play' : 'Save PR scan'}</button>{' '}
        {saved && (
          <button type="button" onClick={() => void remove()}>
            Remove PR scan
          </button>
        )}
      </fieldset>
    </form>
  );

  if (builtIn)
    return (
      <section className="card stack" aria-label="Built-in GitHub PR scanner">
        <div className="page-head">
          <div>
            <p className="muted small">Built-in project</p>
            <h2>GitHub PR Scan</h2>
            <p className="muted">Summarize open pull request discussions with local Ollama.</p>
          </div>
          <button
            className="primary"
            type="button"
            disabled={busy || saved === undefined}
            onClick={() => void toggle()}
          >
            {saved?.enabled ? 'Pause' : 'Play'}
          </button>
        </div>
        {saved && (
          <button type="button" onClick={() => setShowSettings(!showSettings)}>
            {showSettings ? 'Close settings' : 'Settings'}
          </button>
        )}
        {showSettings && form}
        {status && <p role="status">{status}</p>}
        {reports.length > 0 && (
          <details>
            <summary>Recent PR summaries</summary>
            {reports.map((report) => (
              <article key={report.key}>
                <h3>
                  <a href={report.url} target="_blank" rel="noreferrer">
                    {report.key} · {report.title}
                  </a>
                </h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{report.summary}</p>
              </article>
            ))}
          </details>
        )}
      </section>
    );

  return (
    <details className="project-goal">
      <summary>GitHub PR scan</summary>
      {form}
      {status && <p role="status">{status}</p>}
    </details>
  );
}
