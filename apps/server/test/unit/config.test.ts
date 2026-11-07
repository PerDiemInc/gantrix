import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const base = { DATABASE_URL: 'postgres://x@localhost/db', REDIS_URL: 'redis://localhost' };

describe('GANTRIX_APPROVE_ALL', () => {
  it('runs tool calls without asking by default', () => {
    expect(loadConfig(base).GANTRIX_APPROVE_ALL).toBe(true);
  });
  it('keeps the shared project folder unless isolated steps are turned on', () => {
    expect(loadConfig(base).GANTRIX_ISOLATED_STEPS).toBe(false);
    expect(loadConfig({ ...base, GANTRIX_ISOLATED_STEPS: 'true' }).GANTRIX_ISOLATED_STEPS).toBe(
      true,
    );
  });
  it('asks first when set to false', () => {
    expect(loadConfig({ ...base, GANTRIX_APPROVE_ALL: 'false' }).GANTRIX_APPROVE_ALL).toBe(false);
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
