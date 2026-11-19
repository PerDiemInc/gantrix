import { describe, expect, it } from 'vitest';
import { NEW_ITEMS } from '../../src/components/NewMenu.tsx';
import { NEW_KINDS, parseHash } from '../../src/hooks.ts';

describe('routes', () => {
  it('opens the form for each thing the New menu creates', () => {
    expect(parseHash('#/new/project')).toEqual({ page: 'new', kind: 'project' });
    expect(parseHash('#/new/job')).toEqual({ page: 'new', kind: 'job' });
    expect(parseHash('#/new/agent')).toEqual({ page: 'new', kind: 'agent' });
  });

  it('falls back to a project for "#/new" and for a kind it does not know', () => {
    expect(parseHash('#/new')).toEqual({ page: 'new', kind: 'project' });
    expect(parseHash('#/new/skill')).toEqual({ page: 'new', kind: 'project' });
  });

  it('has a Jobs page, and keeps the old ones', () => {
    expect(parseHash('#/jobs')).toEqual({ page: 'jobs' });
    expect(parseHash('#/agents')).toEqual({ page: 'agents' });
    expect(parseHash('#/projects/abc')).toEqual({ page: 'project', id: 'abc' });
    expect(parseHash('#/tasks/abc/logs/s1')).toEqual({ page: 'logs', id: 'abc', stepId: 's1' });
    expect(parseHash('')).toEqual({ page: 'projects' });
  });

  it('describes every kind in the menu', () => {
    for (const kind of NEW_KINDS) {
      expect(NEW_ITEMS[kind].title).toBeTruthy();
      expect(NEW_ITEMS[kind].hint).toBeTruthy();
    }
    expect(NEW_KINDS).toEqual(['project', 'job', 'agent']);
  });
});
