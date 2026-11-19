import type { DiscussionDto, DiscussionMessageDto, DiscussionReplyDto } from '@gantrix/shared';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { chatMarkdown } from '../markdown.ts';
import { Icon } from './Icon.tsx';
import { Avatar } from './ui.tsx';

/** Things worth asking first, for someone who opens the panel and doesn't know where to start. */
export const STARTERS = [
  'Where does the project stand?',
  "What's blocking us?",
  'What happens next?',
  'Is it on track to finish in time?',
];

/** The answer takes a while on a local model, so it says so instead of looking stuck. */
function Waiting({ owner, slow }: { owner: string; slow: boolean }) {
  return (
    <li className="line line-owner" aria-live="polite">
      <span className="speaker speaker-system" aria-hidden="true">
        <Icon name="clock" size={16} />
      </span>
      <div className="bubble">
        <p className="muted">
          {owner} is looking at the project…
          {slow && ' This is taking a while: the model may still be starting or loading.'}
        </p>
      </div>
    </li>
  );
}

/**
 * A conversation with the project's owner about where it stands. The owner answers from the
 * project's current state each time, so asking again later gives a fresh answer. It can't change
 * anything: notes to the team go through the Team chat.
 */
export function OwnerChat({ taskId }: { taskId: string }) {
  const [owner, setOwner] = useState<DiscussionDto['owner'] | null>(null);
  const [messages, setMessages] = useState<DiscussionMessageDto[]>([]);
  const [text, setText] = useState('');
  const [asking, setAsking] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [slow, setSlow] = useState(false);
  const end = useRef<HTMLLIElement>(null);

  useEffect(() => {
    let live = true;
    setOwner(null);
    setMessages([]);
    setLoadError('');
    api.get<DiscussionDto>(`/api/tasks/${taskId}/discussion`).then(
      (d) => {
        if (!live) return;
        setOwner(d.owner);
        setMessages(d.messages);
      },
      (e: Error) => live && setLoadError(e.message),
    );
    return () => {
      live = false;
    };
  }, [taskId]);

  // Follow the conversation as it grows, like the Team chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message arrives or the owner is thinking
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, asking]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(q);
    setError('');
    setSlow(false);
    // A local model can take a while to load, or Ollama may be starting: say so, not nothing.
    const timer = setTimeout(() => setSlow(true), 6_000);
    try {
      const r = await api.post<DiscussionReplyDto>(`/api/tasks/${taskId}/discussion`, { text: q });
      setMessages((list) => [...list, ...r.messages]);
      if (r.startedOllama) setNotice("Ollama wasn't running, so Gantrix started it.");
      setText('');
    } catch (err) {
      // Nothing was saved, so the question stays in the box to send again.
      setText(q);
      setError((err as Error).message);
    }
    clearTimeout(timer);
    setAsking('');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(text);
    }
  };

  if (loadError) {
    return (
      <p className="error" role="alert">
        {loadError}
      </p>
    );
  }
  if (!owner) return <p className="muted">Loading…</p>;

  return (
    <div className="meeting owner-chat">
      <p className="muted small owner-intro">
        <Avatar name={owner.name} avatar={owner.avatar} size={20} />
        <span>
          You're talking with <b>{owner.name}</b>, who answers from the project's live status. To
          change what the team does, use the Team chat.
        </span>
      </p>
      {notice && (
        <p className="muted small" role="status">
          {notice}
        </p>
      )}
      <ol className="meeting-lines" aria-live="polite" aria-relevant="additions">
        {!messages.length && !asking && (
          <li className="owner-starters">
            <span className="muted small">Ask about…</span>
            <div className="chips">
              {STARTERS.map((q) => (
                <button key={q} type="button" className="chip" onClick={() => void ask(q)}>
                  {q}
                </button>
              ))}
            </div>
          </li>
        )}
        {messages.map((m) => (
          <li key={m.id} className={`line line-${m.role === 'user' ? 'you' : 'owner'}`}>
            {m.role === 'owner' ? (
              <Avatar name={owner.name} avatar={owner.avatar} size={32} />
            ) : (
              <span className="speaker speaker-you" aria-hidden="true">
                <Icon name="chat" size={16} />
              </span>
            )}
            <div className="bubble">
              <div className="line-head">
                <b>{m.role === 'user' ? 'You' : owner.name}</b>
                <time
                  className="muted small"
                  dateTime={m.createdAt}
                  title={new Date(m.createdAt).toLocaleString()}
                >
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
              </div>
              {m.role === 'user' ? (
                <p>{m.text}</p>
              ) : (
                <div
                  className="md"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: chatMarkdown escapes raw HTML and only links http(s)/mailto
                  dangerouslySetInnerHTML={{ __html: chatMarkdown(m.text) }}
                />
              )}
            </div>
          </li>
        ))}
        {asking && (
          <>
            <li className="line line-you">
              <span className="speaker speaker-you" aria-hidden="true">
                <Icon name="chat" size={16} />
              </span>
              <div className="bubble">
                <div className="line-head">
                  <b>You</b>
                </div>
                <p>{asking}</p>
              </div>
            </li>
            <Waiting owner={owner.name} slow={slow} />
          </>
        )}
        <li ref={end} className="line-end" />
      </ol>
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="owner-text">
          Ask {owner.name}
        </label>
        <textarea
          id="owner-text"
          rows={2}
          value={text}
          maxLength={4000}
          disabled={Boolean(asking)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Ask ${owner.name} how it's going…`}
        />
        <div className="composer-foot">
          <span className="muted small">Enter sends · Shift + Enter for a new line</span>
          <button type="submit" className="primary" disabled={Boolean(asking) || !text.trim()}>
            <Icon name="send" size={14} /> {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
