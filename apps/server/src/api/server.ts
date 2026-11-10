import Fastify, { type FastifyError } from 'fastify';
import type { EngineDeps } from '../engine/deps.ts';
import { bearerAuth } from './auth.ts';
import type { EventHub } from './event-hub.ts';
import { HttpError } from './http.ts';
import { agentRoutes } from './routes/agents.ts';
import { approvalRoutes } from './routes/approvals.ts';
import { connectionRoutes } from './routes/connections.ts';
import { skillRoutes } from './routes/skills.ts';
import { streamRoutes } from './routes/stream.ts';
import { taskRoutes } from './routes/tasks.ts';

export interface ApiDeps extends EngineDeps {
  hub: EventHub;
}

/** Postgres error code, whether Drizzle wrapped the error or not. */
const pgCode = (error: unknown): string | undefined => {
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof e.code === 'string' ? e.code : e.cause?.code;
  return typeof code === 'string' ? code : undefined;
};

export function buildServer(deps: ApiDeps, token: string, logger = true) {
  const app = Fastify({
    // The live-event streams never end on their own; without this, close() waits forever.
    forceCloseConnections: true,
    // Log paths without query strings, so nothing sensitive in a URL reaches the logs.
    logger: logger && {
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.split('?')[0] ?? '',
        }),
      },
    },
    bodyLimit: 1024 * 1024,
  });
  // Only when Gantrix listens on loopback: on purpose on another address, the Host is that one.
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(deps.config.GANTRIX_HOST);
  app.addHook('onRequest', bearerAuth(token, { checkHost: loopback }));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    const code = pgCode(error);
    if (code === '23505') return reply.code(409).send({ error: 'That name is already taken.' });
    if (code === '23503')
      return reply.code(400).send({ error: 'A referenced record does not exist.' });
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message }); // e.g. malformed JSON
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal error.' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  agentRoutes(app, deps);
  connectionRoutes(app, deps);
  skillRoutes(app, deps);
  taskRoutes(app, deps);
  approvalRoutes(app, deps);
  streamRoutes(app, deps);
  return app;
}
