import type { FastifyInstance } from 'fastify';
import { sampleLive } from '../../live.ts';
import { sampleSystem } from '../../system.ts';
import type { ApiDeps } from '../server.ts';

/** What this machine is doing: memory, load and containers, and who is working on which model. Read-only. */
export function systemRoutes(app: FastifyInstance, { db, config }: ApiDeps): void {
  app.get('/api/system', async () => sampleSystem());
  app.get('/api/live', async () => sampleLive(db, config));
}
