import type { LiveAgentDto, LiveDto, LoadedModelDto, ModelServerDto } from '@gantrix/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { Avatar, StatusPill } from '../components/ui.tsx';
import { bytes, duration } from '../format.ts';

const POLL_MS = 3_000;

const PROVIDER_LABEL: Record<LiveAgentDto['provider'], string> = {
  ollama: 'Ollama',
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
  'claude-code': 'Claude Code',
  codex: 'ChatGPT (Codex)',
  http: 'Custom HTTP',
};

/** Polls while the tab is visible, one request at a time. `now` ticks every second for the timers. */
function useLive() {
  const [data, setData] = useState<LiveDto | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const busy = useRef(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (busy.current || document.hidden) return;
      busy.current = true;
      try {
        const d = await api.get<LiveDto>('/api/live');
        if (live) {
          setData(d);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      busy.current = false;
    };
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      live = false;
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);
  return { data, error, now };
}

function Where({ isLocal }: { isLocal: boolean }) {
  return (
    <span className={`pill ${isLocal ? 's-succeeded' : 's-awaiting_approval'}`}>
      {isLocal ? 'local' : 'cloud'}
    </span>
  );
}

const elapsed = (since: string | null, now: number) =>
  since ? duration(Math.max(0, Math.floor((now - Date.parse(since)) / 1000) * 1000)) : '';

const AGENT_STATE = {
  running: 'working',
  judging: 'working',
  planning: 'working',
  awaiting_approval: 'waiting',
  delegating: 'idle',
} as const;

function Agents({ agents, now }: { agents: LiveAgentDto[]; now: number }) {
  return (
    <div className="table-scroll">
      <table className="list live-agents">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Working on</th>
            <th>Model</th>
            <th>Status</th>
            <th className="num">For</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={`${a.role}-${a.id}`}>
              <td>
                <div className="live-who">
                  <Avatar
                    name={a.agentName}
                    avatar={a.avatar}
                    size={32}
                    state={AGENT_STATE[a.status as keyof typeof AGENT_STATE] ?? 'working'}
                  />
                  <div>
                    <div className="goal">{a.role === 'planner' ? 'Planner' : a.agentName}</div>
                    {a.role === 'judge' && <div className="muted small">being checked</div>}
                    {a.role === 'agent' && a.attempt > 1 && (
                      <div className="muted small">attempt {a.attempt}</div>
                    )}
                  </div>
                </div>
              </td>
              <td>
                <a
                  className="goal live-link"
                  href={
                    a.stepId ? `#/projects/${a.taskId}/logs/${a.stepId}` : `#/projects/${a.taskId}`
                  }
                >
                  {a.stepTitle ?? 'Splitting the goal into tasks'}
                </a>
                <div className="muted small">
                  <a className="live-link" href={`#/projects/${a.taskId}`}>
                    {a.project}
                  </a>
                </div>
              </td>
              <td>
                <div className="mono small">{a.model}</div>
                <div className="live-where">
                  <span className="muted small">
                    {a.role === 'judge' ? 'judge · ' : ''}
                    {a.connection ?? PROVIDER_LABEL[a.provider]}
                  </span>
                  <Where isLocal={a.isLocal} />
                </div>
              </td>
              <td>
                <StatusPill status={a.status} />
              </td>
              <td className="num num-tab small">
                {elapsed(a.since, now)}
                {a.tokensUsed > 0 && (
                  <div className="muted">{a.tokensUsed.toLocaleString()} tokens</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function unloadsIn(m: LoadedModelDto, now: number): string {
  if (!m.expiresAt) return '';
  const left = Date.parse(m.expiresAt) - now;
  // Ollama uses a far-future date for models kept loaded forever.
  if (left > 365 * 86_400_000) return 'stays loaded';
  return left > 0 ? `unloads in ${duration(Math.ceil(left / 1000) * 1000)}` : 'unloading';
}

function Server({
  server,
  agents,
  now,
}: {
  server: ModelServerDto;
  agents: LiveAgentDto[];
  now: number;
}) {
  const users = (model: string) =>
    agents.filter(
      (a) =>
        a.provider === 'ollama' &&
        (a.model === model || `${a.model}:latest` === model) &&
        (a.status === 'running' || a.status === 'judging' || a.status === 'planning'),
    );
  return (
    <section className="card">
      <div className="card-head">
        <h2>{server.name}</h2>
        <span className="live-where">
          <span className="muted small mono">{server.url}</span>
          <Where isLocal={server.isLocal} />
        </span>
      </div>
      {!server.available && <p className="muted">{server.error}</p>}
      {server.available && !server.models.length && (
        <p className="muted">
          No model is loaded. Ollama loads one when an agent first calls it and frees the memory
          after ten idle minutes.
        </p>
      )}
      {server.models.length > 0 && (
        <div className="table-scroll">
          <table className="list live-models">
            <thead>
              <tr>
                <th>Model</th>
                <th>Memory</th>
                <th>Runs on</th>
                <th>Used by</th>
                <th className="num">Kept until</th>
              </tr>
            </thead>
            <tbody>
              {server.models.map((m) => {
                const gpu = m.sizeBytes ? Math.round((m.vramBytes / m.sizeBytes) * 100) : 0;
                const busy = users(m.name);
                return (
                  <tr key={m.name}>
                    <td>
                      <div className="goal mono">{m.name}</div>
                      <div className="muted small">
                        {[
                          m.parameterSize,
                          m.quantization,
                          m.contextLength && `${m.contextLength.toLocaleString()} ctx`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </td>
                    <td className="num-tab">{bytes(m.sizeBytes)}</td>
                    <td className="small">
                      {gpu >= 100 ? 'GPU' : gpu <= 0 ? 'CPU' : `${gpu}% GPU, ${100 - gpu}% CPU`}
                    </td>
                    <td>
                      {busy.length ? (
                        <span className="live-users">
                          {busy.map((a) => (
                            <Avatar
                              key={`${a.role}-${a.id}`}
                              name={a.agentName}
                              avatar={a.avatar}
                              size={24}
                            />
                          ))}
                          <span className="small">
                            {busy.length} {busy.length === 1 ? 'agent' : 'agents'}
                          </span>
                        </span>
                      ) : (
                        <span className="muted small">idle</span>
                      )}
                    </td>
                    <td className="num num-tab small">{unloadsIn(m, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function LivePage({ embedded = false }: { embedded?: boolean }) {
  const { data, error, now } = useLive();
  const agents = data?.agents ?? [];
  const working = agents.filter(
    (a) => AGENT_STATE[a.status as keyof typeof AGENT_STATE] === 'working',
  );
  const loaded = data?.servers.flatMap((s) => s.models) ?? [];
  const memory = loaded.reduce((sum, m) => sum + m.sizeBytes, 0);
  const cloud = agents.filter((a) => !a.isLocal).length;

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          {embedded ? null : <h1>Running agents</h1>}
          <p className="muted">
            The agents working right now, the model each one runs on, and the models loaded in
            memory on this machine. Updates every {POLL_MS / 1000}s.
          </p>
        </div>
        {data && (
          <span className="muted small">
            <Icon name="clock" size={12} /> {new Date(data.sampledAt).toLocaleTimeString()}
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Looking…</p>}

      {data && (
        <>
          <div className="stats">
            <section className="card stat">
              <h2>Agents working</h2>
              <p className="stat-value num-tab">{working.length}</p>
              <p className="muted small">
                {agents.length - working.length} waiting · {data.queued} queued
              </p>
            </section>
            <section className="card stat">
              <h2>Models loaded</h2>
              <p className="stat-value num-tab">{loaded.length}</p>
              <p className="muted small">
                {loaded.length ? `${bytes(memory)} in memory` : 'nothing in memory'}
              </p>
            </section>
            <section className="card stat">
              <h2>Leaving this machine</h2>
              <p className="stat-value num-tab">{cloud}</p>
              <p className="muted small">
                {cloud ? 'agents sending prompts to a cloud model' : 'every agent runs locally'}
              </p>
            </section>
            <section className="card stat">
              <h2>Default model</h2>
              <p className="stat-value live-default mono">{data.defaultModel}</p>
              <p className="muted small">planner, judges and agents without their own</p>
            </section>
          </div>

          <section className="card">
            <h2>Agents</h2>
            {agents.length ? (
              <Agents agents={agents} now={now} />
            ) : (
              <p className="muted">
                No agent is working. Start a project on the <a href="#/projects">Projects</a> page
                and they show up here.
              </p>
            )}
          </section>

          {data.servers.map((s) => (
            <Server key={s.url} server={s} agents={agents} now={now} />
          ))}
        </>
      )}
    </div>
  );
}
