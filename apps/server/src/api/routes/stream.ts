import { and, asc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { events } from '../../db/schema.ts';
import type { EventRow } from '../event-hub.ts';
import { parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const HEARTBEAT_MS = 15_000;
const MAX_REPLAY = 5_000;

const StreamQuery = z.object({
  taskId: z.uuid().optional(),
  after: z.coerce.number().int().min(0).optional(),
});

/**
 * Server-Sent Events: GET /api/stream?taskId=… (one task) or without taskId (every task, live only).
 * Reconnecting clients send Last-Event-ID (or ?after=) and receive what they missed first.
 * Subscribing before the replay and de-duplicating by id means no event falls in the gap.
 */
export function streamRoutes(app: FastifyInstance, { db, hub }: ApiDeps): void {
  app.get('/api/stream', async (request, reply) => {
    const { taskId, after: afterParam } = parse(StreamQuery, request.query);
    const header = Number(request.headers['last-event-id']);
    const after = Number.isInteger(header) && header > 0 ? header : (afterParam ?? 0);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let lastSent = after;
    const send = (e: EventRow) => {
      if (e.id <= lastSent) return;
      lastSent = e.id;
      const data = { ...e.payload, taskId: e.taskId, at: e.createdAt };
      raw.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const buffered: EventRow[] = [];
    let replaying = true;
    const unsubscribe = hub.subscribe(taskId ?? '*', (e) =>
      replaying ? buffered.push(e) : send(e),
    );
    const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), HEARTBEAT_MS);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // A task stream replays its history; the all-tasks stream replays only after a reconnect.
    if (taskId || after > 0) {
      const missed = await db
        .select()
        .from(events)
        .where(taskId ? and(eq(events.taskId, taskId), gt(events.id, after)) : gt(events.id, after))
        .orderBy(asc(events.id))
        .limit(MAX_REPLAY);
      for (const e of missed) send(e);
    }
    replaying = false;
    for (const e of buffered.sort((a, b) => a.id - b.id)) send(e);
  });
}
