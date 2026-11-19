import { DEFAULT_MODEL, type DefaultModelDto } from '@gantrix/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connections } from '../../db/schema.ts';
import { describeModel } from '../../live.ts';
import { isModelConnection, needsModel } from '../../models/connections.ts';
import { loadDefaultModel, saveDefaultModel } from '../../settings.ts';
import { HttpError, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const DefaultModel = z.object({
  connectionId: z.uuid().nullable(),
  // An empty box means the built-in model.
  model: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((m) => m || null),
});

export function settingsRoutes(app: FastifyInstance, { db, config }: ApiDeps): void {
  /** The default model as saved, and what it works out to now. */
  async function current(): Promise<DefaultModelDto> {
    const [rows, saved] = await Promise.all([db.select().from(connections), loadDefaultModel(db)]);
    const use = describeModel(config, rows, null, saved);
    return {
      ...saved,
      effective: {
        model: use.model,
        provider: use.provider,
        connection: use.connection,
        isLocal: use.isLocal,
      },
      builtIn: DEFAULT_MODEL,
    };
  }

  app.get('/api/settings/default-model', current);

  // What the planner, the judges and every agent without its own model run on.
  app.put('/api/settings/default-model', async (request) => {
    const { connectionId, model } = parse(DefaultModel, request.body);
    if (connectionId) {
      const c = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
      if (!c) throw new HttpError(400, 'That connection does not exist.');
      if (!isModelConnection(c)) {
        throw new HttpError(
          400,
          `Connection "${c.name}" is a ${c.provider} connection, not a model.`,
        );
      }
      if (c.provider === 'claude-code' || c.provider === 'codex' || c.provider === 'http') {
        throw new HttpError(
          400,
          `The default model can't be on "${c.name}" (${c.provider}): the planner and judges need an Ollama, OpenAI or Anthropic model.`,
        );
      }
      if (needsModel(c.provider) && !model) {
        throw new HttpError(400, `Connection "${c.name}" needs a model: choose one.`);
      }
    }
    await saveDefaultModel(db, { connectionId, model });
    return current();
  });
}
