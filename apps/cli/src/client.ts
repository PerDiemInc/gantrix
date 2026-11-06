import type { StreamEvent } from '@gantrix/shared';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Client = ReturnType<typeof createClient>;

export function createClient(baseUrl: string, token: string) {
  const headers = { authorization: `Bearer ${token}` };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(baseUrl + path, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(
        0,
        `Can't reach the Gantrix API at ${baseUrl}. Is it running? (npm run dev:api)`,
      );
    }
    const text = await response.text();
    const data =
      text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
    if (!response.ok) throw new ApiError(response.status, data?.error ?? response.statusText);
    return data as T;
  }

  /**
   * Reads /api/stream until `signal` aborts, awaiting `onEvent` for each event in order.
   * Reconnects after a dropped connection and resumes with Last-Event-ID.
   */
  async function stream(
    path: string,
    onEvent: (event: StreamEvent) => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<void> {
    let lastId = 0;
    while (!signal.aborted) {
      try {
        const response = await fetch(baseUrl + path, {
          headers: lastId ? { ...headers, 'last-event-id': String(lastId) } : headers,
          signal,
        });
        if (!response.ok || !response.body) {
          throw new ApiError(response.status, `Stream failed: ${response.statusText}`);
        }
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const id = /^id: (\d+)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (id && data) {
              lastId = Number(id);
              await onEvent({ ...JSON.parse(data), id: lastId } as StreamEvent);
              if (signal.aborted) return;
            }
            end = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) throw error;
      }
      await new Promise((r) => setTimeout(r, 1_000)); // dropped: reconnect
    }
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    del: (path: string) => request<void>('DELETE', path),
    stream,
  };
}
