import type { ModelSource } from '@gantrix/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

const OTHER = '__other__';

/** Where the agent runs, then one of that place's models (or any name typed by hand). */
export function ModelPicker({
  connectionId,
  model,
  onChange,
}: {
  connectionId: string;
  model: string;
  onChange: (v: { connectionId: string; model: string }) => void;
}) {
  const [sources, setSources] = useState<ModelSource[] | null>(null);
  const [typing, setTyping] = useState(false);
  const load = (fresh = false) =>
    api
      .get<ModelSource[]>(`/api/models${fresh ? '?fresh=true' : ''}`)
      .then(setSources, () => setSources([]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => void load(), []);
  const source = sources?.find((s) => (s.connectionId ?? '') === connectionId);
  const models = source?.models ?? [];
  const showInput = typing || (source && !models.length) || (model && !models.includes(model));
  return (
    <>
      <label>
        Runs on
        <select
          value={connectionId}
          onChange={(e) => {
            setTyping(false);
            onChange({ connectionId: e.target.value, model: '' });
          }}
        >
          {(
            sources ?? [
              { connectionId: null, name: 'Ollama (default)', provider: 'ollama', models: [] },
            ]
          ).map((s) => (
            <option key={s.connectionId ?? ''} value={s.connectionId ?? ''}>
              {s.name} · {s.provider}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model{' '}
        <button type="button" className="link small" onClick={() => void load(true)}>
          refresh
        </button>
        {!showInput ? (
          <select
            value={model}
            onChange={(e) =>
              e.target.value === OTHER
                ? setTyping(true)
                : onChange({ connectionId, model: e.target.value })
            }
          >
            <option value="">
              {connectionId ? 'Choose a model' : 'Default (GANTRIX_DEFAULT_MODEL)'}
            </option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
        ) : (
          <input
            value={model}
            onChange={(e) => onChange({ connectionId, model: e.target.value })}
            placeholder={
              source?.provider === 'claude-code'
                ? 'sonnet'
                : source?.provider === 'codex'
                  ? 'gpt-5.6-sol'
                  : 'model name'
            }
          />
        )}
        {source?.error && (
          <span className="muted small">
            Couldn't list models: {source.error}. Type a name instead.
          </span>
        )}
      </label>
    </>
  );
}
