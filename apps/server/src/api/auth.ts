import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Requires "Authorization: Bearer <GANTRIX_TOKEN>" on every /api route except /api/health.
 * Hashing both sides first makes the comparison constant-time regardless of length.
 * Tokens are never accepted in URLs, so they don't end up in logs or browser history.
 */
export function bearerAuth(token: string) {
  const expected = digest(token);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/') || request.url === '/api/health') return;
    const header = request.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!given || !timingSafeEqual(digest(given), expected)) {
      await reply.code(401).send({ error: 'Missing or invalid token.' });
    }
  };
}
