import { marked } from 'marked';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

export type PreviewKind = 'markdown' | 'html' | 'image' | 'text';

export function previewKind(path: string): PreviewKind {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  return 'text';
}

/** "design/mockups/a.html" + "../tokens.css" → "design/tokens.css"; null if it leaves the folder. */
export function resolveRelative(from: string, href: string): string | null {
  if (/^([a-z]+:|\/\/|#|data:)/i.test(href) || href.startsWith('/')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of href.split(/[?#]/)[0]?.split('/') ?? []) {
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// Agent-written pages are untrusted: no scripts, no network, only inline styles and embedded
// images. The iframe sandbox also gives the page its own origin, away from the token.
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

const MD_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 "IBM Plex Sans", system-ui, -apple-system, sans-serif; max-width: 76ch;
    margin: 24px auto; padding: 0 20px; color: CanvasText; background: Canvas; }
  h1, h2, h3 { line-height: 1.25; }
  pre, code { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.92em; }
  pre { padding: 12px 14px; border-radius: 8px; overflow-x: auto;
    background: color-mix(in srgb, CanvasText 6%, Canvas); }
  table { border-collapse: collapse; margin: 12px 0; }
  th, td { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); padding: 6px 10px;
    text-align: left; vertical-align: top; }
  img { max-width: 100%; }
  blockquote { margin: 0; padding-left: 14px; border-left: 3px solid color-mix(in srgb, CanvasText 25%, Canvas); }`;

async function fileText(taskId: string, path: string) {
  return api.get<string>(`/api/tasks/${taskId}/files/content?path=${encodeURIComponent(path)}`);
}
async function fileDataUrl(taskId: string, path: string): Promise<string | null> {
  try {
    const r = await api.get<{ mime: string; base64: string }>(
      `/api/tasks/${taskId}/files/content?path=${encodeURIComponent(path)}&encoding=base64`,
    );
    return `data:${r.mime};base64,${r.base64}`;
  } catch {
    return null;
  }
}

/** Puts the stylesheets and images a page links to (inside the workspace) into the page itself. */
async function inlineAssets(taskId: string, path: string, html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')) {
    const target = resolveRelative(path, link.getAttribute('href') ?? '');
    if (!target) continue;
    const css = await fileText(taskId, target).catch(() => null);
    if (css === null) continue;
    const style = doc.createElement('style');
    style.textContent = css;
    link.replaceWith(style);
  }
  for (const img of doc.querySelectorAll<HTMLImageElement>('img[src]')) {
    const target = resolveRelative(path, img.getAttribute('src') ?? '');
    const url = target ? await fileDataUrl(taskId, target) : null;
    if (url) img.setAttribute('src', url);
  }
  // Scripts wouldn't run anyway; remove them so the source of the preview stays readable.
  for (const s of doc.querySelectorAll('script')) s.remove();
  const meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = CSP;
  doc.head.prepend(meta);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

async function markdownPage(taskId: string, path: string, text: string): Promise<string> {
  const body = await marked.parse(text, { gfm: true });
  return inlineAssets(
    taskId,
    path,
    `<html><head><meta charset="utf-8"><style>${MD_STYLE}</style></head><body>${body}</body></html>`,
  );
}

export function FilePreview({ taskId, path }: { taskId: string; path: string }) {
  const kind = previewKind(path);
  const [mode, setMode] = useState<'preview' | 'source'>(kind === 'text' ? 'source' : 'preview');
  const [source, setSource] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setSource(null);
    setPage(null);
    setImage(null);
    setError('');
    setMode(kind === 'text' ? 'source' : 'preview');
    (async () => {
      if (kind === 'image') {
        const url = await fileDataUrl(taskId, path);
        if (live) url ? setImage(url) : setError('This image is too large or unreadable.');
        return;
      }
      const text = await fileText(taskId, path);
      if (!live) return;
      setSource(text);
      if (kind === 'markdown') setPage(await markdownPage(taskId, path, text));
      if (kind === 'html') setPage(await inlineAssets(taskId, path, text));
    })().catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [taskId, path, kind]);

  return (
    <div className="preview">
      <div className="preview-head">
        <span className="mono small">{path}</span>
        {(kind === 'markdown' || kind === 'html') && (
          <div className="segmented small-seg" role="tablist" aria-label="View">
            {(['preview', 'source'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? 'active' : ''}
                onClick={() => setMode(m)}
              >
                {m === 'preview' ? 'Preview' : 'Source'}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {kind === 'image' && image && (
        <img className="preview-image" src={image} alt={`Preview of ${path}`} />
      )}
      {mode === 'preview' && page && (
        <iframe
          className="preview-frame"
          title={`Preview of ${path}`}
          sandbox=""
          srcDoc={page}
          referrerPolicy="no-referrer"
        />
      )}
      {mode === 'source' && source !== null && <pre className="output">{source}</pre>}
      {!error && !image && !page && source === null && <p className="muted small">Loading…</p>}
    </div>
  );
}
