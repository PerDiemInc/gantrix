import type { ConnectionDto, ModelProvider } from '@gantrix/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';

const PROVIDERS: { value: ModelProvider; label: string; url: string }[] = [
  { value: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434' },
  { value: 'openai', label: 'OpenAI or compatible', url: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic or compatible', url: 'https://api.anthropic.com' },
  { value: 'claude-code', label: 'Claude Code on this machine (claude -p)', url: 'claude' },
];
const empty = { name: '', provider: 'openai' as ModelProvider, baseUrl: '', headers: '' };

/** "Name: value" per line → a header map. */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error(`"${line}" should look like "Name: value".`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function TestButton({ c }: { c: ConnectionDto }) {
  const [model, setModel] = useState(c.provider === 'claude-code' ? 'haiku' : '');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setResult('');
    const r = await api.post<{ ok: boolean; reply?: string; error?: string; ms: number }>(
      `/api/connections/${c.id}/test`,
      { model },
    );
    setResult(r.ok ? `OK: "${r.reply}" in ${r.ms} ms` : `Failed: ${r.error}`);
    setBusy(false);
  };
  return (
    <div className="row-actions">
      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model to test" />
      <button
        type="button"
        className="ghost small"
        disabled={!model || busy}
        onClick={() => void run()}
      >
        {busy ? 'Testing…' : 'Test'}
      </button>
      {result && (
        <span className={result.startsWith('OK') ? 'small' : 'error small'}>{result}</span>
      )}
    </div>
  );
}

export function ConnectionsPage() {
  const [list, setList] = useState<ConnectionDto[]>([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const load = () => {
    api.get<ConnectionDto[]>('/api/connections').then(setList);
  };
  useEffect(load, []);
  const provider = PROVIDERS.find((p) => p.value === form.provider);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/connections', {
        name: form.name,
        provider: form.provider,
        headers: parseHeaders(form.headers),
        ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}),
      });
      setForm(empty);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (c: ConnectionDto) => {
    if (!confirm(`Remove connection "${c.name}"?`)) return;
    try {
      await api.del(`/api/connections/${c.id}`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="columns wide-left">
      <section className="card">
        <h2>Connections</h2>
        <p className="muted small">
          Agents use the local Ollama unless you give them a connection. Pick one when you add an
          agent.
        </p>
        <ul className="cards">
          {list.map((c) => (
            <li key={c.id} className="item">
              <div className="item-head">
                <strong>{c.name}</strong>
                <span className="muted mono small">
                  {c.provider} · {c.effectiveUrl}
                </span>
                <span className={`pill ${c.isLocal ? 's-succeeded' : 's-awaiting_approval'}`}>
                  {c.isLocal ? 'local' : 'cloud'}
                </span>
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
              {!c.isLocal && (
                <p className="muted small">
                  Prompts and task content go to this service, and its prices apply.
                </p>
              )}
              <TestButton c={c} />
            </li>
          ))}
        </ul>
      </section>
      <form className="card" onSubmit={(e) => void create(e)}>
        <h2>Add connection</h2>
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="openai"
            pattern="[a-z0-9][a-z0-9-]*"
            required
          />
        </label>
        <label>
          Provider
          <select
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value as ModelProvider })}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {form.provider === 'claude-code' ? 'Path to claude' : 'URL'}{' '}
          <span className="muted small">(blank = {provider?.url})</span>
          <input
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder={provider?.url}
          />
        </label>
        {form.provider !== 'claude-code' && (
          <label>
            Headers <span className="muted small">(one per line)</span>
            <textarea
              rows={3}
              value={form.headers}
              onChange={(e) => setForm({ ...form, headers: e.target.value })}
              placeholder={
                form.provider === 'anthropic'
                  ? 'x-api-key: env:ANTHROPIC_API_KEY'
                  : 'Authorization: Bearer env:OPENAI_API_KEY'
              }
            />
            <span className="muted small">
              env:NAME reads the value from the worker's environment (.env), so the key isn't saved.
              Saved values are never shown again.
            </span>
          </label>
        )}
        {form.provider === 'claude-code' && (
          <p className="muted small">
            Runs claude -p in each project's folder with your Claude login. It gets file tools, plus
            the shell and the web unless the project asks first.
          </p>
        )}
        <button type="submit" className="primary">
          Add connection
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
