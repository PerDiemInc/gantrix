import type { FastifyInstance } from 'fastify';
import { sampleSystem } from '../../system.ts';

/** Memory, load and Docker containers on the machine Gantrix runs on. Read-only. */
export function systemRoutes(app: FastifyInstance): void {
  app.get('/api/system', async () => sampleSystem());
}
