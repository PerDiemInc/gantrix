import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const digest = (value: string) => createHash('sha256').update(value).digest();
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** "localhost:4701" → "localhost", "[::1]:4700" → "[::1]". */
export const hostnameOf = (host: string) =>
  host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');

/**
 * Requires "Authorization: Bearer <GANTRIX_TOKEN>" on every request except GET /api/health.
 *
 * The decision uses the route Fastify actually matched, never the raw URL: the router decodes
 * the path ("/%61pi/tasks" routes to /api/tasks) and strips absolute-form targets
 * ("GET http://x/api/tasks"), so a prefix check on request.url can be walked around.
 * Requests that match no route need the token too.
 *
 * When the API listens on loopback, the Host header must be a loopback name as well. A web page
 * that rebinds its own domain to 127.0.0.1 sends its domain as Host, so it is refused.
 *
 * Hashing both sides first makes the comparison constant-time regardless of length. Tokens are
 * never accepted in URLs, so they don't end up in logs or browser history.
 */
export function bearerAuth(token: string, o: { checkHost: boolean } = { checkHost: true }) {
  const expected = digest(token);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (o.checkHost && !LOOPBACK.has(hostnameOf(request.headers.host ?? '').toLowerCase())) {
      await reply.code(421).send({ error: 'Unexpected Host header.' });
      return;
    }
    if (request.routeOptions.url === '/api/health' && request.method === 'GET') return;
    const header = request.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!given || !timingSafeEqual(digest(given), expected)) {
      await reply.code(401).send({ error: 'Missing or invalid token.' });
    }
  };
}
