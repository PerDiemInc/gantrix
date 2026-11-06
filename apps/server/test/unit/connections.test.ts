import { describe, expect, it } from 'vitest';
import { isLocalUrl, maskHeaders, resolveHeaders } from '../../src/models/connections.ts';
import { splitAuth } from '../../src/models/provider.ts';

describe('connection headers', () => {
  it('reads env:NAME from the environment, also after a "Bearer " prefix', () => {
    const env = { OPENAI_API_KEY: 'sk-test', TEAM: 't1' };
    expect(
      resolveHeaders({ Authorization: 'Bearer env:OPENAI_API_KEY', 'X-Team': 'env:TEAM' }, env),
    ).toEqual({ Authorization: 'Bearer sk-test', 'X-Team': 't1' });
    expect(resolveHeaders({ 'X-Plain': 'value' }, env)).toEqual({ 'X-Plain': 'value' });
  });

  it('names the missing variable instead of sending an empty header', () => {
    expect(() => resolveHeaders({ 'x-api-key': 'env:NOPE' }, {})).toThrow(/NOPE/);
  });

  it('never shows saved values, only env references', () => {
    expect(
      maskHeaders({ Authorization: 'Bearer sk-live-123', 'x-api-key': 'env:ANTHROPIC_API_KEY' }),
    ).toEqual({ Authorization: 'hidden', 'x-api-key': 'env:ANTHROPIC_API_KEY' });
    expect(maskHeaders({ Authorization: 'Bearer env:KEY' })).toEqual({
      Authorization: 'Bearer env:KEY',
    });
  });

  it('maps auth headers to SDK key settings and passes the rest through', () => {
    expect(splitAuth({ Authorization: 'Bearer abc', 'OpenAI-Organization': 'org' })).toEqual({
      bearer: 'abc',
      apiKey: undefined,
      rest: { 'OpenAI-Organization': 'org' },
    });
    expect(splitAuth({ 'X-API-Key': 'k' }).apiKey).toBe('k');
  });
});

describe('isLocalUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', true],
    ['http://localhost:8000/v1', true],
    ['http://192.168.1.20:1234', true],
    ['http://[::1]:4000', true],
    ['https://api.openai.com/v1', false],
    ['https://api.anthropic.com', false],
    ['http://172.32.0.1', false],
  ])('%s → %s', (url, local) => {
    expect(isLocalUrl(url)).toBe(local);
  });
});
