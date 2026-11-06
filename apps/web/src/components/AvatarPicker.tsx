import type { AgentDto } from '@gantrix/shared';
import { type ChangeEvent, useState } from 'react';
import { api } from '../api.ts';
import { avatarChoice, PRESETS, PresetAvatar } from './AgentAvatar.tsx';
import { Icon } from './Icon.tsx';
import { Avatar } from './ui.tsx';

const SIZE = 128;

/** Any picture the browser can open, cropped to a centred square and saved as 128px WebP. */
async function toAvatar(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
  }
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("This browser can't resize images.");
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  );
  const webp = canvas.toDataURL('image/webp', 0.85);
  // Browsers that can't encode WebP return PNG data; the API accepts both.
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

export function AvatarPicker({ agent, onSaved }: { agent: AgentDto; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = avatarChoice(agent.name, agent.avatar);

  const save = async (avatar: string | null) => {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/api/agents/${agent.id}`, { avatar });
      onSaved();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await save(await toAvatar(file));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="avatar-picker">
      <button
        type="button"
        className="avatar-button"
        aria-expanded={open}
        aria-label={`Change ${agent.name}'s avatar`}
        onClick={() => setOpen(!open)}
      >
        <Avatar name={agent.name} avatar={agent.avatar} size={44} />
        <span className="avatar-edit" aria-hidden="true">
          <Icon name="plus" size={12} />
        </span>
      </button>
      {open && (
        <fieldset className="avatar-panel">
          <legend className="sr-only">Avatar for {agent.name}</legend>
          <div className="avatar-grid">
            {PRESETS.map((p) => {
              const selected = current.kind === 'preset' && current.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`avatar-option${selected ? ' selected' : ''}`}
                  aria-pressed={selected}
                  title={p.label}
                  disabled={busy}
                  onClick={() => void save(`preset:${p.id}`)}
                >
                  <PresetAvatar id={p.id} size={40} />
                  <span className="sr-only">{p.label}</span>
                </button>
              );
            })}
          </div>
          <div className="row-actions">
            <label className="button ghost small upload">
              <Icon name="file" size={14} /> Upload image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                onChange={(e) => void upload(e)}
                disabled={busy}
              />
            </label>
            <button
              type="button"
              className="ghost small"
              disabled={busy}
              onClick={() => void save('initials')}
            >
              Initials
            </button>
            <button
              type="button"
              className="ghost small"
              disabled={busy}
              onClick={() => void save(null)}
            >
              Default
            </button>
          </div>
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
        </fieldset>
      )}
    </div>
  );
}
