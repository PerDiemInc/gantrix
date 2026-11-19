import { describe, expect, it } from 'vitest';
import { loadConfig, removedEnvWarnings } from '../../src/config.ts';

describe('settings are not environment variables', () => {
  it('says so, with the value, where to set it, when the old variables are still set', () => {
    const warnings = removedEnvWarnings({
      GANTRIX_DEFAULT_MODEL: 'llama3.1:8b',
      GANTRIX_DEFAULT_CONNECTION: 'gateway',
      OLLAMA_BASE_URL: 'http://10.0.0.5:11434',
      GANTRIX_MAX_MINUTES: '120',
    });
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('GANTRIX_DEFAULT_MODEL=llama3.1:8b in .env is no longer read');
    expect(warnings[0]).toContain('Agents → Default model');
    expect(warnings[1]).toContain('GANTRIX_DEFAULT_CONNECTION=gateway');
    expect(warnings[2]).toContain('OLLAMA_BASE_URL=http://10.0.0.5:11434');
    expect(warnings[2]).toContain('Settings → Ollama');
    expect(warnings[3]).toContain('GANTRIX_MAX_MINUTES=120');
    expect(warnings[3]).toContain('Settings → Task defaults');
  });

  it("never prints a secret's value", () => {
    const warnings = removedEnvWarnings({
      SLACK_BOT_TOKEN: 'xoxb-super-secret-value',
      SLACK_APP_TOKEN: 'xapp-another-secret',
      SLACK_CHANNEL_ID: 'C0123456789',
    });
    expect(warnings).toHaveLength(3);
    const text = warnings.join('\n');
    expect(text).toContain('SLACK_BOT_TOKEN in .env is no longer read');
    expect(text).toContain('SLACK_APP_TOKEN in .env is no longer read');
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('another-secret');
    // A channel is not a secret, so it is shown.
    expect(text).toContain('SLACK_CHANNEL_ID=C0123456789');
    expect(text).toContain('Settings → Slack');
  });

  it('covers every variable that moved, and says nothing when they are not set or are empty', () => {
    expect(removedEnvWarnings({})).toEqual([]);
    const all = [
      'GANTRIX_DEFAULT_MODEL',
      'GANTRIX_DEFAULT_CONNECTION',
      'OLLAMA_BASE_URL',
      'GANTRIX_LLM_CONCURRENCY',
      'GANTRIX_MAX_STEP_ATTEMPTS',
      'GANTRIX_MAX_REPLANS',
      'GANTRIX_MAX_TOKENS',
      'GANTRIX_MAX_MINUTES',
      'GANTRIX_APPROVE_ALL',
      'GANTRIX_ISOLATED_STEPS',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_CHANNEL_ID',
      'SLACK_ALLOWED_USERS',
      'GANTRIX_DASHBOARD_URL',
    ];
    expect(removedEnvWarnings(Object.fromEntries(all.map((n) => [n, 'x'])))).toHaveLength(
      all.length,
    );
    expect(removedEnvWarnings(Object.fromEntries(all.map((n) => [n, '  '])))).toEqual([]);
  });

  it('does not put them in the configuration from the environment', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x@localhost/x',
      REDIS_URL: 'redis://localhost:6379',
      GANTRIX_DEFAULT_MODEL: 'llama3.1:8b',
      GANTRIX_DEFAULT_CONNECTION: 'gateway',
    });
    expect(config).not.toHaveProperty('GANTRIX_DEFAULT_MODEL');
    expect(config).not.toHaveProperty('GANTRIX_DEFAULT_CONNECTION');
  });
});
