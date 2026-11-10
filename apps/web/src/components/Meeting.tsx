import {
  type AgentDto,
  isTerminal,
  mentionedAgents,
  type StreamEvent,
  type TaskDetailDto,
} from '@gantrix/shared';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { label } from '../format.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Avatar } from './ui.tsx';

type Speaker = 'planner' | 'agent' | 'judge' | 'you' | 'system';

interface Line {
  id: number;
  at: string;
  speaker: Speaker;
  /** Shown above the text: the agent's name, "Planner", "Judge", "You". */
  name: string;
  text: string;
  /** Tool calls and receipts: shown smaller, as asides. */
  aside?: boolean;
}

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The task's events as a conversation between the planner, the agents, the judge and you. */
export function meetingLines(
  events: StreamEvent[],
  task: TaskDetailDto,
  agentNames: Map<string, { name: string }>,
): Line[] {
  const steps = new Map(task.steps.map((s) => [s.id, s]));
  const plans = new Map(task.plans.map((p) => [p.version, p]));
  const who = (stepId: string) => {
    const s = steps.get(stepId);
    return (s?.agentId && agentNames.get(s.agentId)?.name) || 'agent';
  };
  const lines: Line[] = [];
  const say = (e: StreamEvent, speaker: Speaker, name: string, text: string, aside = false) =>
    lines.push({ id: e.id, at: e.at, speaker, name, text, ...(aside ? { aside } : {}) });

  for (const e of events) {
    switch (e.type) {
      case 'task.status':
        if (e.status === 'planning' && e.reason)
          say(e, 'planner', 'Planner', `Replanning: ${e.reason}.`);
        else if (isTerminal(e.status)) {
          say(
            e,
            'system',
            'Gantrix',
            `Project ${label(e.status)}${e.reason ? `: ${e.reason.replace(/\.$/, '')}` : ''}.`,
          );
        }
        break;
      case 'plan.created': {
        const plan = plans.get(e.version);
        const list = e.stepKeys
          .map((k) => {
            const s = task.steps.find((x) => x.key === k && x.planVersion === e.version);
            const agent = s?.agentId ? agentNames.get(s.agentId)?.name : undefined;
            return `${k}${agent ? ` (${agent})` : ''}`;
          })
          .join(', ');
        say(
          e,
          'planner',
          'Planner',
          `Plan v${e.version}: ${list}.${plan?.reason || e.reason ? ` ${plan?.reason || e.reason}` : ''}`,
        );
        break;
      }
      case 'step.status': {
        const s = steps.get(e.stepId);
        const title = s?.title ?? e.key;
        if (e.status === 'running') {
          say(
            e,
            'agent',
            who(e.stepId),
            e.attempt > 1
              ? `Trying "${title}" again (attempt ${e.attempt}).`
              : `Starting "${title}".`,
          );
        } else if (e.status === 'judging') {
          // The latest output is on the step; earlier attempts' replies are in the Logs page.
          const out =
            s && s.attempt === e.attempt && s.output
              ? clip(s.output)
              : 'Finished; over to the judge.';
          say(e, 'agent', who(e.stepId), out);
        } else if (e.status === 'succeeded') {
          say(
            e,
            'judge',
            'Judge',
            `Passed ${e.key}${s?.judgeReason && s.attempt === e.attempt ? `: ${s.judgeReason}` : ''}`,
          );
        } else if (e.status === 'failed') {
          say(
            e,
            'judge',
            'Judge',
            `Failed ${e.key}${s?.judgeReason || s?.error ? `: ${s?.judgeReason || s?.error}` : ''}`,
          );
        }
        break;
      }
      case 'step.tool_call':
        say(
          e,
          'agent',
          who(e.stepId),
          `${e.tool} ${clip(e.summary, 140)}${e.autoApproved ? '' : ''}`,
          true,
        );
        break;
      case 'approval.requested':
        say(
          e,
          'agent',
          who(e.stepId),
          e.question ? `Question for you: ${e.question}` : `I need your OK to run ${e.tool}.`,
        );
        break;
      case 'approval.decided':
        say(e, 'you', 'You', e.answer ? e.answer : e.approved ? 'Approved.' : 'Skipped or denied.');
        break;
      case 'goal.judged':
        say(e, 'judge', 'Judge', `Goal ${e.passed ? 'met' : 'not met yet'}: ${e.reason}`);
        break;
      case 'budget.exceeded':
        say(e, 'system', 'Gantrix', `Budget exceeded (${e.limit}): ${e.detail}`);
        break;
      case 'user.message': {
        const tagged = mentionedAgents(e.text, [...agentNames.values()]).map((a) => a.name);
        const to = e.stepId ? who(e.stepId) : tagged.length ? tagged.join(', ') : 'everyone';
        say(e, 'you', `You to ${to}`, e.text);
        break;
      }
      case 'step.edited': {
        const what = e.fields.length ? `changed ${e.fields.join(', ')} of` : 'touched';
        say(
          e,
          'you',
          'You',
          `${e.rerun ? 'Reran' : 'Edited'} ${e.key}${e.fields.length ? ` (${what} it)` : ''}.`,
        );
        break;
      }
      case 'task.team':
        say(
          e,
          'you',
          'You',
          e.agentIds
            ? `Changed the team to ${e.agentIds.length} agents.`
            : 'Opened the project to every agent.',
        );
        break;
      case 'user.message_delivered':
        say(e, 'agent', who(e.stepId), 'Read your note.', true);
        break;
    }
  }
  return lines;
}

const OPEN_STEP = new Set([
  'pending',
  'queued',
  'running',
  'judging',
  'awaiting_approval',
  'delegating',
]);

/** The "@partial" being typed just before the caret, or undefined when there is none. */
export function mentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | undefined {
  const match = /(?:^|[^\p{L}\p{N}_.])@([^@\n]{0,40})$/u.exec(text.slice(0, caret));
  if (!match) return undefined;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}

/** The project's agents whose name starts with what was typed after "@". */
export function mentionOptions<A extends { name: string }>(team: readonly A[], query: string): A[] {
  const q = query.toLowerCase();
  return team.filter((a) => a.name.toLowerCase().startsWith(q)).slice(0, 8);
}

type TeamMember = Pick<AgentDto, 'id' | 'name'> & { avatar?: string | null };

function Composer({
  task,
  agentNames,
  to,
  setTo,
}: {
  task: TaskDetailDto;
  agentNames: Map<string, { name: string }>;
  to: string;
  setTo: (stepId: string) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string }>();
  const [highlight, setHighlight] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const open = task.steps.filter((s) => OPEN_STEP.has(s.status));
  const team: TeamMember[] = [...agentNames.entries()]
    .filter(([id]) => !task.agentIds?.length || task.agentIds.includes(id))
    .map(([id, a]) => ({ id, ...a }));
  const options = mention ? mentionOptions(team, mention.query) : [];
  const tagged = to ? [] : mentionedAgents(text, team);
  const taggedSteps = tagged.length === 1 ? open.filter((s) => s.agentId === tagged[0]?.id) : [];
  const route = !tagged.length
    ? ''
    : taggedSteps.length === 1
      ? `Goes to ${tagged[0]?.name} on ${taggedSteps[0]?.key}.`
      : `The planner gives this to ${tagged.map((a) => a.name).join(', ')}.`;
  if (isTerminal(task.status)) {
    return (
      <p className="muted small">
        {task.status === 'needs_attention'
          ? 'The project is stopped. Resume or add time to keep going.'
          : 'This project has finished. Start a new project to keep going.'}
      </p>
    );
  }
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/tasks/${task.id}/messages`, { text, ...(to ? { stepId: to } : {}) });
      setText('');
      setMention(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const track = (value: string, caret: number) => {
    setText(value);
    setMention(mentionQuery(value, caret));
    setHighlight(0);
  };
  const pick = (agent: TeamMember) => {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    const insert = `@${agent.name} `;
    const next = text.slice(0, mention.start) + insert + text.slice(end);
    setText(next);
    setMention(undefined);
    const caret = mention.start + insert.length;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHighlight((h) => (h + step + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const agent = options[highlight];
        if (agent) pick(agent);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(undefined);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
  };
  return (
    <form className="composer" onSubmit={(e) => void send(e)}>
      <label className="sr-only" htmlFor="chat-to">
        Send to
      </label>
      <select id="chat-to" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">Everyone (the plan changes after running tasks finish)</option>
        {open.map((s) => (
          <option key={s.id} value={s.id}>
            {(s.agentId && agentNames.get(s.agentId)?.name) || 'agent'} · {s.key} ({label(s.status)}
            )
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="chat-text">
        Message
      </label>
      <div className="mention-field">
        <textarea
          id="chat-text"
          ref={input}
          rows={2}
          value={text}
          onChange={(e) => track(e.target.value, e.target.selectionStart)}
          onBlur={() => setMention(undefined)}
          placeholder={
            to
              ? 'A note for this agent; it reads it before its next turn.'
              : 'Change the plan, add a requirement, correct a mistake… Type @ to tag an agent.'
          }
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls="chat-mentions"
          aria-autocomplete="list"
          aria-activedescendant={options.length ? `chat-mention-${highlight}` : undefined}
          onKeyDown={onKeyDown}
        />
        {options.length > 0 && (
          <div id="chat-mentions" className="mention-list" role="listbox" aria-label="Agents">
            {options.map((a, i) => (
              <div
                key={a.id}
                id={`chat-mention-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === highlight}
                className={`mention-option${i === highlight ? ' active' : ''}`}
                // mousedown, not click: a click would blur the textarea and close the list first
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(a);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <Avatar name={a.name} avatar={a.avatar ?? null} size={20} />
                {a.name}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="composer-foot">
        <span className="muted small">{route || 'Ctrl or Cmd + Enter sends'}</span>
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          <Icon name="send" size={14} /> {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

const SPEAKER_ICON: Record<Exclude<Speaker, 'agent'>, IconName> = {
  planner: 'list',
  judge: 'gavel',
  you: 'chat',
  system: 'dot',
};

export function Meeting({
  task,
  events,
  agentNames,
  target,
  onTarget,
}: {
  task: TaskDetailDto;
  events: StreamEvent[];
  agentNames: Map<string, { name: string }>;
  target: string;
  onTarget: (stepId: string) => void;
}) {
  const lines = meetingLines(events, task, agentNames);
  const avatarOf = new Map(
    [...agentNames.values()].map((a) => [a.name, (a as { avatar?: string | null }).avatar ?? null]),
  );
  const end = useRef<HTMLLIElement>(null);
  // Follow the conversation as it grows, like a chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a line arrives
  useEffect(() => {
    // Braces matter: scrollIntoView returns a Promise in current Chrome, and React would treat a
    // returned value as the effect's cleanup function.
    void end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length]);
  return (
    <div className="meeting">
      <ol className="meeting-lines" aria-live="polite" aria-relevant="additions">
        {lines.map((l) => (
          <li key={l.id} className={`line line-${l.speaker}${l.aside ? ' aside' : ''}`}>
            {l.speaker === 'agent' ? (
              <Avatar name={l.name} avatar={avatarOf.get(l.name)} size={32} />
            ) : (
              <span className={`speaker speaker-${l.speaker}`} aria-hidden="true">
                <Icon name={SPEAKER_ICON[l.speaker]} size={16} />
              </span>
            )}
            <div className="bubble">
              <div className="line-head">
                <b>{l.name}</b>
                <time className="muted small">{new Date(l.at).toLocaleTimeString()}</time>
              </div>
              <p>{l.text}</p>
            </div>
          </li>
        ))}
        <li ref={end} className="line-end" />
      </ol>
      <Composer task={task} agentNames={agentNames} to={target} setTo={onTarget} />
    </div>
  );
}
