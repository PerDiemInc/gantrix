import { projectTitle, type TaskDto } from '@gantrix/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { go } from '../hooks.ts';
import { Icon } from './Icon.tsx';

export interface SlackStatus {
  /** Bot token + channel are set: projects can post. */
  posts: boolean;
  /** Socket Mode is set too: replies in the thread reach the project. */
  replies: boolean;
  channel: string | null;
}

let slackCache: Promise<SlackStatus> | null = null;
/** Whether Slack is set up on the server (asked once per page load). */
export function useSlackStatus(): SlackStatus | null {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  useEffect(() => {
    slackCache ??= api
      .get<SlackStatus>('/api/slack')
      .catch(() => ({ posts: false, replies: false, channel: null }));
    void slackCache.then(setStatus);
  }, []);
  return status;
}

/** The project's name as a heading, with Rename. */
export function ProjectName({ task, onChange }: { task: TaskDto; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.patch(`/api/tasks/${task.id}`, { name: value.trim() || null });
      setEditing(false);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (editing) {
    return (
      <form className="rename" onSubmit={(e) => void save(e)}>
        <label className="sr-only" htmlFor="project-name">
          Project name
        </label>
        <input
          id="project-name"
          value={value}
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          placeholder={projectTitle({ ...task, name: null })}
          // biome-ignore lint/a11y/noAutofocus: opened by the Rename button
          autoFocus
        />
        <button type="submit" className="primary small">
          Save
        </button>
        <button type="button" className="ghost small" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
      </form>
    );
  }
  return (
    <div className="project-name">
      <h1>{projectTitle(task)}</h1>
      <button
        type="button"
        className="ghost small icon-only"
        aria-label="Rename project"
        title="Rename"
        onClick={() => {
          setValue(task.name ?? '');
          setEditing(true);
        }}
      >
        <Icon name="edit" size={14} />
      </button>
    </div>
  );
}

/** Turns a project's Slack updates on or off; hidden when Slack isn't set up. */
export function SlackSwitch({ task, onChange }: { task: TaskDto; onChange: () => void }) {
  const slack = useSlackStatus();
  const [busy, setBusy] = useState(false);
  if (!slack?.posts) return null;
  const toggle = async () => {
    setBusy(true);
    await api.patch(`/api/tasks/${task.id}`, { slack: !task.slack }).catch(() => {});
    setBusy(false);
    onChange();
  };
  return (
    <label
      className="inline switch small"
      title={
        slack.replies
          ? 'Progress goes to a Slack thread; replies there steer the project'
          : 'Progress goes to a Slack thread'
      }
    >
      <input
        type="checkbox"
        role="switch"
        aria-checked={task.slack}
        checked={task.slack}
        disabled={busy}
        onChange={() => void toggle()}
      />
      <Icon name="hash" size={14} /> Slack
    </label>
  );
}

/** Delete, with a confirmation dialog that says exactly what goes. */
export function DeleteProject({ task }: { task: TaskDto }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api.del(`/api/tasks/${task.id}`);
      dialog.current?.close();
      go('/projects');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="ghost danger" onClick={() => dialog.current?.showModal()}>
        <Icon name="trash" size={14} /> Delete
      </button>
      <dialog ref={dialog} className="confirm-dialog" aria-labelledby="delete-title">
        <h2 id="delete-title">Delete “{projectTitle(task)}”?</h2>
        <p>
          This removes the project, its tasks, chat and history, and the files in its workspace.
          Sites it deployed stay. You can't undo this.
        </p>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row-actions">
          <button
            type="button"
            className="danger-solid"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? 'Deleting…' : 'Delete project'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => dialog.current?.close()}
            // biome-ignore lint/a11y/noAutofocus: the safe choice gets focus, so Enter doesn't delete
            autoFocus
          >
            Keep it
          </button>
        </div>
      </dialog>
    </>
  );
}
