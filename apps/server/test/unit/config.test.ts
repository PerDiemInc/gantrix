import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const base = { DATABASE_URL: 'postgres://x@localhost/db', REDIS_URL: 'redis://localhost' };

describe('GANTRIX_APPROVE_ALL', () => {
  it('runs tool calls without asking by default', () => {
    expect(loadConfig(base).GANTRIX_APPROVE_ALL).toBe(true);
  });
  it('asks first when set to false', () => {
    expect(loadConfig({ ...base, GANTRIX_APPROVE_ALL: 'false' }).GANTRIX_APPROVE_ALL).toBe(false);
  });
});
