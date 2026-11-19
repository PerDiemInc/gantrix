import {
  checkSlackToken,
  type OllamaCheckDto,
  type OllamaDetectDto,
  parseSlackUserIds,
  type RuntimeSettingsDto,
  type SlackSettingsTestDto,
  type TaskDefaultsDto,
} from '@gantrix/shared';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';

/** One setting: a label, the control, and what it does. */
function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="setting-field">
      <label htmlFor={id}>{label}</label>
      <div id={id}>{children}</div>
      {help && <p className="muted small">{help}</p>}
    </div>
  );
}

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span className="ok-note small" role="status">
      <Icon name="check" size={14} /> Saved
    </span>
  ) : null;
}

/** Where Gantrix looks for Ollama. */
function OllamaCard({
  saved,
  onSaved,
}: {
  saved: RuntimeSettingsDto['ollama'];
  onSaved: (s: RuntimeSettingsDto) => void;
}) {
  const [url, setUrl] = useState(saved.baseUrl);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const [check, setCheck] = useState<OllamaCheckDto | null>(null);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<OllamaDetectDto | null>(null);
  const dirty = url.trim().replace(/\/+$/, '') !== saved.baseUrl;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOk(false);
    try {
      onSaved(await api.put<RuntimeSettingsDto>('/api/settings/ollama', { baseUrl: url }));
      setOk(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const find = async () => {
    setFinding(true);
    setError('');
    setCheck(null);
    setFound(null);
    try {
      const r = await api.post<OllamaDetectDto>('/api/settings/ollama/detect');
      setFound(r);
      if (r.baseUrl) {
        setUrl(r.baseUrl);
        setOk(false);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setFinding(false);
  };
  const run = async () => {
    setChecking(true);
    setError('');
    setCheck(null);
    try {
      setCheck(
        await api.post<OllamaCheckDto>('/api/settings/ollama/check', { baseUrl: url.trim() }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
    setChecking(false);
  };

  return (
    <form className="card" onSubmit={(e) => void save(e)}>
      <h2>Ollama</h2>
      <p className="muted small">
        Where Gantrix looks for Ollama, the program that runs the local models. The default is on
        this machine.
      </p>
      <Field
        label="Address"
        help="If Ollama isn't running and the address is on this machine, Check starts it."
      >
        <input
          className="mono"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setOk(false);
            setCheck(null);
          }}
          placeholder={saved.builtIn}
          spellCheck={false}
          aria-label="Ollama address"
        />
      </Field>
      <div className="row-actions">
        <button type="submit" className="primary" disabled={!dirty || busy || !url.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => void find()} disabled={finding}>
          {finding ? 'Looking…' : 'Find Ollama'}
        </button>
        <button type="button" onClick={() => void run()} disabled={checking || !url.trim()}>
          {checking ? 'Checking…' : 'Check'}
        </button>
        {url.trim() !== saved.builtIn && (
          <button type="button" className="ghost" onClick={() => setUrl(saved.builtIn)}>
            Use the built-in address
          </button>
        )}
        <Saved show={ok && !dirty} />
      </div>
      {found && (
        <p
          className={found.baseUrl ? 'ok-note' : 'error'}
          role={found.baseUrl ? 'status' : 'alert'}
        >
          {found.baseUrl ? (
            <>
              <Icon name="check" size={14} />{' '}
              {found.started && "Ollama wasn't running, so Gantrix started it. "}
              Found Ollama at <code>{found.baseUrl}</code>
              {found.models.length
                ? ` with ${found.models.length} model${found.models.length === 1 ? '' : 's'}`
                : ''}
              . Save to use it.
            </>
          ) : (
            <>
              {found.message} Tried: {found.tried.join(', ')}. If it runs elsewhere, type its
              address.
            </>
          )}
        </p>
      )}
      {check && (
        <p className={check.ok ? 'ok-note' : 'error'} role={check.ok ? 'status' : 'alert'}>
          {check.ok ? (
            <>
              <Icon name="check" size={14} />{' '}
              {check.started && "Ollama wasn't running, so Gantrix started it. "}
              Ollama answers
              {check.models.length
                ? ` and has ${check.models.length} model${check.models.length === 1 ? '' : 's'}: ${check.models.slice(0, 6).join(', ')}${check.models.length > 6 ? ', …' : ''}.`
                : ', but has no models yet. Download one with ollama pull.'}
            </>
          ) : (
            check.message
          )}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

const NUMBER_FIELDS: {
  key: keyof Pick<
    TaskDefaultsDto,
    'maxMinutes' | 'maxTokens' | 'maxReplans' | 'maxStepAttempts' | 'llmConcurrency'
  >;
  label: string;
  help: string;
  min: number;
  max: number;
}[] = [
  {
    key: 'maxMinutes',
    label: 'Time limit (minutes)',
    help: 'A project stops when it has run this long.',
    min: 1,
    max: 1440,
  },
  {
    key: 'maxTokens',
    label: 'Token limit',
    help: 'A project stops after using this many model tokens.',
    min: 1000,
    max: 10_000_000,
  },
  {
    key: 'maxReplans',
    label: 'Replans allowed',
    help: 'How many times the planner may start over after failed tasks.',
    min: 0,
    max: 20,
  },
  {
    key: 'maxStepAttempts',
    label: 'Attempts per task',
    help: 'A rejected task tries again, with the judge’s feedback, this many times.',
    min: 1,
    max: 10,
  },
  {
    key: 'llmConcurrency',
    label: 'Model calls at once',
    help: 'Per worker. Raise it only if your machine can run models side by side. Applies within a few seconds.',
    min: 1,
    max: 16,
  },
];

/** What a new project starts with. Each project can still change these. */
function TaskDefaultsCard({
  saved,
  builtIn,
  onSaved,
}: {
  saved: TaskDefaultsDto;
  builtIn: TaskDefaultsDto;
  onSaved: (s: RuntimeSettingsDto) => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [askFirst, setAskFirst] = useState(saved.askFirst);
  const [isolated, setIsolated] = useState(saved.isolatedSteps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const value = (k: (typeof NUMBER_FIELDS)[number]['key']) => form[k] ?? String(saved[k]);
  const dirty =
    askFirst !== saved.askFirst ||
    isolated !== saved.isolatedSteps ||
    NUMBER_FIELDS.some((f) => value(f.key) !== String(saved[f.key]));
  const touched = () => setOk(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOk(false);
    try {
      const body = {
        ...Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, Number(value(f.key))])),
        askFirst,
        isolatedSteps: isolated,
      };
      onSaved(await api.put<RuntimeSettingsDto>('/api/settings/task-defaults', body));
      setForm({});
      setOk(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const resetToBuiltIn = () => {
    setForm(Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, String(builtIn[f.key])])));
    setAskFirst(builtIn.askFirst);
    setIsolated(builtIn.isolatedSteps);
    touched();
  };

  return (
    <form className="card" onSubmit={(e) => void save(e)}>
      <h2>Task defaults</h2>
      <p className="muted small">
        What a new project starts with. You can still change the limits and the approval switch for
        one project when you create it.
      </p>
      <div className="settings-grid">
        {NUMBER_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} help={f.help}>
            <input
              type="number"
              min={f.min}
              max={f.max}
              value={value(f.key)}
              onChange={(e) => {
                setForm({ ...form, [f.key]: e.target.value });
                touched();
              }}
              aria-label={f.label}
            />
          </Field>
        ))}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={askFirst}
          onChange={(e) => {
            setAskFirst(e.target.checked);
            touched();
          }}
        />
        Ask me before risky tools
        <span className="muted small">
          New projects wait for your OK before shell, web, MCP and email tools. Off: agents run them
          on their own (shell isn’t sandboxed).
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={isolated}
          onChange={(e) => {
            setIsolated(e.target.checked);
            touched();
          }}
        />
        A separate folder for each task
        <span className="muted small">
          Agents can’t overwrite each other’s files. It isn’t a sandbox for shell.
        </span>
      </label>
      <div className="row-actions">
        <button type="submit" className="primary" disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="ghost" onClick={resetToBuiltIn}>
          Use the built-in values
        </button>
        <Saved show={ok && !dirty} />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

type SecretState = { mode: 'keep' } | { mode: 'replace'; value: string } | { mode: 'remove' };

/** A token that is saved but never shown again: keep it, replace it, or remove it. */
function SecretField({
  label,
  kind,
  isSet,
  state,
  onChange,
  placeholder,
}: {
  label: string;
  kind: 'bot' | 'app';
  isSet: boolean;
  state: SecretState;
  onChange: (s: SecretState) => void;
  placeholder: string;
}) {
  const id = useId();
  const typing = !isSet || state.mode === 'replace';
  const value = state.mode === 'replace' ? state.value : '';
  const check = checkSlackToken(kind, value);
  return (
    <div className="token-field">
      <label htmlFor={id}>{label}</label>
      {typing ? (
        <div className="token-row">
          <input
            id={id}
            type="password"
            value={value}
            onChange={(e) => onChange({ mode: 'replace', value: e.target.value })}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={check.state === 'wrong'}
          />
          {isSet && (
            <button
              type="button"
              className="ghost small"
              onClick={() => onChange({ mode: 'keep' })}
            >
              Keep the saved one
            </button>
          )}
        </div>
      ) : (
        <div className="token-row">
          <span id={id} className={state.mode === 'remove' ? 'muted' : 'ok-note'}>
            {state.mode === 'remove' ? 'Will be removed when you save' : '••••••••  Saved'}
          </span>
          <button
            type="button"
            className="ghost small"
            onClick={() => onChange({ mode: 'replace', value: '' })}
          >
            Replace
          </button>
          {state.mode !== 'remove' && (
            <button
              type="button"
              className="ghost danger small"
              onClick={() => onChange({ mode: 'remove' })}
            >
              Remove
            </button>
          )}
          {state.mode === 'remove' && (
            <button
              type="button"
              className="ghost small"
              onClick={() => onChange({ mode: 'keep' })}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {typing && (
        <p
          className={`small ${check.state === 'wrong' ? 'error' : check.state === 'ok' ? 'ok-note' : 'muted'}`}
        >
          {check.hint || ' '}
        </p>
      )}
    </div>
  );
}

/** Projects post to a Slack thread, and replies in it steer them. */
function SlackCard({
  saved,
  onSaved,
}: {
  saved: RuntimeSettingsDto['slack'];
  onSaved: (s: RuntimeSettingsDto) => void;
}) {
  const [bot, setBot] = useState<SecretState>({ mode: 'keep' });
  const [app, setApp] = useState<SecretState>({ mode: 'keep' });
  const [channel, setChannel] = useState(saved.channelId ?? '');
  const [people, setPeople] = useState(saved.allowedUsers.join(', '));
  const [dash, setDash] = useState(saved.dashboardUrl);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const [test, setTest] = useState<SlackSettingsTestDto | null>(null);

  const ids = parseSlackUserIds(people);
  const botValue = bot.mode === 'replace' ? bot.value.trim() : '';
  const appValue = app.mode === 'replace' ? app.value.trim() : '';
  const tokenProblem =
    (bot.mode === 'replace' && checkSlackToken('bot', botValue).state === 'wrong') ||
    (app.mode === 'replace' && checkSlackToken('app', appValue).state === 'wrong');
  const dirty =
    bot.mode !== 'keep' ||
    app.mode !== 'keep' ||
    channel.trim() !== (saved.channelId ?? '') ||
    ids.ids.join(',') !== saved.allowedUsers.join(',') ||
    dash.trim().replace(/\/+$/, '') !== saved.dashboardUrl;
  const touched = () => {
    setOk(false);
    setTest(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOk(false);
    setTest(null);
    try {
      const body = {
        ...(bot.mode === 'replace'
          ? { botToken: botValue }
          : bot.mode === 'remove'
            ? { botToken: null }
            : {}),
        ...(app.mode === 'replace'
          ? { appToken: appValue }
          : app.mode === 'remove'
            ? { appToken: null }
            : {}),
        channelId: channel.trim() || null,
        allowedUsers: ids.ids,
        dashboardUrl: dash.trim(),
      };
      onSaved(await api.put<RuntimeSettingsDto>('/api/settings/slack', body));
      setBot({ mode: 'keep' });
      setApp({ mode: 'keep' });
      setOk(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const run = async () => {
    setTesting(true);
    setError('');
    try {
      setTest(await api.post<SlackSettingsTestDto>('/api/settings/slack/test'));
    } catch (err) {
      setError((err as Error).message);
    }
    setTesting(false);
  };

  return (
    <form className="card" onSubmit={(e) => void save(e)}>
      <h2>Slack for projects</h2>
      <p className="muted small">
        Each project with <b>Post to Slack</b> on gets a thread in one channel with its progress,
        and replies in the thread steer it. These are the same two tokens as the{' '}
        <a href="#/connect/slack">Connect Slack guide</a>, which also shows where to get them. They
        are kept on this machine and never shown again.
      </p>
      <SecretField
        label="Bot token"
        kind="bot"
        isSet={saved.botTokenSet}
        state={bot}
        onChange={(s) => {
          setBot(s);
          touched();
        }}
        placeholder="xoxb-…"
      />
      <SecretField
        label="App-level token (so replies reach the project)"
        kind="app"
        isSet={saved.appTokenSet}
        state={app}
        onChange={(s) => {
          setApp(s);
          touched();
        }}
        placeholder="xapp-…"
      />
      <Field
        label="Channel ID"
        help="Where projects post. In Slack: open the channel, then its name at the top, and copy the Channel ID at the bottom (like C0123456789). Invite the bot with /invite @Gantrix."
      >
        <input
          className="mono"
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            touched();
          }}
          placeholder="C0123456789"
          spellCheck={false}
          aria-label="Channel ID"
        />
      </Field>
      <Field
        label="Who may steer from Slack"
        help="Member IDs (like U01ABCDE2F), separated by commas or lines. Mentions and profile links work too. Needed for replies."
      >
        <textarea
          rows={2}
          value={people}
          onChange={(e) => {
            setPeople(e.target.value);
            touched();
          }}
          placeholder="U01ABCDE2F, U02GHIJK3L"
          spellCheck={false}
          aria-label="Member IDs"
        />
        {ids.rejected.length > 0 && (
          <p className="error small" role="alert">
            Not a member ID: {ids.rejected.join(', ')}. Slack needs the ID (U…), not the name.
          </p>
        )}
      </Field>
      <Field
        label="Dashboard address"
        help="Links in Slack messages open the project here. Use an address your team can reach."
      >
        <input
          className="mono"
          value={dash}
          onChange={(e) => {
            setDash(e.target.value);
            touched();
          }}
          spellCheck={false}
          aria-label="Dashboard address"
        />
      </Field>
      <div className="row-actions">
        <button
          type="submit"
          className="primary"
          disabled={!dirty || busy || tokenProblem || ids.rejected.length > 0}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => void run()}
          disabled={testing || dirty || !saved.botTokenSet}
          title={dirty ? 'Save first, then test what is saved' : undefined}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <Saved show={ok && !dirty} />
        {saved.posts && (
          <span className="muted small">
            {saved.listens
              ? 'Posting and listening for replies.'
              : 'Posting only: add an app-level token for replies.'}
          </span>
        )}
      </div>
      {test && (
        <div role={test.ok ? 'status' : 'alert'}>
          <p className={test.ok ? 'ok-note' : 'error'}>
            <Icon name={test.ok ? 'check' : 'alert'} size={14} /> {test.summary}
          </p>
          {test.channel === 'invite' && (
            <p className="error small">
              The bot can’t see that channel yet. In Slack, open it and type{' '}
              <code>/invite @Gantrix</code>.
            </p>
          )}
          {test.channel === 'found' && <p className="muted small">The bot can see the channel.</p>}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function SettingsPage() {
  const [data, setData] = useState<RuntimeSettingsDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get<RuntimeSettingsDto>('/api/settings/runtime')
      .then(setData, (e: Error) => setError(e.message));
  }, []);
  return (
    <div className="stack settings-page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            Saved in the database and applied at once, with nothing to restart. The default model is
            on the <a href="#/agents">Agents</a> page.
          </p>
        </div>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <OllamaCard key={data.ollama.baseUrl} saved={data.ollama} onSaved={setData} />
          <TaskDefaultsCard
            key={JSON.stringify(data.taskDefaults)}
            saved={data.taskDefaults}
            builtIn={data.taskDefaultsBuiltIn}
            onSaved={setData}
          />
          <SlackCard key={JSON.stringify(data.slack)} saved={data.slack} onSaved={setData} />
        </>
      )}
    </div>
  );
}
