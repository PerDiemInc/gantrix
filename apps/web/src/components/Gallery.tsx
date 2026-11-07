import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { FilePreview, previewKind, Thumbnail } from './FilePreview.tsx';

/** Every design mockup (HTML under design/ or site/) and image in the project, as thumbnails. */
export function Gallery({ taskId, version }: { taskId: string; version: number }) {
  const [files, setFiles] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh as tasks finish
  useEffect(() => {
    api
      .get<{ files: string[] }>(`/api/tasks/${taskId}/files`)
      .then((r) =>
        setFiles(
          r.files.filter((f) => {
            const kind = previewKind(f);
            // Isolated projects keep each step's files in steps/<id>/; inputs/ holds copies.
            if (/(^|\/)inputs\//.test(f)) return false;
            return (
              kind === 'image' || (kind === 'html' && /^(steps\/[^/]+\/)?(design|site)\//.test(f))
            );
          }),
        ),
      )
      .catch(() => setFiles([]));
  }, [taskId, version]);
  if (!files.length) return null;
  return (
    <section className="card" aria-labelledby="gallery">
      <h2 id="gallery">Designs and images</h2>
      <ul className="gallery">
        {files.map((f) => (
          <li key={f}>
            <button
              type="button"
              className={`thumb-button${open === f ? ' active' : ''}`}
              aria-pressed={open === f}
              onClick={() => setOpen(open === f ? null : f)}
            >
              <Thumbnail taskId={taskId} path={f} />
            </button>
          </li>
        ))}
      </ul>
      {open && <FilePreview taskId={taskId} path={open} />}
    </section>
  );
}
