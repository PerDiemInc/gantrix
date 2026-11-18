import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const PrSettingsSchema = z
  .object({
    enabled: z.boolean(),
    GITHUB_TOKEN: z.string().min(1),
    GITHUB_PR_ORG: optional(z.string().regex(/^[a-z\d][a-z\d-]*$/i)),
    GITHUB_PR_REPOS: z.array(
      z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .refine((repo) => repo.split('/').every((part) => part !== '.' && part !== '..')),
    ),
    GITHUB_PR_INTERVAL_SECONDS: z.number().int().min(60).max(86400),
    GITHUB_PR_MODEL: z.string().min(1),
    SLACK_BOT_TOKEN: optional(z.string().startsWith('xoxb-')),
    SLACK_APP_TOKEN: optional(z.string().startsWith('xapp-')),
    SLACK_CHANNEL_ID: optional(z.string().regex(/^[CG][A-Z0-9]{6,}$/)),
    SLACK_ALLOWED_USERS: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)),
    PR_SMTP_URL: optional(z.url({ protocol: /^smtps?$/ })),
    PR_EMAIL_FROM: optional(z.email()),
    PR_EMAIL_TO: optional(z.email()),
    PR_IMAP_HOST: optional(z.hostname()),
    PR_IMAP_USER: optional(z.string()),
    PR_IMAP_PASSWORD: optional(z.string()),
  })
  .refine(
    (value) => value.GITHUB_PR_ORG || value.GITHUB_PR_REPOS.length,
    'Enter an organization or repository.',
  )
  .refine(
    (v) => Boolean(v.SLACK_BOT_TOKEN) === Boolean(v.SLACK_CHANNEL_ID),
    'Slack requires a bot token and channel.',
  )
  .refine(
    (v) => !v.SLACK_APP_TOKEN || Boolean(v.SLACK_BOT_TOKEN && v.SLACK_ALLOWED_USERS.length),
    'Slack replies require a bot token and allowed users.',
  )
  .refine((v) => {
    const smtp = [v.PR_SMTP_URL, v.PR_EMAIL_FROM, v.PR_EMAIL_TO];
    return smtp.every(Boolean) || !smtp.some(Boolean);
  }, 'Email delivery requires SMTP URL, sender, and recipient.')
  .refine((v) => {
    const imap = [v.PR_IMAP_HOST, v.PR_IMAP_USER, v.PR_IMAP_PASSWORD];
    return !imap.some(Boolean) || (imap.every(Boolean) && Boolean(v.PR_SMTP_URL));
  }, 'Email replies require SMTP delivery settings and IMAP host, user, and password.');

export type PrSettings = z.infer<typeof PrSettingsSchema>;
export const secretFields = [
  'GITHUB_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'PR_SMTP_URL',
  'PR_IMAP_PASSWORD',
] as const;

const key = (token: string) =>
  createHash('sha256').update('gantrix:task-pr-settings:').update(token).digest();

export function sealSettings(taskId: string, token: string, settings: PrSettings): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(token), iv).setAAD(Buffer.from(taskId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(settings)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openSettings(taskId: string, token: string, value: string): PrSettings {
  const buffer = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(token), buffer.subarray(0, 12))
    .setAAD(Buffer.from(taskId))
    .setAuthTag(buffer.subarray(12, 28));
  return PrSettingsSchema.parse(
    JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString()),
  );
}
