import type { DefaultModelSettingDto } from '@gantrix/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { appSettings } from './db/schema.ts';

const DEFAULT_MODEL_KEY = 'default_model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The default model: what the planner, the judges and every agent without its own model use.
 * Chosen on the Agents page and kept in the database, not in the environment. Nothing saved
 * means the built-in model on the local Ollama.
 */
export async function loadDefaultModel(db: Db): Promise<DefaultModelSettingDto> {
  const row = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, DEFAULT_MODEL_KEY),
  });
  const v = row?.value as { connectionId?: unknown; model?: unknown } | undefined;
  return {
    connectionId:
      typeof v?.connectionId === 'string' && UUID.test(v.connectionId) ? v.connectionId : null,
    model: typeof v?.model === 'string' && v.model.trim() ? v.model.trim() : null,
  };
}

export async function saveDefaultModel(db: Db, value: DefaultModelSettingDto): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: DEFAULT_MODEL_KEY, value: { ...value } })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: { ...value }, updatedAt: new Date() },
    });
}
