import { execFile } from 'node:child_process';
import { LOCAL_AGENTS, type LocalAgentDto, type LocalAgentId } from '@gantrix/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { connections } from '../db/schema.ts';

const binOf = (id: LocalAgentId) =>
  id === 'claude' ? (process.env.CLAUDE_CODE_BIN ?? 'claude') : (process.env.CODEX_BIN ?? 'codex');

function versionOf(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5_000 }, (error, out) =>
      resolve(error ? null : out.trim().split('\n')[0] || 'installed'),
    );
  });
}

/** Which local agent CLIs this machine has. */
export async function detectLocalAgents(): Promise<LocalAgentDto[]> {
  return Promise.all(
    (Object.keys(LOCAL_AGENTS) as LocalAgentId[]).map(async (id) => {
      const version = await versionOf(binOf(id));
      return { id, ...LOCAL_AGENTS[id], installed: version !== null, version };
    }),
  );
}

/** The saved connection for a local agent CLI, created the first time it's used. */
export async function ensureLocalConnection(db: Db, id: LocalAgentId) {
  const { provider, connectionName } = LOCAL_AGENTS[id];
  const [existing] = await db.select().from(connections).where(eq(connections.provider, provider));
  if (existing) return existing;
  const [taken] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.name, connectionName));
  const [created] = await db
    .insert(connections)
    .values({ name: taken ? `${connectionName}-agent` : connectionName, provider })
    .returning();
  if (!created) throw new Error('Connection insert returned no row');
  return created;
}
