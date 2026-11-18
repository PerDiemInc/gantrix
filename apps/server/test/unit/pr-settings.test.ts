import { describe, expect, it } from 'vitest';
import {
  openSettings,
  PrSettingsSchema,
  sealSettings,
} from '../../src/integrations/pr-settings.ts';

const fields = {
  enabled: true,
  GITHUB_TOKEN: 'github-secret',
  GITHUB_PR_ORG: 'PerDiemInc',
  GITHUB_PR_REPOS: [],
  GITHUB_PR_INTERVAL_SECONDS: 300,
  GITHUB_PR_MODEL: 'qwen3:8b',
  SLACK_ALLOWED_USERS: [],
};

describe('task PR scan settings', () => {
  it('encrypts saved configuration and binds it to its task', () => {
    const settings = PrSettingsSchema.parse(fields);
    const saved = sealSettings('task-a', 'local-api-token', settings);
    expect(Buffer.from(saved, 'base64').includes('github-secret')).toBe(false);
    expect(openSettings('task-a', 'local-api-token', saved)).toEqual(settings);
    expect(() => openSettings('task-b', 'local-api-token', saved)).toThrow();
    expect(() => openSettings('task-a', 'different-token', saved)).toThrow();
  });

  it('requires complete transport settings and permits GitHub-only scans', () => {
    expect(PrSettingsSchema.safeParse(fields).success).toBe(true);
    expect(PrSettingsSchema.safeParse({ ...fields, PR_IMAP_HOST: 'imap.gmail.com' }).success).toBe(
      false,
    );
    expect(PrSettingsSchema.safeParse({ ...fields, SLACK_BOT_TOKEN: 'xoxb-test' }).success).toBe(
      false,
    );
  });
});
