import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { eq, isNotNull } from 'drizzle-orm';
import { agents, connections } from '../db/schema.ts';
import { type EngineDeps, modelDefaults } from '../engine/deps.ts';
import { resolveHeaders, resolveModelSpec } from '../models/connections.ts';
import { createChatModel } from '../models/provider.ts';
import { clip, SlackApi } from './api.ts';
import { type SlackEvent, SocketMode } from './socket.ts';

type Agent = typeof agents.$inferSelect;

export interface ParsedMessage {
  /** The agent named at the start of the message, if any. */
  agent: Agent | null;
  text: string;
}

/**
 * "@Gantrix writer: draft the update" → the writer agent and "draft the update". Without a
 * name, the text is returned as is. The bot mention is always removed.
 */
export function parseAgentMessage(raw: string, botUserId: string, named: Agent[]): ParsedMessage {
  const text = raw.replaceAll(`<@${botUserId}>`, '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  for (const agent of [...named].sort((a, b) => b.name.length - a.name.length)) {
    const name = agent.name.toLowerCase();
    if (lower.startsWith(name) && /^[\s:,-]|^$/.test(lower.slice(name.length))) {
      return { agent, text: text.slice(name.length).replace(/^[\s:,-]+/, '') };
    }
  }
  return { agent: null, text };
}

const SYSTEM = (agent: Agent) =>
  [
    `You are ${agent.name}, an AI agent. ${agent.description}`.trim(),
    agent.systemPrompt,
    'You are chatting with a teammate in Slack. Reply briefly (at most 8 short lines) in Slack',
    'formatting (*bold*, • bullets). You cannot run tools or change files in this chat; if the',
    'work needs that, say it should be started as a Gantrix project or job.',
  ]
    .filter(Boolean)
    .join('\n');

interface Live {
  key: string;
  api: SlackApi;
  socket: SocketMode;
  botUserId: string;
  allowed: Set<string>;
  agentIds: string[];
}

/**
 * Chat with an agent in Slack. An agent with a Slack connection (bot token to reply, app-level
 * token to hear) answers when an allowed person DMs the bot or @mentions it in a channel,
 * e.g. "@Gantrix writer: summarize what we shipped". With one agent on the connection, no name
 * is needed. Replies stay in the thread and use that thread as the conversation.
 */
export class AgentSlack {
  readonly #deps: EngineDeps;
  readonly #live = new Map<string, Live>();
  readonly #seen: string[] = [];
  #timer: NodeJS.Timeout | null = null;
  #syncing: Promise<void> | null = null;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
  }

  async start(): Promise<void> {
    await this.sync();
    this.#timer = setInterval(() => void this.sync(), 30_000);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.#syncing;
    for (const l of this.#live.values()) l.socket.close();
    this.#live.clear();
  }

  /** Opens a connection per Slack connection that has agents, and closes the ones that don't. */
  sync(): Promise<void> {
    this.#syncing ??= this.#sync()
      .catch((e: unknown) =>
        console.error(`Agent Slack: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => {
        this.#syncing = null;
      });
    return this.#syncing;
  }

  async #sync(): Promise<void> {
    const { db, config } = this.#deps;
    const rows = await db
      .select({ agent: agents, connection: connections })
      .from(agents)
      .innerJoin(connections, eq(connections.id, agents.slackConnectionId))
      .where(isNotNull(agents.slackConnectionId));
    const byConnection = new Map<
      string,
      { connection: typeof connections.$inferSelect; ids: string[] }
    >();
    for (const { agent, connection } of rows) {
      if (connection.provider !== 'slack') continue;
      const entry = byConnection.get(connection.id) ?? { connection, ids: [] };
      entry.ids.push(agent.id);
      byConnection.set(connection.id, entry);
    }
    for (const [id, live] of this.#live) {
      const next = byConnection.get(id);
      const key = next ? JSON.stringify([next.connection.headers, next.connection.settings]) : '';
      if (next && key === live.key) {
        live.agentIds = next.ids;
        continue;
      }
      live.socket.close();
      this.#live.delete(id);
    }
    for (const [id, { connection, ids }] of byConnection) {
      if (this.#live.has(id)) continue;
      try {
        const headers = resolveHeaders(connection.headers);
        const bot = headers['Bot-Token'];
        const app = headers['App-Token'];
        if (!bot || !app) throw new Error('it needs both a bot token and an app-level token');
        const api = new SlackApi(bot, config.SLACK_API_URL);
        const { user_id } = await api.call<{ user_id: string }>('auth.test');
        const live: Live = {
          key: JSON.stringify([connection.headers, connection.settings]),
          api,
          botUserId: user_id,
          allowed: new Set(
            (connection.settings.allowedUsers ?? '')
              .split(',')
              .map((u) => u.trim())
              .filter(Boolean),
          ),
          agentIds: ids,
          socket: new SocketMode(app, config.SLACK_API_URL, (e) => this.handle(id, e)),
        };
        this.#live.set(id, live);
        live.socket.start();
        console.log(`Slack: agents on "${connection.name}" can be talked to.`);
      } catch (error) {
        console.error(
          `Slack connection "${connection.name}" is off: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** One Slack event for one connection. Exposed for tests. */
  async handle(connectionId: string, event: SlackEvent): Promise<void> {
    const live = this.#live.get(connectionId);
    if (!live || !event.channel || !event.ts || !event.user || event.bot_id || event.subtype)
      return;
    const direct = event.type === 'message' && event.channel.startsWith('D');
    if (event.type !== 'app_mention' && !direct) return;
    if (event.user === live.botUserId) return;
    const id = `${event.channel}:${event.ts}`;
    if (this.#seen.includes(id)) return;
    this.#seen.push(id);
    if (this.#seen.length > 200) this.#seen.shift();
    // Only the people the connection lists may talk to its agents.
    if (!live.allowed.has(event.user)) return;

    const { db, config } = this.#deps;
    const thread = event.thread_ts ?? event.ts;
    const reply = (text: string) =>
      live.api.call('chat.postMessage', {
        channel: event.channel,
        thread_ts: thread,
        text,
        unfurl_links: false,
      });
    const team = (
      await Promise.all(
        live.agentIds.map((agentId) =>
          db.query.agents.findFirst({ where: eq(agents.id, agentId) }),
        ),
      )
    ).filter((a): a is Agent => Boolean(a));
    const parsed = parseAgentMessage(event.text ?? '', live.botUserId, team);
    const agent = parsed.agent ?? (team.length === 1 ? team[0] : undefined);
    if (!agent) {
      await reply(
        `Which agent? Start your message with a name: ${team.map((a) => `_${a.name}_`).join(', ')}.`,
      );
      return;
    }
    if (!parsed.text) {
      await reply(`Hi, I'm *${agent.name}*. ${clip(agent.description, 200)} Ask me something.`);
      return;
    }
    try {
      const history = await this.#history(live, event, thread, agent);
      const model = createChatModel(
        await resolveModelSpec(db, config, agent),
        'worker',
        modelDefaults(config),
      );
      const answer = await model.invoke(
        [new SystemMessage(SYSTEM(agent)), ...history, new HumanMessage(parsed.text)],
        { signal: AbortSignal.timeout(180_000) },
      );
      const text =
        typeof answer.content === 'string' ? answer.content : JSON.stringify(answer.content);
      await reply(text.trim() || '…');
    } catch (error) {
      await reply(
        `${agent.name} couldn't answer: ${clip(error instanceof Error ? error.message : String(error), 300)}`,
      ).catch(() => undefined);
    }
  }

  /** The thread so far (without the message being answered), as chat turns. */
  async #history(
    live: Live,
    event: SlackEvent,
    thread: string,
    agent: Agent,
  ): Promise<BaseMessage[]> {
    if (!event.thread_ts) return [];
    const res = await live.api.call<{ messages?: { user?: string; text?: string; ts?: string }[] }>(
      'conversations.replies',
      { channel: event.channel, ts: thread, limit: 20 },
    );
    return (res.messages ?? [])
      .filter((m) => m.ts !== event.ts && m.text)
      .slice(-12)
      .map((m) =>
        m.user === live.botUserId
          ? new AIMessage(m.text ?? '')
          : new HumanMessage(parseAgentMessage(m.text ?? '', live.botUserId, [agent]).text),
      );
  }
}
