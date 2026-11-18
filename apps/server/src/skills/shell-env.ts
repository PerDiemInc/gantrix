import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { taskEnv } from '../db/schema.ts';

const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * The variables a project's shell commands get. "env:NAME" reads the worker's environment, so
 * a secret can stay in .env instead of the database.
 *
 * Shell runs with HOME set to the project folder, where the AWS CLI and Terraform would find
 * no profiles: with AWS_PROFILE set, the config and credentials files of the real home are
 * named too (unless the project names its own).
 */
export function resolveShellEnv(
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    const ref = ENV_REF.exec(value.trim())?.[1];
    if (!ref) {
      out[name] = value;
      continue;
    }
    const resolved = env[ref];
    if (!resolved) {
      throw new Error(
        `The project's variable ${name} reads ${ref}, which isn't set in the worker's environment (add it to .env and restart the worker).`,
      );
    }
    out[name] = resolved;
  }
  if (out.AWS_PROFILE && !out.HOME) {
    out.AWS_CONFIG_FILE ??= join(home, '.aws', 'config');
    out.AWS_SHARED_CREDENTIALS_FILE ??= join(home, '.aws', 'credentials');
  }
  return out;
}

export async function loadShellEnv(db: Db, taskId: string): Promise<Record<string, string>> {
  const row = await db.query.taskEnv.findFirst({ where: eq(taskEnv.taskId, taskId) });
  return row ? resolveShellEnv(row.vars) : {};
}
