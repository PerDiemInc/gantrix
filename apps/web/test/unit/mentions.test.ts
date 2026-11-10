import { describe, expect, it } from 'vitest';
import { mentionOptions, mentionQuery } from '../../src/components/Meeting.tsx';

describe('chat @-mention autocomplete', () => {
  it('finds the "@partial" just before the caret', () => {
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('hi @Res', 7)).toEqual({ start: 3, query: 'Res' });
    expect(mentionQuery('hi @Lead De', 11)).toEqual({ start: 3, query: 'Lead De' });
  });
  it('stays closed for emails, new lines and text without "@"', () => {
    expect(mentionQuery('bob@res', 7)).toBeUndefined();
    expect(mentionQuery('@Res\nnext', 9)).toBeUndefined();
    expect(mentionQuery('hello', 5)).toBeUndefined();
  });
  it('offers the agents whose name starts with the query', () => {
    const team = [{ name: 'Researcher' }, { name: 'Reviewer' }, { name: 'Writer' }];
    expect(mentionOptions(team, 're').map((a) => a.name)).toEqual(['Researcher', 'Reviewer']);
    expect(mentionOptions(team, '')).toHaveLength(3);
    expect(mentionOptions(team, 'x')).toEqual([]);
  });
});
