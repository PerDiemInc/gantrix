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

export function PrScanSettings({ taskId }: { taskId: string }) {
  const path = `/api/tasks/${taskId}/pr-scan`;
  const [saved, setSaved] = useState<Saved | null>();
  const [removed, setRemoved] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

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
    const payload: Record<string, unknown> = { enabled: data.has('enabled') };
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
      setStatus('PR scan settings saved.');
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

  return (
    <details className="project-goal">
      <summary>GitHub PR scan</summary>
      {saved !== undefined && (
        <form key={version} onSubmit={(event) => void save(event)} autoComplete="off">
          <fieldset disabled={busy}>
            <label>
              <input type="checkbox" name="enabled" defaultChecked={saved?.enabled ?? false} />{' '}
              Enable scheduled scan
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
            <button type="submit">Save PR scan</button>{' '}
            {saved && (
              <button type="button" onClick={() => void remove()}>
                Remove PR scan
              </button>
            )}
          </fieldset>
        </form>
      )}
      {status && <p role="status">{status}</p>}
    </details>
  );
}
