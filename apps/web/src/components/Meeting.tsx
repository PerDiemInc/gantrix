import { isTerminal, type StreamEvent, type TaskDetailDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { label } from '../format.ts';

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
          say(e, 'system', 'Gantrix', `Task ${label(e.status)}${e.reason ? `: ${e.reason}` : ''}.`);
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
            `✔ ${e.key}${s?.judgeReason && s.attempt === e.attempt ? `: ${s.judgeReason}` : ''}`,
          );
        } else if (e.status === 'failed') {
          say(
            e,
            'judge',
            'Judge',
            `✖ ${e.key}${s?.judgeReason || s?.error ? `: ${s?.judgeReason || s?.error}` : ''}`,
          );
        }
        break;
      }
      case 'step.tool_call':
        say(
          e,
          'agent',
          who(e.stepId),
          `→ ${e.tool} ${e.summary}${e.autoApproved ? ' ⚡' : ''}`,
          true,
        );
        break;
      case 'approval.requested':
        say(e, 'agent', who(e.stepId), `I need your OK to run ${e.tool}.`);
        break;
      case 'approval.decided':
        say(e, 'you', 'You', e.approved ? 'Approved.' : 'Denied.');
        break;
      case 'goal.judged':
        say(e, 'judge', 'Judge', `Goal ${e.passed ? 'met' : 'not met yet'}: ${e.reason}`);
        break;
      case 'budget.exceeded':
        say(e, 'system', 'Gantrix', `Budget exceeded (${e.limit}): ${e.detail}`);
        break;
      case 'user.message':
        say(e, 'you', e.stepId ? `You → ${who(e.stepId)}` : 'You → everyone', e.text);
        break;
      case 'user.message_delivered':
        say(e, 'agent', who(e.stepId), 'Read your note.', true);
        break;
    }
  }
  return lines;
}

const OPEN_STEP = new Set(['pending', 'queued', 'running', 'judging', 'awaiting_approval']);

function Composer({
  task,
  agentNames,
}: {
  task: TaskDetailDto;
  agentNames: Map<string, { name: string }>;
}) {
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const open = task.steps.filter((s) => OPEN_STEP.has(s.status));
  if (isTerminal(task.status)) {
    return <p className="muted small">The task has finished. Start a new task to keep going.</p>;
  }
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/tasks/${task.id}/messages`, { text, ...(to ? { stepId: to } : {}) });
      setText('');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <form className="composer" onSubmit={(e) => void send(e)}>
      <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send to">
        <option value="">Everyone (replans after running steps)</option>
        {open.map((s) => (
          <option key={s.id} value={s.id}>
            {(s.agentId && agentNames.get(s.agentId)?.name) || 'agent'} · {s.key} ({label(s.status)}
            )
          </option>
        ))}
      </select>
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          to
            ? 'A note for this agent; it reads it before its next turn.'
            : 'Change the plan, add a requirement, correct a mistake…'
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
        }}
      />
      <button type="submit" className="primary" disabled={busy || !text.trim()}>
        {busy ? 'Sending…' : 'Send'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export function Meeting({
  task,
  events,
  agentNames,
}: {
  task: TaskDetailDto;
  events: StreamEvent[];
  agentNames: Map<string, { name: string }>;
}) {
  const lines = meetingLines(events, task, agentNames);
  const end = useRef<HTMLLIElement>(null);
  // Follow the conversation as it grows, like a chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a line arrives
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [lines.length]);
  return (
    <div className="meeting">
      <ol className="meeting-lines">
        {lines.map((l) => (
          <li key={l.id} className={`line line-${l.speaker}${l.aside ? ' aside' : ''}`}>
            <span className="avatar" aria-hidden="true">
              {l.name
                .replace(/^You.*/, 'You')
                .slice(0, 2)
                .toUpperCase()}
            </span>
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
      <Composer task={task} agentNames={agentNames} />
    </div>
  );
}
