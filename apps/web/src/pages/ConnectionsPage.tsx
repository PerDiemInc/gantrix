import {
  type ConnectionDto,
  type ConnectionProvider,
  DEFAULT_HTTP_REQUEST,
  HTTP_METHODS,
  type HttpMethod,
  isServiceProvider,
  type ServiceProvider,
} from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { ModelSelect, useModelSources } from '../components/ModelPicker.tsx';

const PROVIDERS: { value: ConnectionProvider; label: string; url: string }[] = [
  { value: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434' },
  { value: 'openai', label: 'OpenAI or compatible', url: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic or compatible', url: 'https://api.anthropic.com' },
  { value: 'http', label: 'Custom HTTP server', url: 'https://your-server/v1/generate' },
  { value: 'claude-code', label: 'Claude Code on this machine (claude -p)', url: 'claude' },
  { value: 'codex', label: 'ChatGPT on this machine (Codex CLI)', url: 'codex' },
  { value: 'github', label: 'GitHub (token)', url: 'https://api.github.com' },
  { value: 'slack', label: 'Slack (existing app)', url: 'https://slack.com/api' },
];

/** GitHub and Slack connections: secrets go in headers, the rest in plain settings. */
const SERVICE_FIELDS: Record<
  ServiceProvider,
  {
    secrets: {
      header: string;
      label: string;
      prefix?: string;
      placeholder: string;
      required: boolean;
    }[];
    settings: { key: string; label: string; placeholder: string }[];
    help: string;
  }
> = {
  github: {
    secrets: [
      {
        header: 'Authorization',
        label: 'Token',
        prefix: 'Bearer ',
        placeholder: 'ghp_… or env:GITHUB_TOKEN',
        required: true,
      },
    ],
    settings: [
      { key: 'org', label: 'Organization', placeholder: 'PerDiemInc' },
      { key: 'repos', label: 'Repositories (comma-separated)', placeholder: 'api, dashboard' },
    ],
    help: 'A fine-grained token with Pull requests: Read. Set an organization, repositories, or both.',
  },
  slack: {
    secrets: [
      {
        header: 'Bot-Token',
        label: 'Bot token',
        placeholder: 'xoxb-… or env:SLACK_BOT_TOKEN',
        required: true,
      },
      {
        header: 'App-Token',
        label: 'App-level token (optional, for replies in threads)',
        placeholder: 'xapp-… or env:SLACK_APP_TOKEN',
        required: false,
      },
    ],
    settings: [
      { key: 'channel', label: 'Channel ID', placeholder: 'C0123456789' },
      {
        key: 'allowedUsers',
        label: 'Allowed Slack user IDs (comma-separated)',
        placeholder: 'U01ABC…',
      },
    ],
    help: 'Use the bot token of the Slack app you already installed. Invite the bot to the channel.',
  },
};
const CONTENT_TYPES = ['application/json', 'text/plain', 'application/x-www-form-urlencoded'];

/** One header. A saved value is never sent back by the API, so "keep" means: leave it as is. */
interface HeaderRow {
  key: number;
  name: string;
  value: string;
  keep: boolean;
}

interface Form {
  name: string;
  provider: ConnectionProvider;
  baseUrl: string;
  headers: HeaderRow[];
  settings: Record<string, string>;
  method: HttpMethod;
  contentType: string;
  bodyTemplate: string;
  replyPath: string;
}

let nextKey = 1;
const row = (name = '', value = '', keep = false): HeaderRow => ({
  key: nextKey++,
  name,
  value,
  keep,
});

const emptyForm = (): Form => ({
  name: '',
  provider: 'http',
  baseUrl: '',
  settings: {},
  headers: [row('Authorization', 'Bearer ')],
  method: DEFAULT_HTTP_REQUEST.method,
  contentType: DEFAULT_HTTP_REQUEST.contentType,
  bodyTemplate: DEFAULT_HTTP_REQUEST.bodyTemplate,
  replyPath: DEFAULT_HTTP_REQUEST.replyPath,
});

function formFrom(c: ConnectionDto): Form {
  return {
    name: c.name,
    provider: c.provider,
    baseUrl: c.baseUrl ?? '',
    settings: c.settings,
    // "hidden" = a saved value; env:NAME references are shown as they are and can be edited.
    headers: Object.entries(c.headers).map(([k, v]) =>
      v === 'hidden' ? row(k, '', true) : row(k, v, false),
    ),
    method: c.request?.method ?? DEFAULT_HTTP_REQUEST.method,
    contentType: c.request?.contentType ?? DEFAULT_HTTP_REQUEST.contentType,
    bodyTemplate: c.request?.bodyTemplate ?? DEFAULT_HTTP_REQUEST.bodyTemplate,
    replyPath: c.request?.replyPath ?? '',
  };
}

function HeaderRows({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  const set = (key: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <fieldset className="header-rows">
      <legend>Headers</legend>
      {rows.map((r, i) => (
        <div key={r.key} className="header-row">
          <label className="sr-only" htmlFor={`h-name-${r.key}`}>
            Header {i + 1} name
          </label>
          <input
            id={`h-name-${r.key}`}
            value={r.name}
            onChange={(e) => set(r.key, { name: e.target.value })}
            placeholder="Authorization"
            spellCheck={false}
          />
          <label className="sr-only" htmlFor={`h-value-${r.key}`}>
            Header {i + 1} value
          </label>
          {r.keep ? (
            <div className="kept">
              <span className="muted small">saved value (hidden)</span>
              <button
                type="button"
                className="ghost small"
                onClick={() => set(r.key, { keep: false })}
              >
                Replace
              </button>
            </div>
          ) : (
            <input
              id={`h-value-${r.key}`}
              value={r.value}
              onChange={(e) => set(r.key, { value: e.target.value })}
              placeholder="Bearer env:MY_API_KEY"
              spellCheck={false}
              autoComplete="off"
            />
          )}
          <button
            type="button"
            className="ghost small danger"
            aria-label={`Remove header ${r.name || i + 1}`}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="ghost small" onClick={() => onChange([...rows, row()])}>
        <Icon name="plus" size={14} /> Add header
      </button>
      <span className="muted small">
        Write <code>env:NAME</code> (or <code>Bearer env:NAME</code>) to read the value from the
        worker's .env, so it isn't saved. Saved values are never shown again.
      </span>
    </fieldset>
  );
}

interface TestResult {
  ok: boolean;
  reply?: string;
  error?: string;
  ms: number;
  http?: {
    status: number;
    raw: string;
    reply: string;
    path: string | null;
    paths?: string[];
    request: { method: string; url: string; headers: Record<string, string>; body: string | null };
  };
}

function TestPanel({ c, onUsePath }: { c: ConnectionDto; onUsePath?: (path: string) => void }) {
  const { sources } = useModelSources();
  // Codex also takes "default" (the CLI's own choice), which its list doesn't name.
  const offered = [
    ...new Set([
      ...(c.provider === 'codex' ? ['default'] : []),
      ...(sources?.find((s) => s.connectionId === c.id)?.models ?? []),
    ]),
  ];
  const [model, setModel] = useState(
    c.provider === 'claude-code' ? 'haiku' : c.provider === 'codex' ? 'default' : '',
  );
  const [prompt, setPrompt] = useState('Reply with the single word: OK');
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const service = isServiceProvider(c.provider);
  const run = async () => {
    setBusy(true);
    setResult(null);
    setResult(
      await api
        .post<TestResult>(`/api/connections/${c.id}/test`, {
          model,
          ...(c.provider === 'http' ? { prompt } : {}),
        })
        .catch((e: Error) => ({ ok: false, error: e.message, ms: 0 })),
    );
    setBusy(false);
  };
  return (
    <div className="test-panel">
      <div className="row-actions">
        {!service && (
          <ModelSelect
            models={offered}
            value={model}
            onChange={setModel}
            emptyLabel="Choose a model to test"
            placeholder="model to test"
            label="Model to test"
            typeOnly={c.provider === 'http'}
          />
        )}
        {c.provider === 'http' && (
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Test prompt"
          />
        )}
        <button
          type="button"
          className="ghost small"
          disabled={(!service && !model) || busy}
          onClick={() => void run()}
        >
          {busy ? 'Testing…' : 'Test'}
        </button>
      </div>
      {result && (
        <p className={result.ok ? 'small' : 'error small'} role="status">
          {result.ok
            ? service
              ? `OK in ${result.ms} ms. ${result.reply}`
              : `OK in ${result.ms} ms: "${result.reply}"`
            : `Failed: ${result.error}`}
        </p>
      )}
      {result?.http && (
        <details className="http-debug" open={!result.ok}>
          <summary>Request and response</summary>
          <pre className="output">
            {`${result.http.request.method} ${result.http.request.url}\n${Object.entries(
              result.http.request.headers,
            )
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}${result.http.request.body ? `\n\n${result.http.request.body}` : ''}`}
          </pre>
          <p className="muted small">
            Status {result.http.status}
            {result.http.path ? ` · reply read from ${result.http.path}` : ''}
          </p>
          <pre className="output">{result.http.raw}</pre>
          {result.http.paths && result.http.paths.length > 0 && (
            <div className="chips">
              <span className="muted small">Text in the response:</span>
              {result.http.paths.map((p) =>
                onUsePath ? (
                  <button key={p} type="button" className="chip" onClick={() => onUsePath(p)}>
                    {p}
                  </button>
                ) : (
                  <span key={p} className="chip mono">
                    {p}
                  </span>
                ),
              )}
            </div>
          )}
        </details>
      )}
    </div>
  );
}

export function ConnectionsPage() {
  const [list, setList] = useState<ConnectionDto[]>([]);
  const [form, setForm] = useState<Form>(emptyForm);
  const [editing, setEditing] = useState<ConnectionDto | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const load = () => {
    api.get<ConnectionDto[]>('/api/connections').then(setList);
  };
  useEffect(load, []);
  const provider = PROVIDERS.find((p) => p.value === form.provider);
  const isHttp = form.provider === 'http';

  const edit = (c: ConnectionDto) => {
    setEditing(c);
    setForm(formFrom(c));
    setError('');
    setSaved('');
    document.getElementById('connection-form')?.scrollIntoView({ block: 'start' });
  };
  const reset = () => {
    setEditing(null);
    setForm(emptyForm());
    setError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSaved('');
    const headers: Record<string, string> = {};
    const service = isServiceProvider(form.provider) ? SERVICE_FIELDS[form.provider] : null;
    for (const r of form.headers) {
      const field = service?.secrets.find((f) => f.header === r.name);
      if (field && !r.keep && !r.value.trim() && !field.required) continue;
      if (!r.name.trim()) continue;
      if (!r.keep && !r.value.trim()) {
        setError(`Header ${r.name} has no value. Remove it or fill it in.`);
        return;
      }
      const value = r.value.trim();
      const prefixed =
        field?.prefix && !value.toLowerCase().startsWith(field.prefix.toLowerCase())
          ? `${field.prefix}${value}`
          : value;
      headers[r.name.trim()] = r.keep ? 'hidden' : prefixed;
    }
    const body = {
      name: form.name,
      provider: form.provider,
      headers,
      baseUrl: form.provider === 'slack' ? null : form.baseUrl.trim() || null,
      ...(service
        ? {
            settings: Object.fromEntries(
              Object.entries(form.settings)
                .filter(([k, v]) => v.trim() && service.settings.some((f) => f.key === k))
                .map(([k, v]) => [k, v.trim()]),
            ),
          }
        : {}),
      ...(isHttp
        ? {
            request: {
              method: form.method,
              contentType: form.contentType,
              bodyTemplate: form.bodyTemplate,
              replyPath: form.replyPath.trim(),
            },
          }
        : {}),
    };
    try {
      if (editing) {
        await api.patch(`/api/connections/${editing.id}`, body);
        setSaved(`Saved ${form.name}.`);
        const fresh = await api.get<ConnectionDto>(`/api/connections/${editing.id}`);
        setEditing(fresh);
        setForm(formFrom(fresh));
      } else {
        await api.post('/api/connections', body);
        setSaved(`Added ${form.name}. Test it below.`);
        setForm(emptyForm());
      }
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (c: ConnectionDto) => {
    if (!confirm(`Remove connection "${c.name}"?`)) return;
    try {
      await api.del(`/api/connections/${c.id}`);
      if (editing?.id === c.id) reset();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  // GitHub and Slack have fixed secret fields; switching to one lays them out.
  const pickProvider = (value: ConnectionProvider) => {
    if (!isServiceProvider(value)) return setForm({ ...form, provider: value });
    setForm({
      ...form,
      provider: value,
      baseUrl: '',
      settings: {},
      headers: SERVICE_FIELDS[value].secrets.map((f) => row(f.header, f.prefix ?? '')),
    });
  };
  const serviceForm = isServiceProvider(form.provider) ? SERVICE_FIELDS[form.provider] : null;

  return (
    <div className="columns wide-left">
      <section className="card">
        <h2>Connections</h2>
        <p className="muted small">
          Agents use the local Ollama unless you give them a connection. Pick one when you add an
          agent. GitHub and Slack connections hold the credentials jobs and scans use.
        </p>
        <p className="slack-banner">
          <span>
            <b>Talk to your agents in Slack.</b> A step-by-step guide gets the tokens for you.
          </span>
          <a className="button primary" href="#/connect/slack">
            Connect Slack
          </a>
        </p>
        <ul className="cards">
          {list.map((c) => (
            <li key={c.id} className={`item${editing?.id === c.id ? ' editing' : ''}`}>
              <div className="item-head">
                <strong>{c.name}</strong>
                <span className="muted mono small">
                  {c.provider === 'http' ? `${c.request?.method ?? 'POST'} ` : `${c.provider} · `}
                  {c.effectiveUrl}
                </span>
                <span className={`pill ${c.isLocal ? 's-succeeded' : 's-awaiting_approval'}`}>
                  {c.isLocal ? 'local' : 'cloud'}
                </span>
                <button type="button" className="ghost small" onClick={() => edit(c)}>
                  Edit
                </button>
                <button type="button" className="ghost danger small" onClick={() => void remove(c)}>
                  Remove
                </button>
              </div>
              {Object.keys(c.headers).length > 0 && (
                <p className="mono small">
                  {Object.entries(c.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </p>
              )}
              {Object.keys(c.settings).length > 0 && (
                <p className="mono small muted">
                  {Object.entries(c.settings)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </p>
              )}
              {c.provider === 'http' && c.request && (
                <p className="mono small muted">
                  {c.request.contentType} · reply {c.request.replyPath || 'auto-detected'}
                </p>
              )}
              {!c.isLocal && !isServiceProvider(c.provider) && (
                <p className="muted small">
                  Prompts and task content go to this service, and its prices apply.
                </p>
              )}
              <TestPanel
                c={c}
                {...(editing?.id === c.id ? { onUsePath: (p: string) => set('replyPath', p) } : {})}
              />
            </li>
          ))}
        </ul>
      </section>

      <form id="connection-form" className="card" onSubmit={(e) => void submit(e)}>
        <div className="card-head">
          <h2>{editing ? `Edit ${editing.name}` : 'Add connection'}</h2>
          {editing && (
            <button type="button" className="ghost small" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="my-server"
            pattern="[a-z0-9][a-z0-9-]*"
            required
          />
        </label>
        <label>
          Provider
          <select
            value={form.provider}
            onChange={(e) => pickProvider(e.target.value as ConnectionProvider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {form.provider !== 'slack' && (
          <label>
            {form.provider === 'claude-code'
              ? 'Path to claude'
              : form.provider === 'codex'
                ? 'Path to codex'
                : 'URL'}{' '}
            {!isHttp && <span className="muted small">(blank = {provider?.url})</span>}
            <input
              value={form.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
              placeholder={provider?.url}
              required={isHttp}
              spellCheck={false}
            />
            {isHttp && (
              <span className="muted small">
                http:// or https://. It can contain <code>{'{{model}}'}</code> or{' '}
                <code>{'{{prompt}}'}</code>.
              </span>
            )}
          </label>
        )}

        {isHttp && (
          <>
            <div className="row-actions">
              <label className="grow">
                Method
                <select
                  value={form.method}
                  onChange={(e) => set('method', e.target.value as HttpMethod)}
                >
                  {HTTP_METHODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="grow">
                Content-Type
                <input
                  value={form.contentType}
                  onChange={(e) => set('contentType', e.target.value)}
                  list="content-types"
                  spellCheck={false}
                />
                <datalist id="content-types">
                  {CONTENT_TYPES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </label>
            </div>
            {form.method !== 'GET' && (
              <label>
                Body
                <textarea
                  className="mono"
                  rows={5}
                  value={form.bodyTemplate}
                  onChange={(e) => set('bodyTemplate', e.target.value)}
                  spellCheck={false}
                />
                <span className="muted small">
                  Put <code>{'{{prompt}}'}</code> where your server wants the text, at any depth,
                  e.g. <code>{'{"input": {"text": "{{prompt}}"}}'}</code>. Also{' '}
                  <code>{'{{system}}'}</code>, <code>{'{{model}}'}</code> and{' '}
                  <code>{'"{{messages}}"'}</code> (an OpenAI-style array).
                </span>
              </label>
            )}
            <label>
              Reply path <span className="muted small">(blank = auto-detect)</span>
              <input
                value={form.replyPath}
                onChange={(e) => set('replyPath', e.target.value)}
                placeholder="choices.0.message.content"
                spellCheck={false}
              />
              <span className="muted small">
                Where the answer is in the response JSON. Test the connection to see the paths it
                has; while editing, click one to use it.
              </span>
            </label>
          </>
        )}

        {serviceForm && (
          <>
            <p className="muted small">{serviceForm.help}</p>
            {serviceForm.secrets.map((f) => {
              const r = form.headers.find((h) => h.name === f.header);
              const update = (patch: Partial<HeaderRow>) =>
                set(
                  'headers',
                  r
                    ? form.headers.map((h) => (h === r ? { ...h, ...patch } : h))
                    : [...form.headers, { ...row(f.header, f.prefix ?? ''), ...patch }],
                );
              if (r?.keep) {
                return (
                  <div key={f.header}>
                    {f.label}
                    <div className="kept">
                      <span className="muted small">saved value (hidden)</span>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => update({ keep: false, value: '' })}
                      >
                        Replace
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <label key={f.header}>
                  {f.label}
                  <input
                    value={(r?.value ?? '').replace(f.prefix ?? '\0', '')}
                    onChange={(e) => update({ value: e.target.value })}
                    placeholder={f.placeholder}
                    required={f.required}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
              );
            })}
            {serviceForm.settings.map((f) => (
              <label key={f.key}>
                {f.label}
                <input
                  value={form.settings[f.key] ?? ''}
                  onChange={(e) => set('settings', { ...form.settings, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                  spellCheck={false}
                />
              </label>
            ))}
          </>
        )}
        {!serviceForm && form.provider !== 'claude-code' && form.provider !== 'codex' && (
          <HeaderRows rows={form.headers} onChange={(rows) => set('headers', rows)} />
        )}
        {form.provider === 'claude-code' && (
          <p className="muted small">
            Runs claude -p in each project's folder with your Claude login. It gets file tools, plus
            the shell and the web unless the project asks first.
          </p>
        )}
        {form.provider === 'codex' && (
          <p className="muted small">
            Runs codex exec in each project's folder with your ChatGPT login. It can only write in
            that folder, and it can use the network unless the project asks first.
          </p>
        )}
        <button type="submit" className="primary">
          {editing ? 'Save changes' : 'Add connection'}
        </button>
        {saved && (
          <p className="small" role="status">
            {saved}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
