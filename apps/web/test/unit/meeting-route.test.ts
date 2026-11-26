import { describe, expect, it } from 'vitest';
import { parseHash } from '../../src/hooks.ts';

describe('dashboard hash routing', () => {
  it('opens the meeting page directly', () => {
    expect(parseHash('#/meetings')).toEqual({ page: 'meetings' });
  });

  it('keeps the meeting route when the document URL has a query string', () => {
    const url = new URL('http://localhost:4701/?utm_source=chatgpt.com#/meetings');
    expect(parseHash(url.hash)).toEqual({ page: 'meetings' });
  });

  it('preserves project navigation and the unknown-route fallback', () => {
    expect(parseHash('#/projects')).toEqual({ page: 'projects' });
    expect(parseHash('#/projects/example')).toEqual({ page: 'project', id: 'example' });
    expect(parseHash('#/unknown')).toEqual({ page: 'projects' });
  });
});
