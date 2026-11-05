import { EVENTS_CHANNEL, type EventNotice, type GantrixEvent } from '@gantrix/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { events } from './db/schema.ts';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbExecutor = Db | Transaction;

/**
 * Records the event and announces it. Called inside a transaction, Postgres delivers the
 * NOTIFY only on commit, so listeners never hear about a change that rolled back.
 */
export async function emit(
  tx: DbExecutor,
  taskId: string,
  event: GantrixEvent,
  stepId?: string,
): Promise<number> {
  const [row] = await tx
    .insert(events)
    .values({ taskId, stepId: stepId ?? null, type: event.type, payload: event })
    .returning({ id: events.id });
  if (!row) throw new Error('Event insert returned no row');
  const notice: EventNotice = { taskId, id: row.id };
  await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(notice)})`);
  return row.id;
}
