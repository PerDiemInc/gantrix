/** One event from the Events API, as delivered over Socket Mode. */
export interface SlackEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

/**
 * Socket Mode: Slack pushes events over a WebSocket we open, so a local Gantrix needs no
 * public URL. Every envelope is acked first; then the event is handled. Reconnects on
 * Slack's "disconnect" (it rotates connections) and on errors, with backoff.
 */
export class SocketMode {
  readonly #appToken: string;
  readonly #base: string;
  readonly #onEvent: (event: SlackEvent) => Promise<void>;
  readonly #log: (message: string) => void;
  #ws: WebSocket | null = null;
  #closed = false;
  #delay = 1_000;

  constructor(
    appToken: string,
    base: string,
    onEvent: (event: SlackEvent) => Promise<void>,
    log: (message: string) => void = console.error,
  ) {
    this.#appToken = appToken;
    this.#base = base.replace(/\/$/, '');
    this.#onEvent = onEvent;
    this.#log = log;
  }

  start(): void {
    void this.#connect();
  }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    try {
      const res = await fetch(`${this.#base}/apps.connections.open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#appToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { ok: boolean; url?: string; error?: string };
      if (!json.ok || !json.url) throw new Error(json.error ?? `HTTP ${res.status}`);
      const ws = new WebSocket(json.url);
      this.#ws = ws;
      ws.addEventListener('message', (m) => this.#receive(ws, String(m.data)));
      ws.addEventListener('close', () => {
        if (this.#ws === ws) this.#retry();
      });
      ws.addEventListener('error', () => ws.close());
    } catch (error) {
      this.#log(`Slack Socket Mode: ${error instanceof Error ? error.message : String(error)}`);
      this.#retry();
    }
  }

  #retry(): void {
    this.#ws = null;
    if (this.#closed) return;
    const delay = this.#delay;
    this.#delay = Math.min(this.#delay * 2, 60_000);
    setTimeout(() => void this.#connect(), delay).unref();
  }

  #receive(ws: WebSocket, data: string): void {
    let envelope: {
      type?: string;
      envelope_id?: string;
      payload?: { event?: SlackEvent };
    };
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }
    if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (envelope.type === 'hello') this.#delay = 1_000;
    if (envelope.type === 'disconnect') ws.close();
    const event = envelope.type === 'events_api' ? envelope.payload?.event : undefined;
    if (event) {
      this.#onEvent(event).catch((error: unknown) =>
        this.#log(`Slack event: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }
}
