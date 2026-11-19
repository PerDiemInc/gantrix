import type { ModelSource } from '@gantrix/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

const OTHER = '__other__';

/**
 * A dropdown of models. A name that isn't in the list (a model not installed yet, or one saved
 * on an agent) stays selectable instead of turning the control into a text box; typing a name by
 * hand is something you choose with "Other…", and "Back to the list" undoes it. `typeOnly` is for
 * servers that have no list to offer, where a name has to be typed.
 */
export function ModelSelect({
  models,
  value,
  onChange,
  emptyLabel,
  placeholder = 'model name',
  label,
  typeOnly = false,
}: {
  models: readonly string[];
  value: string;
  onChange: (model: string) => void;
  /** The choice that means "no model chosen": the default, or a prompt to pick. */
  emptyLabel: string;
  placeholder?: string;
  /** For screen readers, when no visible label wraps it. */
  label?: string;
  typeOnly?: boolean;
}) {
  const [typing, setTyping] = useState(false);
  if (typing || typeOnly) {
    return (
      <span className="model-typed">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={label ?? 'Model name'}
        />
        {!typeOnly && (
          <button
            type="button"
            className="link small"
            onClick={() => {
              setTyping(false);
              if (value && !models.includes(value)) onChange('');
            }}
          >
            Back to the list
          </button>
        )}
      </span>
    );
  }
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => (e.target.value === OTHER ? setTyping(true) : onChange(e.target.value))}
    >
      <option value="">{emptyLabel}</option>
      {value && !models.includes(value) && (
        <option value={value}>{models.length ? `${value} (not in the list)` : value}</option>
      )}
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      <option value={OTHER}>Other…</option>
    </select>
  );
}

/** The models each place offers, loaded once; `refresh` asks the servers again. */
export function useModelSources() {
  const [sources, setSources] = useState<ModelSource[] | null>(null);
  const load = (fresh = false) =>
    api
      .get<ModelSource[]>(`/api/models${fresh ? '?fresh=true' : ''}`)
      .then(setSources, () => setSources([]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => void load(), []);
  return { sources, refresh: () => load(true) };
}

/** Where the agent runs, then one of that place's models, chosen from a dropdown. */
export function ModelPicker({
  connectionId,
  model,
  onChange,
  emptyLabel,
  modelServersOnly = false,
}: {
  connectionId: string;
  model: string;
  onChange: (v: { connectionId: string; model: string }) => void;
  /** What "no model chosen" means here. Default: "The default model". */
  emptyLabel?: string;
  /** Only places that can plan and judge (Ollama, OpenAI, Anthropic), for choosing the default. */
  modelServersOnly?: boolean;
}) {
  const { sources: all, refresh } = useModelSources();
  const sources = all
    ? all.filter((s) => !modelServersOnly || ['ollama', 'openai', 'anthropic'].includes(s.provider))
    : all;
  const source = sources?.find((s) => (s.connectionId ?? '') === connectionId);
  const models = source?.models ?? [];
  return (
    <>
      <label>
        Runs on
        <select
          value={connectionId}
          onChange={(e) => onChange({ connectionId: e.target.value, model: '' })}
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
        <button type="button" className="link small" onClick={() => void refresh()}>
          refresh
        </button>
        <ModelSelect
          models={models}
          value={model}
          onChange={(m) => onChange({ connectionId, model: m })}
          emptyLabel={connectionId ? 'Choose a model' : (emptyLabel ?? 'The default model')}
          placeholder={
            source?.provider === 'claude-code'
              ? 'sonnet'
              : source?.provider === 'codex'
                ? 'gpt-5.6-sol'
                : 'model name'
          }
          typeOnly={source?.provider === 'http'}
        />
        {source?.error && (
          <span className="muted small">
            Couldn't list models: {source.error}. Start it and press refresh, or choose Other… to
            type a name.
          </span>
        )}
        {source && !source.error && !models.length && source.provider !== 'http' && (
          <span className="muted small">
            No models found here yet. Press refresh, or choose Other… to type a name.
          </span>
        )}
      </label>
    </>
  );
}
