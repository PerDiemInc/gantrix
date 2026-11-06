import type { StreamEvent } from '@gantrix/shared';

const TOKEN_KEY = 'gantrix.token';

// The token lives in this browser only. Storage can be unavailable (private mode), so every
// access is guarded and the app falls back to asking again.
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const auth = (): Record<string, string> => ({ authorization: `Bearer ${getToken()}` });

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? auth() : { ...auth(), 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await response.text();
  const data =
    text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!response.ok) throw new ApiError(response.status, data?.error ?? response.statusText);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: (path: string) => request<void>('DELETE', path),
};

/**
 * Follows /api/stream with fetch (EventSource can't send the Authorization header).
 * Reconnects after drops and resumes with Last-Event-ID. Returns a function that stops it.
 */
export function subscribe(path: string, onEvent: (event: StreamEvent) => void): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let lastId = 0;
  void (async () => {
    while (!signal.aborted) {
      try {
        const response = await fetch(path, {
          headers: lastId ? { ...auth(), 'last-event-id': String(lastId) } : auth(),
          signal,
        });
        if (!response.ok || !response.body) throw new ApiError(response.status, 'stream failed');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const id = /^id: (\d+)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (id && data) {
              lastId = Number(id);
              onEvent({ ...JSON.parse(data), id: lastId } as StreamEvent);
            }
            end = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // dropped or refused; retry below
      }
      if (!signal.aborted) await new Promise((r) => setTimeout(r, 1_500));
    }
  })();
  return () => controller.abort();
}
