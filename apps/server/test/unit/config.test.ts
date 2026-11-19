import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const base = { DATABASE_URL: 'postgres://x@localhost/db', REDIS_URL: 'redis://localhost' };

describe('settings chosen in the dashboard', () => {
  it('start at their defaults: tools run without asking, shared project folder, the local Ollama', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      GANTRIX_APPROVE_ALL: true,
      GANTRIX_ISOLATED_STEPS: false,
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      GANTRIX_LLM_CONCURRENCY: 2,
      GANTRIX_MAX_MINUTES: 60,
      GANTRIX_MAX_TOKENS: 200_000,
      GANTRIX_MAX_REPLANS: 5,
      GANTRIX_MAX_STEP_ATTEMPTS: 3,
      SLACK_ALLOWED_USERS: [],
      GANTRIX_DASHBOARD_URL: 'http://127.0.0.1:4701',
    });
    expect(c.SLACK_BOT_TOKEN).toBeUndefined();
  });

  it('take overrides in code (how tests set them), not values from the environment', () => {
    const c = loadConfig(
      {
        ...base,
        GANTRIX_APPROVE_ALL: 'false',
        OLLAMA_BASE_URL: 'http://elsewhere:1',
        SLACK_BOT_TOKEN: 'xoxb-1',
      },
      { GANTRIX_ISOLATED_STEPS: true, GANTRIX_LLM_CONCURRENCY: 4 },
    );
    expect(c.GANTRIX_ISOLATED_STEPS).toBe(true);
    expect(c.GANTRIX_LLM_CONCURRENCY).toBe(4);
    // Set in the environment: ignored.
    expect(c.GANTRIX_APPROVE_ALL).toBe(true);
    expect(c.OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(c.SLACK_BOT_TOKEN).toBeUndefined();
  });

  it('do not share one list between configs', () => {
    const a = loadConfig(base);
    a.SLACK_ALLOWED_USERS.push('U1');
    expect(loadConfig(base).SLACK_ALLOWED_USERS).toEqual([]);
  });
});

describe('folder settings', () => {
  it('expands ~ in defaults as well as in values that are set', () => {
    const c = loadConfig(base);
    expect(c.GANTRIX_SITES_DIR).toBe(`${homedir()}/.gantrix/sites`);
    expect(c.GANTRIX_WORKSPACES_DIR).toBe(`${homedir()}/.gantrix/workspaces`);
    expect(loadConfig({ ...base, GANTRIX_SITES_DIR: '~/x' }).GANTRIX_SITES_DIR).toBe(
      `${homedir()}/x`,
    );
  });
});
