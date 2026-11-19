import { describe, expect, it } from 'vitest';
import { loadConfig, removedEnvWarnings } from '../../src/config.ts';

describe('the default model is not an environment variable', () => {
  it('says so, with the value, when the old variables are still set', () => {
    const warnings = removedEnvWarnings({
      GANTRIX_DEFAULT_MODEL: 'llama3.1:8b',
      GANTRIX_DEFAULT_CONNECTION: 'gateway',
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('GANTRIX_DEFAULT_MODEL=llama3.1:8b is no longer read');
    expect(warnings[0]).toContain('Agents page');
    expect(warnings[1]).toContain('GANTRIX_DEFAULT_CONNECTION=gateway is no longer read');
  });

  it('says nothing when they are not set, or empty', () => {
    expect(removedEnvWarnings({})).toEqual([]);
    expect(
      removedEnvWarnings({ GANTRIX_DEFAULT_MODEL: '  ', GANTRIX_DEFAULT_CONNECTION: '' }),
    ).toEqual([]);
  });

  it('does not put them in the configuration', () => {
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
