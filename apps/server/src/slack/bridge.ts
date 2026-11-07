import { type GantrixEvent, projectTitle } from '@gantrix/shared';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ALL, type EventHub } from '../api/event-hub.ts';
import { agents, approvals, steps, tasks } from '../db/schema.ts';
import {
  decideApproval,
  extendTask,
  resumeTask,
  STOPPED_BY_USER,
  sendMessage,
  setTeam,
  stopTask,
  updateTask,
} from '../engine/commands.ts';
import { type EngineDeps, modelDefaults } from '../engine/deps.ts';
import { resolveModelSpec } from '../models/connections.ts';
import { createChatModel } from '../models/provider.ts';
import { clip, esc, SlackApi } from './api.ts';
import { projectFacts, projectStatus } from './facts.ts';
import { type SlackEvent, SocketMode } from './socket.ts';

type Task = typeof tasks.$inferSelect;
interface Post {
  text: string;
  /** Also show it in the channel, not only the thread. */
  broadcast?: boolean;
}

export const SLACK_HELP = [
  '*Talk to the project in this thread*',
  '• Reply normally to steer the team, or to answer a question an agent asked.',
  '• Mention me to ask anything about it: _@Gantrix what is left to do?_',
  '• _@Gantrix status_: who is working on what',
  '• _@Gantrix add designer_ / _remove cto_: change the team',
  '• _@Gantrix stop_ / _resume_ / _extend 60m_ / _rename Crumb site_',
].join('\n');

const QUESTION_SYSTEM = `You answer a teammate's question in Slack about a project that a team of AI
agents is working on. Use only the facts given. If they don't answer it, say what you do know
and what is unknown. Be brief: at most 6 short lines. Use Slack formatting (*bold*, • bullets).
Don't invent progress, files or numbers.`;

/**
 * Two-way Slack. Out: each project with Slack on gets one thread in SLACK_CHANNEL_ID, and its
 * progress posts there. In (Socket Mode, needs SLACK_APP_TOKEN): replies in the thread steer
 * the project or answer an agent's question; mentions ask about it or change it.
 */
export class SlackBridge {
  readonly #deps: EngineDeps;
  readonly #hub: EventHub;
  readonly #api: SlackApi;
  readonly #channel: string;
  readonly #socket: SocketMode | null;
  readonly #chains = new Map<string, Promise<void>>();
  readonly #seen: string[] = [];
  #botUserId = '';
  #unsubscribe: (() => void) | null = null;

  constructor(deps: EngineDeps, hub: EventHub, api?: SlackApi) {
    const { config } = deps;
    if (!config.SLACK_BOT_TOKEN || !config.SLACK_CHANNEL_ID) {
      throw new Error('SlackBridge needs SLACK_BOT_TOKEN and SLACK_CHANNEL_ID');
    }
    this.#deps = deps;
    this.#hub = hub;
    this.#api = api ?? new SlackApi(config.SLACK_BOT_TOKEN, config.SLACK_API_URL);
    this.#channel = config.SLACK_CHANNEL_ID;
    this.#socket = config.SLACK_APP_TOKEN
      ? new SocketMode(config.SLACK_APP_TOKEN, config.SLACK_API_URL, (e) => this.handle(e))
      : null;
  }

  async start(): Promise<void> {
    const auth = await this.#api.call<{ user_id: string }>('auth.test');
    this.#botUserId = auth.user_id;
    this.#unsubscribe = this.#hub.subscribe(ALL, (row) => {
      this.#inOrder(row.taskId, () =>
        this.#onGantrixEvent(row.taskId, row.payload as GantrixEvent),
      );
    });
    this.#socket?.start();
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#socket?.close();
    await Promise.allSettled(this.#chains.values());
  }

  /** Waits for every post queued so far (tests). */
  async idle(): Promise<void> {
    while (this.#chains.size) await Promise.allSettled([...this.#chains.values()]);
  }

  #link(taskId: string): string {
    return `${this.#deps.config.GANTRIX_DASHBOARD_URL.replace(/\/$/, '')}/#/projects/${taskId}`;
  }

  /** Posts for one project go out in order; different projects don't wait for each other. */
  #inOrder(taskId: string, work: () => Promise<void>): void {
    const prev = this.#chains.get(taskId) ?? Promise.resolve();
    const next = prev
      .then(work)
      .catch((error: unknown) =>
        console.error(`Slack: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        if (this.#chains.get(taskId) === next) this.#chains.delete(taskId);
      });
    this.#chains.set(taskId, next);
  }

  // ── Out: Gantrix → Slack ─────────────────────────────────────────────────

  async #onGantrixEvent(taskId: string, event: GantrixEvent): Promise<void> {
    const task = await this.#deps.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task?.slack) return;
    const thread = await this.#thread(task);
    const post = await this.#format(task, event);
    if (!post) return;
    await this.#api.call('chat.postMessage', {
      channel: thread.channel,
      thread_ts: thread.ts,
      text: post.text,
      unfurl_links: false,
      ...(post.broadcast ? { reply_broadcast: true } : {}),
    });
  }

  /** The project's thread, started with an intro message the first time. */
  async #thread(task: Task): Promise<{ channel: string; ts: string }> {
    if (task.slackThreadTs && task.slackChannel) {
      return { channel: task.slackChannel, ts: task.slackThreadTs };
    }
    const team = await this.#teamNames(task);
    const hours = task.budget.maxMinutes / 60;
    const intro = [
      `:rocket: *${esc(projectTitle(task))}*`,
      task.description ? esc(clip(task.description, 300)) : '',
      `>${esc(clip(task.goal, 400))}`,
      `Team: ${team.length ? team.join(', ') : 'every agent'} · Time limit: ${Number.isInteger(hours) ? `${hours} h` : `${task.budget.maxMinutes} min`} · <${this.#link(task.id)}|Open in Gantrix>`,
      this.#socket
        ? '_Reply in this thread to steer the team or answer their questions. Mention me to ask about the project. Mention me with "help" for more._'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const res = await this.#api.call<{ ts: string; channel: string }>('chat.postMessage', {
      channel: this.#channel,
      text: intro,
      unfurl_links: false,
    });
    await this.#deps.db
      .update(tasks)
      .set({ slackChannel: res.channel, slackThreadTs: res.ts })
      .where(eq(tasks.id, task.id));
    return { channel: res.channel, ts: res.ts };
  }

  async #teamNames(task: Task): Promise<string[]> {
    if (!task.agentIds?.length) return [];
    const rows = await this.#deps.db
      .select({ name: agents.name })
      .from(agents)
      .where(inArray(agents.id, task.agentIds));
    return rows.map((r) => r.name);
  }

  async #stepWithAgent(stepId: string) {
    const [row] = await this.#deps.db
      .select({ title: steps.title, agent: agents.name, output: steps.output, error: steps.error })
      .from(steps)
      .leftJoin(agents, eq(agents.id, steps.agentId))
      .where(eq(steps.id, stepId));
    return row;
  }

  async #format(task: Task, e: GantrixEvent): Promise<Post | null> {
    switch (e.type) {
      case 'plan.created': {
        const rows = await this.#deps.db
          .select({ key: steps.key, title: steps.title, agent: agents.name })
          .from(steps)
          .leftJoin(agents, eq(agents.id, steps.agentId))
          .where(and(eq(steps.taskId, task.id), eq(steps.planVersion, e.version)))
          .orderBy(asc(steps.createdAt));
        const list = rows.map((s) => `• ${esc(s.title)}: *${s.agent ?? 'unassigned'}*`).join('\n');
        return {
          text:
            e.version > 1
              ? `:world_map: *New plan* (${rows.length} tasks). Why: ${esc(clip(e.reason, 300))}\n${list}`
              : `:world_map: *The plan* (${rows.length} tasks)\n${list}`,
        };
      }
      case 'step.status': {
        if (e.status !== 'succeeded' && e.status !== 'failed') return null;
        const s = await this.#stepWithAgent(e.stepId);
        if (!s) return null;
        return e.status === 'succeeded'
          ? { text: `:white_check_mark: *${s.agent ?? 'An agent'}* finished “${esc(s.title)}”` }
          : {
              text: `:x: *${s.agent ?? 'An agent'}* couldn't finish “${esc(s.title)}”${s.error ? `: ${esc(clip(s.error, 200))}` : ''}`,
            };
      }
      case 'approval.requested': {
        const s = await this.#stepWithAgent(e.stepId);
        const who = s?.agent ?? 'An agent';
        if (e.tool !== 'ask_user') {
          return {
            text: `:raised_hand: *${who}* wants to use \`${e.tool}\`. Approve or deny it in <${this.#link(task.id)}|Gantrix>.`,
          };
        }
        const approval = await this.#deps.db.query.approvals.findFirst({
          where: eq(approvals.id, e.approvalId),
        });
        const options = Array.isArray(approval?.args.options)
          ? approval.args.options.map(String)
          : [];
        return {
          text: [
            `:question: *${who}* asks: ${esc(e.question ?? String(approval?.args.question ?? ''))}`,
            ...options.map((o, i) => `${i + 1}. ${esc(o)}`),
            this.#socket
              ? `_Reply in this thread to answer${options.length ? ' (a number picks an option)' : ''}._`
              : `_Answer it in <${this.#link(task.id)}|Gantrix>._`,
          ].join('\n'),
          broadcast: true,
        };
      }
      case 'delegation.started': {
        const s = await this.#stepWithAgent(e.stepId);
        return {
          text: `:arrow_right_hook: *${s?.agent ?? 'An agent'}* handed “${esc(e.title)}” to *${e.agent}*`,
        };
      }
      case 'goal.judged':
        return e.passed
          ? null
          : {
              text: `:repeat: The goal isn't met yet, so the team is replanning. ${esc(clip(e.reason, 300))}`,
            };
      case 'task.team': {
        const names = await this.#teamNames({ ...task, agentIds: e.agentIds });
        return {
          text: `:busts_in_silhouette: Team: ${names.length ? names.join(', ') : 'every agent'}`,
        };
      }
      case 'task.status':
        switch (e.status) {
          case 'succeeded':
            return {
              text: `:tada: *${esc(projectTitle(task))}* is done.${task.result ? `\n${esc(clip(task.result, 700))}` : ''}\n<${this.#link(task.id)}|See the results>`,
              broadcast: true,
            };
          case 'failed':
            return {
              text: `:boom: The project failed: ${esc(clip(e.reason ?? '', 300))}`,
              broadcast: true,
            };
          case 'cancelled':
            return { text: ':octagonal_sign: The project was cancelled.' };
          case 'needs_attention':
            return e.reason === STOPPED_BY_USER
              ? { text: ':double_vertical_bar: Stopped. Mention me with "resume" to go on.' }
              : {
                  text: `:double_vertical_bar: Paused: ${esc(clip(e.reason ?? '', 300))}\nMention me with "extend 60m" to give it more time.`,
                  broadcast: true,
                };
          case 'running':
            return e.reason ? { text: `:arrow_forward: ${esc(e.reason)}` } : null;
          default:
            return null;
        }
      default:
        return null;
    }
  }

  // ── In: Slack → Gantrix ──────────────────────────────────────────────────

  /** One Events API event: an @mention, or a message in a channel the app is in. */
  async handle(ev: SlackEvent): Promise<void> {
    if (ev.type !== 'app_mention' && ev.type !== 'message') return;
    if (ev.bot_id || ev.subtype || !ev.user || !ev.ts || !ev.text) return;
    if (ev.channel !== this.#channel) return;
    // Slack can deliver an event twice; and a mention also arrives as a plain message.
    const key = `${ev.type === 'app_mention' ? 'm' : 'p'}:${ev.ts}`;
    if (this.#seen.includes(key)) return;
    this.#seen.push(key);
    if (this.#seen.length > 500) this.#seen.shift();
    const mention = ev.type === 'app_mention';
    if (!mention && (!ev.thread_ts || ev.text.includes(`<@${this.#botUserId}>`))) return;

    const threadTs = ev.thread_ts ?? ev.ts;
    const reply = (text: string) =>
      this.#api.call('chat.postMessage', {
        channel: ev.channel,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
      });
    const text = ev.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    const task = ev.thread_ts
      ? await this.#deps.db.query.tasks.findFirst({
          where: and(eq(tasks.slackChannel, ev.channel), eq(tasks.slackThreadTs, ev.thread_ts)),
        })
      : undefined;
    if (!task) {
      if (mention) await reply(await this.#overview());
      return;
    }
    const allowed = this.#deps.config.SLACK_ALLOWED_USERS.includes(ev.user);
    const denied = () =>
      reply(
        `Only people listed in SLACK_ALLOWED_USERS can change this project. Ask the Gantrix owner to add your Slack id (${ev.user}).`,
      );

    if (!mention) {
      if (!allowed) return void (await denied());
      return this.#reply(task, text, ev, reply);
    }
    await this.#command(task, text, allowed, reply, denied);
  }

  /** A plain reply in the thread: answers the oldest open question, or steers the team. */
  async #reply(task: Task, text: string, ev: SlackEvent, reply: (t: string) => Promise<unknown>) {
    const [question] = await this.#deps.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.taskId, task.id),
          eq(approvals.status, 'pending'),
          eq(approvals.tool, 'ask_user'),
        ),
      )
      .orderBy(asc(approvals.createdAt))
      .limit(1);
    if (question) {
      const options = Array.isArray(question.args.options) ? question.args.options.map(String) : [];
      const pick = /^\d+$/.test(text) ? options[Number(text) - 1] : undefined;
      await decideApproval(this.#deps, question.id, true, pick ?? text);
      await this.#react(ev, 'white_check_mark');
      return;
    }
    const sent = await sendMessage(this.#deps, task.id, { text: `(from Slack) ${text}` });
    if (sent.status === 'sent') await this.#react(ev, 'eyes');
    else
      await reply(
        'The project has finished, so nobody is listening. Mention me with "resume" first.',
      );
  }

  async #react(ev: SlackEvent, name: string): Promise<void> {
    await this.#api
      .call('reactions.add', { channel: ev.channel, timestamp: ev.ts, name })
      .catch(() => {}); // reactions:write is optional
  }

  async #command(
    task: Task,
    text: string,
    allowed: boolean,
    reply: (t: string) => Promise<unknown>,
    denied: () => Promise<unknown>,
  ): Promise<void> {
    const words = text.toLowerCase();
    if (!text || words === 'help') return void (await reply(SLACK_HELP));
    if (words === 'status') {
      return void (await reply(await projectStatus(this.#deps.db, task, this.#link(task.id))));
    }
    const team = /^(add|remove)\s+(.+)$/i.exec(text);
    const extend = /^extend\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?)?$/i.exec(text);
    const rename = /^rename\s+(.+)$/i.exec(text);
    const write = team || extend || rename || ['stop', 'resume', 'continue'].includes(words);
    if (write && !allowed) return void (await denied());

    if (team)
      return void (await reply(
        await this.#changeTeam(task, team[1] === 'add' ? 'add' : 'remove', team[2] ?? ''),
      ));
    if (extend) {
      const n = Number(extend[1]);
      const minutes = /^h/i.test(extend[2] ?? '') ? n * 60 : n;
      const r = await extendTask(this.#deps, task.id, { minutes });
      return void (await reply(
        r.status === 'finished'
          ? 'This project has finished; there is nothing to extend.'
          : `Added ${minutes} min. The time limit is now ${r.budget.maxMinutes} min.`,
      ));
    }
    if (rename) {
      await updateTask(this.#deps, task.id, { name: clip(rename[1] ?? '', 120) });
      return void (await reply(`Renamed to *${esc(clip(rename[1] ?? '', 120))}*.`));
    }
    if (words === 'stop') {
      const stopped = await stopTask(this.#deps, task.id);
      if (!stopped) await reply("It isn't running.");
      return; // the status post says it stopped
    }
    if (words === 'resume' || words === 'continue') {
      if (task.status !== 'needs_attention')
        return void (await reply('Only a stopped project can resume.'));
      await resumeTask(this.#deps, task.id);
      return;
    }
    await reply(await this.#answer(task, text));
  }

  async #changeTeam(task: Task, op: 'add' | 'remove', names: string): Promise<string> {
    const all = await this.#deps.db.select({ id: agents.id, name: agents.name }).from(agents);
    const wanted = names
      .split(/[\s,]+|\band\b/i)
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    const found = all.filter((a) => wanted.includes(a.name.toLowerCase()));
    const missing = wanted.filter((w) => !found.some((a) => a.name.toLowerCase() === w));
    if (!found.length) {
      return `I don't know ${missing.join(', ')}. Agents: ${all.map((a) => a.name).join(', ')}.`;
    }
    const current = new Set(task.agentIds ?? all.map((a) => a.id));
    if (op === 'add' && !task.agentIds) return 'Every agent can already work on this project.';
    for (const a of found) {
      if (op === 'add') current.add(a.id);
      else current.delete(a.id);
    }
    if (!current.size) return 'A project needs at least one agent.';
    await setTeam(this.#deps, task.id, [...current]);
    const verb = op === 'add' ? 'Added' : 'Removed';
    return `${verb} ${found.map((a) => `*${a.name}*`).join(', ')}.${missing.length ? ` I don't know ${missing.join(', ')}.` : ''}${op === 'add' ? ' They pick up work from the next plan, or reassign a task to them.' : ''}`;
  }

  async #answer(task: Task, question: string): Promise<string> {
    const { db, config } = this.#deps;
    const facts = await projectFacts(db, task);
    const model = createChatModel(
      await resolveModelSpec(db, config, null),
      'planner',
      modelDefaults(config),
    );
    const res = await model.invoke(
      [
        new SystemMessage(QUESTION_SYSTEM),
        new HumanMessage(`Facts:\n${facts}\n\nQuestion: ${question}`),
      ],
      { signal: AbortSignal.timeout(120_000) },
    );
    const text = (typeof res.content === 'string' ? res.content : res.text)
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
    return text || "I couldn't work that out. Try “@Gantrix status”.";
  }

  /** A mention outside a project thread: the projects that post here. */
  async #overview(): Promise<string> {
    const rows = await this.#deps.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.slack, true),
          inArray(tasks.status, ['planning', 'running', 'awaiting_approval']),
        ),
      );
    if (!rows.length) {
      return `No projects are running with Slack updates. Start one in <${this.#deps.config.GANTRIX_DASHBOARD_URL}|Gantrix> and turn on "Post to Slack".`;
    }
    return [
      '*Running projects* (reply in a project’s thread to talk to it):',
      ...rows.map(
        (t) => `• <${this.#link(t.id)}|${esc(projectTitle(t))}>: ${t.status.replace('_', ' ')}`,
      ),
    ].join('\n');
  }
}
