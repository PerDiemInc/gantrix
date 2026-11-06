import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

/**
 * Settings live in a file of their own (default ~/.gantrix/outreach.env, chmod 600), not in
 * SKILL.md: Gantrix passes MCP servers only the env a skill declares, and SMTP passwords don't
 * belong in a skill file.
 */
const Schema = z.object({
  SMTP_URL: z.string().regex(/^smtps?:\/\//, 'SMTP_URL must start with smtp:// or smtps://'),
  OUTREACH_FROM: z.string().min(3),
  // CAN-SPAM: every commercial email carries a valid postal address and a way to opt out.
  OUTREACH_POSTAL_ADDRESS: z.string().min(10),
  OUTREACH_UNSUBSCRIBE: z
    .string()
    .min(5)
    .default('Not interested? Reply "unsubscribe" and I won\'t email you again.'),
  OUTREACH_DAILY_LIMIT: z.coerce.number().int().min(1).max(500).default(25),
});

export type OutreachSettings = z.infer<typeof Schema>;

export interface OutreachConfig {
  /** null when the file is missing or invalid; sending then explains how to set it up. */
  settings: OutreachSettings | null;
  problem: string | null;
  /** One address per line; never emailed. Shared by every task. */
  doNotContactFile: string;
  /** CSV of every send, used for the daily cap and to avoid emailing someone twice. */
  sentLogFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OutreachConfig {
  const dir = env.OUTREACH_DIR ?? join(env.HOME ?? homedir(), '.gantrix', 'outreach');
  const file = env.OUTREACH_CONFIG ?? join(env.HOME ?? homedir(), '.gantrix', 'outreach.env');
  const paths = {
    doNotContactFile: join(dir, 'do-not-contact.txt'),
    sentLogFile: join(dir, 'sent.csv'),
  };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { ...paths, settings: null, problem: `No outreach settings at ${file}.` };
  }
  const parsed = Schema.safeParse(parseEnv(raw));
  if (!parsed.success) {
    return {
      ...paths,
      settings: null,
      problem: `Outreach settings in ${file} are invalid:\n${z.prettifyError(parsed.error)}`,
    };
  }
  return { ...paths, settings: parsed.data, problem: null };
}

export const SETUP_HELP = `To send email, create ~/.gantrix/outreach.env (chmod 600) with:
SMTP_URL=smtps://user:app-password@smtp.example.com:465
OUTREACH_FROM=Your Name <you@example.com>
OUTREACH_POSTAL_ADDRESS=Your Company, 1 Main St, City, ST 00000
# optional: OUTREACH_UNSUBSCRIBE=..., OUTREACH_DAILY_LIMIT=25
Until then, save the drafts to files instead.`;
