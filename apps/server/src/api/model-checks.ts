import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { connections } from '../db/schema.ts';
import { needsModel } from '../models/connections.ts';
import { HttpError } from './http.ts';

/** OpenAI and Anthropic connections need a model name; catch that now rather than mid-project. */
export async function requireModelFor(
  db: Db,
  connectionId: string | null | undefined,
  model: string | null | undefined,
): Promise<void> {
  if (!connectionId || model) return;
  const c = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  if (c && needsModel(c.provider)) {
    throw new HttpError(400, `Connection "${c.name}" needs a model: choose one.`);
  }
}
