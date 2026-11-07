import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { previewKind, Thumbnail } from './FilePreview.tsx';
import { Icon } from './Icon.tsx';

/** An agent's ask_user question: pick an option, write an answer, or skip. */
/** The workspace file an answer option names, if it is a page or an image we can preview. */
export function fileFor(option: string, files: string[], stepId?: string): string | undefined {
  const o = option.trim().replace(/^\.\//, '').toLowerCase();
  // The marker, or this step's own folder when a long listing was cut off before the marker.
  // A legacy project that merely has a steps/ folder doesn't count.
  const isolated =
    files.includes('.isolated-steps') ||
    (!!stepId && files.some((f) => f.startsWith(`steps/${stepId}/`)));
  // A question belongs to one execution workspace, never another agent's mutable output.
  // Legacy projects without isolation keep their original root-relative preview behavior.
  if (isolated && !stepId) return undefined;
  const prefix = isolated ? `steps/${stepId}/` : '';
  const candidates = files.filter((f) => {
    if (prefix && !f.startsWith(prefix)) return false;
    const kind = previewKind(f);
    return kind === 'html' || kind === 'image';
  });
  const relative = (file: string) => file.slice(prefix.length).toLowerCase();
  const exact = candidates.find((f) => relative(f) === o);
  if (exact) return exact;
  // Basename shortcuts are useful, but an ambiguous thumbnail is worse than no thumbnail.
  const matches = candidates.filter((f) => {
    const base = relative(f).split('/').pop() ?? '';
    return base === o || base.replace(/\.[a-z]+$/, '') === o;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function QuestionCard({
  id,
  taskId,
  stepId,
  who,
  args,
  onDone,
}: {
  id: string;
  /** Lets options that name a mockup or image show a preview. */
  taskId?: string;
  /** The execution workspace of the question, for isolated projects. */
  stepId?: string;
  /** The agent or task asking, e.g. "designer · pick_style". */
  who: string;
  args: Record<string, unknown>;
  onDone?: () => void;
}) {
  const question = String(args.question ?? '');
  const options = Array.isArray(args.options) ? args.options.map(String) : [];
  const why = typeof args.why === 'string' ? args.why : '';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!taskId || !options.length) return;
    api
      .get<{ files: string[] }>(`/api/tasks/${taskId}/files`)
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, [taskId, options.length]);
  const previews = options.map((o) => fileFor(o, files, stepId));
  const visual = previews.some(Boolean);

  const send = async (answer: string | null) => {
    setBusy(true);
    setError('');
    try {
      await api.post(
        `/api/approvals/${id}`,
        answer ? { approved: true, answer } : { approved: false },
      );
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) void send(text.trim());
  };

  return (
    <section className="question" aria-label={`Question from ${who}`}>
      <p className="question-who small">
        <Icon name="chat" size={14} /> {who} asks
      </p>
      <p className="question-text">{question}</p>
      {why && <p className="muted small">{why}</p>}
      {options.length > 0 && (
        <div className={visual ? 'question-options visual' : 'question-options'}>
          {options.map((o, i) => {
            const file = previews[i];
            return (
              <button
                key={o}
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void send(o)}
              >
                {file && taskId ? <Thumbnail taskId={taskId} path={file} label={o} /> : o}
              </button>
            );
          })}
        </div>
      )}
      <form className="question-answer" onSubmit={submit}>
        <label className="sr-only" htmlFor={`answer-${id}`}>
          Your answer
        </label>
        <input
          id={`answer-${id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={options.length ? 'Or write your own answer' : 'Your answer'}
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          <Icon name="send" size={14} /> Answer
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void send(null)}>
          Skip
        </button>
      </form>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
