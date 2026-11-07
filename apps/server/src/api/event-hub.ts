import { EVENTS_CHANNEL, type EventNotice } from '@gantrix/shared';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import type { Db } from '../db/client.ts';
import { events } from '../db/schema.ts';

export type EventRow = typeof events.$inferSelect;
type Listener = (event: EventRow) => void;

export const ALL = '*';

/**
 * One Postgres LISTEN connection for the whole API process, fanned out to SSE clients.
 * NOTIFY carries ids only; the row is read once per event and shared by all listeners.
 * Reconnects with backoff; clients recover anything missed via Last-Event-ID replay.
 */
export class EventHub {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #db: Db;
  readonly #url: string;
  #client: pg.Client | null = null;
  #closed = false;

  constructor(db: Db, url: string) {
    this.#db = db;
    this.#url = url;
  }

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.#url });
    client.on('notification', (n) => void this.#deliver(n.payload));
    client.on('error', () => void this.#reconnect(client));
    client.on('end', () => void this.#reconnect(client));
    await client.connect();
    await client.query(`listen ${EVENTS_CHANNEL}`);
    this.#client = client;
  }

  /** Listen to one task's events, or to every task with "*". Returns the unsubscribe function. */
  subscribe(taskId: string | typeof ALL, listener: Listener): () => void {
    const set = this.#listeners.get(taskId) ?? new Set();
    set.add(listener);
    this.#listeners.set(taskId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.#listeners.delete(taskId);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#client?.end().catch(() => {});
  }

  async #deliver(payload: string | undefined): Promise<void> {
    if (!payload) return;
    const notice = JSON.parse(payload) as EventNotice;
    const targets = [
      ...(this.#listeners.get(notice.taskId) ?? []),
      ...(this.#listeners.get(ALL) ?? []),
    ];
    if (!targets.length) return;
    const row = await this.#db.query.events.findFirst({ where: eq(events.id, notice.id) });
    if (row) for (const listener of targets) listener(row);
  }

  async #reconnect(dead: pg.Client): Promise<void> {
    if (this.#closed || this.#client !== dead) return;
    this.#client = null;
    for (let delay = 500; !this.#closed; delay = Math.min(delay * 2, 10_000)) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        await this.start();
        return;
      } catch {
        // keep retrying
      }
    }
  }
}
