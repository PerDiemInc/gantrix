import type { ConnectionDto } from '@gantrix/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useAgents } from '../hooks.ts';

/** Agents that answer people in Slack, and the Slack connection each one uses. */
export function SlackAgents() {
  const agents = useAgents();
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  useEffect(() => {
    api.get<ConnectionDto[]>('/api/connections').then(setConnections);
  }, []);
  const chatty = [...agents.values()].filter((a) => a.slackConnectionId);
  return (
    <section className="card">
      <h2>Chatting in Slack</h2>
      {chatty.length === 0 ? (
        <p className="muted small">
          No agent is in Slack yet. On the Agents page, press <b>Set up</b> next to Slack on an
          agent (it needs a Slack connection with bot credentials).
        </p>
      ) : (
        <ul className="cards">
          {chatty.map((a) => (
            <li key={a.id} className="item">
              <strong>{a.name}</strong>{' '}
              <span className="muted small">
                via{' '}
                {connections.find((c) => c.id === a.slackConnectionId)?.name ??
                  'a Slack connection'}
                {' · '}
                <code>@bot {a.name}: …</code>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
