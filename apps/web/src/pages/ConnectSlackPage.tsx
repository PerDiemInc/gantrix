import {
  type AgentDto,
  type ConnectionDto,
  checkSlackToken,
  interpretSlackTest,
  OWNER_AGENT_NAMES,
  parseSlackUserIds,
  SLACK_LINKS,
  type SlackTestOutcome,
  type SlackTokenKind,
  slackManifestUrl,
} from '@gantrix/shared';
import { type ReactNode, useEffect, useId, useState } from 'react';
import manifest from '../../../../docs/slack-app-manifest.yml?raw';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { Avatar } from '../components/ui.tsx';

/** Where to click in Slack, as a trail. Plain text, so it can't go stale like a screenshot. */
function ClickPath({ steps }: { steps: string[] }) {
  return (
    <ol className="click-path" aria-label="Where to click in Slack">
      {steps.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`card slack-step${done ? ' done' : ''}`} aria-labelledby={id}>
      <h2 id={id}>
        <span className="np-step" aria-hidden="true">
          {done ? <Icon name="check" size={14} /> : n}
        </span>
        {title}
        {done && <span className="sr-only"> (done)</span>}
      </h2>
      {children}
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A secret field that says, as it is filled in, whether it is the token that was asked for. */
function TokenField({
  label,
  kind,
  value,
  onChange,
  placeholder,
  problem,
}: {
  label: string;
  kind: SlackTokenKind;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  problem?: string | undefined;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const check = checkSlackToken(kind, value);
  const note = problem ?? check.hint;
  const bad = Boolean(problem) || check.state === 'wrong';
  return (
    <div className="token-field">
      <label htmlFor={id}>{label}</label>
      <div className="token-row">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={bad}
          aria-describedby={`${id}-note`}
        />
        <button type="button" className="ghost small" onClick={() => setShown(!shown)}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      <p
        id={`${id}-note`}
        className={`small ${bad ? 'error' : check.state === 'ok' ? 'ok-note' : 'muted'}`}
        role={bad ? 'alert' : undefined}
      >
        {note || ' '}
      </p>
    </div>
  );
}

/**
 * Connect Slack, start to finish: make the app from Gantrix's manifest, copy two tokens and a
 * member ID, test it, and pick the agents that talk in Slack. Secrets stay in this page's memory
 * until saved; nothing is kept in the browser.
 */
export function ConnectSlackPage() {
  const [name, setName] = useState('slack');
  const [bot, setBot] = useState('');
  const [app, setApp] = useState('');
  const [idsText, setIdsText] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connId, setConnId] = useState('');
  const [outcome, setOutcome] = useState<SlackTestOutcome | null>(null);
  const [existing, setExisting] = useState<ConnectionDto[]>([]);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [enableError, setEnableError] = useState('');

  useEffect(() => {
    api.get<ConnectionDto[]>('/api/connections').then(
      (list) => setExisting(list.filter((c) => c.provider === 'slack')),
      () => {},
    );
  }, []);

  const botCheck = checkSlackToken('bot', bot);
  const appCheck = checkSlackToken('app', app);
  const { ids, rejected } = parseSlackUserIds(idsText);
  const ready =
    botCheck.state === 'ok' &&
    appCheck.state === 'ok' &&
    ids.length > 0 &&
    !rejected.length &&
    name.trim().length > 0;
  const connected = outcome?.ok === true;
  const problem = (field: 'bot' | 'app') =>
    outcome?.problems.find((p) => p.field === field)?.message;

  const copyManifest = async () => {
    try {
      await navigator.clipboard.writeText(manifest);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
      document.getElementById('slack-manifest')?.setAttribute('open', '');
    }
  };

  const saveAndTest = async () => {
    setBusy(true);
    setError('');
    setOutcome(null);
    try {
      const body = {
        name: name.trim(),
        provider: 'slack',
        baseUrl: null,
        headers: { 'Bot-Token': bot.trim(), 'App-Token': app.trim() },
        settings: { allowedUsers: ids.join(',') },
      };
      // Fixing a token and pressing the button again updates the connection, not a second one.
      const saved = connId
        ? await api.patch<ConnectionDto>(`/api/connections/${connId}`, body)
        : await api.post<ConnectionDto>('/api/connections', body);
      setConnId(saved.id);
      const result = interpretSlackTest(
        await api.post<{ ok: boolean; reply?: string; error?: string }>(
          `/api/connections/${saved.id}/test`,
        ),
      );
      setOutcome(result);
      if (result.ok) {
        const list = await api.get<AgentDto[]>('/api/agents');
        setAgents(list);
        // Start with the project manager only: the agent to ask "where do things stand?".
        // The rest are one click away, so no agent lands in Slack by surprise.
        setPicked(
          new Set(
            list
              .filter(
                (a) => !a.slackConnectionId && OWNER_AGENT_NAMES.includes(a.name.toLowerCase()),
              )
              .map((a) => a.id),
          ),
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      setError(
        /already taken/i.test(message)
          ? `A connection named "${name.trim()}" already exists. Pick another name, or edit it on the Connections page.`
          : message,
      );
    }
    setBusy(false);
  };

  const turnOn = async () => {
    setBusy(true);
    setEnableError('');
    const done: string[] = [];
    const failed: string[] = [];
    for (const a of agents.filter((x) => picked.has(x.id))) {
      try {
        await api.patch(`/api/agents/${a.id}`, { slackConnectionId: connId });
        done.push(a.name);
      } catch (err) {
        failed.push(`${a.name}: ${(err as Error).message}`);
      }
    }
    setEnabled(done);
    if (failed.length) setEnableError(failed.join(' '));
    setBusy(false);
  };
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Show the example with the agent best at status questions, if it was turned on.
  const example =
    enabled?.find((n) => OWNER_AGENT_NAMES.includes(n.toLowerCase())) ??
    enabled?.[0] ??
    agents.find((a) => picked.has(a.id))?.name ??
    'cpo';

  return (
    <div className="stack slack-wizard">
      <header className="page-head">
        <div>
          <h1>Connect Slack</h1>
          <p className="muted">
            About five minutes. Talk to your agents from Slack, and ask them where things stand.
            Everything runs over a connection Gantrix opens to Slack, so no public URL is needed.
          </p>
        </div>
        <a className="button ghost" href="#/connections">
          Connections
        </a>
      </header>

      {existing.length > 0 && (
        <p className="muted small" role="note">
          Already connected: {existing.map((c) => c.name).join(', ')}. This page adds another one;
          to change one, edit it on the Connections page.
        </p>
      )}

      <Step n={1} title="Create the Slack app" done={false}>
        <p>
          Slack builds the app for you from Gantrix's manifest: its name, bot user, permissions and
          Socket Mode. You only choose a workspace.
        </p>
        <div className="row-actions">
          <a
            className="button primary"
            href={slackManifestUrl(manifest)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Slack with the manifest filled in <Icon name="play" size={12} />
          </a>
          <button type="button" className="ghost" onClick={() => void copyManifest()}>
            {copied ? 'Copied' : 'Copy the manifest instead'}
          </button>
        </div>
        <ClickPath steps={['Pick your workspace', 'Next', 'Review the summary', 'Create']} />
        <p className="muted small">
          Slack asks you to sign in if you aren't. Nothing is installed yet. If the page doesn't
          arrive filled in, go to <ExternalLink href={SLACK_LINKS.yourApps}>your apps</ExternalLink>
          , choose <b>Create New App → From a manifest</b> and paste the copied manifest. Slack's
          own guide:{' '}
          <ExternalLink href={SLACK_LINKS.manifestDocs}>
            Configuring apps with manifests
          </ExternalLink>
          .
        </p>
        <details id="slack-manifest">
          <summary className="small">Show the manifest</summary>
          <pre className="output">{manifest}</pre>
        </details>
      </Step>

      <Step n={2} title="Install it and copy the bot token" done={botCheck.state === 'ok'}>
        <p>
          The bot token lets Gantrix post and reply as the app. It appears once the app is installed
          in your workspace.
        </p>
        <ClickPath steps={['Install App', 'Install to Workspace', 'Allow']} />
        <ClickPath
          steps={['OAuth & Permissions', 'Bot User OAuth Token', 'Copy (starts with xoxb-)']}
        />
        <p className="muted small">
          Open <ExternalLink href={SLACK_LINKS.yourApps}>your apps</ExternalLink> and choose
          Gantrix.
        </p>
        <TokenField
          label="Bot User OAuth Token"
          kind="bot"
          value={bot}
          onChange={setBot}
          placeholder="xoxb-…"
          problem={problem('bot')}
        />
      </Step>

      <Step n={3} title="Make the app-level token" done={appCheck.state === 'ok'}>
        <p>
          This second token lets Gantrix <em>hear</em> messages, over Socket Mode. It is separate
          from the bot token and needs one scope.
        </p>
        <ClickPath
          steps={[
            'Basic Information',
            'App-Level Tokens',
            'Generate Token and Scopes',
            'Name it "gantrix"',
            'Add Scope: connections:write',
            'Generate',
            'Copy (starts with xapp-)',
          ]}
        />
        <p className="muted small">
          More on it:{' '}
          <ExternalLink href={SLACK_LINKS.socketModeDocs}>Using Socket Mode</ExternalLink>.
        </p>
        <TokenField
          label="App-level token"
          kind="app"
          value={app}
          onChange={setApp}
          placeholder="xapp-…"
          problem={problem('app')}
        />
      </Step>

      <Step n={4} title="Say who may talk to the agents" done={ids.length > 0 && !rejected.length}>
        <p>
          Only the people listed here can talk to your agents in Slack. Add your own member ID, and
          anyone else you trust. It looks like <code>U01ABCDE2F</code>, and is not your name.
        </p>
        <ClickPath
          steps={['Your profile picture in Slack', 'Profile', '⋮ More', 'Copy member ID']}
        />
        <p className="muted small">
          Slack's help page:{' '}
          <ExternalLink href={SLACK_LINKS.memberIdHelp}>finding a member ID</ExternalLink>.
        </p>
        <label>
          Member IDs
          <textarea
            rows={2}
            value={idsText}
            onChange={(e) => setIdsText(e.target.value)}
            placeholder="U01ABCDE2F, U02GHIJK3L"
            spellCheck={false}
            aria-describedby="slack-ids-note"
          />
        </label>
        <p
          id="slack-ids-note"
          className={`small ${rejected.length ? 'error' : 'muted'}`}
          role={rejected.length ? 'alert' : undefined}
        >
          {rejected.length
            ? `Not a member ID: ${rejected.join(', ')}. Slack needs the ID (U…), not the name.`
            : ids.length
              ? `${ids.length} ${ids.length === 1 ? 'person' : 'people'}: ${ids.join(', ')}`
              : 'Paste one or more, separated by commas or lines. Mentions and profile links work too.'}
        </p>
      </Step>

      <Step n={5} title="Save and test" done={connected}>
        <label>
          Name this connection
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row-actions">
          <button
            type="button"
            className="primary"
            disabled={!ready || busy}
            onClick={() => void saveAndTest()}
          >
            {busy && !outcome ? 'Testing…' : connId ? 'Save and test again' : 'Save and test'}
          </button>
          {!ready && (
            <span className="muted small">
              Fill in steps 2 to 4 first: the bot token, the app-level token and a member ID.
            </span>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {outcome && (
          <p className={outcome.ok ? 'ok-note' : 'error'} role={outcome.ok ? 'status' : 'alert'}>
            {outcome.ok ? <Icon name="check" size={14} /> : <Icon name="alert" size={14} />}{' '}
            {outcome.summary}
            {!outcome.ok && (
              <span className="muted small"> It is saved; fix it above and test again.</span>
            )}
          </p>
        )}
      </Step>

      <Step n={6} title="Choose the agents that talk in Slack" done={enabled !== null}>
        {!connected ? (
          <p className="muted">Available once the test in step 5 passes.</p>
        ) : enabled === null ? (
          <>
            {agents.length === 0 ? (
              <p className="muted">
                You have no agents yet. Add one with <b>New → Agent</b>, then pick this connection
                in its <b>Talk to it in Slack</b> menu.
              </p>
            ) : (
              <ul className="cards agent-pick">
                {agents.map((a) => (
                  <li key={a.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={picked.has(a.id)}
                        onChange={() => toggle(a.id)}
                      />
                      <Avatar name={a.name} avatar={a.avatar} size={24} />
                      <b>{a.name}</b>
                      <span className="muted small">
                        {a.slackConnectionId
                          ? 'already in Slack (this moves it)'
                          : a.description.length > 110
                            ? `${a.description.slice(0, 109)}…`
                            : a.description}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {agents.length > 0 && (
              <div className="row-actions">
                <button
                  type="button"
                  className="ghost small"
                  onClick={() =>
                    setPicked(new Set(picked.size === agents.length ? [] : agents.map((a) => a.id)))
                  }
                >
                  {picked.size === agents.length ? 'Select none' : 'Select all'}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || picked.size === 0}
                  onClick={() => void turnOn()}
                >
                  {busy
                    ? 'Turning on…'
                    : `Turn on Slack for ${picked.size} agent${picked.size === 1 ? '' : 's'}`}
                </button>
              </div>
            )}
          </>
        ) : (
          <div role="status">
            <p className="ok-note">
              <Icon name="check" size={14} />{' '}
              {enabled.length
                ? `${enabled.join(', ')} ${enabled.length === 1 ? 'is' : 'are'} on Slack. They come online within about 30 seconds.`
                : 'No agent was changed.'}
            </p>
            {enableError && (
              <p className="error" role="alert">
                {enableError}
              </p>
            )}
            <p>Now, in Slack:</p>
            <ul className="slack-try">
              <li>
                Send <b>Gantrix</b> a direct message: <code>{example}: what's your status?</code>
              </li>
              <li>
                Or in a channel, invite it once with <code>/invite @Gantrix</code>, then write{' '}
                <code>@Gantrix {example}: what are you working on?</code>
              </li>
            </ul>
            <p className="muted small">
              Replies stay in the thread, and the thread is the conversation.{' '}
              <a href="#/agents">See your agents</a>
            </p>
          </div>
        )}
      </Step>
    </div>
  );
}
